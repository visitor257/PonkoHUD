'use strict';

// PTY 会话管理：拉起 server/ptybridge.py（ConPTY），用 stdio 上的 JSON lines 通信。
//
// 存在的理由：Node 标准库没有 PTY，而"交互式程序卡死"的根因就是持久 PowerShell
// 的 stdin 是管道不是终端。这里负责桥进程的生命周期与事件分发，不碰编码。
const { spawn } = require('child_process');
const path = require('path');

const BRIDGE = path.join(__dirname, 'ptybridge.py');
const PY = process.env.PONKO_PY || 'python';

class PtySession {
  constructor(id = '0') {
    this.id = id;              // 会话 id = 前端那个标签的 id，日志/调试用
    this.proc = null;
    this.running = false;
    this.gen = 0;              // 会话代际：每次 start 自增，用于隔离旧会话的残响事件
    this.shell = 'pwsh';
    this.cols = 80;
    this.rows = 24;
    this._waiters = [];
    this._subs = new Set();
    this._buf = '';
    this.lastError = '';
    this._backlog = '';        // 前端订阅前的输出要能补上，否则启动横幅/首屏丢了
  }

  backlogText() { return this._backlog; }

  on(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  _emit(ev) {
    if (ev.t === 'out') {
      // 只把"当前这代会话"的输出攒进 backlog。被顶掉的旧桥临死前还会吐几帧
      // （它的 stdout 监听还挂着），若收进 backlog，新终端一上来就会凭空多出
      // 上一段会话的残影 —— 前端也会误以为它已经就绪。
      if (ev.gen === undefined || ev.gen === this.gen) {
        this._backlog += ev.text || '';
        if (this._backlog.length > 400000) this._backlog = this._backlog.slice(-200000);
      }
    }
    for (const fn of this._subs) {
      try { fn(ev); } catch (e) { /* 订阅者自己的锅 */ }
    }
  }

  /** PowerShell 启动后按 shell 类型发初始化（直接跑程序时无 shell，跳过） */
  _sendInit() {
    if (this.shell !== 'pwsh' && this.shell !== 'cmd') return;
    setTimeout(() => {
      if (this.proc && this.running) {
        // 结尾只用 \r（Enter）。用 \r\n 时多出的 \n 会被误当续行。
        // 命令本身也必须匹配 shell：CMD 不认 PowerShell 语法（会报“语法不正确”）。
        this.write(this.shell === 'cmd'
          ? 'chcp 65001 >nul & cls\r'
          : '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Clear-Host\r');
      }
    }, 300);
  }

  /** 启动后等 shell 就绪，再把命令喂进真终端（交互式程序专用） */
  async startAndRun(cmd, opts = {}) {
    const r = await this.start(opts);
    if (!r.ok) return r;
    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; off(); resolve(); } };
      const off = this.on((ev) => { if (ev.t === 'ready' && ev.gen === this.gen) setTimeout(done, 1300); });
      setTimeout(done, 5000);            // 兜底，别让请求挂死
    });
    this.write(String(cmd) + '\r');
    return r;
  }

  /**
   * 直接在 PTY 里跑一个程序（argv 数组），不先起 shell。
   * 程序退出 = PTY 结束 = 前端自动回到上层 shell（不会留一层多余 shell）。
   */
  startProgram(argv, opts = {}) {
    return this.start({ ...opts, argv });
  }

  /** @returns {Promise<{ok:boolean,msg?:string}>} */
  start(opts = {}) {
    const useArgv = Array.isArray(opts.argv) && opts.argv.length > 0;
    const shell = useArgv ? '' : (opts.shell === 'cmd' ? 'cmd' : 'pwsh');
    const cols = Math.max(10, Math.min(400, opts.cols || 80));
    const rows = Math.max(4, Math.min(200, opts.rows || 24));
    this.cols = cols;
    this.rows = rows;
    this.shell = shell;
    this._backlog = '';

    if (this.proc && this.running) this._kill();
    this.gen++;                          // 新会话开始：旧会话之后吐的 exit 都带着旧 gen，不会再误杀新订阅者
    const gen = this.gen;

    let proc;
    try {
      proc = spawn(PY, [BRIDGE], {
        cwd: path.resolve(__dirname, '..'),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      return Promise.resolve({ ok: false, msg: '拉起 PTY 桥失败：' + e.message });
    }
    this.proc = proc;
    this.running = true;

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      this._buf += chunk;
      let nl;
      while ((nl = this._buf.indexOf('\n')) !== -1) {
        const line = this._buf.slice(0, nl).trim();
        this._buf = this._buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch (e) { continue; }
        if (ev.t === 'out') ev.text = Buffer.from(ev.d || '', 'base64').toString('utf8');
        ev.gen = gen;                                          // 事件归属到产生它的那代会话
        if (ev.t === 'exit' && this.proc === proc) this.running = false;
        if (ev.t === 'error') this.lastError = ev.msg || '';
        if (ev.t === 'ready' && this.proc === proc) this._sendInit();   // 桥就绪后统一发初始化，顺序可控
        this._emit(ev);
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => { this.lastError = String(d).slice(0, 400); });
    proc.on('exit', () => {
      // 只有当前会话的桥退出才清状态；被顶掉的旧桥退出时不能动新会话的 proc/running
      if (this.proc === proc) { this.running = false; this.proc = null; }
      this._emit({ t: 'exit', code: 0, reason: 'bridge-gone', gen });
    });

    // 启动桥：argv 模式直接跑程序；否则起 shell
    const startOp = { op: 'start', cwd: opts.cwd || undefined, cols, rows };
    if (useArgv) startOp.argv = opts.argv;
    else startOp.shell = shell;
    this._send(startOp);
    return Promise.resolve({ ok: true });
  }

  _send(obj) {
    if (!this.proc) return;
    try {
      this.proc.stdin.write(JSON.stringify(obj) + '\n');
    } catch (e) { /* 桥已走 */ }
  }

  write(text) {
    if (!this.proc || !this.running) return false;
    this._send({ op: 'write', d: Buffer.from(String(text), 'utf8').toString('base64') });
    return true;
  }

  resize(cols, rows) {
    if (!this.proc) return;
    this.cols = cols;
    this.rows = rows;
    this._send({ op: 'resize', cols, rows });
  }

  _kill() {
    const p = this.proc;
    this.proc = null;
    this.running = false;
    if (!p) return;
    try { p.stdin.write(JSON.stringify({ op: 'quit' }) + '\n'); } catch (e) { /* noop */ }
    setTimeout(() => { try { p.kill(); } catch (e) { /* noop */ } }, 800);
  }

  stop() {
    const gen = this.gen;
    this._kill();
    this._emit({ t: 'exit', code: 0, reason: 'stopped', gen });
  }
}

// ── 会话表：一个标签 = 一个 PtySession ───────────────────────────────────
// 以前这里导出的是**唯一**那个实例；现在按 id 存取，默认会话仍叫 '0'，
// 所以只用一个 shell 的老路径（不带 session 参数的请求）行为不变。
const ID_RE = /^[A-Za-z0-9_-]{1,24}$/;
const MAX_SESSIONS = 12;

/** 把任意输入规整成合法会话 id；非法/空值一律落到默认会话 '0' */
function normSession(id) {
  const s = String(id === undefined || id === null ? '' : id);
  return ID_RE.test(s) ? s : '0';
}

const sessions = new Map();

/** 取会话；create=false 时只查不建（status/stream 这类只读路径不该凭空造会话） */
function getSession(id, create = true) {
  const k = normSession(id);
  let s = sessions.get(k);
  if (!s && create) {
    if (sessions.size >= MAX_SESSIONS) return null;
    s = new PtySession(k);
    sessions.set(k, s);
  }
  return s || null;
}

/** 关掉并移除一个会话（含其子进程），最后一个标签关掉时前端会调它 */
function dropSession(id) {
  const k = normSession(id);
  const s = sessions.get(k);
  if (!s) return false;
  try { s.stop(); } catch (e) { /* 桥可能已经走了 */ }
  sessions.delete(k);
  return true;
}

function listSessions() {
  return [...sessions.values()].map((s) => ({
    id: s.id, running: s.running, shell: s.shell, error: s.lastError || '',
  }));
}

const defaultSession = getSession('0');

module.exports = {
  pty: defaultSession, PtySession,
  getSession, dropSession, listSessions, normSession, MAX_SESSIONS,
};
