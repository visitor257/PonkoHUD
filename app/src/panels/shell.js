// SHELL：真命令执行（后端持久 pwsh 会话，cd / 变量都保留）
//
// 两种渲染模式：
//   · 管道模式（默认）：后端持久会话逐行回传，中文/退出码/cwd 都稳
//   · PTY 模式：命中交互式程序（python/node/ssh…）或输入 `pty <cmd>` 时切到 ConPTY
//     真终端，输出是 ANSI 流，交给 vt.js 维护屏幕缓冲后按格渲染（颜色/光标/全屏都对）
//
// 多标签（对齐 eDEX-UI 的终端标签）：ShellTab = 一个标签的全部状态，ShellPanel = 标签栏 +
// 当前标签。每个标签在后端是一个独立的会话（自己的持久 pwsh、cwd、shell 种类、PTY），
// 后台标签的 PTY 流也不退订 —— 切回来屏幕内容、滚屏位置都还在。
import { ATTR } from '../grid.js';
import { runShell, abortShell, ptyWrite, ptyResize, ptyStop, ptyClose, ptyStream, shellState } from '../api.js';
import { VT, cellColor } from '../vt.js';

const MAX_TABS = 8;

// ── 一个标签：所有状态都在实例上，标签之间互不共享 ────────────────────────
export class ShellTab {
  constructor(mood, id, n) {
    this.mood = mood;
    this.id = id;              // 后端会话 id（也是 /api/shell、/api/pty 的 session）
    this.n = n;                // 标签序号（只用于显示）
    this.lines = [];           // {kind:'cmd'|'out'|'err'|'info', text}
    this.cwd = 'C:\\';
    this.busy = false;
    this.scroll = 0;
    this.input = '';
    this.caret = 0;
    this.focus = false;
    this.rect = null;
    this._cancel = null;
    this.kind = 'pwsh';            // pwsh | cmd（由后端同步）
    this.onLine = null;            // 输出钩子（主装配拿它扫 IP 往地球上打标记）
    this.pty = null;               // {vt, off, scroll} —— 非 null 即真终端模式
    this._ptyLabel = '';           // 真终端里跑的程序名（显示用）
    this._lastCmd = '';            // 最近一条命令（用来给真终端取名字）
    this._resizeAt = 0;
    this.hist = [];                // 管道模式本地命令历史（↑/↓ 浏览）
    this.histIdx = -1;             // -1 = 未在浏览历史
    this.histDraft = '';           // 进入浏览前正在编辑的草稿
    this._histShown = null;        // 上次由 ↑/↓ 填进输入框的内容（判断用户是否又改了）
    this.push('info', 'Ponko HUD shell · 持久会话 · 输入 help 看可用命令');
    this.refreshState();
  }

  /** 拉一次后端真实状态：会话实际起始目录是 USERPROFILE，前端默认写的 C:\ 是错的 */
  refreshState() {
    return shellState(this.id).then((s) => {
      if (s && s.cwd) this.cwd = s.cwd;
      if (s && s.shell) this.kind = s.shell || 'pwsh';
    }).catch(() => { /* 后端没起来就先用默认 C:\，不影响功能 */ });
  }

  /** 标签栏上的名字：真终端就显示程序名 */
  title() {
    if (this.pty) return this._ptyLabel || 'term';
    return this.kind === 'cmd' ? 'cmd' : 'pwsh';
  }

  /** 关标签时调用：退订、中止、让后端回收整个会话（连 pwsh 子进程一起） */
  dispose() {
    try { this._cancel && this._cancel(); } catch (e) { /* 已经结束了 */ }
    try { this.pty && this.pty.off && this.pty.off(); } catch (e) { /* 流已经断了 */ }
    this.pty = null;
    this._cancel = null;
    ptyClose(this.id);
  }

  // ── PTY：真终端 ────────────────────────────────────────
  inPty() { return !!this.pty; }

