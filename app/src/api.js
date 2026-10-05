// 后端接口封装（流式接口用 NDJSON 逐行解析）

export async function sysSnapshot() {
  const r = await fetch('/api/sys');
  if (!r.ok) throw new Error('sys ' + r.status);
  return r.json();
}

export async function netgeo() {
  const r = await fetch('/api/netgeo');
  if (!r.ok) throw new Error('netgeo ' + r.status);
  return r.json();
}

export async function geoLookup(ip) {
  const r = await fetch('/api/geo?ip=' + encodeURIComponent(ip));
  if (!r.ok) throw new Error('geo ' + r.status);
  return r.json();
}

function stream(url, body, onEvent, onEnd) {
  const ctrl = new AbortController();
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  }).then(async (res) => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.trim()) {
          try { onEvent(JSON.parse(line)); } catch (e) { /* 坏行忽略 */ }
        }
      }
    }
    if (onEnd) onEnd();
  }).catch((e) => { if (e.name !== 'AbortError') onEvent({ t: 'error', text: String(e.message) }); });
  return () => ctrl.abort();
}

export const runShell = (cmd, onEvent, onEnd) => stream('/api/shell', { cmd }, onEvent, onEnd);
export const askAgent = (text, onEvent, onEnd, history) => stream('/api/agent', { text, history: history || [] }, onEvent, onEnd);

// ── LLM 接入配置（前端配置框用）
export const getLlmConfig = () => fetch('/api/llm/config')
  .then((r) => r.json()).catch(() => ({ configured: false }));
export const saveLlmConfig = (cfg) => post('/api/llm/config', cfg);
// 连通性验证：真的打一次远端接口，返回 { ok, ms, model, via } 或 { ok:false, error }
export const testLlmConfig = (cfg) => fetch('/api/llm/test', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg || {}),
}).then((r) => r.json()).catch((e) => ({ ok: false, error: '请求后端失败：' + String(e.message) }));
export const abortShell = () => fetch('/api/shell', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ abort: true }),
});

// ── PTY（真终端）：交互式程序专用
function post(url, body) {
  return fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  }).then((r) => r.json()).catch(() => ({ ok: false }));
}

export const ptyStart = (opts) => post('/api/pty', { op: 'start', ...(opts || {}) });
export const ptyWrite = (text) => post('/api/pty', { op: 'write', text });
export const ptyResize = (cols, rows) => post('/api/pty', { op: 'resize', cols, rows });
export const ptyStop = () => post('/api/pty', { op: 'stop' });
export const ptyStatus = () => fetch('/api/pty/status').then((r) => r.json()).catch(() => ({ running: false }));

/** 订阅终端输出流（NDJSON 长连接） */
export function ptyStream(onEvent, onEnd) {
  const ctrl = new AbortController();
  fetch('/api/pty/stream', { signal: ctrl.signal }).then(async (res) => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.trim()) { try { onEvent(JSON.parse(line)); } catch (e) { /* 坏行忽略 */ } }
      }
    }
    if (onEnd) onEnd();
  }).catch((e) => { if (e.name !== 'AbortError' && onEnd) onEnd(); });
  return () => ctrl.abort();
}
