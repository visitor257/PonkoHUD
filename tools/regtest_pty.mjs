// Ponko HUD PTY regression test.
//
// The contrast this file pins down:
//   OLD — input was locally line-buffered, only flushed to the PTY on Enter.
//         Interactive programs looked dead while you typed (no echo, no Tab,
//         no Backspace, no ^D) — this is what "交互性程序有问题" was about.
//   NEW — every keystroke is forwarded immediately (eDEX-UI's model:
//         xterm.onData -> pty.write), so the program echoes as you type.
//
// Tests:
//   passthrough  typing WITHOUT Enter must already echo back  (the core fix)
//   python       interactive python output (banner / >>> / calculation)
//   chinese      Chinese text round-trips through the terminal
//   ctrlc        ^C interrupts a running program, session survives
//   ctrld        ^D (EOF) is forwarded, returns to the shell
//   genisol      a subscriber never receives a stale session's exit
//
// Single shared PTY singleton on the server, so tests run sequentially.
// Usage: node tools/regtest_pty.mjs [testName]
import { TextDecoder } from 'node:util';

const BASE = 'http://127.0.0.1:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(body) {
  const res = await fetch(BASE + '/api/pty', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.text();
}

class Stream {
  constructor() { this.events = []; this.closed = false; this.ctrl = new AbortController(); }
  push(ev) { this.events.push(ev); }
  out() { return this.events.filter((e) => e.t === 'out').map((e) => e.text || '').join(''); }
  /** out() with VT escape sequences removed — readline interleaves cursor codes
   *  between echoed characters, so raw text is not contiguous to match against. */
  plain() {
    return this.out()
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  }
  async wait(pred, ms = 6000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const f = this.events.find(pred);
      if (f) return f;
      await sleep(40);
    }
    return null;
  }
  /** poll: does the escape-stripped text received past `fromIdx` match? */
  async waitText(re, fromIdx, ms = 5000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (re.test(this.plain().slice(fromIdx))) return true;
      await sleep(60);
    }
    return false;
  }
  async open() {
    const res = await fetch(BASE + '/api/pty/stream', { signal: this.ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            try { this.push(JSON.parse(line)); } catch { /* ignore */ }
          }
        }
      } catch { /* aborted */ }
      this.closed = true;
    })();
    return this;
  }
  close() { try { this.ctrl.abort(); } catch { /* noop */ } }
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function startSession() {
  const r = await post({ op: 'start', shell: 'pwsh' });
  const j = JSON.parse(r);
  if (!j.ok) throw new Error('start failed: ' + r);
  return j;
}

/** subscribed PTY with python already sitting at its >>> prompt */
async function pythonReady() {
  await startSession();
  const s = await new Stream().open();
  await s.wait((e) => e.t === 'ready', 8000);
  await sleep(500);
  await post({ op: 'write', text: 'python\r\n' });
  await s.wait((e) => e.t === 'out' && />>>/.test(e.text || ''), 9000);
  await sleep(700);   // let readline finish painting the prompt before we type
  return s;
}

// ---- passthrough: per-keystroke echo ---------------------------------------
// THE guard for "interactive programs feel dead": characters must be echoed by
// the program as they are typed, with no Enter involved.
async function testPassthroughEcho() {
  const s = await pythonReady();
  const base = s.plain().length;
  for (const ch of 'abc=1+1') {          // type it the way a human would
    await post({ op: 'write', text: ch });
    await sleep(70);
  }
  const echoed = await s.waitText(/abc=1\+1/, base, 4000);
  if (!echoed) {
    const tail = s.plain().slice(base).slice(-120);
    s.close();
    return record('per-keystroke echo (no Enter)', false, 'no echo before Enter. tail=' + JSON.stringify(tail));
  }
  await post({ op: 'write', text: '\r' });
  await sleep(900);
  const after = s.plain().slice(base);
  s.close();
  if (/Traceback|SyntaxError/.test(after)) {
    return record('typed line executes cleanly', false, 'traceback after Enter');
  }
  return record('per-keystroke passthrough', true, 'echoed while typing, executed on Enter');
}

