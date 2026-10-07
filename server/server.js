// Ponko HUD 本地后端：纯 Node 标准库，零第三方依赖
//   GET  /api/sys            系统快照
//   POST /api/shell          执行 shell 命令（NDJSON 流：out/err/exit）
//   POST /api/agent          agent 对话（NDJSON 流：mood/thinking/token/tool/done）
//                            ★ mood 事件完全由 agent 的正文标记产出，后端不推断情绪
//   GET  /api/mood/protocol  心情协议：状态枚举 + 可用表情 + 给 LLM 的 system 提示词
//   GET  /api/charpacks      列出素材包（用户自定义表情）
//   /*                       静态文件（app/ 目录）
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const sysinfo = require('./sysinfo');
const netgeo = require('./netgeo');
const moodp = require('./moodprotocol');
const { pty } = require('./pty');

// ─────────────────────────────── LLM 接入配置（本地持久化到 llm-config.json）
// 用户在前端填 API 地址 / API Key / 模型；配好后 /api/agent 改走真 LLM 流式调用。
const LLM_CFG_PATH = path.join(__dirname, 'llm-config.json');
// provider  = 用户的选择：auto（自动识别）/ openai（OpenAI 兼容）/ anthropic（Claude 原生）
// resolved  = 自动识别后实际用到的协议，写盘后对话时就不用再猜
// rawProvider：只认两个真协议，其它（含空串）一律 ''（= 还没识别/不适用）
// normProvider：在 rawProvider 之上把空值补成 auto，用于"用户意图"字段
function rawProvider(p) {
  const s = String(p || '').trim().toLowerCase();
  return (s === 'openai' || s === 'anthropic') ? s : '';
}
function normProvider(p) {
  return rawProvider(p) || 'auto';
}
let llmCfg = { baseUrl: '', apiKey: '', model: '', provider: 'auto', resolved: '', configured: false };
(function loadLlmCfg() {
  try {
    const j = JSON.parse(fs.readFileSync(LLM_CFG_PATH, 'utf8'));
    llmCfg = Object.assign({ baseUrl: '', apiKey: '', model: '' }, j);
  } catch (e) { /* 没有配置文件就用默认值 */ }
  llmCfg.provider = normProvider(llmCfg.provider);
  llmCfg.resolved = rawProvider(llmCfg.resolved);
  llmCfg.configured = !!(llmCfg.baseUrl && llmCfg.apiKey);
})();
function saveLlmCfg(cfg) {
  const prov = normProvider(cfg.provider || llmCfg.provider);
  llmCfg = {
    baseUrl: (cfg.baseUrl || '').trim(),
    apiKey: (cfg.apiKey || '').trim(),
    model: (cfg.model || llmCfg.model || 'gpt-3.5-turbo').trim(),
    provider: prov,
    // 显式选了协议就等于确定了（resolved 同步过去）；auto 则以探测结果为准
    resolved: rawProvider(cfg.resolved) || (prov === 'auto' ? '' : prov),
  };
  llmCfg.configured = !!(llmCfg.baseUrl && llmCfg.apiKey);
  try { fs.writeFileSync(LLM_CFG_PATH, JSON.stringify(llmCfg, null, 2)); } catch (e) { /* 写不了就内存里用着 */ }
  return publicLlmCfg();
}
// 不回传明文 key，只告诉前端"有没有配过"
function publicLlmCfg() {
  return {
    configured: llmCfg.configured, baseUrl: llmCfg.baseUrl, model: llmCfg.model,
    hasKey: !!llmCfg.apiKey, provider: llmCfg.provider, resolved: llmCfg.resolved || '',
  };
}
// 对话时真正用的协议：探测结果优先，其次用户显式选择，都没有就按 OpenAI 兼容走
function activeProvider() {
  return rawProvider(llmCfg.resolved) || rawProvider(llmCfg.provider) || 'openai';
}

// ─────────────────────────── LLM 连通性验证（保存前必须真的打一次接口）
// 之前 /api/llm/config 只做「非空→写盘」，于是乱填地址/Key 也能"配置成功"，
// 直到第一次对话才炸。现在保存前先探一次，并且顺便认出对面是什么协议：
//   OpenAI 兼容：GET {base}/v1/models（顺带校模型名）→ 不行再 POST /v1/chat/completions 探针
//   Anthropic  ：POST {base}/v1/messages（x-api-key + anthropic-version）
// 两者报文完全不通，所以「自动识别」就是按顺序各试一次，谁通用谁。
function llmV1(base) {
  const b = String(base || '').trim().replace(/\/+$/, '');
  return b.replace(/\/v1$/, '') + '/v1';          // 兼容带或不带 /v1 的地址
}
const ANTHROPIC_VERSION = '2023-06-01';