  async enterPty(cmd) {
    if (this.pty) { if (cmd) ptyWrite(cmd + '\r', this.id); return; }
    const vt = new VT(100, 24);
    const off = ptyStream(this.id,
      (e) => {
        if (e.t === 'out') { vt.write(e.text || ''); if (this.onLine) this.onLine(e.text || ''); }
        else if (e.t === 'exit') this.leavePty('终端已退出');
        else if (e.t === 'error') this.push('err', 'PTY：' + (e.msg || '未知错误'));
      },
      () => { /* 流断即视为会话结束 */ },
    );
    this.pty = { vt, off, scroll: 0 };
    // 会话由后端拉起（后端才知道该喂什么命令），前端只连流 + 同步尺寸
    if (cmd) setTimeout(() => ptyWrite(cmd + '\r', this.id), 1500);
  }

  leavePty(reason) {
    if (!this.pty) return;
    try { this.pty.off && this.pty.off(); } catch (e) {}
    this.pty = null;
    this.ime = null;
    this._ptyLabel = '';
    ptyStop(this.id);
    // 退出真终端后重新拉一次后端状态，保证 shell 种类/cwd 跟后端一致（cmd/pwsh 不同步过）
    this.refreshState();
    this.push('info', reason || '已退出真终端，回到管道模式。');
  }

  /** 真终端里的按键：整行提交 + 回车；程序自己负责回显 */
  sendToPty(text) {
    if (!this.pty) return;
    ptyWrite(text + '\r', this.id);
  }

  /** 按键直通：可打印字符（含中文 IME 结果）。粘贴的多行按终端惯例换成回车。 */
  ptyType(text) {
    if (!this.pty || !text) return;
    ptyWrite(String(text).replace(/\r?\n/g, '\r'), this.id);
  }

  /** 按键直通：控制序列原始字节（\x03 / \x1b[A / \x7f …） */
  ptyKey(seq) {
    if (!this.pty || !seq) return;
    ptyWrite(seq, this.id);
  }

  get prompt() { return this.kind === 'cmd' ? `${this.cwd}>` : `PS ${this.cwd}> `; }

  push(kind, text) {
    for (const l of String(text === undefined || text === null ? '' : text).split('\n')) {
      this.lines.push({ kind, text: l });
      if (this.onLine) { try { this.onLine(l); } catch (e) { /* 钩子炸了不能拖垮面板 */ } }
    }
    if (this.lines.length > 500) this.lines.splice(0, this.lines.length - 500);
    this.scroll = 0;
  }

  async exec(cmd) {
    if (this.busy) return;
    const c = cmd.trim();
    this.push('cmd', c);
    if (!c) return;
    if (this.pty) { this.sendToPty(c); return; }   // 真终端里：整行发进去，由程序自己回显
    // 记入命令历史（与上一条相同则不重复记）；↑/↓ 用它回翻
    if (this.hist[this.hist.length - 1] !== c) this.hist.push(c);
    this.histIdx = -1; this.histDraft = ''; this._histShown = null;
    if (c === 'clear' || c === 'cls') { this.lines.length = 0; return; }
    if (c === 'help') {
      this.push('info', '当前 shell：' + (this.kind === 'cmd' ? 'CMD' : 'PowerShell'));
      this.push('info', 'cmd / powershell   切换 shell（exit 从 CMD 退回）');
      this.push('info', 'clear 清屏 · ESC 中断 · ↑/↓ 翻命令历史 · pty <cmd> 开真终端（任意程序都行）');
      this.push('info', '交互式程序（python / node / ssh / vim…裸跑）会自动开真终端');
      this.push('info', '真终端 = 按键直通：^C 中断 · ^D 结束输入 · ^E 退出终端');
      this.push('info', '多标签：^⇧T 新建 · ^Tab 切换 · ^⇧W 关闭（各标签互相独立）');
      return;
    }
    this.busy = true;
    this.mood.touch();
    // 命令成败是事实，不是情绪——是否反映到心情上由 agent 决定
    // （想让 shell 反向影响时加 ?local=1，或直接改 mood.localSignals）
    this._cancel = runShell(c, (e) => {
      if (e.t === 'out') this.push('out', e.text);
      else if (e.t === 'err') this.push('err', e.text);
      else if (e.t === 'cwd') this.cwd = e.text;
      else if (e.t === 'shell') this.kind = e.text || 'pwsh';
      else if (e.t === 'pty') {                    // 后端开好真终端了，前端切渲染模式
        // 给真终端取个名字：'python' / 'pty python' / 'pty pwsh' 都取到程序名
        this._ptyLabel = String(c).replace(/^!?pty\s+/i, '').split(/\s+/)[0] || '';
        this.enterPty();
        this.busy = false;
        return;
      }
      else if (e.t === 'exit') {
        this.busy = false;
        if (e.code !== 0) {
          this.push('err', (e.error === 'timeout' ? '命令超时（60s），已中断' : `退出码 ${e.code}`));
          if (this.mood.localSignals) this.mood.fromLocal('error', '上一条命令失败了');
          else this.mood.touch();
        } else this.mood.touch();
      } else if (e.t === 'error') {
        this.busy = false;
        this.push('err', e.text);
        if (this.mood.localSignals) this.mood.fromLocal('error', 'shell 出错');
        else this.mood.touch();
      }
    }, undefined, this.id);
  }