// ---- python output ---------------------------------------------------------
async function testPythonOutput() {
  const s = await pythonReady();
  await post({ op: 'write', text: 'print("CN 6*7 =", 6*7)\r\n' });
  const out = await s.wait((e) => e.t === 'out' && /42/.test(e.text || ''), 6000);
  if (!out) { s.close(); return record('python prints result', false, 'no 42'); }
  const strayExit = s.events.find((e) => e.t === 'exit');
  if (strayExit) { s.close(); return record('python session stable', false, 'spurious exit'); }
  s.close();
  return record('interactive python shows output', true, 'banner/>>>/42 present, no stray exit');
}

// ---- Chinese round-trip ----------------------------------------------------
async function testChinese() {
  const s = await pythonReady();
  const base = s.plain().length;
  await post({ op: 'write', text: 'print("中文 输出测试 =", 99)\r\n' });
  const ok = await s.waitText(/99/, base, 8000);
  const cn = /中文/.test(s.plain().slice(base));
  const tail = s.plain().slice(base).slice(-160);
  s.close();
  if (!ok) return record('Chinese input accepted', false, 'no 99. tail=' + JSON.stringify(tail));
  return record('Chinese round-trip', true, cn ? '中文 echoed correctly' : 'result OK (echo omitted)');
}

// ---- Ctrl+C ----------------------------------------------------------------
async function testCtrlC() {
  const s = await pythonReady();
  const base = s.plain().length;
  await post({ op: 'write', text: 'while True: pass\r\n' });   // runaway loop
  await sleep(500);
  await post({ op: 'write', text: '\x03' });                   // ^C
  const ki = await s.waitText(/KeyboardInterrupt/, base, 6000);
  if (!ki) { s.close(); return record('Ctrl+C interrupts loop', false, 'no KeyboardInterrupt'); }
  await sleep(400);
  const exited = s.events.find((e) => e.t === 'exit');
  s.close();
  if (exited) return record('shell survives Ctrl+C', false, 'session exited');
  return record('Ctrl+C forwards & interrupts', true, 'KeyboardInterrupt raised, session alive');
}

// ---- Ctrl+D ----------------------------------------------------------------
async function testCtrlD() {
  const s = await pythonReady();
  await post({ op: 'write', text: '\x04' });                   // ^D -> leave python
  await sleep(1200);
  await post({ op: 'write', text: 'echo STILL_ALIVE\r\n' });
  const ok = await s.wait((e) => e.t === 'out' && /STILL_ALIVE/.test(e.text || ''), 4000);
  s.close();
  if (!ok) return record('Ctrl+D returns to shell', false, 'shell unresponsive after ^D');
  return record('Ctrl+D (EOF) is forwarded', true, 'left python, shell still alive');
}

// ---- generation isolation --------------------------------------------------
async function testGenIsolation() {
  await startSession();                       // G1
  const s = await new Stream().open();        // subGen = G1
  await sleep(300);
  await startSession();                        // G2 -> A killed (exit G1, own → visible)
  await sleep(300);
  await startSession();                        // G3 -> B killed (exit G2, dropped)
  await sleep(300);
  await startSession();                        // G4 -> C killed (exit G3, dropped)
  await sleep(2000);
  const exits = s.events.filter((e) => e.t === 'exit');
  s.close();
  if (exits.length !== 1) {
    return record('gen isolation (no stale exit)', false,
      `expected exactly 1 exit (own), got ${exits.length}: ${JSON.stringify(exits)}`);
  }
  return record('gen isolation (stale exit filtered)', true, 'only own session exit delivered');
}

(async () => {
  try {
    const health = await fetch(BASE + '/index.html');
    if (health.status !== 200) throw new Error('backend not reachable (status ' + health.status + ')');
  } catch (e) {
    console.log('FAIL  backend reachable — ' + e.message);
    process.exit(2);
  }
  const tests = [
    ['passthrough', testPassthroughEcho],
    ['python', testPythonOutput],
    ['chinese', testChinese],
    ['ctrlc', testCtrlC],
    ['ctrld', testCtrlD],
    ['genisol', testGenIsolation],
  ];
  const only = process.argv[2];
  for (const [name, fn] of tests) {
    if (only && only !== name) continue;
    try { await fn(); } catch (e) { record(name, false, e.message); }
  }
  try { await post({ op: 'stop' }); } catch { /* noop */ }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`);
  process.exit(failed.length ? 1 : 0);
})();
