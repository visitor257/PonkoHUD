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
  constructor() {
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

  /** PowerShell 输出切 UTF-8 + 清屏（在任何用户命令之前，顺序由这里保证） */
  _sendInit() {
    setTimeout(() => {
      if (this.proc && this.running) {
        this.write('[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Clear-Host\r\n');
      }
    }, 300);
  }

  /** 启动后等 PowerShell 就绪，再把命令喂进真终端（交互式程序专用） */
  async startAndRun(cmd, opts = {}) {
    const r = await this.start(opts);
    if (!r.ok) return r;
    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; off(); resolve(); } };
      const off = this.on((ev) => { if (ev.t === 'ready' && ev.gen === this.gen) setTimeout(done, 1300); });
      setTimeout(done, 5000);            // 兜底，别让请求挂死
    });
    this.write(String(cmd) + '\r\n');
    return r;
  }

  /** @returns {Promise<{ok:boolean,msg?:string}>} */
  start(opts = {}) {
    const shell = opts.shell === 'cmd' ? 'cmd' : 'pwsh';
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

    this._send({ op: 'start', shell, cwd: opts.cwd || undefined, cols, rows });
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

module.exports = { pty: new PtySession(), PtySession };
