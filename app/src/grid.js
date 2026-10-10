// 字符网格渲染器：整个 UI 的唯一绘制原语
//
// 关键点（这是性能与观感的核心）：
//   1. 单元格缓冲 (chs/fg/bg/attr) 与绘制分离 —— 面板只写缓冲，render() 统一画
//   2. 块字符走 fillRect 而不是 fillText：█ ▀ ▄ ░ ▒ ▓ ▁-▇ 全是实心/矩形区域，
//      画色块比画字形快一个数量级，而且边缘严丝合缝不会有字体抗锯齿缝隙
//   3. 背景按行做 span 合并，前景同色连续字符合并成一次 fillText
//   4. 宽字符（CJK / 全角符号）占 2 列，按 advance 推进并清掉后一格

const BLOCK = new Map([
  ['█', { k: 'full' }],
  ['▀', { k: 'upper' }],
  ['▄', { k: 'lower' }],
  ['▌', { k: 'left' }],
  ['▐', { k: 'right' }],
  ['░', { k: 'shade', a: 0.25 }],
  ['▒', { k: 'shade', a: 0.5 }],
  ['▓', { k: 'shade', a: 0.75 }],
  ['▁', { k: 'bar', a: 0.125 }],
  ['▂', { k: 'bar', a: 0.25 }],
  ['▃', { k: 'bar', a: 0.375 }],
  // ▄ 已登记为 lower（下半块），而 bar 4/8 与它同形，无需重复
  ['▅', { k: 'bar', a: 0.625 }],
  ['▆', { k: 'bar', a: 0.75 }],
  ['▇', { k: 'bar', a: 0.875 }],
]);

const rgbCache = new Map();
function css(c) {
  let s = rgbCache.get(c);
  if (s === undefined) {
    s = `rgb(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255})`;
    rgbCache.set(c, s);
  }
  return s;
}
export const rgb = (r, g, b) => ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
export function mix(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return rgb(Math.round(ar + (br - ar) * t), Math.round(ag + (bg - ag) * t), Math.round(ab + (bb - ab) * t));
}
export function scale(c, t) {
  return rgb(Math.min(255, Math.round(((c >> 16) & 255) * t)),
             Math.min(255, Math.round(((c >> 8) & 255) * t)),
             Math.min(255, Math.round((c & 255) * t)));
}

const A_BOLD = 1, A_DIM = 2, A_UNDER = 4, A_INV = 8;

