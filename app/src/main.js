// 主装配：布局 / 主循环 / 输入 / 鼠标
import { Grid, ATTR, rgb } from './grid.js';
import { themeFor, MOOD_KEYS } from './theme.js';
import { Mood } from './mood.js';
import { loadPacks } from './charpack.js';
import { sysSnapshot, netgeo } from './api.js';
import { SysPanel } from './panels/sys.js';
import { ShellPanel } from './panels/shell.js';
import { AgentPanel } from './panels/agent.js';
import { CharPanel } from './panels/char.js';
import { GlobePanel } from './panels/globe.js';

const canvas = document.getElementById('screen');
const grid = new Grid(canvas, { fontSize: 15, lineHeight: 1.2 });
const hidden = document.getElementById('hidden-input');

const mood = new Mood();
const panels = {
  sys: new SysPanel(),
  globe: new GlobePanel(),
  shell: new ShellPanel(mood),
  agent: new AgentPanel(mood),
  char: null,                       // 等素材包加载完再建
};
panels.agent._clearHidden = () => { hidden.value = ''; };   // 关闭配置框时清空隐藏输入框
let packs = [], pack = null;

// 布局
//   左上 GLOBE │ 中上 SHELL │ 右列 MOOD + SYS(右下)
//   下半 AGENT 横跨左+中两列（延伸至最左），贴地
const L = { left: 34, right: 30, topH: 0.5 };
let rects = {};
let dragSplit = null;
const SPLIT_W = 1;
const SYS_H = 8;                  // 右下 SYS 小格高度

function layout() {
  const cols = grid.cols, rows = grid.rows;
  const topH = 2, botH = 2;
  const y0 = topH, mainH = rows - topH - botH;
  const midW = Math.max(20, cols - L.left - L.right - SPLIT_W * 2);
  const lx = 0, cx = L.left + SPLIT_W, rx = cx + midW + SPLIT_W;
  const rightW = Math.max(10, cols - rx);

  const halfH = Math.max(6, Math.floor((mainH - 1) * L.topH));
  // 右列：MOOD 在上，SYS 压成底部一小格（空间不够时只保 MOOD）
  const sysH = Math.max(0, Math.min(SYS_H, mainH - 16));
  const charH = mainH - sysH - (sysH > 0 ? 1 : 0);

  rects = {
    globe: { x: lx, y: y0, w: L.left, h: halfH },
    shell: { x: cx, y: y0, w: midW, h: halfH },
    agent: { x: lx, y: y0 + halfH + 1, w: cx + midW - lx, h: mainH - halfH - 1 },
    char: { x: rx, y: y0, w: rightW, h: charH },
    sys: { x: rx, y: y0 + charH + 1, w: rightW, h: sysH },
    s1: { x: L.left, y: y0, w: SPLIT_W, h: halfH },              // 只在上半（下半被 AGENT 横跨）
    s2: { x: rx - SPLIT_W, y: y0, w: SPLIT_W, h: mainH },
    hsplit: { x: lx, y: y0 + halfH, w: cx + midW - lx, h: 1 },
  };
  for (const k in panels) {
    const p = panels[k];
    if (!p) continue;
    p.layout(rects[k]);
    const r = rects[k];
    // 进场动画：按宽高比决定展开方向——横框（宽≥高）左右展开，竖框（高>宽）上下展开
    if (r && r.w >= 4 && r.h >= 3) p.orient = (r.w >= r.h) ? 'h' : 'v';
    if (p.open === undefined) { p.open = 0; p.delay = OPEN_DELAY[k] ?? 0; p.contentFade = 0; }
  }
}

// ── 焦点：SHELL 与 AGENT 共用一条隐藏输入线（IME 友好）
let focus = 'agent';
let prevPty = false;                 // 上一帧是否处于真终端模式（用于进入时自动把焦点给 shell）
function activeInputPanel() { return focus === 'shell' ? panels.shell : panels.agent; }

