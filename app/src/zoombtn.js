// 每个面板右下角的「放大 / 还原」按钮（纯函数，便于回归）
//
// 点一下 → 该框撑满整个内容区（顶部 chrome 2 行 + 底部提示 2 行保留，退出按钮和快捷键还够得着）；
// 再点一下（放大态下按钮仍在右下角，只是换成了 〼）→ 回到原来的分栏。
//
// 按钮画在框的**底边线**上而不是正文里：正文最后一行是 shell 的输入行 / agent 的输入行，
// 画在那儿会跟内容打架；底边线本来就是一整行 '─'，切走几格放按钮正好像一个挂角。
// 最右一列留给 '┘'，所以按钮右端从 x+w-2 起算。
//
// 图标用符号不用文字：⛶ = 放大（四角撑开，就是"全屏"那个符号），〼 = 还原（方框里画了
// 十字/田字格，读起来就是"这一个框"）。
//
// 两个符号在真实字体下**都是 2 格宽**（实测：□ 才是 1 格，⛶ 和 〼 都是 2 —— 别按码点猜，
// 几何符号区里不少字符是全角，用 tools/_measure_sym.mjs 量）。所以按钮宽度取**偶数**（6），
// 两边补白正好 2/2，两个符号都落在正中间 —— 一奇一偶混着用的话（比如 □ + 〼）必然有一个
// 要偏半格，这是字符网格的数学约束，补白怎么分都救不回来。

export const ZOOM_KEYS = ['globe', 'shell', 'agent', 'char', 'sys'];

export const PANEL_NAME = {
  globe: 'GLOBE', shell: 'SHELL', agent: 'AGENT', char: 'MOOD', sys: 'SYS',
};

/** ⛶ 放大 / 〼 还原 —— 纯符号，不写字（两个都是 2 格宽） */
export const ZOOM_LABELS = { off: '⛶', on: '〼' };

/** 按钮至少这么宽（偶数 = 符号 2 格 + 左右各 2 格补白，符号正好落在正中） */
export const ZOOM_MIN_W = 6;

/** 两态共用的固定宽度（取最宽的那个，且不小于 ZOOM_MIN_W） */
export function zoomWidth(g) {
  let w = ZOOM_MIN_W;
  for (const k of ['off', 'on']) w = Math.max(w, g.strWidth(ZOOM_LABELS[k]));
  return w;
}

/** 某个状态的标签文本，左右补空格居中到固定宽度 */
export function zoomLabel(g, on) {
  const s = ZOOM_LABELS[on ? 'on' : 'off'];
  const pad = Math.max(0, zoomWidth(g) - g.strWidth(s));
  const l = Math.floor(pad / 2);
  return ' '.repeat(l) + s + ' '.repeat(pad - l);
}

/** 按钮在框底边线上的落位：绘制与命中判定共用这一套坐标 */
export function zoomBtnRect(g, r, on) {
  const w = zoomWidth(g);
  const x1 = r.x + r.w - 2;                       // 最右一列是 '┘'
  const x0 = Math.max(r.x + 1, x1 - w + 1);
  return { x0, x1, y: r.y + r.h - 1, w, label: zoomLabel(g, on) };
}

/** 放大态的目标矩形：整个内容区（上下 chrome 各留 2 行） */
export function fullRect(g, chromeTop = 2, chromeBot = 2) {
  return {
    x: 0,
    y: chromeTop,
    w: g.cols,
    h: Math.max(3, g.rows - chromeTop - chromeBot),
  };
}