async function probeOpenAI(base, apiKey, model, t0) {
  const v1 = llmV1(base);
  const hdr = { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' };
  let netErr = '';

  // ① 模型列表
  try {
    const r = await fetch(v1 + '/models', { headers: hdr, signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      const ids = j && Array.isArray(j.data)
        ? j.data.map((x) => x.id || x.name).filter(Boolean)
        : [];
      if (ids.length && !ids.includes(model)) {
        const tip = ids.slice(0, 6).join(' / ') + (ids.length > 6 ? ' …' : '');
        return { ok: false, ms: Date.now() - t0, provider: 'openai', models: ids, error: `Key 有效，但没找到模型「${model}」。可用：${tip}` };
      }
      return { ok: true, ms: Date.now() - t0, provider: 'openai', model, via: 'models', models: ids };
    }
    if (r.status === 401 || r.status === 403) {
      const d = await r.text().catch(() => '');
      return { ok: false, ms: Date.now() - t0, provider: 'openai', error: `鉴权失败（HTTP ${r.status}）：Key 不对或没有权限 ${d.slice(0, 120)}` };
    }
    // 其他状态码：落到 ② 再试一次
  } catch (e) {
    netErr = e.name === 'TimeoutError' ? '请求 /models 超时' : ('连不上：' + e.message);
  }

  // ② 极小对话探针
  try {
    const r = await fetch(v1 + '/chat/completions', {
      method: 'POST',
      headers: { ...hdr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(15000),
    });
    if (r.ok) return { ok: true, ms: Date.now() - t0, provider: 'openai', model, via: 'chat' };
    let d = '';
    try { d = (await r.text()).slice(0, 160); } catch (e) {}
    if (r.status === 401 || r.status === 403) return { ok: false, ms: Date.now() - t0, provider: 'openai', error: `鉴权失败（HTTP ${r.status}）：Key 不对 ${d}` };
    if (r.status === 404) return { ok: false, ms: Date.now() - t0, provider: 'openai', error: `没有 ${v1}/chat/completions（HTTP 404）：地址填错了吗？` };
    return { ok: false, ms: Date.now() - t0, provider: 'openai', error: `LLM 返回 HTTP ${r.status}：${d}` };
  } catch (e) {
    const m = e.name === 'TimeoutError' ? '对话请求超时' : ('连不上：' + e.message);
    return { ok: false, ms: Date.now() - t0, provider: 'openai', error: netErr || m };
  }
}

async function probeAnthropic(base, apiKey, model, t0) {
  const url = llmV1(base) + '/messages';
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(15000),
    });
    if (r.ok) {
      let j = null; try { j = await r.json(); } catch (e) {}
      return { ok: true, ms: Date.now() - t0, provider: 'anthropic', model: (j && j.model) || model, via: 'messages' };
    }
    let d = '';
    try { d = (await r.text()).slice(0, 160); } catch (e) {}
    if (r.status === 401 || r.status === 403) return { ok: false, ms: Date.now() - t0, provider: 'anthropic', error: `鉴权失败（HTTP ${r.status}）：x-api-key 不对或没权限 ${d}` };
    if (r.status === 404) return { ok: false, ms: Date.now() - t0, provider: 'anthropic', error: `没有 ${url}（HTTP 404）：这不是 Anthropic 接口吧？` };
    return { ok: false, ms: Date.now() - t0, provider: 'anthropic', error: `Anthropic 返回 HTTP ${r.status}：${d}` };
  } catch (e) {
    const m = e.name === 'TimeoutError' ? 'Anthropic 请求超时' : ('连不上：' + e.message);
    return { ok: false, ms: Date.now() - t0, provider: 'anthropic', error: m };
  }
}

async function testLlm(cfg) {
  const base = String((cfg && cfg.baseUrl) || llmCfg.baseUrl || '').trim();
  const apiKey = String((cfg && cfg.apiKey) || llmCfg.apiKey || '').trim();
  const model = String((cfg && cfg.model) || llmCfg.model || '').trim() || 'gpt-3.5-turbo';
  if (!base) return { ok: false, error: '缺少 API 地址' };
  if (!apiKey) return { ok: false, error: '缺少 API Key' };

  let u;
  try { u = new URL(base); } catch (e) { return { ok: false, error: `API 地址不是合法 URL：${base}` }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: 'API 地址必须以 http:// 或 https:// 开头' };
  }

  const t0 = Date.now();
  const want = normProvider((cfg && cfg.provider) || llmCfg.provider);
  if (want === 'anthropic') return probeAnthropic(base, apiKey, model, t0);
  if (want === 'openai') return probeOpenAI(base, apiKey, model, t0);

  // auto：OpenAI 兼容先试（中转站绝大多数是它），不行再试 Anthropic 原生
  const a = await probeOpenAI(base, apiKey, model, t0);
  if (a.ok) return a;
  const b = await probeAnthropic(base, apiKey, model, t0);
  if (b.ok) return b;
  // 两个都不通：优先展示"真连上了但被拒"的那条（鉴权类比 404/连不上更能说明问题）
  const pick = [a, b].find((x) => /鉴权失败/.test(x.error || '')) || a;
  return { ok: false, ms: Date.now() - t0, error: pick.error, models: pick.models, tried: ['openai', 'anthropic'] };
}

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app');
const CHARS = path.join(ROOT, 'characters');
const PORT = Number(process.env.PONKO_PORT || 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, obj, code = 200) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
}

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  const b = Buffer.from(body);
  // 本地应用禁缓存：否则 WebView2 会把旧 JS 模块缓存住，改了前端代码"不生效"
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': b.length, 'Cache-Control': 'no-cache' });
  res.end(b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > 4 << 20) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ─────────────────────────────── shell（pwsh 持久会话 / cmd 一次性执行）