  abort() {
    if (this.pty) { ptyWrite('\x03', this.id); return; }   // 真终端里：^C 就是中断当前程序
    if (!this.busy) return;
    abortShell(this.id);
    try { this._cancel && this._cancel(); } catch (e) {}
    this.busy = false;
    this.push('info', '^C 已中断');
  }

  /** ↑ / ↓：真终端里交给程序（命令历史），管道模式里翻本地命令历史（滚屏交给鼠标滚轮） */
  onArrow(dir) {
    if (this.pty) { ptyWrite(dir > 0 ? '\x1b[A' : '\x1b[B', this.id); return true; }
    if (!this.hist.length) return true;
    // 用户又改了输入（跟上次回翻填进去的不一样）→ 重新开始浏览
    if (this.histIdx === -1 || this.input !== this._histShown) {
      this.histDraft = this.input;
      this.histIdx = this.hist.length;
    }
    if (dir > 0) { if (this.histIdx > 0) this.histIdx--; }             // ↑ 往旧翻
    else { if (this.histIdx < this.hist.length) this.histIdx++; }      // ↓ 往新翻
    this.input = this.histIdx >= this.hist.length ? this.histDraft : this.hist[this.histIdx];
    this._histShown = this.input;
    this.caret = this.input.length;
    return true;
  }

  /** 面板主体（不含外框：外框由 ShellPanel 画，标签栏在框外顶部） */
  body(g, C) {
    const r = this.rect, T = C.theme;
    if (!r || r.w < 8 || r.h < 4) return;
    if (this.pty) return this.drawPty(g, C);

    const x = r.x + 1, iw = r.w - 2;
    const viewH = r.h - 3;                 // 留 1 行输入
    const prompt = this.prompt;
    const indent = '  ';

    // 可见行（从底部往上排）
    const items = [];
    for (const l of this.lines) {
      const pre = l.kind === 'cmd' ? prompt : indent;
      const full = pre + l.text;
      const n = Math.max(1, Math.ceil(g.strWidth(full) / iw));
      for (let i = 0; i < n; i++) {
        items.push({ text: full.slice(i * iw, (i + 1) * iw), kind: l.kind, first: i === 0 });
      }
    }
    const start = Math.max(0, items.length - viewH - this.scroll);
    let y = r.y + 1;
    for (let i = start; i < Math.min(items.length, start + viewH); i++) {
      const it = items[i];
      const col = it.kind === 'cmd' ? T.accent
        : it.kind === 'err' ? T.err
        : it.kind === 'info' ? T.dim : T.text;
      g.text(x, y, it.text, col, T.panel);
      y++;
    }
    while (y < r.y + r.h - 2) { g.text(x, y, ' '.repeat(iw), T.text, T.panel); y++; }

    // 输入行
    const iy = r.y + r.h - 2;
    let cx = g.text(x, iy, prompt, T.accent, T.panel);
    const maxLen = Math.max(1, r.x + r.w - 1 - cx - 1);
    // 长命令把光标推进可视区内：窗口跟着 caret 滑，而不是永远从头开始截断
    const caret = Math.max(0, Math.min(this.caret, this.input.length));
    const off = Math.max(0, caret - maxLen + 1);
    const tx0 = cx;
    g.text(tx0, iy, this.input.slice(off, off + maxLen), T.text, T.panel);
    // 光标必须画在 caret 对应的那一列（原来直接拿 g.text 的返回列 = 永远贴末尾）
    if (this.focus && Math.floor(C.t * 2) % 2 === 0) {
      const col = tx0 + g.strWidth(this.input.slice(off, caret));
      if (col < r.x + r.w - 1) g.set(col, iy, '█', T.accent, T.accent);
    }
  }

