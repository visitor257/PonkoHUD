// 回归：LLM 对话上下文（多轮记忆）
//
// 之前用户反馈"对面完全没有记忆"，根因是前端算好了 history 却没传给 askAgent
// （第 4 个参数漏了），每轮请求都只有当前这一句。
// 这个脚本把整条链路钉死：
//   ① 前端 send() 构造的 history 里有什么（当前提问必须排除，否则后端会再追加一遍）
//   ② 后端真的把它转发给了 LLM 吗 —— 两套协议各自的消息数组长什么样
// 需要真后端 + mock LLM 服务（跟 test_llm_stream.mjs 一样起临时端口）。
//   用法：node tools/test_agent_context.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentPanel } from '../app/src/panels/agent.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_PORT = 8791;
const BACKEND_PORT = 8792;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;
const BACK = `http://127.0.0.1:${BACKEND_PORT}`;
const KEY = 'sk-context-test';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   → ' + detail : ''}`);
}

// ── 1. 前端：send() 打包出来的 history ────────────────────────────────
// 用假 fetch 截住 /api/agent 的请求体；顺便也覆盖 api.js 有没有把字段发出去。
console.log('── 前端 send() 构造上下文 ──');
{
  const captured = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    captured.push({ url: String(url), body: JSON.parse(opts.body || '{}') });
    return {
      ok: true,
      body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
    };
  };

  const moodCalls = [];
  const mood = { touch() {}, fromAgent() { moodCalls.push('agent'); return true; } };
  const a = new AgentPanel(mood);
  a.llmConfigured = true;

  // 两轮既有对话，其中 agent 那句带心情标记（不该回灌给 LLM）
  a.push('user', '我叫小明');
  a.push('agent', '你好小明 [[mood:idle|face:smile|note:打招呼]]');
  a.push('think', '这条思考不该进上下文');

  a.send('还记得我是谁吗');
  const req = captured.find((c) => c.url.includes('/api/agent'));
  record('send() 真的发出了请求', !!req, captured.map((c) => c.url).join(','));
  record('请求体带了 history 字段', !!(req && Array.isArray(req.body.history)), JSON.stringify(req && req.body.history));

  const h = (req && req.body.history) || [];
  record('history 里有上一轮提问', h.some((m) => m.role === 'user' && m.content === '我叫小明'), JSON.stringify(h));
  const ag = h.find((m) => m.role === 'agent');
  record('history 里有上一轮回复', !!ag, JSON.stringify(ag));
  record('history 剥掉了 [[mood:...]] 标记', !!ag && !ag.content.includes('[[mood:'), ag && ag.content);
  record('history 排除了本次提问（后端会自己追加）',
    !h.some((m) => m.role === 'user' && m.content === '还记得我是谁吗'), JSON.stringify(h));
  record('think 块不进上下文', !h.some((m) => m.role === 'think'), JSON.stringify(h));
  // 相对顺序（面板构造时会先 push 一条欢迎语，所以不能断言是全表的绝对顺序）
  const iUser = h.findIndex((m) => m.content === '我叫小明');
  const iAgent = h.findIndex((m) => m.role === 'agent' && m.content.startsWith('你好小明'));
  record('history 按时间先后排列（提问在回复之前）', iUser >= 0 && iAgent > iUser, `user@${iUser} agent@${iAgent}`);

  // 窗口裁剪：30 轮之后只保留最近 20 条
  const a2 = new AgentPanel(mood);
  a2.llmConfigured = true;
  for (let i = 0; i < 20; i++) { a2.push('user', 'u' + i); a2.push('agent', 'a' + i); }
  captured.length = 0;
  a2.busy = false;
  a2.send('最新的提问');
  const h2 = ((captured.find((c) => c.url.includes('/api/agent')) || {}).body || {}).history || [];
  record('超出窗口的旧对话被裁掉', h2.length === 20, `len=${h2.length}`);
  record('保留的是最近的对话', h2[h2.length - 1] && h2[h2.length - 1].content === 'a19', JSON.stringify(h2.slice(-2)));

  globalThis.fetch = realFetch;
}

// ── 1b. 收尾心情：done 事件带回的心情要落地（否则回复一结束就回落成待机） ──
console.log('\n── 收尾心情落地 ──');
{
  const realFetch = globalThis.fetch;
  const enc = new TextEncoder();
  const LINES = [
    JSON.stringify({ t: 'mood', state: 'stream', note: '开始输出' }),
    JSON.stringify({ t: 'token', text: '你好' }),
    JSON.stringify({ t: 'done', tokens: 2, mood: { state: 'idle', face: 'smile', note: '收工' } }),
  ];
  globalThis.fetch = async () => {
    let i = 0;
    return {
      ok: true,
      body: { getReader: () => ({ read: async () => (i < LINES.length ? { done: false, value: enc.encode(LINES[i++] + '\n') } : { done: true, value: undefined }) }) },
    };
  };

  const applied = [];
  const mood = { touch() {}, fromAgent(ev) { applied.push(ev); return true; }, fromLocal() {} };
  const a = new AgentPanel(mood);
  a.llmConfigured = true;
  a.send('你好');
  await new Promise((r) => setTimeout(r, 80));      // 等假流走完

  record('流中的心情照旧落地', applied[0] && applied[0].state === 'stream', JSON.stringify(applied[0]));
  record('done 的收尾心情也落地了', applied.length >= 2 && applied[applied.length - 1].state === 'idle',
    JSON.stringify(applied.map((x) => x.state)));
  record('收尾心情带上了 face/note', applied[applied.length - 1].face === 'smile' && applied[applied.length - 1].note === '收工',
    JSON.stringify(applied[applied.length - 1]));
  globalThis.fetch = realFetch;
}

