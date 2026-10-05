// 对话流回归：验证 OpenAI 兼容与 Anthropic 两套 SSE 都能被正确解析成 token 事件
// 配置验证（tools/test_llm.mjs）只证明"连得上"，这里证明"真能聊"——两套协议的
// SSE 报文格式完全不同（choices[0].delta.content vs content_block_delta.text_delta），
// 任一边解析写错，用户在界面上就只看到空白回答。
//   用法：node tools/test_llm_stream.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 注意：不能用 new URL().pathname —— 中文路径会被百分号编码，导致 spawn cwd ENOENT
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_PORT = 8793;
const BACKEND_PORT = 8794;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;
const BACK = `http://127.0.0.1:${BACKEND_PORT}`;
const KEY = 'sk-stream-test';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   → ' + detail : ''}`);
}

// ── mock：同一端口按路径分流，各按自己的协议吐 SSE ──────────────────
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/v1/messages') {
    // Anthropic：事件行 + data 行，文本在 delta.text 里
    if ((req.headers['x-api-key'] || '') !== KEY) { res.writeHead(401); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const t of ['HELLO', '-ANTH', 'ROPIC']) {
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })}\n\n`);
    }
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    res.end();
    return;
  }
  if (u.pathname === '/v1/chat/completions') {
    if ((req.headers.authorization || '') !== 'Bearer ' + KEY) { res.writeHead(401); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const t of ['HELLO', '-OPEN', 'AI']) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  res.writeHead(404); res.end('nope');
});

// 打 /api/agent（NDJSON 流），把 token 拼回来
async function chat() {
  const r = await fetch(BACK + '/api/agent', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hi', history: [] }),
  });
  const body = await r.text();
  let text = '', done = false, err = '';
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    if (o.t === 'token') text += o.text || '';
    else if (o.t === 'done') done = true;
    else if (o.t === 'error') err = o.text || '';
  }
  return { text, done, err };
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
  if (!up) { console.log('backend 没起来，测试中止'); mock.close(); backend.kill(); process.exit(3); }

  const save = (b) => fetch(BACK + '/api/llm/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
  }).then((r) => r.json());

  // 1) OpenAI 兼容流
  await save({ baseUrl: MOCK_URL, apiKey: KEY, model: 'gpt-x', provider: 'openai' });
  let r = await chat();
  record('OpenAI 流解析正确', r.text === 'HELLO-OPENAI' && r.done && !r.err, JSON.stringify(r));

  // 2) Anthropic 原生流
  await save({ baseUrl: MOCK_URL, apiKey: KEY, model: 'claude-x', provider: 'anthropic' });
  r = await chat();
  record('Anthropic 流解析正确', r.text === 'HELLO-ANTHROPIC' && r.done && !r.err, JSON.stringify(r));

  // 3) 协议写错时应当报错，而不是静默给空回答
  await save({ baseUrl: MOCK_URL, apiKey: 'sk-wrong', model: 'claude-x', provider: 'anthropic' });
  r = await chat();
  record('Anthropic 错 Key 有报错', !!r.err && /401/.test(r.err), r.err || JSON.stringify(r));

  // 清理：还原/删除测试产生的 llm-config.json
  try {
    if (backup !== null) fs.writeFileSync(cfgPath, backup); else fs.unlinkSync(cfgPath);
  } catch (e) {}

  backend.kill();
  mock.closeAllConnections?.();
  mock.closeIdleConnections?.();
  await new Promise((r2) => mock.close(r2));
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exitCode = failed.length ? 1 : 0;
})();