// 配置框：把隐藏输入框内容同步到当前字段（字段态写值，按钮态清空）
function syncCfgHidden() {
  const a = panels.agent;
  if (a.form.idx >= 0 && a.form.idx < a.form.fields.length) hidden.value = a.form.fields[a.form.idx].value || '';
  else hidden.value = '';
}

function syncHidden() {
  // 配置框编辑态：隐藏输入框内容由 syncCfgHidden 维护，位置仍贴在 agent 输入行即可
  if (focus === 'agent' && panels.agent.inConfig) {
    syncCfgHidden();
    panels.shell.focus = false;
    panels.agent.focus = true;
    return;
  }
  const p = activeInputPanel();
  const r = p.rect;
  if (!r) return;
  const iy = p === panels.shell ? r.y + r.h - 2 : r.y + r.h - 3;
  hidden.style.left = grid.px(r.x + 1) + 'px';
  hidden.style.top = grid.py(iy) + 'px';
  hidden.style.width = Math.max(40, grid.px(r.x + r.w - 1) - grid.px(r.x + 1)) + 'px';
  hidden.style.height = grid.cellH + 'px';
  hidden.style.fontSize = grid.fontSize + 'px';
  panels.shell.focus = focus === 'shell';
  panels.agent.focus = focus === 'agent';
}

// ── 真终端按键 → 控制序列（xterm 惯例，等同 eDEX-UI 交给 xterm.js 的那一套）
const PTY_KEYS = {
  Enter: '\r', Tab: '\t', Escape: '\x1b', Backspace: '\x7f',
  Delete: '\x1b[3~', Insert: '\x1b[2~',
  Home: '\x1b[H', End: '\x1b[F',
  PageUp: '\x1b[5~', PageDown: '\x1b[6~',
  ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D',
  F1: '\x1bOP', F2: '\x1bOQ', F3: '\x1bOR', F4: '\x1bOS',
  F5: '\x1b[15~', F6: '\x1b[17~', F7: '\x1b[18~', F8: '\x1b[19~',
  F9: '\x1b[20~', F10: '\x1b[21~', F11: '\x1b[23~', F12: '\x1b[24~',
};

// 真终端输入：把隐藏输入框里刚攒下的一小段立刻倒进 PTY 并清空（做句柄是为了
// compositionend 和 input 两条路径复用同一份逻辑，避免中文被送两次或丢尾巴）
function drainToPty() {
  if (focus !== 'shell' || !panels.shell.inPty()) return;
  const typed = hidden.value;
  if (typed) panels.shell.ptyType(typed);
  hidden.value = '';
  mood.touch();
}

