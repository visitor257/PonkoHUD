// VT100/xterm 终端仿真器（够用子集）
//
// PTY 吐出来的是带 ANSI 转义的字节流：光标定位、颜色、擦除、全屏切换……
// 要正确显示就必须自己维护一块屏幕缓冲，再交给 grid 渲染。
// 这里只做"真实的终端会做的事"，不做任何美化。

export const DEFAULT_FG = 7;
export const DEFAULT_BG = 0;

// xterm 默认 16 色（索引 0-15），后面 256 色用标准算法算
const PALETTE16 = [
  [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
  [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
  [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
  [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];

const cache = new Map();

/** ANSI 颜色索引 → 'rgb(r,g,b)'（256 色 + 默认色由调用方兜底） */
export function ansiColor(idx) {
  if (cache.has(idx)) return cache.get(idx);
  let rgb;
  if (idx < 16) rgb = PALETTE16[idx];
  else if (idx < 232) {
    const n = idx - 16;
    const b = n % 6, g = Math.floor(n / 6) % 6, r = Math.floor(n / 36) % 6;
    const f = (v) => (v === 0 ? 0 : 55 + v * 40);
    rgb = [f(r), f(g), f(b)];
  } else {
    const v = 8 + (idx - 232) * 10;
    rgb = [v, v, v];
  }
  const s = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  cache.set(idx, s);
  return s;
}

function blank(fg, bg) { return { ch: ' ', fg, bg, bold: false }; }

// 东亚宽字符：终端里占 2 列。列位置必须和真终端一致，否则回显/重绘全部错位。
const WIDE_RE = /[\u1100-\u115F\u2329\u232A\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

export class VT {
  constructor(cols = 80, rows = 24) {
    this.scrollback = [];
    this.scrollbackMax = 3000;
    this.resize(cols, rows);
  }

  resize(cols, rows) {
    cols = Math.max(8, cols | 0);
    rows = Math.max(2, rows | 0);
    // 尺寸变化不能清空屏幕：面板在进场动画/窗口缩放期间会反复 resize，
    // 一清就把程序已经吐出来的字全抹了（表现就是"只剩第一行"）。
    // 按真实终端的做法迁移旧内容：可视区从底部对齐，列数变了就裁剪/留空。
    const oldBuf = this.buf, oldCols = this.cols, oldRows = this.rows;
    const mk = () => Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => blank(DEFAULT_FG, DEFAULT_BG)));
    this.cols = cols;
    this.rows = rows;
    this.buf = mk();
    this.alt = mk();
    this.altActive = false;
    if (oldBuf) {
      // 可视区从底部对齐（真终端如此）；被挤出顶部的行滚进 scrollback，而不是丢掉
      const n = Math.min(oldRows, rows);
      const extra = oldRows - n;
      if (!this.altActive) {
        for (let i = 0; i < extra; i++) {
          this.scrollback.push(oldBuf[i]);
          if (this.scrollback.length > this.scrollbackMax) this.scrollback.shift();
        }
      }
      for (let i = 0; i < n; i++) {
        const src = oldBuf[extra + i];
        if (!src) continue;
        const dst = this.buf[rows - n + i];
        for (let x = 0; x < Math.min(oldCols, cols); x++) dst[x] = src[x];
      }
      this.x = Math.max(0, Math.min(this.x, cols - 1));
      this.y = Math.max(0, Math.min(this.y, rows - 1));
    } else { this.x = 0; this.y = 0; }
    this.fg = DEFAULT_FG; this.bg = DEFAULT_BG; this.bold = false;
    this.saved = null;
    this.wrapPending = false;
    this.title = '';
    this._state = 'ground';
    this._csi = '';
    this._osc = '';
    this.dirty = true;
  }

  screen() { return this.altActive ? this.alt : this.buf; }

  clearAll() {
    const s = this.screen();
    for (let y = 0; y < this.rows; y++) s[y].fill(blank(this.fg, this.bg));
    this.x = this.y = 0;
  }

  _scrollUp(n = 1) {
    const s = this.screen();
    for (let i = 0; i < n; i++) {
      const top = s.shift();
      if (!this.altActive) {
        this.scrollback.push(top);
        if (this.scrollback.length > this.scrollbackMax) this.scrollback.shift();
      }
      s.push(Array.from({ length: this.cols }, () => blank(this.fg, this.bg)));
    }
  }

  _put(ch) {
    const wide = WIDE_RE.test(ch);
    if (this.wrapPending || (wide && this.x + 1 >= this.cols)) {
      // 上一字符停在行尾，或宽字符在最后一列放不下：换行
      this.x = 0;
      this.y++;
      this.wrapPending = false;
      if (this.y >= this.rows) { this._scrollUp(); this.y = this.rows - 1; }
    }
    const s = this.screen();
    if (this.y >= this.rows) this.y = this.rows - 1;
    s[this.y][this.x] = { ch, fg: this.fg, bg: this.bg, bold: this.bold, wide };
    this.x++;
    if (wide) {
      if (this.x < this.cols) { s[this.y][this.x] = { ch: '', fg: this.fg, bg: this.bg, wide2: true }; this.x++; }
    }
    if (this.x >= this.cols) { this.x = this.cols - 1; this.wrapPending = true; }
  }

  _csiDispatch(p, final) {
    const s = this.screen();
    // 任何光标移动都结束"待换行"状态（真实终端如此），否则停在行尾后再移动光标会错行
    if (final === 'A' || final === 'B' || final === 'C' || final === 'D' ||
        final === 'E' || final === 'F' || final === 'G' || final === '`' ||
        final === 'd' || final === 'H' || final === 'f') this.wrapPending = false;
    const arg = (i, d) => {
      const v = p[i] === undefined || p[i] === '' ? d : parseInt(p[i], 10);
      return Number.isFinite(v) ? v : d;
    };
    switch (final) {
      case 'A': this.y = Math.max(0, this.y - arg(0, 1)); break;         // CUU
      case 'B': this.y = Math.min(this.rows - 1, this.y + arg(0, 1)); break; // CUD
      case 'C': this.x = Math.min(this.cols - 1, this.x + arg(0, 1)); break; // CUF
      case 'D': this.x = Math.max(0, this.x - arg(0, 1)); break;         // CUB
      case 'E': this.y = Math.min(this.rows - 1, this.y + arg(0, 1)); this.x = 0; break;
      case 'F': this.y = Math.max(0, this.y - arg(0, 1)); this.x = 0; break;
      case 'G': case '`': this.x = Math.max(0, Math.min(this.cols - 1, arg(0, 1) - 1)); break; // CHA
      case 'd': this.y = Math.max(0, Math.min(this.rows - 1, arg(0, 1) - 1)); break;           // VPA
      case 'H': case 'f':                                                 // CUP
        this.y = Math.max(0, Math.min(this.rows - 1, arg(0, 1) - 1));
        this.x = Math.max(0, Math.min(this.cols - 1, arg(1, 1) - 1));
        this.wrapPending = false;
        break;
      case 'J': {                                                        // ED
        const mode = arg(0, 0);
        for (let y = 0; y < this.rows; y++) {
          const hit = mode === 0 ? (y >= this.y && (y > this.y || true))
            : mode === 1 ? y <= this.y : true;
          if (mode === 0 && y === this.y) {
            for (let x = this.x; x < this.cols; x++) s[y][x] = blank(this.fg, this.bg);
          } else if (hit) s[y].fill(blank(this.fg, this.bg));
        }
        break;
      }
      case 'K': {                                                        // EL
        const mode = arg(0, 0);
        const row = s[this.y];
        if (mode === 0) for (let x = this.x; x < this.cols; x++) row[x] = blank(this.fg, this.bg);
        else if (mode === 1) for (let x = 0; x <= this.x && x < this.cols; x++) row[x] = blank(this.fg, this.bg);
        else row.fill(blank(this.fg, this.bg));
        break;
      }
      case 'L': {                                                        // IL 插入行
        const n = Math.min(arg(0, 1), this.rows - this.y);
        for (let i = 0; i < n; i++) s.splice(this.y, 0, Array.from({ length: this.cols }, () => blank(this.fg, this.bg)));
        s.length = this.rows;
        break;
      }
      case 'M': {                                                        // DL 删除行
        const n = Math.min(arg(0, 1), this.rows - this.y);
        s.splice(this.y, n);
        while (s.length < this.rows) s.push(Array.from({ length: this.cols }, () => blank(this.fg, this.bg)));
        break;
      }
      case 'P': {                                                        // DCH 删字符
        const n = arg(0, 1);
        s[this.y].splice(this.x, n);
        while (s[this.y].length < this.cols) s[this.y].push(blank(this.fg, this.bg));
        break;
      }
      case 'S': this._scrollUp(arg(0, 1)); break;
      case 'T': for (let i = 0; i < arg(0, 1); i++) { s.pop(); s.unshift(Array.from({ length: this.cols }, () => blank(this.fg, this.bg))); } break;
      case 's': this.saved = { x: this.x, y: this.y, fg: this.fg, bg: this.bg, bold: this.bold }; break;
      case 'u': if (this.saved) { this.x = this.saved.x; this.y = this.saved.y; } break;
      case 'm': this._sgr(p); break;                                     // SGR
      default: break;                                                    // 其它（含 ?1049 等）见 _mode
    }
  }

  _sgr(p) {
    if (!p.length) p = ['0'];
    for (let i = 0; i < p.length; i++) {
      const n = parseInt(p[i], 10) || 0;
      if (n === 0) { this.fg = DEFAULT_FG; this.bg = DEFAULT_BG; this.bold = false; }
      else if (n === 1) this.bold = true;
      else if (n === 22) this.bold = false;
      else if (n === 39) this.fg = DEFAULT_FG;
      else if (n === 49) this.bg = DEFAULT_BG;
      else if (n >= 30 && n <= 37) this.fg = n - 30;
      else if (n >= 90 && n <= 97) this.fg = n - 90 + 8;
      else if (n >= 40 && n <= 47) this.bg = n - 40;
      else if (n >= 100 && n <= 107) this.bg = n - 100 + 8;
      else if (n === 38 || n === 48) {
        // 256 色 / truecolor：38;5;N  或  38;2;r;g;b
        const isFg = n === 38;
        if (p[i + 1] === '5') { const c = parseInt(p[i + 2], 10); if (Number.isFinite(c)) { if (isFg) this.fg = c; else this.bg = c; } i += 2; }
        else if (p[i + 1] === '2') {
          const r = parseInt(p[i + 2], 10) | 0, g = parseInt(p[i + 3], 10) | 0, b = parseInt(p[i + 4], 10) | 0;
          const key = 256 + (r << 16 | g << 8 | b);
          cache.set(key, `rgb(${r},${g},${b})`);
          if (isFg) this.fg = key; else this.bg = key;
          i += 4;
        }
      }
    }
  }

  _mode(p, final) {
    // 形如 ESC [ ? 1049 h / l
    const isSet = final === 'h';
    for (const raw of p) {
      const n = parseInt(String(raw).replace('?', ''), 10);
      if (n === 1049 || n === 47 || n === 1047) {
        if (isSet && !this.altActive) { this.altActive = true; this.alt = Array.from({ length: this.rows }, () => Array.from({ length: this.cols }, () => blank(this.fg, this.bg))); }
        else if (!isSet && this.altActive) this.altActive = false;
      }
      // 其余（光标可见 ?25、鼠标 ?1000、括号粘贴 ?2004…）：忽略即可，不影响显示
    }
  }

  /** 喂入一段（已解码的）终端输出 */
  write(text) {
    if (!text) return;
    for (const ch of String(text)) this._feed(ch);
    this.dirty = true;
  }

  _feed(ch) {
    const code = ch.codePointAt(0);
    switch (this._state) {
      case 'esc':
        if (ch === '[') { this._state = 'csi'; this._csi = ''; }
        else if (ch === ']') { this._state = 'osc'; this._osc = ''; }
        else if (ch === '7') { this.saved = { x: this.x, y: this.y, fg: this.fg, bg: this.bg, bold: this.bold }; this._state = 'ground'; }
        else if (ch === '8') { if (this.saved) { this.x = this.saved.x; this.y = this.saved.y; } this._state = 'ground'; }
        else if (ch === 'M') { /* RI 反向上移，少见 */ this.y = Math.max(0, this.y - 1); this._state = 'ground'; }
        else this._state = 'ground';   // ESC c / ESC ( B 之类一律忽略
        return;
      case 'csi': {
        if (ch >= '\x40' && ch <= '\x7e') {
          const body = this._csi;
          this._state = 'ground';
          if (body.startsWith('?')) this._mode(body.slice(1).split(';'), ch);
          else this._csiDispatch(body.split(';'), ch);
        } else if (code >= 0x20) this._csi += ch;
        return;
      }
      case 'osc':
        if (ch === '\x07') { this._state = 'ground'; this._osc = ''; }
        else if (ch === '\n' || code === 0x9c) { this._state = 'ground'; this._osc = ''; }
        else this._osc += ch;
        return;
      default: break;
    }
    // ground
    if (code === 0x1b) { this._state = 'esc'; return; }
    if (code === 0x0d) { this.x = 0; this.wrapPending = false; return; }         // CR
    if (code === 0x0a) {                                                          // LF
      this.y++;
      this.wrapPending = false;
      if (this.y >= this.rows) { this._scrollUp(); this.y = this.rows - 1; }
      return;
    }
    if (code === 0x08) { this.x = Math.max(0, this.x - 1); this.wrapPending = false; return; }  // BS
    if (code === 0x09) {                                                          // TAB
      const next = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8);
      this.x = next; this.wrapPending = false; return;
    }
    if (code < 0x20 || code === 0x7f) return;                                     // 其它控制字符忽略
    this._put(ch);
  }

  /** 取一行（含 scrollback），y 从 0 开始；超出返回 null */
  line(y) {
    if (y < this.scrollback.length) return this.scrollback[y];
    const s = this.screen();
    return s[y - this.scrollback.length] || null;
  }

  get totalLines() { return this.scrollback.length + this.rows; }
}

/**
 * 单元格颜色 → CSS 颜色。默认前景/背景返回 null，交给面板用 HUD 主题色，
 * 这样"没指定颜色的普通输出"仍然是 HUD 的配色，程序自己上了色的才用它的颜色。
 */
export function cellColor(idx) {
  if (idx === DEFAULT_FG || idx === DEFAULT_BG) return null;
  if (cache.has(idx)) return cache.get(idx);
  return ansiColor(idx);
}
