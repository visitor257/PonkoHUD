// 单框放大 / 还原的过场动画（纯函数，便于回归）
//
// 字符网格上做不了真正的像素缩放，这里的做法是「矩形插值」：把起点框和终点框的
// 四条边按进度一起插值，四舍五入吸附到整格。屏幕上看到的就是那个框一路长大 / 缩小。
//
// 一次过场分**三段依次**走完，不是一锅端：
//   放大   ① 其它框「由近及远」依次淡出 + 主角框里的内容淡出
//          ② 主角框位移（只带框、不带内容）
//          ③ 主角框内容淡入
//   还原   ① 主角框内容淡出
//          ② 主角框位移
//          ③ 其它框「由远及近」依次淡入 + 主角框内容淡入
//
// 两条「不要同时」是这套节奏的全部意义：
//
//   · 其它框要错开（stagger）。一起没、一起现，看着像整屏闪了一下就换页，没有过程；
//     错开之后视线是被牵着走的 —— 放大时从手指点下去那块地方扩散出去，
//     还原时从最远处一路收回来，最后才轮到紧贴主角的那一块。
//
//   · 内容先走、框后动。位移那一段主角框是空的（实心底 + 描边），和开机时各框展开
//     用的是同一套笔法。按中间尺寸排版的话终端换行每帧都在重算，文字会跟着框来回抽，
//     那不是动画，是抖动。
//
// 淡出用的是 grid 的 fadeAll：只混前景色的话会剩一地空色块、最后一帧才"啪"地消失，
// 连底色带边框一起往屏幕背景里溶才干净（见 grid.js）。

/** 一次过场的总时长（秒）。?zoomanim=N 可覆盖（验证时拉长了好采样） */
export const ZOOM_DUR = 0.66;
/** 三段占总时长的比例：淡出 / 位移 / 淡入 */
export const ZOOM_W = { out: 0.34, move: 0.38, in: 0.28 };
/** 单个「其它框」自己淡完所需的时长，占它所在段的比例（剩下的用来错开） */
export const ZOOM_OTHER_W = 0.34;
export const ZOOM_STAGGER_W = 1 - ZOOM_OTHER_W;
/** 位移段的描边：前 26% 由正常线色升到 accent，72% 之后再由 accent 收回线色。
 *  两头都留一段渐变，是因为进出位移段都不能"啪"地换色（前后都是正常线色的框） */
export const ZOOM_INK_IN = 0.26;
export const ZOOM_INK = 0.72;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** easeOutCubic：一冲出去、末段减速收住（位移段用，和 boot 那套 easing 一个味） */
export function zoomEase(t) {
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
}

/** smoothstep：两头都平滑。淡入淡出用它，避免起步那一顿和到位那一下的硬着陆 */
export function zoomSmooth(t) {
  const u = clamp01(t);
  return u * u * (3 - 2 * u);
}

/** 总进度 u → 当前在哪一段、段内走到哪（u 已归一化到 0..1，与总时长无关） */
export function zoomPhase(dir, u) {
  const t = clamp01(u);
  if (t < ZOOM_W.out) return { seg: 'out', p: t / ZOOM_W.out };
  if (t < ZOOM_W.out + ZOOM_W.move) return { seg: 'move', p: (t - ZOOM_W.out) / ZOOM_W.move };
  return { seg: 'in', p: (t - ZOOM_W.out - ZOOM_W.move) / ZOOM_W.in };
}

/** 两条边插值后的矩形，格子必须取整 —— 否则半个格子会把 box-drawing 线画歪 */
export function zoomAnimRect(from, to, e) {
  const at = (a, b) => Math.round(a + (b - a) * e);
  const x = at(from.x, to.x);
  const y = at(from.y, to.y);
  const x2 = at(from.x + from.w, to.x + to.w);
  const y2 = at(from.y + from.h, to.y + to.h);
  return { x, y, w: Math.max(2, x2 - x), h: Math.max(2, y2 - y) };
}

/**
 * 描边色里 accent 的占比（0 = 全 accent，1 = 全线色），只用于位移段。
 * 进段时框还是正常线色（上一段刚淡完内容），所以先升到 accent 再收回去。
 */
export function zoomBorderMix(e) {
  const t = clamp01(e);
  if (t <= ZOOM_INK_IN) return 1 - t / ZOOM_INK_IN;          // 线色 → accent
  if (t >= ZOOM_INK) return (t - ZOOM_INK) / (1 - ZOOM_INK);  // accent → 线色
  return 0;
}

/**
 * 错开：第 idx 个框（0 = 最先动）在段内进度 p 时自己走到哪。
 * 最后一个框的窗口正好撑满整段（起点 = 错开窗口末尾，终点 = 段末），谁都不会被截断。
 */
export function zoomStagger(p, idx, n) {
  const gap = n > 1 ? ZOOM_STAGGER_W / (n - 1) : 0;
  return clamp01((p - idx * gap) / ZOOM_OTHER_W);
}

/** 主角框内容的可见度：out 段 1→0（先退干净），move 段 0（带着妆走），in 段 0→1 */
export function zoomSelfFade(seg, p) {
  if (seg === 'out') return 1 - zoomSmooth(p);
  if (seg === 'in') return zoomSmooth(p);
  return 0;
}

/**
 * 第 idx 个「其它框」的可见度。
 * 放大：只有 out 段在场，1→0；还原：只有 in 段在场，0→1。其余时段一律 0（不在屏幕上）。
 * 还原的淡入顺序是放大的**倒放**（远的先回来），这样一次往返在视觉上严格可逆。
 */
export function zoomOtherFade(dir, seg, p, idx, n) {
  const i = dir > 0 ? idx : (n - 1 - idx);
  if (dir > 0) return seg === 'out' ? 1 - zoomSmooth(zoomStagger(p, i, n)) : 0;
  return seg === 'in' ? zoomSmooth(zoomStagger(p, i, n)) : 0;
}

/**
 * 其它框的出场顺序：按中心距主角**由近及远**。
 * 用几何距离而不是面板的固定次序 —— 固定次序下相邻两下熄灭的框可能一个在左上一个在右下，
 * 视线跳来跳去；按距离排才会连成一片扩散出去的波。
 */
export function zoomOtherOrder(key, keys, rects) {
  const a = rects && rects[key];
  const cx = a ? a.x + a.w / 2 : 0, cy = a ? a.y + a.h / 2 : 0;
  const dist = (k) => {
    const r = rects && rects[k];
    if (!r) return Infinity;
    const dx = (r.x + r.w / 2) - cx, dy = (r.y + r.h / 2) - cy;
    return dx * dx + dy * dy;
  };
  return keys.filter((k) => k !== key && rects && rects[k]).sort((m, n) => dist(m) - dist(n));
}
