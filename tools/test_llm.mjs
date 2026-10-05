// LLM 连通性验证回归测试
// 目的：修「配置框乱填也能通过」之前，验证真的会被拦住。
// 做法：起一个本地 OpenAI 兼容 mock + 真实后端，逐分支打 /api/llm/test。
//   用法：node tools/test_llm.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 注意：不能用 new URL().pathname —— 中文路径会被百分号编码，导致 spawn cwd ENOENT
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_PORT = 8789;
const BACKEND_PORT = 8790;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;
const BACK = `http://127.0.0.1:${BACKEND_PORT}`;
const GOOD_KEY = 'sk-good';
const ANTH_KEY = 'sk-ant-good';
const MODELS = ['gpt-4o-mini', 'gpt-4o', 'text-embedding-3-small'];

// full: /models 可用；chatonly: /models 404，只能走对话探针；anthropic: 只认 /v1/messages
let mockMode = 'full';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   → ' + detail : ''}`);
}

// ── mock OpenAI 服务 ────────────────────────────────
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  // Anthropic 分支：x-api-key 头 + /v1/messages
  if (u.pathname.startsWith('/v1/messages')) {
    if (mockMode !== 'anthropic') { res.writeHead(404); res.end('not an anthropic endpoint'); return; }
    if ((req.headers['x-api-key'] || '') !== ANTH_KEY || !req.headers['anthropic-version']) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', model: 'claude-3-5-sonnet-latest', content: [{ type: 'text', text: 'hi' }] }));
    return;
  }
  const ok = (req.headers.authorization || '') === 'Bearer ' + GOOD_KEY;
  if (!ok) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
    return;
  }
  if (mockMode === 'anthropic') { res.writeHead(404); res.end('anthropic only'); return; }
  if (u.pathname === '/v1/models') {
    if (mockMode === 'chatonly') { res.writeHead(404); res.end('no models here'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: MODELS.map((id) => ({ id })) }));
    return;
  }
  if (u.pathname === '/v1/chat/completions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }));
    return;
  }
  res.writeHead(404); res.end('nope');
});