export class Grid {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    // 等宽字体优先，CJK 由浏览器回退到中文字体（度量仍是 1em ≈ 2 个等宽格，对齐才不会散）
    this.font = opts.font || '"Cascadia Mono","Cascadia Code","Consolas","Microsoft YaHei","Noto Sans CJK SC",monospace';
    this.fontSize = opts.fontSize || 15;
    this.lineHeight = opts.lineHeight || 1.18;
    this.pad = opts.pad || 0;
    this.cols = 0; this.rows = 0;
    this.cellW = 8; this.cellH = 16;
    this.asciiW = 8;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.stats = { cells: 0, rects: 0, texts: 0, ms: 0 };
    this._wcache = new Map();
    this._fontCache = new Map();
    this.fade = 1;                 // 内容淡入：1=正常，0=完全融进背景（看不见）
    this.fadeBg = 0;               // fade<1 时前景色混入的目标底色（main 在画面板前设为该面板底色）
    this.fadeAll = false;          // true = 连边框(nofade)和背景一起淡；整块退场时才开（见 zoomanim）
    this.resize();
  }

  resize() {
    const c = this.canvas;
    const cssW = c.clientWidth || 1280, cssH = c.clientHeight || 720;
    c.width = Math.max(1, Math.floor(cssW * this.dpr));
    c.height = Math.max(1, Math.floor(cssH * this.dpr));
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this._setFont(false);
    // 等宽字体的单字符宽度：取一段样本求平均，避免单字符度量误差
    const w = this.ctx.measureText('MMMMMMMMMM').width / 10;
    this.cellW = Math.max(4, w);
    this.cellH = Math.max(6, Math.round(this.fontSize * this.lineHeight));
    this.asciiW = this.cellW;

    this.cols = Math.max(8, Math.floor((cssW - this.pad * 2) / this.cellW));
    this.rows = Math.max(4, Math.floor((cssH - this.pad * 2) / this.cellH));
    this.ox = Math.round((cssW - this.cols * this.cellW) / 2);
    this.oy = Math.round((cssH - this.rows * this.cellH) / 2);

    const n = this.cols * this.rows;
    this.chs = new Array(n).fill(' ');
    this.fgs = new Int32Array(n);
    this.bgs = new Int32Array(n);
    this.attrs = new Uint8Array(n);
    this.ctx.textBaseline = 'middle';
    return this;
  }

  _setFont(bold) {
    const key = bold ? 1 : 0;
    let f = this._fontCache.get(key);
    if (!f) {
      f = `${bold ? 'bold ' : ''}${this.fontSize}px ${this.font}`;
      this._fontCache.set(key, f);
    }
    if (this.ctx.font !== f) this.ctx.font = f;
  }

  /** 字符占几列（缓存） */
  chWidth(ch) {
    let w = this._wcache.get(ch);
    if (w === undefined) {
      this._setFont(false);
      w = Math.max(1, Math.round(this.ctx.measureText(ch).width / this.asciiW));
      this._wcache.set(ch, w);
    }
    return w;
  }
  /** 字符串占几列 */
  strWidth(s) {
    let n = 0;
    for (const ch of s) n += this.chWidth(ch);
    return n;
  }

  clear(fg = 0x000000, bg = 0x000000) {
    this.chs.fill(' ');
    this.fgs.fill(fg);
    this.bgs.fill(bg);
    this.attrs.fill(0);
  }

  idx(x, y) { return y * this.cols + x; }
  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.cols && y < this.rows; }

  set(x, y, ch, fg, bg, attr = 0, nofade = false) {
    if (!this.inBounds(x, y)) return;
    // 内容淡入：非边框字符在 fade<1 时把前景色往背景色混，越接近背景越看不见
    if (this.fade < 1 && (!nofade || this.fadeAll)) {
      const target = (bg != null && !this.fadeAll) ? bg : this.fadeBg;
      if (fg != null) fg = mix(fg, target, 1 - this.fade);
      // 整块退场（fadeAll）时背景也得跟着淡，否则框里的内容淡完了、底色还留着，
      // 变成一地空色块拖到最后一帧才消失
      if (this.fadeAll && bg != null) bg = mix(bg, this.fadeBg, 1 - this.fade);
    }
    const i = this.idx(x, y);
    this.chs[i] = ch; this.fgs[i] = fg; this.bgs[i] = bg; this.attrs[i] = attr;
  }

  /** 写字符串，返回结束列（宽字符自动推进 2 列） */
  text(x, y, s, fg, bg, attr = 0) {
    let cx = x;
    for (const ch of s) {
      const w = this.chWidth(ch);
      if (cx + w > this.cols) break;
      this.set(cx, y, ch, fg, bg, attr);
      // 宽字符吃掉后一格，避免残留
      for (let k = 1; k < w; k++) this.set(cx + k, y, '', fg, bg, attr);
      cx += w;
    }
    return cx;
  }

  /** 只填背景色的连续区域（画条、高亮行） */
  fill(x, y, w, h, ch, fg, bg, attr = 0) {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) this.set(xx, yy, ch, fg, bg, attr);
    }
  }

  /** 边框（Unicode box-drawing，单线） */
  box(x, y, w, h, fg, bg = null, title = null, titleFg = null, right = null) {
    const panelBg = bg === null ? this.bgs[this.idx(x, y)] : bg;
    if (bg !== null) this.fill(x, y, w, h, ' ', fg, bg);
    const X2 = x + w - 1, Y2 = y + h - 1;
    // 边框线条用 nofade：淡入阶段仍清晰，避免与展开框衔接时跳变
    this.set(x, y, '┌', fg, panelBg, 0, true);
    this.set(X2, y, '┐', fg, panelBg, 0, true);
    this.set(x, Y2, '└', fg, panelBg, 0, true);
    this.set(X2, Y2, '┘', fg, panelBg, 0, true);
    for (let yy = y + 1; yy < Y2; yy++) {
      this.set(x, yy, '│', fg, panelBg, 0, true);
      this.set(X2, yy, '│', fg, panelBg, 0, true);
    }
    for (let xx = x + 1; xx < X2; xx++) {
      this.set(xx, y, '─', fg, panelBg, 0, true);
      this.set(xx, Y2, '─', fg, panelBg, 0, true);
    }
    // 标题 / 右侧状态文字属于“内容”，随 fade 淡入
    if (title) {
      const tw = this.strWidth(title);
      const at = 2;
      if (at + tw + 1 <= w - 2) this.text(x + at, y, title, titleFg || fg, panelBg);
    }
    if (right) {
      const rw = this.strWidth(right);
      this.text(X2 - 1 - rw, y, right, titleFg || fg, panelBg);
    }
  }

  // ── 绘制 ──────────────────────────────────────────────
  render() {
    const t0 = performance.now();
    const { ctx, cols, rows, cellW, cellH, ox, oy } = this;
    const st = this.stats;
    st.rects = 0; st.texts = 0; st.cells = cols * rows;

    ctx.fillStyle = css(this.bgs[0] !== undefined ? this.bgs[0] : 0);
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    for (let y = 0; y < rows; y++) {
      const py = oy + y * cellH;
      const rowBase = y * cols;

      // ── 趟 1：背景 span 合并
      let x = 0;
      while (x < cols) {
        const bg = this.bgs[rowBase + x];
        let x2 = x + 1;
        while (x2 < cols && this.bgs[rowBase + x2] === bg) x2++;
        if (bg !== this.bgs[0]) {
          ctx.fillStyle = css(bg);
          ctx.fillRect(ox + x * cellW, py, (x2 - x) * cellW, cellH);
          st.rects++;
        }
        x = x2;
      }

      // ── 趟 2：前景
      x = 0;
      while (x < cols) {
        const i = rowBase + x;
        const ch = this.chs[i];
        if (ch === ' ' || ch === '') { x++; continue; }
        const attr = this.attrs[i];
        let fg = this.fgs[i], bg = this.bgs[i];
        if (attr & A_INV) { const t = fg; fg = bg; bg = t; }
        if (attr & A_DIM) fg = scale(fg, 0.55);
        const b = BLOCK.get(ch);
        const px = ox + x * cellW;

        if (b) {
          switch (b.k) {
            case 'full':
              ctx.fillStyle = css(fg); ctx.fillRect(px, py, cellW, cellH); st.rects++; break;
            case 'upper':
              ctx.fillStyle = css(fg); ctx.fillRect(px, py, cellW, Math.ceil(cellH / 2));
              ctx.fillStyle = css(bg); ctx.fillRect(px, py + Math.floor(cellH / 2), cellW, cellH - Math.floor(cellH / 2));
              st.rects += 2; break;
            case 'lower':
              ctx.fillStyle = css(bg); ctx.fillRect(px, py, cellW, Math.floor(cellH / 2));
              ctx.fillStyle = css(fg); ctx.fillRect(px, py + Math.floor(cellH / 2), cellW, cellH - Math.floor(cellH / 2));
              st.rects += 2; break;
            case 'left':
              ctx.fillStyle = css(fg); ctx.fillRect(px, py, Math.ceil(cellW / 2), cellH); st.rects++; break;
            case 'right':
              ctx.fillStyle = css(fg); ctx.fillRect(px + Math.floor(cellW / 2), py, cellW - Math.floor(cellW / 2), cellH); st.rects++; break;
            case 'shade':
              ctx.fillStyle = css(mix(bg, fg, b.a)); ctx.fillRect(px, py, cellW, cellH); st.rects++; break;
            case 'bar': {
              const hgt = Math.max(1, Math.round(cellH * b.a));
              ctx.fillStyle = css(fg); ctx.fillRect(px, py + cellH - hgt, cellW, hgt); st.rects++; break;
            }
          }
          x++;
          continue;
        }

        // 同色 + 同属性 + 单宽字符 → 合并成一次 fillText
        let s = '', x2 = x;
        const bold = !!(attr & A_BOLD);
        while (x2 < cols) {
          const j = rowBase + x2;
          const c2 = this.chs[j];
          if (c2 === ' ' || c2 === '') break;
          if (BLOCK.has(c2)) break;
          if (this.fgs[j] !== this.fgs[i] || this.bgs[j] !== this.bgs[i]) break;
          if (!!(this.attrs[j] & A_BOLD) !== bold) break;
          if ((this.attrs[j] & A_INV) !== (attr & A_INV)) break;
          if ((this.attrs[j] & A_DIM) !== (attr & A_DIM)) break;
          if (this.chWidth(c2) !== 1) break;
          s += c2; x2++;
        }
        if (!s) { // 宽字符：单独画
          this._setFont(bold);
          ctx.fillStyle = css(fg);
          ctx.fillText(ch, px, py + cellH / 2);
          st.texts++;
          x += this.chWidth(ch);
          continue;
        }
        this._setFont(bold);
        ctx.fillStyle = css(fg);
        ctx.fillText(s, px, py + cellH / 2);
        st.texts++;
        if (attr & A_UNDER) {
          ctx.fillRect(px, py + cellH - 1, s.length * cellW, 1);
          st.rects++;
        }
        x = x2;
      }
    }
    st.ms = performance.now() - t0;
  }

  /** 网格坐标 → CSS 像素（给 DOM 覆盖层定位用） */
  px(gx) { return this.ox + gx * this.cellW; }
  py(gy) { return this.oy + gy * this.cellH; }
  /** CSS 像素 → 网格坐标 */
  gx(px) { return Math.floor((px - this.ox) / this.cellW); }
  gy(py) { return Math.floor((py - this.oy) / this.cellH); }
}

export const ATTR = { BOLD: A_BOLD, DIM: A_DIM, UNDER: A_UNDER, INV: A_INV };