hidden.addEventListener('input', (e) => {
  // 配置框编辑态：把隐藏输入框的内容写进当前字段（按钮态不接受文本）
  if (focus === 'agent' && panels.agent.inConfig) {
    const a = panels.agent;
    if (a.form.idx >= 0 && a.form.idx < a.form.fields.length) a.form.fields[a.form.idx].value = hidden.value;
    else hidden.value = '';
    mood.touch();
    return;
  }
  // 真终端模式：不在本地攒行。隐藏输入框只当 IME 合成面，敲/合成出来一个字符就立刻
  // 倒进 PTY（eDEX-UI 就是 xterm.onData → pty.write），回显与行编辑交给 shell 自己。
  if (focus === 'shell' && panels.shell.inPty()) {
    // 合成中先不动：IME 还没定稿，此刻送进去的是拼音串。真正的结果是 compositionend /
    // 随后的 input 事件，那时再把整段中文倒进 PTY。
    if (e && e.isComposing) { mood.touch(); return; }
    drainToPty();
    return;
  }
  const p = activeInputPanel();
  p.input = hidden.value;
  p.caret = hidden.selectionStart ?? p.input.length;
  mood.touch();                          // 打字不等于情绪，只防"长时间无活动"误判
});
hidden.addEventListener('keydown', (e) => {
  // 配置框编辑态：拦截 Tab/↑↓/Enter/Esc 走表单导航；其余按键（含中文 IME）照常进隐藏输入框
  if (focus === 'agent' && panels.agent.inConfig) {
    const a = panels.agent;
    if (e.isComposing) return;
    if (e.key === 'Tab' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); a.configNav(e.key === 'ArrowUp' ? -1 : 1); syncCfgHidden();
    } else if (e.key === 'Enter') {
      e.preventDefault(); a.configEnter(); syncCfgHidden();
    } else if (e.key === 'Escape') {
      e.preventDefault(); if (a.llmConfigured) a.configClose();
    }
    return;
  }
  // ── 真终端：裸直通。只有 Ctrl+Shift+E 留给界面（退出真终端），其余按键一律按真实
  //    终端序列转发 —— python REPL 的补全/历史、vim、top、ssh 才真的能用。
  if (focus === 'shell' && panels.shell.inPty()) {
    if (e.isComposing) return;                        // IME 合成中不抢
    if (e.ctrlKey && e.shiftKey && (e.key === 'E' || e.key === 'e')) {
      e.preventDefault();
      panels.shell.leavePty('已退出真终端，回到管道模式。');
      return;
    }
    // Alt+字符 → ESC + 字符（xterm 的 meta 惯例）
    if (e.altKey && !e.ctrlKey && e.key.length === 1) {
      e.preventDefault();
      panels.shell.ptyKey('\x1b' + e.key);
      return;
    }
    // Ctrl+字母 → 标准控制码 ^A..^Z（^C 中断 / ^D EOF / ^L 清屏 / ^R 反搜 / ^A ^E 行首行尾…）
    if (e.ctrlKey && !e.altKey && /^[a-zA-Z]$/.test(e.key)) {
      e.preventDefault();
      panels.shell.ptyKey(String.fromCharCode(e.key.toLowerCase().charCodeAt(0) - 96));
      return;
    }
    const seq = PTY_KEYS[e.key];
    if (seq !== undefined) { e.preventDefault(); panels.shell.ptyKey(seq); return; }
    // 可打印字符：就在 keydown 里转发，不等 input 事件。
    // 原因是中文 IME 开启时浏览器会把字母吞进合成缓冲 —— keydown 的 keyCode 变成 229、
    // e.key 变成 'Process'，input 事件根本不发（或被 isComposing 挡掉），于是"打字没反应，
    // 只有标点（IME 直接上屏的那些）能进"。这里绕开 input：非 IME 的按键按 e.key 直接送。
    if (e.keyCode !== 229 && !e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
      e.preventDefault();
      panels.shell.ptyType(e.key);
      return;
    }
    // 到这儿只剩"IME 正在处理"这一种情况：交给 composition 事件（见下方监听器）
  }
  const p = activeInputPanel();
  if (e.isComposing) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    const text = hidden.value;
    hidden.value = ''; p.input = ''; p.caret = 0;
    if (focus === 'shell') panels.shell.exec(text);
    else panels.agent.send(text);
  } else if (e.key === 'Tab') {
    e.preventDefault();
    focus = focus === 'shell' ? 'agent' : 'shell';
    hidden.value = activeInputPanel().input;
    syncHidden();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    if (focus === 'shell') panels.shell.abort(); else panels.agent.abort();
  } else if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
    // 终端惯例：Ctrl+C = 中断。真终端里转发 ^C 给 PTY（杀当前程序），
    // 管道模式里中止正在跑的命令；agent 面板则停止生成。
    e.preventDefault();
    if (focus === 'shell') panels.shell.abort(); else panels.agent.abort();
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const dir = e.key === 'ArrowUp' ? 1 : -1;
    const p = focus === 'shell' ? panels.shell : panels.agent;
    p.onArrow(dir);
    // 面板可能改了输入（shell 翻历史）：同步到隐藏输入框，回车才发得出翻出来的命令
    if (!(focus === 'agent' && panels.agent.inConfig)) {
      hidden.value = p.input || '';
      try { hidden.setSelectionRange(hidden.value.length, hidden.value.length); } catch (err) { /* 忽略 */ }
    }
  }
  if (e.ctrlKey && (e.key === 'm' || e.key === 'M')) {
    e.preventDefault();
    const i = MOOD_KEYS.indexOf(mood.key);
    mood.force(MOOD_KEYS[(i + 1) % MOOD_KEYS.length]);
  }
});