//
// 为什么 cmd 不能也用持久会话：cmd.exe 的 stdin 管道在 chcp 65001 下会吞掉多字节命令
// （实测卡死在 "More?"），而默认 936 又把中文命令解烂。所以 CMD 模式改一次性 `cmd /c`：
// 命令作为 argv 传入 → Windows 走 UTF-16，中文无损；输出侧用 chcp 65001 强制 UTF-8。
//
// 另一个坑：裸跑 cmd / python / ssh 这类交互式程序会**抢占父 shell 的 stdin**，
// 之后所有命令都被喂给它（"is not recognized as an internal or external command"），
// 而且哨兵行被吞导致退出码永远是 0 —— 整个会话废掉。故必须拦截。
const SENTINEL = 'PONKO_DONE_9f3c';
let sh = null, shBuf = '', shState = 'idle';   // idle | busy
let shellKind = 'pwsh';                        // pwsh | cmd
let curDir = process.env.USERPROFILE || 'C:\\';
let activeProc = null;                         // CMD 模式下的一次性进程

// 裸跑（不带参数）会抢 stdin 的交互式程序
const REPL_BLOCK = new Set(['python', 'python3', 'py', 'node', 'ipython', 'ssh', 'ftp', 'sftp', 'telnet',
  'nslookup', 'mysql', 'psql', 'sqlite3', 'diskpart', 'regedit', 'wsl', 'bash', 'sh', 'zsh',
  'more', 'less', 'vim', 'nvim', 'nano', 'emacs', 'top', 'htop', 'tmux', 'ranger', 'notepad']);

function spawnShell() {
  if (sh) { try { sh.kill(); } catch (e) {} sh = null; }
  sh = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
    cwd: curDir,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  shBuf = '';
  sh.stdout.setEncoding('utf8');
  sh.stderr.setEncoding('utf8');
  sh.on('exit', () => { sh = null; });

  // ── 中文编码：Windows PowerShell 5.1 的管道是 ANSI(936)，两头都会坏
  //   · 输出侧：强制 UTF-8，否则文件名 / 错误消息等"系统产生的中文"会变成 GBK 字节
  //   · 输入侧：[Console]::InputEncoding 设置了也不生效（实测），
  //     所以命令走 base64（纯 ASCII）进去，由 PowerShell 自己解成 UTF-8 字符串
  sh.ready = false;
  sh.stdin.write('try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch { }\n');
  sh.stdin.write('$OutputEncoding=[System.Text.Encoding]::UTF8\n');
  sh.stdin.write('$ProgressPreference="SilentlyContinue"; $ErrorActionPreference="Continue"\n');
  // 就绪前吃掉初始化期的所有输出
  const swallow = (c) => { if (!sh || !sh.ready) { shBuf = ''; return; } };
  sh.stdout.on('data', swallow);
  setTimeout(() => { if (sh) { sh.stdout.off('data', swallow); sh.ready = true; shBuf = ''; } }, 400);
  return sh;
}
spawnShell();

// cmd 输出用的是系统 ANSI 代码页（chcp 对管道无效，实测），所以在 Node 侧按该代码页解码。
// 中文命令则走 argv（UTF-16），不受影响 —— 两边分开治。
const CP_MAP = { 936: 'gbk', 950: 'big5', 932: 'shift_jis', 949: 'euc-kr', 65001: 'utf-8', 1252: 'windows-1252' };
let cmdEnc = 'gbk';
try {
  const cp = Number((require('child_process').execSync('chcp', { windowsHide: true }).toString() || '').match(/(\d+)/) || [0, 936])[1];
  if (CP_MAP[cp]) cmdEnc = CP_MAP[cp];
} catch (e) { /* 保持 gbk */ }