  /** 真终端渲染：逐格把 VT 屏幕缓冲画进网格（保留程序自己的颜色） */
  drawPty(g, C) {
    const r = this.rect, T = C.theme, p = this.pty, vt = p.vt;
    const x = r.x + 1, iw = r.w - 2, viewH = r.h - 2;

    // 面板尺寸变了（拖动分割条 / 窗口缩放）要同步给 PTY，否则换行位置不对
    if (vt.cols !== iw || vt.rows !== viewH) {
      vt.resize(iw, viewH);
      const now = Date.now();
      if (now - this._resizeAt > 400) { this._resizeAt = now; ptyResize(iw, viewH, this.id); }
    }

    const start = Math.max(0, vt.totalLines - viewH - p.scroll);
    let hasContent = false;                // 启动阶段（pwsh 还没吐字）给个提示，别让面板干等
    for (let row = 0; row < viewH; row++) {
      const line = vt.line(start + row);
      let cx = x;
      const yy = r.y + 1 + row;
      for (let col = 0; col < iw && cx < r.x + r.w - 1; col++) {
        const cell = line ? line[col] : null;
        const ch = cell ? cell.ch : ' ';
        if (ch !== ' ' && ch !== '') hasContent = true;
        const fg = cell ? (cellColor(cell.fg) || T.text) : T.text;
        const bg = cell ? (cellColor(cell.bg) || T.panel) : T.panel;
        g.set(cx, yy, ch, fg, bg, cell && cell.bold ? ATTR.BOLD : 0);
        const w = g.chWidth(ch);
        for (let k = 1; k < w; k++) g.set(cx + k, yy, '', fg, bg);
        cx += w;
      }
      while (cx < r.x + r.w - 1) { g.set(cx, yy, ' ', T.text, T.panel); cx++; }
    }
    if (!hasContent) {
      const name = this._ptyLabel ? `：${this._ptyLabel}` : '';
      g.text(x + 2, r.y + 1 + (viewH >> 1), `正在启动真终端${name}…`, T.dim, T.panel);
      g.text(x + 2, r.y + 2 + (viewH >> 1), '（真终端让交互程序能用；Ctrl+Shift+E 退出）', T.darker, T.panel);
    }

    // IME 合成中：拼音预览画在光标处（还没发进程序，只是让你看见自己正在打什么）
    const absY0 = vt.scrollback.length + vt.y;
    if (this.ime && !p.scroll && absY0 >= start && absY0 < start + viewH) {
      g.text(x + vt.x, r.y + 1 + (absY0 - start), this.ime, T.accent, T.panel);
    }

    // 光标：只在"当前屏"且可视时画
    const absY = vt.scrollback.length + vt.y;
    if (!p.scroll && absY >= start && absY < start + viewH) {
      const cy = r.y + 1 + (absY - start);
      const cell = vt.line(absY) ? vt.line(absY)[vt.x] : null;
      const ch = cell && cell.ch !== ' ' ? cell.ch : ' ';
      const blink = Math.floor(C.t * 2) % 2 === 0;
      g.set(x + vt.x, cy, blink ? ch : ' ', T.panel, blink ? T.accent : T.panel);
    }
  }

