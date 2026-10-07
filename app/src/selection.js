// 文本选择：自绘字符网格里没有"文本节点"，浏览器原生拖选不存在，这里自己维护一块选区。
//
// 选区用**网格坐标**（列,行）表示，理由是绘制层本身就是字符网格：
//   · 高亮 = 把选区内的格子前后景互换，正好复用渲染缓冲，不用另开销路
//   · 取文本 = 直接读当前帧的 chs 缓冲，shell 输出 / PTY 终端画面 / 对话记录因此都能选中
// 挪到独立模块是为了能在没有 DOM 的环境里跑回归脚本（见 tools/test_caret_sel.mjs）。
//
// 选区的语义是**文档式的线性选择**（不是终端的矩形块选）：
// 按下处是锚点，鼠标走到哪儿选到哪儿，跨行时自然流过去 ——
//   首行：锚点 → 该行行尾
//   中间行：整行（行首 → 行尾）
//   末行：行首 → 光标
// 之前用的是"矩形块选"（每行取同一列范围），那是终端的列选，在对话/日志上选出来会缺字、多空格。
export class Selection {
  constructor() { this.reset(); }

  reset() { this.sel = null; this.drag = false; this.moved = false; this.at = null; this.tag = null; }

  get active() { return !!this.sel; }

  /**
   * 起锚点。r 是面板矩形，选区被限制在它的内容区（不含边框）。
   * tag 记下按在哪个面板（'shell' / 'agent'），at 记下按下的网格坐标 ——
   * 松手时要判断这次按下是"拖选"还是"单击"，两者语义不同（见 end）。
   * @returns true 表示这次按下落在正文区、可以开始拖选
   */
  begin(c, r, tag) {
    if (!r) return false;
    const b = { x0: r.x + 1, y0: r.y + 1, x1: r.x + r.w - 2, y1: r.y + r.h - 2 };
    if (c.x < b.x0 || c.x > b.x1 || c.y < b.y0 || c.y > b.y1) return false;
    this.sel = { ax: c.x, ay: c.y, hx: c.x, hy: c.y, b };
    this.drag = true; this.moved = false;
    this.at = { x: c.x, y: c.y }; this.tag = tag || null;
    return true;
  }

  /** 拖到新位置：head 跟着鼠标走，锚点不动 */
  to(c) {
    if (!this.sel) return;
    const b = this.sel.b;
    this.sel.hx = Math.max(b.x0, Math.min(b.x1, c.x));
    this.sel.hy = Math.max(b.y0, Math.min(b.y1, c.y));
    this.moved = true;
  }

  /** 松手：没拖动过（只是点了一下）就不算选区 */
  done() { this.end(); }

  /**
   * 松手，并告诉调用方这次按下该不该当"单击"处理：
   *   true  —— 从头到尾没拖动，选区已丢弃，此时才该去切焦点 / 把光标挪到点击处
   *   false —— 拖出选区了，别再挪光标，否则拖选会把输入行的光标一起带跑
   * at / tag 会保留到下一次 begin，所以 true 时还能读到按下的位置与面板。
   * （松手可能发生在窗口外，mousemove 里检测不到按键时也会间接走到这儿）
   */
  end() {
    this.drag = false;
    if (this.sel && !this.moved) { this.sel = null; return true; }
    return false;
  }

  clear() { this.sel = null; this.drag = false; }

  /**
   * 锚点与光标按"文档顺序"排好：先比行、同行再比列。
   * 反向拖（从下往上）时锚点在后、光标在前，这里一次性把 (sx,sy)/(ex,ey) 正过来，
   * 后面算行片段就不用再三处判断方向。
   */
  ord() {
    const s = this.sel;
    if (!s) return null;
    let { ax, ay, hx, hy } = s;
    if (ay > hy || (ay === hy && ax > hx)) [ax, ay, hx, hy] = [hx, hy, ax, ay];
    return { sx: ax, sy: ay, ex: hx, ey: hy, b: s.b };
  }

  /** 归一化的外接矩形（左上 → 右下），供旧调用方/测试按 x0,y0,x1,y1 读取 */
  norm() {
    const o = this.ord();
    if (!o) return null;
    return {
      x0: Math.min(o.sx, o.ex), x1: Math.max(o.sx, o.ex),
      y0: o.sy, y1: o.ey,
    };
  }

  /**
   * 逐行的实际选中区间 [{y, xa, xb, empty}] —— 线性选区的核心。
   * 中间行/首行的"行尾"取该行最后一个非空格字符，而不是面板右边界：
   * 这样高亮会贴着文字收住（文档里选整行就是贴到行尾），复制时也不会拖出一长串空格。
   */
  spans(g) {
    const o = this.ord();
    if (!o) return [];
    const b = o.b;
    const rowEnd = (y) => {
      for (let x = b.x1; x >= b.x0; x--) {
        const ch = g.chs[g.idx(x, y)];
        if (ch && ch !== ' ') return x;         // '' 是宽字符续格，不当作内容
      }
      return b.x0 - 1;                          // 整行空白：没有可选的
    };
    const out = [];
    for (let y = o.sy; y <= o.ey; y++) {
      let xa, xb;
      if (o.sy === o.ey) { xa = o.sx; xb = o.ex; }          // 单行：锚点 → 光标，精确到列
      else if (y === o.sy) { xa = o.sx; xb = rowEnd(y); }   // 首行：锚点 → 行尾
      else if (y === o.ey) { xa = b.x0; xb = o.ex; }        // 末行：行首 → 光标
      else { xa = b.x0; xb = rowEnd(y); }                   // 中间行：整行
      xb = Math.min(xb, b.x1);
      out.push({ y, xa, xb, empty: xb < xa });
    }
    return out;
  }

  /** 选区内的格子反色 —— 必须在所有面板画完之后、grid.render() 之前调用 */
  paint(g) {
    for (const r of this.spans(g)) {
      if (r.empty) continue;
      for (let x = r.xa; x <= r.xb; x++) {
        if (!g.inBounds(x, r.y)) continue;
        const i = g.idx(x, r.y);
        const f = g.fgs[i];
        g.fgs[i] = g.bgs[i]; g.bgs[i] = f;
        g.attrs[i] = 0;          // 清掉 bold/反色等属性，避免与这里的交换叠加出怪颜色
      }
    }
  }

  /** 选区里的文本：逐行读当前帧的字符缓冲，宽字符的续格要跳过 */
  text(g) {
    const lines = this.spans(g).map((r) => {
      let line = '';
      if (!r.empty) {
        for (let x = r.xa; x <= r.xb; x++) {
          const ch = g.chs[g.idx(x, r.y)];
          if (ch && ch !== '') line += ch;    // '' 是宽字符占位的后一格
        }
      }
      return line.replace(/\s+$/, '');
    });
    while (lines.length && !lines[0]) lines.shift();                    // 拖过头带出来的空行不要
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines.join('\n');
  }
}