async function post(pathname, body) {
  const r = await fetch(BACK + pathname, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
}
const getCfg = () => fetch(BACK + '/api/llm/config').then((r) => r.json());

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

  const before = await getCfg();

  // 1) 地址是乱码 —— 应该立刻被 URL 解析拦下
  let r = await post('/api/llm/test', { baseUrl: '随便乱写asdf', apiKey: GOOD_KEY, model: 'gpt-4o-mini' });
  record('乱码地址被拦', r.ok === false && /不是合法 URL/.test(r.error || ''), r.error);

  // 2) 缺 Key
  r = await post('/api/llm/test', { baseUrl: MOCK_URL, apiKey: '', model: 'gpt-4o-mini' });
  record('缺 Key 被拦', r.ok === false && /缺少 API Key/.test(r.error || ''), r.error);

  // 3) 非 http(s) 协议
  r = await post('/api/llm/test', { baseUrl: 'ftp://127.0.0.1/v1', apiKey: GOOD_KEY, model: 'gpt-4o-mini' });
  record('非法协议被拦', r.ok === false && /http/.test(r.error || ''), r.error);

  // 4) 地址对但 Key 错 → 鉴权失败（不应落到对话探针）
  r = await post('/api/llm/test', { baseUrl: MOCK_URL, apiKey: 'sk-wrong', model: 'gpt-4o-mini' });
  record('错误 Key → 鉴权失败', r.ok === false && /鉴权失败/.test(r.error || ''), r.error);

  // 5) 端口没人听 → 连不上
  r = await post('/api/llm/test', { baseUrl: 'http://127.0.0.1:1/v1', apiKey: GOOD_KEY, model: 'gpt-4o-mini' });
  record('不可达地址 → 连不上', r.ok === false && /连不上|超时/.test(r.error || ''), r.error);

  // 6) 都对但模型名不存在 → 拦下并给出可用清单
  r = await post('/api/llm/test', { baseUrl: MOCK_URL, apiKey: GOOD_KEY, model: 'gpt-9-turbo-ultra' });
  record('模型名不存在被拦', r.ok === false && /没有模型|没找到模型/.test(r.error || '') && Array.isArray(r.models),
    r.error);

  // 7) 全对 → 通过（走 /models 路径）
  r = await post('/api/llm/test', { baseUrl: MOCK_URL, apiKey: GOOD_KEY, model: 'gpt-4o-mini' });
  record('正确配置通过', r.ok === true && r.via === 'models', JSON.stringify(r).slice(0, 90));

  // 8) 中转站场景：没有 /models 接口 → 退化成对话探针
  mockMode = 'chatonly';
  r = await post('/api/llm/test', { baseUrl: MOCK_URL, apiKey: GOOD_KEY, model: 'whatever-model' });
  record('无 /models 时走对话探针', r.ok === true && r.via === 'chat', JSON.stringify(r).slice(0, 90));
  mockMode = 'full';

  // 9) 关键：验证失败不应该写进配置
  await post('/api/llm/test', { baseUrl: '乱码', apiKey: 'x', model: 'y' });
  const after = await getCfg();
  record('失败不落盘', after.configured === before.configured && after.baseUrl === before.baseUrl,
    `configured=${after.configured} baseUrl=${after.baseUrl}`);

  // ── Anthropic 分支 ────────────────────────────────
  mockMode = 'anthropic';   // 只认 /v1/messages，OpenAI 两条路径都 404
  const ANTH_MODEL = 'claude-3-5-sonnet-latest';

  // 10) 手动指定 anthropic
  r = await post('/api/llm/test', { baseUrl: MOCK_URL, apiKey: ANTH_KEY, model: ANTH_MODEL, provider: 'anthropic' });
  record('指定 Anthropic 协议通过', r.ok === true && r.provider === 'anthropic' && r.via === 'messages',
    JSON.stringify(r).slice(0, 90));

  // 11) 自动识别：对面只支持 Anthropic，auto 应该自己认出来
  r = await post('/api/llm/test', { baseUrl: MOCK_URL, apiKey: ANTH_KEY, model: ANTH_MODEL, provider: 'auto' });
  record('auto 认出 Anthropic', r.ok === true && r.provider === 'anthropic', JSON.stringify(r).slice(0, 90));

  // 12) 手动指定 openai 却连 Anthropic → 应该失败（不能悄悄放过）
  r = await post('/api/llm/test', { baseUrl: MOCK_URL, apiKey: ANTH_KEY, model: ANTH_MODEL, provider: 'openai' });
  record('指定 OpenAI 连 Anthropic 失败', r.ok === false, r.error);

  // 13) Anthropic 的 Key 不对 → 鉴权失败（走 x-api-key 头）
  r = await post('/api/llm/test', { baseUrl: MOCK_URL, apiKey: 'sk-ant-wrong', model: ANTH_MODEL, provider: 'anthropic' });
  record('Anthropic 错 Key → 鉴权失败', r.ok === false && /鉴权失败/.test(r.error || ''), r.error);

  // 14) 保存后要把识别结果记下来，对话时才不用再猜
  await post('/api/llm/config', { baseUrl: MOCK_URL, apiKey: ANTH_KEY, model: ANTH_MODEL, provider: 'auto', resolved: 'anthropic' });
  const savedA = await getCfg();
  record('保存记住 resolved=anthropic', savedA.configured === true && savedA.resolved === 'anthropic' && savedA.provider === 'auto',
    JSON.stringify(savedA).slice(0, 110));
  mockMode = 'full';

  // 15) 保存成功的情况（跑完立刻恢复现场，别给仓库留 key）
  await post('/api/llm/config', { baseUrl: MOCK_URL, apiKey: GOOD_KEY, model: 'gpt-4o-mini', provider: 'openai' });
  const saved = await getCfg();
  record('保存后 configured=true', saved.configured === true && saved.resolved === 'openai', JSON.stringify(saved).slice(0, 90));

  // 清理：还原/删除测试产生的 llm-config.json
  try {
    if (backup !== null) fs.writeFileSync(cfgPath, backup); else fs.unlinkSync(cfgPath);
  } catch (e) {}

  backend.kill();
  // 先掐掉 keep-alive 连接，再等服务器真正关闭；最后不要用 process.exit()
  // —— Node 24 上强退会在 uv handle 关闭途中 abort（Assertion failed ... async.c:76）
  mock.closeAllConnections?.();
  mock.closeIdleConnections?.();
  await new Promise((r) => mock.close(r));
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exitCode = failed.length ? 1 : 0;
})();