  onWheel(d) {
    if (this.pty) {
      const vt = this.pty.vt;
      this.pty.scroll = Math.max(0, Math.min(Math.max(0, vt.totalLines - this.rect.h + 2),
        this.pty.scroll + (d > 0 ? -1 : 1)));
      return true;
    }
    this.scroll = Math.max(0, Math.min(400, this.scroll + (d > 0 ? -1 : 1)));
    return true;
  }
}

// ── 面板：标签栏 + 当前标签（对外 API 与单标签时代完全一致，主装配不用改）──
export class ShellPanel {
  constructor(mood) {
    this.mood = mood;
    this.rect = null;
    this.tabs = [];
    this.active = 0;
    this._focus = false;
    this._onLine = null;
    this._tabHits = [];        // 最近一帧标签栏的命中区 [{x0,x1,idx}]，idx=-1 是“+”
    this._seq = 0;
    this.newTab();
    this._reapStale();
  }

  // ── 当前标签 ──
  get tab() { return this.tabs[this.active] || null; }
  _nextId() { return 't' + (++this._seq) + Math.random().toString(36).slice(2, 6); }

  /**
   * 页面刚加载时，后端可能还挂着上次刷新遗留的标签会话（每个都占一个 pwsh/PTY 子进程）。
   * 把不是本页的、以 't' 开头的会话收掉；默认会话 '0' 不动（老路径还在用）。
   */
  async _reapStale() {
    try {
      const r = await fetch('/api/sessions').then((x) => x.json());
      const mine = new Set(this.tabs.map((t) => t.id));
      for (const s of (r && r.sessions) || []) {
        if (/^t/.test(s.id) && !mine.has(s.id)) ptyClose(s.id);
      }
    } catch (e) { /* 后端没起来就算了 */ }
  }

  // ── 转发给当前标签的属性（主装配按老接口用，不用感知多标签）──
  get focus() { return this._focus; }
  set focus(v) {
    this._focus = !!v;
    for (const t of this.tabs) t.focus = this._focus && t === this.tab;
  }

  get onLine() { return this._onLine; }
  set onLine(fn) { this._onLine = fn; for (const t of this.tabs) t.onLine = fn; }

  get input() { return this.tab ? this.tab.input : ''; }
  set input(v) { if (this.tab) this.tab.input = v; }
  get caret() { return this.tab ? this.tab.caret : 0; }
  set caret(v) { if (this.tab) this.tab.caret = v; }
  get ime() { return this.tab ? this.tab.ime : null; }
  set ime(v) { if (this.tab) this.tab.ime = v; }
  get prompt() { return this.tab ? this.tab.prompt : ''; }
  get kind() { return this.tab ? this.tab.kind : 'pwsh'; }
  get cwd() { return this.tab ? this.tab.cwd : ''; }
  get lines() { return this.tab ? this.tab.lines : []; }
  get busy() { return this.tab ? this.tab.busy : false; }

  // ── 转发给当前标签的方法 ──
  layout(r) { this.rect = r; this._syncRect(); }
  inPty() { return !!(this.tab && this.tab.inPty()); }
  exec(text) { return this.tab ? this.tab.exec(text) : undefined; }
  abort() { if (this.tab) this.tab.abort(); }
  sendToPty(t) { if (this.tab) this.tab.sendToPty(t); }
  ptyType(t) { if (this.tab) this.tab.ptyType(t); }
  ptyKey(s) { if (this.tab) this.tab.ptyKey(s); }
  leavePty(reason) { if (this.tab) this.tab.leavePty(reason); }
  enterPty(cmd) { return this.tab ? this.tab.enterPty(cmd) : undefined; }
  onArrow(dir) { return this.tab ? this.tab.onArrow(dir) : true; }
  onWheel(d) { return this.tab ? this.tab.onWheel(d) : false; }
  push(kind, text) { if (this.tab) this.tab.push(kind, text); }

  // ── 标签管理 ──
  newTab() {
    if (this.tabs.length >= MAX_TABS) return null;
    const t = new ShellTab(this.mood, this._nextId(), this.tabs.length + 1);
    t.onLine = this._onLine;
    this.tabs.push(t);
    this.active = this.tabs.length - 1;
    this._syncRect();
    this.syncFocus();
    return t;
  }