// IME 定稿（中文/日文候选落地）：立刻把最终整段文本送进真终端。
// 光靠 input 事件不行——合成期间的 input 会把拼音串当正文发出去。
// ── 中文 IME：合成期间在终端光标处显示拼音预览（不发给程序，拼音不是正文），
//    定稿（compositionend）才把最终文本送进 PTY。这是 xterm.js / VSCode 的做法。
hidden.addEventListener('compositionstart', () => {
  if (focus === 'shell' && panels.shell.inPty()) panels.shell.ime = '';
});
hidden.addEventListener('compositionupdate', (e) => {
  if (focus === 'shell' && panels.shell.inPty()) panels.shell.ime = e.data || '';
});
hidden.addEventListener('compositionend', (e) => {
  if (focus === 'shell' && panels.shell.inPty()) {
    const t = (e && e.data) || hidden.value || '';
    if (t) panels.shell.ptyType(t);
    panels.shell.ime = null;
    hidden.value = '';
    mood.touch();
    return;
  }
  drainToPty();
});

// ── 鼠标：拖拽分割条 / 拖地球 / 点表情标签 / 滚轮
function cellAt(e) {
  const b = canvas.getBoundingClientRect();
  return { x: grid.gx(e.clientX - b.left), y: grid.gy(e.clientY - b.top) };
}
function inRect(r, c) { return r && c.x >= r.x && c.x < r.x + r.w && c.y >= r.y && c.y < r.y + r.h; }

canvas.addEventListener('mousedown', (e) => {
  const c = cellAt(e);
  hidden.focus();
  if (inRect(rects.s1, c)) { dragSplit = { k: 's1', x: c.x }; return; }
  if (inRect(rects.s2, c)) { dragSplit = { k: 's2', x: c.x }; return; }
  if (inRect(rects.hsplit, c)) { dragSplit = { k: 'h', y: c.y }; return; }
  if (panels.globe.hit(c.x, c.y)) { panels.globe.onDown(c.x, c.y); return; }
  if (panels.char) {
    const key = panels.char.chipAt(c.x, c.y);
    if (key) { mood.force(key); return; }
  }
  if (inRect(rects.shell, c)) { focus = 'shell'; syncHidden(); return; }
  if (inRect(rects.agent, c)) {
    focus = 'agent';
    const a = panels.agent;
    if (a.inConfig) { a.configMouse(c); syncHidden(); return; }
    // 点输入行：聚焦并把光标放到点击位置，鼠标也能输入对话
    const iy = a.rect.y + a.rect.h - 3, x0 = a.rect.x + 3;
    if (c.y === iy) {
      const ci = Math.max(0, Math.min(a.input.length, c.x - x0));
      a.caret = ci; hidden.value = a.input;
      try { hidden.selectionStart = hidden.selectionEnd = ci; } catch (e) {}
    }
    syncHidden();
    return;
  }
});
window.addEventListener('mousemove', (e) => {
  if (!dragSplit && !panels.globe.dragging) return;
  const c = cellAt(e);
  if (dragSplit) {
    if (dragSplit.k === 's1') L.left = Math.max(20, Math.min(grid.cols - 40, L.left + (c.x - dragSplit.x)));
    else if (dragSplit.k === 's2') {
      const d = c.x - dragSplit.x;
      L.right = Math.max(20, Math.min(grid.cols - 50, L.right - d));
    } else if (dragSplit.k === 'h') {
      const d = c.y - dragSplit.y;
      L.topH = Math.max(0.2, Math.min(0.8, L.topH + d / Math.max(1, grid.rows - 5)));
    }
    layout(); syncHidden();
    dragSplit.x = c.x; dragSplit.y = c.y;
    return;
  }
  panels.globe.onMove(c.x, c.y);
});
window.addEventListener('mouseup', () => { dragSplit = null; panels.globe.onUp(); });
canvas.addEventListener('wheel', (e) => {
  const c = cellAt(e);
  const p = inRect(rects.shell, c) ? panels.shell : inRect(rects.agent, c) ? panels.agent : null;
  if (p && p.onWheel(e.deltaY)) { e.preventDefault(); return; }
  if (panels.globe.hit(c.x, c.y)) {
    if (panels.globe.onWheel(e.deltaY, e.deltaX)) e.preventDefault();
  }
}, { passive: false });