// CMD 模式：一次性 cmd /c（cwd 用 spawn 的 cwd 选项，命令里不再拼路径）
function runCmdOnce(cmd, onLine, onExit) {
  // 三处 cmd 特性必须同时满足，缺一个就坏：
  //  · /s + 外层引号 + windowsVerbatimArguments —— 否则 Node 把 " 转义成 \"（cmd 不认反斜杠转义）
  //  · /V:ON + !VAR! —— cmd /c 立即模式下 & 链里的 %VAR% 在**执行前**就全展开完，
  //    导致 %CD% 是旧目录、%ERRORLEVEL% 拿不到（实测 %EC% 直接输出字面量）
  //  · 先 set 捕获 ERRORLEVEL，因为后面的 echo 会把它重置成 0
  const full = `${cmd} & set "EC=!ERRORLEVEL!" & echo PONKO_CWD:!CD! & echo PONKO_DONE:!EC!`;
  const p = spawn('cmd.exe', ['/V:ON', '/s', '/c', `"${full}"`], {
    cwd: curDir, windowsHide: true, windowsVerbatimArguments: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeProc = p;
  shState = 'busy';
  let buf = '', done = false, code = 0;
  const dec = new TextDecoder(cmdEnc);
  const timer = setTimeout(() => {
    if (!done) { done = true; try { p.kill(); } catch (e) {} onExit(-1, 'timeout'); }
  }, 60000);

  const feed = (s) => {
    buf += s;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      const mc = line.match(/^PONKO_CWD:(.*)$/);
      if (mc) { if (mc[1]) curDir = mc[1].trim(); onLine(curDir, 'cwd'); continue; }
      const md = line.match(/PONKO_DONE:(-?\d+)/);
      if (md) { code = Number(md[1]); return; }
      onLine(line, 'out');
    }
  };
  const flush = () => { if (buf.trim()) feed('\n'); };

  const onData = (c) => feed(dec.decode(c, { stream: true }));
  p.stdout.on('data', onData);
  p.stderr.on('data', onData);
  p.on('exit', () => {
    if (done) return;
    done = true; clearTimeout(timer); flush();
    activeProc = null; shState = 'idle';
    onExit(code, null);
  });
  p.on('error', (e) => {
    if (done) return;
    done = true; clearTimeout(timer); activeProc = null; shState = 'idle';
    onExit(-1, String(e && e.message || e));
  });
}

// 往持久会话写命令：必须走 base64（stdin 是 ANSI 编码，直接写中文会被解烂）
function pwshSend(psCmd) {
  if (!sh || !sh.stdin.writable) return;
  const b64 = Buffer.from(psCmd, 'utf8').toString('base64');
  sh.stdin.write(`Invoke-Expression ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("${b64}")))\n`);
}

function pwshCd(dir) {
  pwshSend(`Set-Location -LiteralPath "${String(dir).replace(/"/g, '`"')}" -ErrorAction SilentlyContinue`);
}

// 把一行命令拆成 argv（处理双/单引号），供 pty.startProgram 直接跑程序
function splitArgs(s) {
  const out = []; let cur = ''; let q = null;
  for (const ch of String(s)) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (ch === ' ' || ch === '\t') { if (cur) { out.push(cur); cur = ''; } }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// 命令分发：先处理 shell 切换 / 交互式拦截，再交给对应执行器
function runCommand(cmd, onLine, onExit) {
  const raw = String(cmd || '').trim();
  const tok0 = (raw.split(/\s+/)[0] || '').toLowerCase().replace(/^["']|["']$/g, '');
  const bare = tok0.replace(/\.(exe|com|bat|cmd)$/, '');
  const noArgs = raw.slice(tok0.length).trim() === '' || raw === tok0;

  // ── 切换 shell（裸 cmd / powershell）
  if (noArgs && (bare === 'cmd' || bare === 'powershell' || bare === 'pwsh')) {
    const want = bare === 'cmd' ? 'cmd' : 'pwsh';
    if (shellKind === want) {
      onLine(want === 'cmd' ? '已经在 CMD 模式了。输入 powershell 切回 PowerShell。'
        : '已经在 PowerShell 模式了。输入 cmd 切到 CMD。', 'info');
      return onExit(0, null);
    }
    shellKind = want;
    curDir = curDir || 'C:\\';
    if (want === 'pwsh') pwshCd(curDir);   // 把 CMD 期间改变的目录同步回持久会话
    onLine(shellKind, 'shell');
    onLine(want === 'cmd'
      ? '已切到 CMD 模式：cd 保持，但 set 的环境变量不跨命令保留。输入 powershell 或 exit 切回。'
      : '已切回 PowerShell 模式（持久会话，cd 和变量都保留）。', 'info');
    return onExit(0, null);
  }

  // ── exit：CMD 模式下等于退回 PowerShell
  if (noArgs && (bare === 'exit' || bare === 'quit')) {
    if (shellKind === 'cmd') {
      shellKind = 'pwsh';
      pwshCd(curDir);
      onLine(shellKind, 'shell');
      onLine('已退回 PowerShell 模式。', 'info');
      return onExit(0, null);
    }
    onLine('这是持久 PowerShell 会话，exit 会关掉整个会话。要退出程序请运行 stop.bat。', 'info');
    return onExit(0, null);
  }

  // ── 显式进入真终端：pty <cmd>
  if (bare === 'pty' || bare === '!pty') {
    const inner = raw.slice(tok0.length).trim() || 'powershell';
    const parts = splitArgs(inner);
    const first = (parts[0] || '').toLowerCase().replace(/^["']|["']$/g, '').replace(/\.(exe|com|bat|cmd)$/, '');
    const ptyOpts = { cwd: curDir,
      cols: Number(process.env.PONKO_PTY_COLS || 100), rows: Number(process.env.PONKO_PTY_ROWS || 30) };
    // 想要一个真终端（开 shell）→ 直接起 shell（不再在里面重复跑一遍同名 shell）；
    // 想把某个程序放真终端跑 → 直接跑，退出即回本 shell
    const isShell = first === 'pwsh' || first === 'powershell' || first === 'cmd';
    const p = isShell
      ? pty.start({ ...ptyOpts, shell: first === 'cmd' ? 'cmd' : 'pwsh' })
      : pty.startProgram(parts, ptyOpts);
    p.then((r) => { if (!r.ok) onLine('PTY 启动失败：' + (r.msg || '未知原因'), 'err'); });
    onLine('__pty__', 'pty');            // 通知前端：切到终端渲染模式
    return onExit(0, null);
  }

  // ── 交互式程序不再拦截，改开真终端（ConPTY）直接跑它 —— 这是"卡死"的正解
  // 直接在 PTY 里跑程序本身（不是先起一层 shell）：程序退出即 PTY 结束，自动回到当前 shell，
  // 不会让用户"莫名其妙掉进第二个 cmd/pwsh，还得再 exit 一次"。
  if (noArgs && REPL_BLOCK.has(bare)) {
    pty.startProgram([bare], { cwd: curDir,
      cols: Number(process.env.PONKO_PTY_COLS || 100), rows: Number(process.env.PONKO_PTY_ROWS || 30) })
      .then((r) => {
        if (!r.ok) {
          onLine('PTY 启动失败：' + (r.msg || '未知原因'), 'err');
          onLine(`带参数执行仍可用管道：${bare} script.py / ${bare} -c "..."`, 'info');
        }
      });
    onLine('__pty__', 'pty');
    return onExit(0, null);
  }
  // CMD 模式下裸 powershell 同理（不带参数就是进 REPL）
  if (shellKind === 'cmd' && noArgs && bare === 'powershell') { /* 上面已处理 */ }

  if (shellKind === 'cmd') return runCmdOnce(raw, onLine, onExit);
  return runPwsh(raw, onLine, onExit);
}

function runPwsh(cmd, onLine, onExit) {
  if (!sh) spawnShell();
  if (!sh.ready) { setTimeout(() => runPwsh(cmd, onLine, onExit), 120); return; }
  shState = 'busy';
  let done = false;
  const timer = setTimeout(() => {
    if (!done) {
      done = true; cleanup();
      // 超时多半是命令抢占了 stdin（会话已不可信），必须重建
      try { sh.kill(); } catch (e) {} sh = null; spawnShell();
      onExit(-1, 'timeout');
    }
  }, 60000);

  function onData(chunk) {
    shBuf += chunk;
    let idx;
    while ((idx = shBuf.indexOf('\n')) >= 0) {
      const line = shBuf.slice(0, idx).replace(/\r$/, '');
      shBuf = shBuf.slice(idx + 1);
      if (line.includes(SENTINEL)) {
        const m = line.match(/PONKO_DONE_9f3c:(-?\d+)/);
        if (!done) { done = true; cleanup(); onExit(m ? Number(m[1]) : 0, null); }
        return;
      }
      const cwd = line.match(/^PONKO_CWD:(.*)$/);
      if (cwd) { if (cwd[1]) curDir = cwd[1]; if (!done) onLine(curDir, 'cwd'); return; }
      if (!done) onLine(line, 'out');
    }
  }
  function onErr(chunk) {
    shBuf += chunk; // stderr 与 stdout 交错，统一按行处理
    onData('');
  }
  function cleanup() {
    clearTimeout(timer);
    if (sh) { sh.stdout.off('data', onData); sh.stderr.off('data', onErr); }
    shState = 'idle';
  }

  sh.stdout.on('data', onData);
  sh.stderr.on('data', onErr);
  // 命令经 base64 传入（绕开 stdin 的 ANSI 编码），PowerShell 侧解码后执行
  pwshSend(cmd);
  // 顺带回传当前目录，前端提示符才能跟着 cd 变
  sh.stdin.write('Write-Output "PONKO_CWD:$((Get-Location).Path)"\n');   // 纯 ASCII，可直接写
  sh.stdin.write(`Write-Output "${SENTINEL}:$LASTEXITCODE"\n`);
}

function killCommand() {
  if (shellKind === 'cmd') {
    if (activeProc) { try { activeProc.kill(); } catch (e) {} activeProc = null; shState = 'idle'; return true; }
    return false;
  }
  if (sh && shState === 'busy') {
    try { sh.kill(); } catch (e) {}
    spawnShell();
    shState = 'idle';
    return true;
  }
  return false;
}

// ─────────────────────────────── 假 agent（后续替换成真 LLM 调用）
//
// 关键约定：**心情由 agent 自己在正文里声明**，格式 [[mood:STATE|face:标签|i:强度|note:自述]]。
// 所以这里模拟的是"一个会自我标注情绪的 LLM 输出"——整段正文交给 streamAgent 原样切片，
// 标记由 moodp.parseInline 剥离。换真 LLM 时，只要把 fakeAgentBody 换成模型输出即可，
// 前端/主题/角色链路一行都不用改。

const DEFAULT_STATE_INTENSITY = { idle: 0.45, think: 0.6, stream: 0.8, sleepy: 0.2, error: 0.7 };

function fakeAgentBody(text) {
  const lower = String(text || '').toLowerCase();
  const wantsShell = /失败|报错|error|构建|build|为什么|查|看|跑|运行|错/.test(lower);

  if (wantsShell) {
    return [
      '[[mood:think|face:thinking|i:0.55|note:先别急着下结论，看现场]]\n',
      '判断需要先看真实输出，而不是凭印象猜。\n',
      '[[mood:error|face:error|i:0.7|note:这个报错有点难缠]]\n',
      '日志里确实有异常，我盯一会儿。\n',
      '[[mood:stream|face:thinking|i:0.8|note:有线索了，先说结论]]\n',
      '问题不在你的代码里。\n\n',
      'AGP 的 path check 在解析中文路径时会直接抛错，这是已知的 AGP 行为。\n\n',
      '两条路：\n',
      '1. 把工程复制到纯 ASCII 目录（比如 C:\\NetGateBuild）再构建，最干净；\n',
      '2. 在 gradle.properties 加 android.overridePathCheck=true，绕过检查。\n\n',
      '[[mood:idle|face:idle|i:0.5|note:我建议方案 1，方案 2 迟早失效]]\n',
      '我推荐方案 1 ——方案 2 是 experimental 开关，将来可能失效。',
    ].join('');
  }

  return [
    '[[mood:think|face:thinking|i:0.55|note:这话里有两层意思]]\n',
    '[[mood:stream|face:streaming|i:0.75|note:捋一下再说]]\n',
    '我理解你要的是两件事：\n\n',
    '一是界面自己画字符网格，而不是套一个真终端；\n',
    '二是我这边的内部状态要能直接决定角色表情，而不是前端替我猜。\n\n',
    '第二点现在已经成立了——心情是我自己在输出里声明的，前端只是执行器。\n',
    '[[mood:idle|face:idle|i:0.45|note:剩下的就是把真 LLM 接进来]]\n',
    '剩下要做的，只是把这里换成真的模型调用。',
  ].join('');
}

/** 把整段正文切成 2-4 字的流式片段（真 LLM 的 token 也会切碎行内标记，故下游需缓冲还原） */
function toChunks(body) {
  const out = [];
  let i = 0;
  while (i < body.length) {
    const n = 2 + Math.floor(Math.random() * 3);
    out.push(body.slice(i, i + n));
    i += n;
  }
  return out;
}

async function streamAgent(res, text, history) {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Transfer-Encoding': 'chunked',
    'X-Accel-Buffering': 'no',
  });
  const emit = (obj) => res.write(JSON.stringify(obj) + '\n');

  // 已配置真 LLM → 走真模型；否则走内置假 agent（演示用，界面逻辑完全一致）
  if (llmCfg.configured) { await callRealLLM(res, emit, text, history); res.end(); return; }

  // 真 LLM 的 token 会随意切开 [[mood:...]]，交给解析器跨片段还原
  const parser = new moodp.MoodStreamParser(facesFromPacks());
  const trimLead = makeLeadTrimmer();

  const chunks = toChunks(fakeAgentBody(text));
  let tokens = 0, lastMood = null;
  for (const raw of chunks) {
    const taken = parser.feed(raw);
    for (const m of taken.moods) { lastMood = m; emit({ t: 'mood', ...m, src: 'agent' }); }
    const s = trimLead(taken.text);
    if (s) { emit({ t: 'token', text: s }); tokens++; }
    await new Promise((r) => setTimeout(r, 18 + Math.floor(Math.random() * 30)));
  }
  const tail = parser.flush();                  // 收尾：冲刷缓冲里的半截标记
  for (const m of tail.moods) { lastMood = m; emit({ t: 'mood', ...m, src: 'agent' }); }
  const ts = trimLead(tail.text);
  if (ts) { emit({ t: 'token', text: ts }); tokens++; }
  emit({ t: 'done', tokens: Math.max(1, Math.ceil(tokens / 1.6)), mood: lastMood || undefined });
  res.end();
}

/**
 * 流式正文的开头空白裁剪器。
 * 模型惯用的写法是先在正文前甩一个 [[mood:...]]、再换行两次才开始说正事：
 *     [[mood:think|note:想想]]\n\n正文……
 * 标记被解析器剥掉之后，那两个换行就原封不动地留在了回复最前面 ——
 * 用户看到的就是"每次回答开头都空两行"。这里把正文真正开始之前的空白全部吃掉，
 * 只在开头生效一次，正文中间的换行/缩进原样保留。
 */
function makeLeadTrimmer() {
  let started = false;
  return (s) => {
    if (!s) return '';
    if (started) return s;
    const t = s.replace(/^[\s\u3000]+/, '');
    if (!t) return '';            // 还没真正开始说话，这段空白整个丢掉
    started = true;
    return t;
  };
}

// 把前端送来的近期对话整理成 LLM 的消息数组（不含 system、不含本次提问）。
// 三个坑：
//   ① 角色名要映射：前端的 'agent' → assistant；system 走单独字段不入列；
//      未知角色一律当 user，免得部分服务对着非法 role 直接 400。
//   ② 历史末尾若已经躺着一条和本次提问一模一样的 user（前端没排干净 / 重发），要剔掉，
//      否则同一次提问被发两遍。
//   ③ 窗口要够宽：10 条只有 5 轮，聊几轮前面的就忘了。
const MAX_HISTORY_MSGS = 20;                  // 约 10 轮
function buildHistory(history, text) {
  const out = [];
  const cur = String(text || '').trim();
  const src = Array.isArray(history) ? history.slice(-MAX_HISTORY_MSGS) : [];
  for (const m of src) {
    if (!m || !m.content) continue;
    const content = String(m.content).trim();
    if (!content) continue;
    let role = m.role === 'agent' ? 'assistant' : m.role;
    if (role === 'system') continue;
    if (role !== 'user' && role !== 'assistant') role = 'user';
    out.push({ role, content });
  }
  while (out.length && out[out.length - 1].role === 'user' && out[out.length - 1].content === cur) out.pop();
  return out;
}

// 真 LLM（SSE 流式）。两套协议：OpenAI 兼容 /chat/completions 与 Anthropic 原生 /messages。
// 心情标记 [[mood:...]] 仍由原解析器处理，所以真模型只要按协议在正文里声明情绪，
// 前端/角色链路一行都不用改。
async function callRealLLM(res, emit, text, history) {
  if (activeProvider() === 'anthropic') { await callAnthropic(res, emit, text, history); return; }
  const base = (llmCfg.baseUrl || '').replace(/\/+$/, '');
  if (!base) { emit({ t: 'error', text: 'LLM 未配置：缺少 API 地址' }); return; }
  const url = base.replace(/\/v1$/, '') + '/v1/chat/completions';   // 兼容带或不带 /v1 的地址
  const sys = moodp.buildSystemPrompt(facesFromPacks());
  const messages = [{ role: 'system', content: sys }, ...buildHistory(history, text)];
  messages.push({ role: 'user', content: text });

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + llmCfg.apiKey },
      body: JSON.stringify({ model: llmCfg.model || 'gpt-3.5-turbo', stream: true, messages, temperature: 0.7 }),
    });
  } catch (e) { emit({ t: 'error', text: '连不上 LLM：' + e.message }); return; }
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.text()).slice(0, 240); } catch (e) {}
    emit({ t: 'error', text: `LLM 返回 ${resp.status}：${detail}` });
    return;
  }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '', tokens = 0, lastMood = null;
  const parser = new moodp.MoodStreamParser(facesFromPacks());
  const trimLead = makeLeadTrimmer();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j; try { j = JSON.parse(data); } catch (e) { continue; }
        const delta = j.choices && j.choices[0] && j.choices[0].delta ? (j.choices[0].delta.content || '') : '';
        if (!delta) continue;
        const taken = parser.feed(delta);
        for (const m of taken.moods) { lastMood = m; emit({ t: 'mood', ...m, src: 'agent' }); }
        const s = trimLead(taken.text);
        if (s) { emit({ t: 'token', text: s }); tokens++; }
      }
    }
  } catch (e) { emit({ t: 'error', text: '读取 LLM 流失败：' + e.message }); }
  const tail = parser.flush();
  for (const m of tail.moods) { lastMood = m; emit({ t: 'mood', ...m, src: 'agent' }); }
  const ts = trimLead(tail.text);
  if (ts) { emit({ t: 'token', text: ts }); tokens++; }
  emit({ t: 'done', tokens: Math.max(1, tokens), mood: lastMood || undefined });
}

// Anthropic 原生（Claude）：POST /v1/messages，x-api-key 头，SSE 事件是
// content_block_delta{ delta:{ type:'text_delta', text } }，跟 OpenAI 的 choices[0].delta 不是一回事。
// 两个 Anthropic 特有的坑：system 必须单独字段（不能塞进 messages）；
// user/assistant 必须严格交替（连续同角色要合并），否则 400。
async function callAnthropic(res, emit, text, history) {
  const base = (llmCfg.baseUrl || '').replace(/\/+$/, '');
  if (!base) { emit({ t: 'error', text: 'LLM 未配置：缺少 API 地址' }); return; }
  const url = base.replace(/\/v1$/, '') + '/v1/messages';
  const sys = moodp.buildSystemPrompt(facesFromPacks());

  const raw = [...buildHistory(history, text), { role: 'user', content: text }];
  // 合并连续同角色 + 保证首条是 user（Anthropic 要求严格交替，否则 400）
  const messages = [];
  for (const m of raw) {
    const prev = messages[messages.length - 1];
    if (prev && prev.role === m.role) prev.content += '\n' + m.content;
    else messages.push({ role: m.role, content: m.content });
  }
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length) messages.push({ role: 'user', content: text });

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'x-api-key': llmCfg.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: llmCfg.model || 'claude-3-5-sonnet-latest',
        max_tokens: 1024,
        system: sys,
        messages,
        stream: true,
      }),
    });
  } catch (e) { emit({ t: 'error', text: '连不上 LLM：' + e.message }); return; }
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.text()).slice(0, 240); } catch (e) {}
    emit({ t: 'error', text: `LLM 返回 ${resp.status}：${detail}` });
    return;
  }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '', tokens = 0, lastMood = null;
  const parser = new moodp.MoodStreamParser(facesFromPacks());
  const trimLead = makeLeadTrimmer();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j; try { j = JSON.parse(data); } catch (e) { continue; }
        let delta = '';
        if (j.type === 'content_block_delta' && j.delta && typeof j.delta.text === 'string') delta = j.delta.text;
        else if (j.type === 'message_delta' && j.delta && typeof j.delta.text === 'string') delta = j.delta.text;
        if (j.type === 'error' && j.error && j.error.message) { emit({ t: 'error', text: String(j.error.message).slice(0, 200) }); }
        if (!delta) continue;
        const taken = parser.feed(delta);
        for (const m of taken.moods) { lastMood = m; emit({ t: 'mood', ...m, src: 'agent' }); }
        const s = trimLead(taken.text);
        if (s) { emit({ t: 'token', text: s }); tokens++; }
      }
    }
  } catch (e) { emit({ t: 'error', text: '读取 LLM 流失败：' + e.message }); }
  const tail = parser.flush();
  for (const m of tail.moods) { lastMood = m; emit({ t: 'mood', ...m, src: 'agent' }); }
  const ts = trimLead(tail.text);
  if (ts) { emit({ t: 'token', text: ts }); tokens++; }
  emit({ t: 'done', tokens: Math.max(1, tokens), mood: lastMood || undefined });
}

/** 当前所有素材包的表情标签（给 LLM 的 system 提示词用） */
function facesFromPacks() {
  const out = new Set();
  for (const p of listCharpacks()) for (const t of Object.keys(p.moods || {})) out.add(t);
  return [...out].sort();
}

// ─────────────────────────────── 素材包
function listCharpacks() {
  const out = [];
  if (!fs.existsSync(CHARS)) return out;
  for (const d of fs.readdirSync(CHARS)) {
    const dir = path.join(CHARS, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    const packPath = path.join(dir, 'frames', 'pack.json');
    if (!fs.existsSync(packPath)) continue;
    try {
      const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
      out.push({ id: d, ...pack, base: `/characters/${d}/frames/` });
    } catch (e) { /* 坏包跳过 */ }
  }
  return out;
}

// ─────────────────────────────── 路由
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname);

  try {
    if (p === '/api/sys') return sendJson(res, sysinfo.snapshot());
    // shell 当前状态（前端面板启动时拉一次，避免首屏用写死的 C:\）
    if (p === '/api/shell/state') return sendJson(res, { cwd: curDir, shell: shellKind });
    // LLM 接入配置：GET 拿当前（不回传明文 key），POST 保存（写 llm-config.json）
    if (p === '/api/llm/config' && req.method === 'GET') return sendJson(res, publicLlmCfg());
    if (p === '/api/llm/config' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      return sendJson(res, saveLlmCfg(body));
    }
    // LLM 连通性验证：真的打一次远端接口，前端据此决定要不要落盘
    if (p === '/api/llm/test' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      return sendJson(res, await testLlm(body));
    }
    if (p === '/api/charpacks') return sendJson(res, listCharpacks());

    // 心情协议：state 枚举 + 素材包可用表情 + 可直接塞给 LLM 的 system 提示词
    if (p === '/api/mood/protocol') {
      const faces = facesFromPacks();
      return sendJson(res, {
        states: moodp.STATES,
        stateKeys: moodp.STATE_KEYS,
        faces,
        tags: moodp.TAG_RE.source,
        systemPrompt: moodp.buildSystemPrompt(faces),
      });
    }
    if (p === '/api/netgeo') return sendJson(res, await netgeo.netgeo(u.searchParams.get('refresh') === '1'));

    // 单个 IP 的地理位置（shell 输出里扫到 IP 时在地球上打标记用）
    if (p === '/api/geo') {
      const ip = u.searchParams.get('ip') || '';
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return sendJson(res, { ip, none: true });
      if (netgeo.isPrivate(ip)) return sendJson(res, { ip, private: true });
      const map = await netgeo.geoMany([ip]);
      return sendJson(res, map[ip] || { ip, none: true });
    }

    if (p === '/api/shell' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (body.abort) return sendJson(res, { aborted: killCommand() });
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Transfer-Encoding': 'chunked',
      });
      // 先把当前 shell 类型 + 真实工作目录同步给前端（前端默认写的 C:\ 是错的，
      // 真实会话起始在 USERPROFILE；命令执行后还会再发一次 cwd 反映 cd 结果）
      res.write(JSON.stringify({ t: 'shell', text: shellKind }) + '\n');
      res.write(JSON.stringify({ t: 'cwd', text: curDir }) + '\n');
      runCommand(body.cmd || '',
        (line, kind) => res.write(JSON.stringify({ t: kind, text: line }) + '\n'),
        (code, err) => { res.write(JSON.stringify({ t: 'exit', code, error: err }) + '\n'); res.end(); });
      return;
    }

    if (p === '/api/agent' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      return await streamAgent(res, body.text || '', body.history || []);
    }

    // ── PTY：真终端会话（交互式程序专用）
    if (p === '/api/pty' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      if (b.op === 'start') {
        const r = await pty.start({ shell: b.shell, cwd: b.cwd || curDir,
          cols: b.cols || 100, rows: b.rows || 30 });
        return sendJson(res, { ok: r.ok, msg: r.msg || '', error: pty.lastError || '' });
      }
      if (b.op === 'write') { pty.write(b.text || ''); return sendJson(res, { ok: true }); }
      if (b.op === 'resize') { pty.resize(b.cols || 100, b.rows || 30); return sendJson(res, { ok: true }); }
      if (b.op === 'stop') { pty.stop(); return sendJson(res, { ok: true }); }
      return sendJson(res, { ok: false, msg: 'unknown op' });
    }

    // 终端输出流：NDJSON 长连接（out / exit / error）
    if (p === '/api/pty/stream') {
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Transfer-Encoding': 'chunked',
        'X-Accel-Buffering': 'no',
      });
      // 订阅前已经吐出来的内容要补上（前端可能晚几百毫秒才连上来）
      const subGen = pty.gen;                        // 只收当前这代会话的事件
      if (pty.backlogText()) {
        res.write(JSON.stringify({ t: 'out', text: pty.backlogText(), backlog: true }) + '\n');
      }
      res.write(JSON.stringify({ t: 'status', running: pty.running }) + '\n');
      const off = pty.on((ev) => {
        if (ev.gen !== undefined && ev.gen !== subGen) return;   // 旧会话残响（如被顶掉时的 exit），不投递
        const out = { t: ev.t, code: ev.code, reason: ev.reason, msg: ev.msg, text: ev.text };
        try { res.write(JSON.stringify(out) + '\n'); } catch (e) { /* 连接已断 */ }
        if (ev.t === 'exit') { try { res.end(); } catch (e) {} }
      });
      req.on('close', off);
      return;
    }

    if (p === '/api/pty/status') {
      return sendJson(res, { running: pty.running, shell: pty.shell, error: pty.lastError || '' });
    }

    // 静态文件
    let file = p === '/' ? '/index.html' : p;
    let full = path.normalize(path.join(APP, file));
    if (file.startsWith('/characters/')) full = path.normalize(path.join(ROOT, file));
    if (!full.startsWith(APP) && !full.startsWith(CHARS)) return send(res, 403, 'forbidden');

    fs.stat(full, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, 'not found: ' + file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(full).pipe(res);
    });
  } catch (e) {
    sendJson(res, { error: String(e && e.message || e) }, 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Ponko HUD backend  http://127.0.0.1:${PORT}/`);
  netgeo.netgeo().catch(() => {});        // 预热：外部地理查询要几秒，别让首次点开地球时干等
});