  selectTab(i) {
    if (typeof i !== 'number' || i < 0 || i >= this.tabs.length) return false;
    if (i === this.active) return false;
    this.active = i;
    this.syncFocus();
    return true;
  }

  /** dir>0 下一个，dir<0 上一个（循环） */
  nextTab(dir) {
    const n = this.tabs.length;
    if (n < 2) return false;
    this.active = (this.active + (dir > 0 ? 1 : -1) + n) % n;
    this.syncFocus();
    return true;
  }

  closeTab(i) {
    if (this.tabs.length <= 1) return false;            // 留最后一个，别把面板清空
    const k = (i === undefined || i === null) ? this.active : i;
    if (k < 0 || k >= this.tabs.length) return false;
    this.tabs[k].dispose();
    this.tabs.splice(k, 1);
    if (k < this.active) this.active--;
    if (this.active >= this.tabs.length) this.active = this.tabs.length - 1;
    this.syncFocus();
    return true;
  }

  /** 命中标签栏：返回标签下标；-1 = “+”新建；null = 没点标签栏 */
  tabAt(x, y) {
    for (const h of this._tabHits) if (x >= h.x0 && x <= h.x1) return h.idx;
    return null;
  }

  /** 标签栏在 SHELL 框**外**：紧贴在框顶线上面那一行 */
  tabBarRow() { return this.rect ? this.rect.y - 1 : -1; }

  syncFocus() {
    for (const t of this.tabs) t.focus = this._focus && t === this.tab;
    this._syncRect();
  }

  _syncRect() {
    const r = this.rect;
    if (!r) return;
    // 标签栏搬到框外了 → 框内空间整块还给终端正文（tab.rect = 整框）
    for (const t of this.tabs) t.rect = { x: r.x, y: r.y, w: r.w, h: r.h };
  }

  draw(g, C) {
    const r = this.rect, T = C.theme;
    if (!r || r.w < 12 || r.h < 4) return;
    g.box(r.x, r.y, r.w, r.h, this._focus ? T.accent : T.line, T.panel,
      'SHELL', T.accent, `${this.active + 1}/${this.tabs.length}`);
    const tab = this.tab;
    if (tab) { tab.rect = { x: r.x, y: r.y, w: r.w, h: r.h }; tab.focus = this._focus; tab.body(g, C); }
  }

  /**
   * 标签栏画在 SHELL 框的顶部边缘线**之上**那一行（框外）。
   * 必须晚于全局 chrome 的分隔线绘制，否则会被那行 '─' 盖掉（见 main.js 的调用点）。
   */
  drawTabBar(g, C) {
    const r = this.rect, T = C.theme;
    if (!r) return;
    const y = r.y - 1;
    if (y < 0) return;
    this._tabHits = [];
    const maxX = r.x + r.w;                      // 独占：[r.x, r.x+r.w)
    let x = r.x;
    for (let i = 0; i < this.tabs.length; i++) {
      const label = ` ${i + 1} ${this.tabs[i].title()} `;
      const w = g.strWidth(label);
      if (x + w > maxX - 3) { g.text(x, y, '…', T.darker, T.bg); x += 1; break; }
      const on = i === this.active;
      // 活动标签用实心色块（反色），“挂在”顶线上；非活动做成低调的小片
      g.text(x, y, label, on ? T.bg : T.dim, on ? T.accent : T.panel);
      this._tabHits.push({ x0: x, x1: x + w - 1, idx: i });
      x += w;
    }
    if (this.tabs.length < MAX_TABS && x + 3 <= maxX) {
      g.text(x, y, ' + ', T.dim, T.bg);
      this._tabHits.push({ x0: x, x1: x + 2, idx: -1 });
      x += 3;
    }
    // 剩下的部分让原来的顶部分隔线继续延伸，看起来就是“标签挂在线上”
    while (x < maxX) { g.set(x, y, '─', T.line, T.bg); x++; }
  }
}