// ── 主循环
let sys = null, last = performance.now(), t = 0, fps = 0;
let bootAt = 0;                 // 进场动画起点（performance.now 时钟）
let openDur = 0.55;            // 每个面板“框从中心向外展开”的时长（秒），?bootdur=N 可覆盖
let contentDur = 0.5;          // 框展开后“内容淡入”的时长（秒），随 ?bootdur 同步
const OPEN_DELAY = { globe: 0, shell: 0.12, char: 0.06, sys: 0.2, agent: 0.16 };
let tokWindow = [], tokRate = 0;
setInterval(() => { tokRate = tokWindow.length; tokWindow = []; }, 1000);   // 粗估 tok/s
async function pollSys() {
  try { sys = await sysSnapshot(); } catch (e) { /* 后端没起来就保持上次数据 */ }
  setTimeout(pollSys, 1000);
}

// ── 网络地理：本机公网出口 + DNS 递归解析器，交给 GLOBE 面板打点
async function pollNet() {
  let delay = 5 * 60 * 1000;
  try {
    const g = await netgeo();
    panels.globe.setGeo(g);
    // 后端刚起来 / 网络正连着时数据还没到，下次早点补
    if (!g.self || !(g.dns || []).length) delay = 15000;
  } catch (e) { delay = 15000; }   // 后端没起来：装饰模式顶着，很快再试
  setTimeout(pollNet, delay);
}

// shell 输出里冒出来的公网 IP → 在地球上点一下（eDEX 的原版交互）
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
function looksPublic(ip) {
  const m = ip.match(/^(\d+)\.(\d+)\./);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  return true;
}
function scanIps(line) {
  const found = line.match(IP_RE);
  if (!found) return;
  for (const ip of found) {
    if (!looksPublic(ip)) continue;
    panels.globe.noteIp(ip);          // 面板内部去重 + 打后端地理查询
  }
}

// ── 进场动画：面板框从中心向两侧 / 上下展开，展开完成后才画内容 ──
function drawOpeningBox(g, r, o, orient, T) {
  if (!r || r.w < 2 || r.h < 2) return;
  let bx, by, bw, bh;
  if (orient === 'h') {                  // 横框：宽度从中心向左右展开，高度已满
    const cx = r.x + Math.floor(r.w / 2);
    bw = Math.max(1, Math.round(r.w * o));
    bx = cx - Math.floor(bw / 2);
    by = r.y; bh = r.h;
  } else {                               // 竖框：高度从中心向上下展开，宽度已满
    const cy = r.y + Math.floor(r.h / 2);
    bh = Math.max(1, Math.round(r.h * o));
    by = cy - Math.floor(bh / 2);
    bx = r.x; bw = r.w;
  }
  g.fill(bx, by, bw, bh, ' ', T.accent, T.panel);   // 实心面板从中心“长”出来
  if (bw >= 2 && bh >= 2) {
    g.set(bx, by, '┌', T.accent, T.panel);
    g.set(bx + bw - 1, by, '┐', T.accent, T.panel);
    g.set(bx, by + bh - 1, '└', T.accent, T.panel);
    g.set(bx + bw - 1, by + bh - 1, '┘', T.accent, T.panel);
    g.text(bx + 1, by, '─'.repeat(bw - 2), T.accent, T.panel);
    g.text(bx + 1, by + bh - 1, '─'.repeat(bw - 2), T.accent, T.panel);
    for (let yy = by + 1; yy < by + bh - 1; yy++) {
      g.set(bx, yy, '│', T.accent, T.panel);
      g.set(bx + bw - 1, yy, '│', T.accent, T.panel);
    }
  }
}
function drawPanel(p, g, C) {
  if (!p) return;
  const o = (p.open === undefined) ? 1 : p.open;
  if (o < 1) {                           // 展开中：只画框（边框清晰），不画内容；easeOut 让框“冲出后收住”
    drawOpeningBox(g, p.rect, 1 - (1 - o) * (1 - o), p.orient || 'h', C.theme);
    return;
  }
  // 展开完成：边框已经清晰，内容再“淡入”（颜色从融进背景渐变到正常）
  g.fadeBg = C.theme.panel;
  g.fade = (p.contentFade === undefined || p.contentFade >= 1) ? 1 : p.contentFade;
  p.draw(g, C);
  if (p === panels.char && p.ensureFrame) p.ensureFrame(Math.min(rects.char.w - 2, 40), t);
  g.fade = 1;                            // 复位，避免影响分割条 / 标题栏
}