// ── 2. 后端：真的转发给 LLM 了吗 ──────────────────────────────────────
console.log('\n── 后端转发（真后端 + mock LLM） ──');

let lastBody = null;                      // mock 收到的请求体
const mock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { lastBody = null; }
  if (req.url === '/v1/messages') {
    if ((req.headers['x-api-key'] || '') !== KEY) { res.writeHead(401); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })}\n\n`);
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    res.end(); return;
  }
  if (req.url === '/v1/chat/completions') {
    if ((req.headers.authorization || '') !== 'Bearer ' + KEY) { res.writeHead(401); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end(); return;
  }
  res.writeHead(404); res.end('nope');
});

const HISTORY = [
  { role: 'user', content: '我叫小明' },
  { role: 'agent', content: '你好小明' },
  { role: 'user', content: '我喜欢猫' },
  { role: 'agent', content: '记住了' },
];
const CUR = '还记得我是谁吗';

async function call(history, cur = CUR) {
  lastBody = null;
  const r = await fetch(BACK + '/api/agent', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: cur, history }),
  });
  await r.text();                         // 把流读完，确保后端已发完请求
  return lastBody;
}

(async () => {
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
  const cfgPath = path.join(ROOT, 'server', 'llm-config.json');
  const hadCfg = fs.existsSync(cfgPath);
  const backup = hadCfg ? fs.readFileSync(cfgPath, 'utf8') : null;

  const backend = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT, env: { ...process.env, PONKO_PORT: String(BACKEND_PORT) }, stdio: 'ignore',
  });
  let up = false;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BACK + '/index.html'); if (r.status === 200) { up = true; break; } } catch (e) {}
    await sleep(200);
  }
  if (!up) { console.log('后端没起来，测试中止'); mock.close(); backend.kill(); process.exit(3); }

  const save = (b) => fetch(BACK + '/api/llm/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
  }).then((r) => r.json());

  // OpenAI 兼容
  await save({ baseUrl: MOCK_URL, apiKey: KEY, model: 'gpt-x', provider: 'openai' });
  let b = await call(HISTORY);
  record('history 为空时只有 system + 本次提问', await (async () => {
    const only = await call([], CUR);
    return only && only.messages.length === 2 && only.messages[0].role === 'system'
      && only.messages[1].role === 'user' && only.messages[1].content === CUR;
  })(), JSON.stringify((lastBody || {}).messages));
  b = await call(HISTORY);
  const ms = (b && b.messages) || [];
  record('历史被转发（system + 4 条历史 + 本次）', ms.length === 6, `len=${ms.length}`);
  record('首条是 system', ms[0] && ms[0].role === 'system', ms[0] && ms[0].role);
  record('末条是本次提问', ms[ms.length - 1] && ms[ms.length - 1].content === CUR, JSON.stringify(ms[ms.length - 1]));
  record('agent 被映射成 assistant', ms.some((m) => m.role === 'assistant' && m.content === '你好小明'), JSON.stringify(ms.map((m) => m.role)));
  record('本次提问没有重复出现', ms.filter((m) => m.role === 'user' && m.content === CUR).length === 1,
    String(ms.filter((m) => m.content === CUR).length));
  record('顺序保持时间先后', JSON.stringify(ms.map((m) => m.role)) === JSON.stringify(['system', 'user', 'assistant', 'user', 'assistant', 'user']),
    JSON.stringify(ms.map((m) => m.role)));

  // 脏数据：历史末尾已经躺着一条和本次一模一样的 user
  const dup = [...HISTORY, { role: 'user', content: CUR }];
  const bd = await call(dup);
  record('历史末尾的重复提问被剔除', bd.messages.filter((m) => m.content === CUR).length === 1,
    String(bd.messages.filter((m) => m.content === CUR).length));

  // Anthropic 原生
  await save({ baseUrl: MOCK_URL, apiKey: KEY, model: 'claude-x', provider: 'anthropic' });
  const ba = await call(HISTORY);
  const ams = (ba && ba.messages) || [];
  record('Anthropic：system 走单独字段', !!ba.system && !ams.some((m) => m.role === 'system'), typeof ba.system);
  record('Anthropic：messages 里没有 system', ams.every((m) => m.role !== 'system'), JSON.stringify(ams.map((m) => m.role)));
  record('Anthropic：历史被转发', ams.some((m) => m.content.includes('我叫小明')), JSON.stringify(ams.map((m) => m.role)));
  record('Anthropic：末条是本次提问', ams[ams.length - 1] && ams[ams.length - 1].content === CUR, JSON.stringify(ams[ams.length - 1]));
  let alt = true;
  for (let i = 1; i < ams.length; i++) if (ams[i].role === ams[i - 1].role) alt = false;
  record('Anthropic：user/assistant 严格交替', alt, JSON.stringify(ams.map((m) => m.role)));

  try { if (backup !== null) fs.writeFileSync(cfgPath, backup); else fs.unlinkSync(cfgPath); } catch (e) {}
  backend.kill();
  mock.closeAllConnections?.();
  mock.closeIdleConnections?.();
  await new Promise((r) => mock.close(r));
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exitCode = failed.length ? 1 : 0;
})();