function drawChrome(T) {
  const cols = grid.cols, rows = grid.rows;
  const model = panels.agent && panels.agent.llmConfigured ? 'local · 已接 LLM' : 'local · 未接 LLM';
  const left = '▚ PONKO HUD   GLOBE · SHELL · AGENT · MOOD · SYS';
  grid.text(0, 0, left, T.accent, T.bg);
  const host = sys ? `${sys.user}@${sys.host}` : 'offline';
  const clock = new Date().toTimeString().slice(0, 8);
  let right = `${host}   ${clock}   ${fps | 0}fps`;
  grid.text(Math.max(0, cols - right.length), 0, right, T.dim, T.bg);
  grid.text(0, 1, '─'.repeat(cols), T.line, T.bg);

  const by = rows - 2;
  grid.text(0, by, '─'.repeat(cols), T.line, T.bg);
  const f = focus === 'shell' ? 'SHELL' : 'AGENT';
  const tip = `▚ 输入焦点=${f} · 地球拖拽旋转 · IP 栏自动横滚 · 配置框可鼠标点 · 分割条可拖`;
  grid.text(0, by + 1, tip, T.dim, T.bg);
  const keys = `[TAB]切换 [ESC]中断 [^M]心情 [滚轮]滚动`;
  grid.text(Math.max(0, cols - keys.length), by + 1, keys, T.darker, T.bg);
}

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now; t += dt;
  fps = fps * 0.9 + (1 / Math.max(1e-3, dt)) * 0.1;
  mood.tick(dt);

  const T = themeFor(mood.key);
  grid.clear(T.text, T.bg);
  grid.fill(0, 0, grid.cols, grid.rows, ' ', T.text, T.bg);

  const C = { theme: T, sys, mood, t, dt, tokRate };
  // 进入真终端时自动把输入焦点切到 shell：否则字会打到 AGENT 输入框（以前踩过这个坑）
  const inPtyNow = panels.shell.inPty();
  if (inPtyNow && !prevPty) { focus = 'shell'; syncHidden(); }
  prevPty = inPtyNow;
  // 进场动画：推进每个面板的展开进度（easeOut，框冲出后收住）
  const elapsed = (now - bootAt) / 1000;
  for (const k in panels) {
    const p = panels[k];
    if (!p || p.open === undefined) continue;
    if (p.open < 1) {
      const local = Math.max(0, elapsed - (p.delay || 0));
      p.open = Math.min(1, local / openDur);
    } else if (p.contentFade !== undefined && p.contentFade < 1) {
      p.contentFade = Math.min(1, p.contentFade + dt / contentDur);
    }
  }
  drawPanel(panels.sys, grid, C);
  drawPanel(panels.globe, grid, C);
  drawPanel(panels.shell, grid, C);
  drawPanel(panels.agent, grid, C);
  drawPanel(panels.char, grid, C);

  // 分割条
  for (const k of ['s1', 's2']) {
    const r = rects[k];
    if (!r) continue;
    for (let y = r.y; y < r.y + r.h; y++) grid.set(r.x, y, '│', T.line, T.bg);
  }
  const hr = rects.hsplit;
  if (hr) grid.text(hr.x, hr.y, '╌'.repeat(hr.w), T.line, T.bg);

  drawChrome(T);
  grid.render();

  requestAnimationFrame(frame);
}

// ── 启动
async function boot() {
  const q = new URLSearchParams(location.search);
  bootAt = performance.now();            // 进场动画计时起点
  const bd = parseFloat(q.get('bootdur'));   // 调试：?bootdur=N 拉长/缩短进场动画（默认 0.55s）
  if (!Number.isNaN(bd) && bd > 0) { openDur = bd; contentDur = bd; }
  // ?mood=think          手动覆盖（调试）
  // ?local=1             shell 成败允许反向影响心情（默认关闭：那是 agent 的活）
  // ?nofallback=1        连"长时间无 agent 活动→瞌睡"的兜底也关掉，完全听 agent
  if (q.get('mood')) mood.force(q.get('mood'));
  if (q.get('local') === '1') mood.localSignals = true;
  if (q.get('nofallback') === '1') mood.autoFallback = false;
  try { packs = await loadPacks(); } catch (e) { packs = []; }
  pack = packs[0] || null;
  if (pack) {
    mood.setFaces(pack.tags());           // 让面板能提示 agent 指定的表情是否收录
    panels.char = new CharPanel(mood, pack);
  }
  panels.agent.onToken = () => tokWindow.push(1);
  panels.shell.onLine = scanIps;
  // 调试：?hscroll=N 让地球面板 IP 说明初始横向偏移 N 列（验证左右滚动用，永久固定不自动）
  const hs = parseInt(q.get('hscroll'), 10);
  if (!Number.isNaN(hs)) { panels.globe._manualTarget = hs; panels.globe._manualUntil = 1e12; }
  // 调试：?sphase=T 把自动跑马灯的累计时钟直接设到 T 秒（验证缓动起停用），例如 ?sphase=1 看刚起步、?sphase=7.5 看将到末端
  const sp = parseFloat(q.get('sphase'));
  if (!Number.isNaN(sp)) { panels.globe._autoClock = sp; panels.globe._frozen = true; }
  window.addEventListener('resize', () => { grid.resize(); layout(); syncHidden(); });
  layout(); syncHidden(); hidden.focus();
  pollSys();
  pollNet();
  requestAnimationFrame(frame);
  // 调试入口：?demo=1 自动跑一轮（shell 真命令 + agent 假流式）
  //            ?demo=pty 自动进真终端跑一次 python REPL（看 VT 渲染对不对）
  if (q.get('demo')) {
    if (q.get('demo') === 'pty') {
      setTimeout(() => panels.shell.exec('python'), 900);
      setTimeout(() => panels.shell.sendToPty('print("中文 6*7 =", 6*7)'), 7000);
      return;
    }
    const asCmd = q.get('shell') === 'cmd';
    if (asCmd) {
      // 演示 CMD 模式：切换 → cd 中文目录 → 列目录 → 触发一次错误退出码
      setTimeout(() => panels.shell.exec('cmd'), 500);
      setTimeout(() => panels.shell.exec('cd "C:\\Users\\Administrator\\WorkBuddy\\智能Agent\\PonkoHUD"'), 1100);
      setTimeout(() => panels.shell.exec('dir /b'), 1700);
      setTimeout(() => panels.shell.exec('echo 中文正常 显示测试'), 2300);
    } else {
      setTimeout(() => panels.shell.exec('cd C:\\Users\\Administrator\\WorkBuddy; Get-ChildItem -Directory | Select-Object -First 3 -ExpandProperty Name'), 600);
      setTimeout(() => panels.shell.exec('Resolve-DnsName www.qq.com -Type A -ErrorAction SilentlyContinue | Select-Object -ExpandProperty IPAddress'), 1500);
    }
    setTimeout(() => panels.agent.send('帮我看下构建为什么失败'), 1400);
  }
}
boot();
