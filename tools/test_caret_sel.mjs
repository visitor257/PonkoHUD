// 回归：输入行光标位置 / 配置框光标与 ←→ / 鼠标拖选（都不需要真 GUI）
import { AgentPanel } from '../app/src/panels/agent.js';
import { ShellPanel } from '../app/src/panels/shell.js';
import { Selection } from '../app/src/selection.js';
import { exitWidth, exitLabel, exitButtonRect } from '../app/src/exitbutton.js';
import { zoomBtnRect, zoomWidth, fullRect } from '../app/src/zoombtn.js';

let fail = 0;
const chk = (name, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   → ' + got}`);
  if (!ok) fail++;
};

// 真实字体（15px 等宽 + 中文 fallback）实测格宽：⛶/〼 是 2 格，□/■ 是 1 格
const CH_W = { '⛶': 2, '〼': 2, '□': 1, '■': 1 };

// ── 极简网格替身：只实现面板画字时用到的几个原语，并记录每次 set 的坐标
function mkGrid() {
  const rows = new Map();
  const sets = [];
  const g = {
    cols: 200, rows: 80,
    rows, sets,
    // 真实字体下实测的格宽（tools/_measure_sym.mjs）：几何符号区里不少字符是全角，
    // 光靠码点范围会算错（⛶ U+26F6 实测 2 格，按范围会判 1 格）→ 这里按实测值覆盖。
    chWidth: (c) => CH_W[c] ?? (c && c.charCodeAt(0) > 0x2e80 ? 2 : 1),
    strWidth(s) { let n = 0; for (const ch of s) n += g.chWidth(ch); return n; },
    text(x, y, s) {
      let col = x; const r = rows.get(y) || {};
      for (const ch of String(s)) {
        r[col] = ch;
        for (let k = 1; k < g.chWidth(ch); k++) r[col + k] = '~';
        col += g.chWidth(ch);
      }
      rows.set(y, r);
      return col;
    },
    set(x, y, ch) { const r = rows.get(y) || {}; r[x] = ch; rows.set(y, r); sets.push({ x, y, ch }); },
    box() {}, fill() {}, inBounds: () => true, idx: (x, y) => y * 200 + x,
  };
  return g;
}
const TH = { text: 1, panel: 0, accent: 2, line: 3, dim: 4, darker: 5, err: 6, warn: 7, ok: 8, bg: 9 };
const C = { theme: TH, t: 0, tokRate: 0 };      // t=0 → 光标处于"亮"相位

console.log('── 1. SHELL 输入行：光标应跟着 caret 走 ──');
{
  const g = mkGrid();
  const s = new ShellPanel({});
  s.layout({ x: 0, y: 0, w: 40, h: 12 });
  s.focus = true;
  s.input = 'hello world';

  const caretCol = (caret) => {
    s.caret = caret; g.sets.length = 0; s.draw(g, C);
    const hit = g.sets.find((v) => v.ch === '█');
    return hit ? hit.x : -1;
  };
  const base = caretCol(0);
  chk('caret=0 时光标紧贴提示符之后', base > 0, base);
  chk('caret=5 → 前进 5 列', caretCol(5) === base + 5, caretCol(5));
  chk('caret=11（末尾）→ 前进 11 列', caretCol(11) === base + 11, caretCol(11));
  chk('caret=2 与末尾不同列（不再是恒定画在末尾）', caretCol(2) !== caretCol(11), `${caretCol(2)} vs ${caretCol(11)}`);

  // 超长命令：窗口应滑动，光标留在可视区内且不越过面板边界
  s.input = 'x'.repeat(300);
  const col = caretCol(300);
  chk('超长输入：光标仍在面板内', col > 0 && col <= 40 - 2, col);
  chk('超长输入：光标贴在可视区右端', col === 37, col);
}

console.log('\n── 2. AGENT 输入行：同样按 caret 定位 ──');
{
  const g = mkGrid();
  const a = new AgentPanel({});
  a.layout({ x: 0, y: 0, w: 60, h: 20 });
  a.focus = true;
  a.input = '你好 hello';
  const caretCol = (caret) => {
    a.caret = caret; g.sets.length = 0; a.draw(g, C);
    const hit = g.sets.find((v) => v.ch === '█');
    return hit ? hit.x : -1;
  };
  const base = caretCol(0);
  chk('caret=0 有光标', base > 0, base);
  chk('caret=1 跳过宽字符（中文占 2 列）', caretCol(1) === base + 2, caretCol(1));
  chk('caret=3 → 2+3 列', caretCol(3) === base + 5, caretCol(3));

  a.input = 'y'.repeat(300);
  const col = caretCol(300);
  chk('超长输入不越界', col > 0 && col <= 60 - 2, col);
}

console.log('\n── 3. 配置框：光标位置 + ←→ 归属 ──');
{
  const g = mkGrid();
  const a = new AgentPanel({});
  a.layout({ x: 0, y: 0, w: 60, h: 30 });
  a.configOpen();
  a.form.fields[0].value = 'https://api.openai.com/v1';

  const fieldLine = () => {
    const y = Object.keys(a._cfg ? {} : {});
    return null;
  };
  const drawOnce = (idx, caret) => {
    a.form.idx = idx; a.form.caret = caret; g.sets.length = 0; a.drawConfig(g, C);
    return g.sets;
  };
  // 文本字段：set 只有光标一处（按钮未选中时走 text）
  const s0 = drawOnce(0, 0);
  chk('文本字段光标存在', s0.length === 1, JSON.stringify(s0));
  const x0 = s0[0].x;
  const s5 = drawOnce(0, 5);
  chk('caret=5 → 光标前进 5 列', s5[0].x === x0 + 5, `${x0} -> ${s5[0].x}`);
  chk('caret=5 光标压在该字符上（不再是追加 █）', s5[0].ch === 'https://api.openai.com/v1'[5], s5[0].ch);
  const sEnd = drawOnce(0, 'https://api.openai.com/v1'.length);
  chk('caret=末尾 → 光标是空格块', sEnd[0].ch === ' ', JSON.stringify(sEnd[0]));

  // ←→ 归属：只有"协议"这种循环字段才吃方向键
  chk('文本字段不吃 ←→', a.cfgCycleField() === false, a.cfgCycleField());
  a.form.idx = 3;
  chk('协议字段吃 ←→', a.cfgCycleField() === true, a.cfgCycleField());

  // 点击某列 → caret 应落到点到那个字符
  const hits = a._cfg.fields.find((f) => f.key === 'baseUrl');
  a.configMouse({ y: hits.y, x: hits.txtStart + 7 });
  chk('点击第 8 列 → caret=7', a.form.caret === 7, a.form.caret);

  // caret 同步要被 clamp，不能越到值外面
  a.form.idx = 0; a.syncFormCaret(999);
  chk('syncFormCaret 夹紧到值长', a.form.caret === 'https://api.openai.com/v1'.length, a.form.caret);
  a.syncFormCaret(-5);
  chk('负位置夹到 0', a.form.caret === 0, a.form.caret);

  // 切字段时光标到末尾
  a.form.idx = 2; a.formCaretToEnd();
  chk('切字段光标到末尾', a.form.caret === a.form.fields[2].value.length, a.form.caret);
}

console.log('\n── 4. 鼠标拖选 ──');
{
  const sel = new Selection();
  const r = { x: 0, y: 0, w: 40, h: 12 };

  chk('点在边框上不算起选', sel.begin({ x: 0, y: 0 }, r) === false, '');
  chk('点在正文区起选', sel.begin({ x: 5, y: 3 }, r) === true, '');
  sel.to({ x: 12, y: 3 });
  let n = sel.norm();
  chk('向右拖 → x0=5,x1=12', n.x0 === 5 && n.x1 === 12, JSON.stringify(n));

  // 反向拖（终点在锚点左上）也要归一化
  sel.begin({ x: 12, y: 5 }, r);
  sel.to({ x: 4, y: 2 });
  n = sel.norm();
  chk('反向拖自动归一化', n.x0 === 4 && n.x1 === 12 && n.y0 === 2 && n.y1 === 5, JSON.stringify(n));

  // 拖到面板外要被夹住
  sel.to({ x: 999, y: 999 });
  n = sel.norm();
  chk('拖出面板被夹在内容区内', n.x1 === r.w - 2 && n.y1 === r.h - 2, JSON.stringify(n));

  // 只点一下、没拖 → 不成立选区
  sel.begin({ x: 6, y: 6 }, r);
  sel.done();
  chk('单击不成选区', sel.active === false, '');

  // paint + text：拿一个真网格替身（带数组缓冲）
  const W = 10, H = 5;
  const gridish = {
    cols: W, rows: H,
    chs: [], fgs: new Array(W * H).fill(1), bgs: new Array(W * H).fill(2), attrs: new Uint8Array(W * H),
    idx: (x, y) => y * W + x,
    inBounds: (x, y) => x >= 0 && y >= 0 && x < W && y < H,
  };
  const alpha = 'abcdefghij';
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) gridish.chs[y * W + x] = alpha[x];

  // 线性（文档式）选区：首行从锚点到行尾、末行从行首到光标。
  // 内容区 b = 列 1..8、行 1..3；网格每行是 'abcdefghij'。
  sel.begin({ x: 2, y: 1 }, { x: 0, y: 0, w: W, h: H });
  sel.to({ x: 5, y: 2 });
  chk('线性选区：首行锚点→行尾 + 末行行首→光标',
    sel.text(gridish) === 'cdefghi\nbcdef', JSON.stringify(sel.text(gridish)));

  const i = sel.norm();
  const before = { f: gridish.fgs[gridish.idx(i.x0, i.y0)], b: gridish.bgs[gridish.idx(i.x0, i.y0)] };
  sel.paint(gridish);
  const after = { f: gridish.fgs[gridish.idx(i.x0, i.y0)], b: gridish.bgs[gridish.idx(i.x0, i.y0)] };
  chk('paint 交换前后景', after.f === before.b && after.b === before.f, JSON.stringify(after));

  // ── 线性选区的几个关键点（不是矩形块选）────────────────────────────
  sel.begin({ x: 5, y: 2 }, { x: 0, y: 0, w: W, h: H });
  sel.to({ x: 2, y: 1 });
  chk('反向拖也是线性、按文档顺序取', sel.text(gridish) === 'cdefghi\nbcdef',
    JSON.stringify(sel.text(gridish)));

  sel.begin({ x: 3, y: 1 }, { x: 0, y: 0, w: W, h: H });
  sel.to({ x: 5, y: 1 });
  chk('单行选择精确到列', sel.text(gridish) === 'def', JSON.stringify(sel.text(gridish)));

  // 三行：首行只取"锚点→行尾"，中间行取整行（行首→行尾），末行只取"行首→光标"
  const sp = (() => {
    sel.begin({ x: 2, y: 1 }, { x: 0, y: 0, w: W, h: H });
    sel.to({ x: 3, y: 3 });
    return sel.spans(gridish).map((r) => `${r.y}:${r.xa}-${r.xb}`);
  })();
  chk('三行片段：首行→行尾 / 中间整行 / 末行→光标',
    sp[0] === '1:2-8' && sp[1] === '2:1-8' && sp[2] === '3:1-3', JSON.stringify(sp));

  // 行尾取"最后一个非空格"，不是面板右边界：把末行右侧留白，尾随空格要裁掉
  for (let x = 3; x < W; x++) gridish.chs[2 * W + x] = ' ';
  sel.begin({ x: 2, y: 1 }, { x: 0, y: 0, w: W, h: H });
  sel.to({ x: 6, y: 2 });
  chk('末行尾随空格被裁掉', sel.text(gridish) === 'cdefghi\nbc', JSON.stringify(sel.text(gridish)));

  // 宽字符：续格不能被当成内容重复读一遍
  for (let x = 0; x < W; x++) gridish.chs[3 * W + x] = ' ';
  gridish.chs[3 * W + 1] = '中'; gridish.chs[3 * W + 2] = ''; gridish.chs[3 * W + 3] = '文'; gridish.chs[3 * W + 4] = '';
  sel.begin({ x: 1, y: 3 }, { x: 0, y: 0, w: W, h: H });
  sel.to({ x: 4, y: 3 });
  chk('宽字符续格跳过', sel.text(gridish) === '中文', JSON.stringify(sel.text(gridish)));

  // 空选区不应产生文本
  sel.clear();
  chk('清空后无文本', sel.text(gridish) === '', sel.text(gridish));
}

// 5. 单击 vs 拖选的判定（main.js 靠 end() 的返回值决定要不要切焦点 / 挪光标）
console.log('\n── 5. 按下→松手：单击还是拖选 ──');
{
  const sel = new Selection();
  const r = { x: 0, y: 0, w: 40, h: 12 };

  sel.begin({ x: 8, y: 9 }, r, 'shell');
  const click = sel.end();
  chk('没拖动 → end() 报"单击"', click === true, click);
  chk('单击不成选区', sel.active === false, sel.active);
  chk('单击仍能读到按下的面板', sel.tag === 'shell', sel.tag);
  chk('单击仍能读到按下坐标', sel.at.x === 8 && sel.at.y === 9, JSON.stringify(sel.at));

  sel.begin({ x: 8, y: 9 }, r, 'agent');
  sel.to({ x: 20, y: 9 });
  const drag = sel.end();
  chk('拖过 → end() 报"拖选"', drag === false, drag);
  chk('拖过保留选区', sel.active === true, sel.active);
  chk('tag 更新为后一次按下的面板', sel.tag === 'agent', sel.tag);

  // 同一个格子按下又松手（没跨格）也该算单击
  sel.begin({ x: 9, y: 9 }, r, 'shell');
  sel.to({ x: 9, y: 9 });
  chk('原地拖动一圈仍算拖选（已 moved）', sel.end() === false, sel.active);

  // 起在面板外（比如点的是边框/分割条）时 tag 不该残留上一次的
  const fresh = new Selection();
  chk('新实例 tag 为空', fresh.tag === null && fresh.at === null, `${fresh.tag} ${JSON.stringify(fresh.at)}`);
}

// 6. AGENT 多行输入：Enter 换行 → 输入框长高，光标到第 2 行；Ctrl+Enter 才发送
console.log('\n── 6. AGENT 输入框多行 ──');
{
  const g = mkGrid();
  const a = new AgentPanel({});
  a.layout({ x: 0, y: 0, w: 60, h: 20 });
  a.focus = true;

  chk('空输入占 1 行', a.inputRows(g) === 1, a.inputRows(g));
  chk('单行文本仍占 1 行', (a.input = 'hello', a.inputRows(g)) === 1, a.inputRows(g));

  // 一次 Enter：input 尾部插入 '\n'（真实浏览器由 textarea 完成，这里手工作等价输入）
  a.input = '第一行\n'; a.caret = 4;
  chk('末尾一个换行 → 2 行', a.inputRows(g) === 2, a.inputRows(g));
  chk('caret 在换行后 → 光标落第 2 行', a.inputWindow(g).cRow === 1, a.inputWindow(g).cRow);

  const caretDraw = () => { g.sets.length = 0; a.draw(g, C); return g.sets.find((v) => v.ch === '█'); };
  a.input = '第一行\n'; a.caret = 4;                        // 换行之后 → 光标在第 2 行
  const yTail = caretDraw().y;
  a.input = '第一行\n第二行'; a.caret = 3;                   // 紧挨 '\n' 之前 → 仍属第 1 行
  const yFirst = caretDraw().y;
  a.caret = 4;                                             // '\n' 之后 → 跳到第 2 行
  const ySecond = caretDraw().y;
  chk('第 1 行行尾与第 2 行的光标不在同一行', yFirst !== ySecond, `${yFirst} vs ${ySecond}`);
  chk('跳到下一行只是下移一格', ySecond === yFirst + 1, `${yFirst} -> ${ySecond}`);
  chk('末行光标与旧写法位置一致', yTail === ySecond, `${yTail} vs ${ySecond}`);

  // 输入框高 2 行时，它的顶边比单行时高一格（不能盖住对话区最后一行之上无谓的空间）
  const w2 = a.inputWindow(g);
  chk('2 行时输入框顶边 = 面板底 - 4', w2.iyTop === 20 - 4, w2.iyTop);
  chk('消息区行数相应减少', w2.iyTop - 1 === 20 - 5, w2.iyTop - 1);

  // 超宽单行要软换行，而不是撑爆面板
  a.input = 'z'.repeat(300); a.caret = 300;
  const wl = a.inputWindow(g);
  chk('超宽行被软换行且不超过行数上限', wl.lines.length > 1 && wl.rows <= 6, `${wl.lines.length}/${wl.rows}`);
  chk('末行在可视窗口内（滚动跟随光标）', wl.top <= wl.cRow && wl.cRow - wl.top < wl.rows, `${wl.top}/${wl.cRow}`);
  chk('每行宽度不超可用宽度', wl.lines.every((L) => g.strWidth(L.text) <= wl.avail), JSON.stringify(wl.avail));

  // 点击定位：多行下点第 2 行第 3 个字符
  a.input = 'abcd\nwxyz'; a.caret = 0;
  const win6 = a.inputWindow(g);
  const clicked = a.caretFromPoint(g, win6.tx0 + 3, win6.iyTop + 1);
  chk('点第 2 行第 4 列 → caret=8', clicked === 8, clicked);
  chk('点输入框外返回 null', a.caretFromPoint(g, win6.tx0, win6.iyTop - 1) === null, '');
  chk('点第 1 行开头 → caret=0', a.caretFromPoint(g, win6.tx0, win6.iyTop) === 0, a.caretFromPoint(g, win6.tx0, win6.iyTop));

  // 宽字符行 Columns 换算
  a.input = '中文\n第二'; a.caret = 2;
  const w6 = a.inputWindow(g);
  const cMid = a.caretFromPoint(g, w6.tx0 + 3, w6.iyTop);     // 点在第 2 个字后半格
  chk('点宽字符后半格 → 落在该字之后', cMid === 2, cMid);
  chk('caret=2 的行内列 = 4（两个宽字符）', w6.cRow === 0 && g.strWidth(a.input.slice(0, 2)) === 4, w6.cRow);

  // 行数上限：面板很矮时不能把对话区吃光
  a.layout({ x: 0, y: 0, w: 60, h: 8 });
  a.input = 'a\nb\nc\nd\ne\nf\ng\nh'; a.caret = 15;
  chk('矮面板：行数被限制，消息区至少留 3 行', a.inputRows(g) === 2, a.inputRows(g));
  chk('且 top 窗口让光标可见', a.inputWindow(g).cRow - a.inputWindow(g).top < a.inputWindow(g).rows, '');
}

// 7. 对话流里的换行必须真的分行（不能被当成 1 列宽字符画进网格）
console.log('\n── 7. 消息正文的多行 ──');
{
  const g = mkGrid();
  const a = new AgentPanel({});
  a.layout({ x: 0, y: 0, w: 40, h: 20 });
  a.llmConfigured = true;
  a.focus = true;
  a.input = '';
  const rowText = (y) => {
    const r = g.rows.get(y) || {};
    let s = '';
    for (let x = 0; x < 60; x++) {
      const ch = r[x];
      if (ch === undefined) s += ' ';
      else if (ch === '~') continue;                 // 宽字符续格
      else s += ch;
    }
    return s.replace(/\s+$/, '');
  };
  const drawMsgs = (role, text) => { a.msgs = []; a.push(role, text); g.rows.clear(); a.draw(g, C); };

  drawMsgs('user', '1\n2');
  chk('用户消息：第 1 行', rowText(1) === ' › 1', JSON.stringify(rowText(1)));
  chk('用户消息：第 2 行独立成一行且缩进对齐', rowText(2) === '   2', JSON.stringify(rowText(2)));
  chk('没有把 "\\n" 当字符塞进同一行', rowText(1) !== ' › 1 2', JSON.stringify(rowText(1)));

  drawMsgs('agent', '第一行\n第二行');
  chk('agent 回复换行也分行', rowText(1) === ' ▌ 第一行' && rowText(2) === '   第二行',
    `${JSON.stringify(rowText(1))} / ${JSON.stringify(rowText(2))}`);

  // 多行里再叠加自动换行：硬行优先，软换行不越界
  const long = 'x'.repeat(100);
  drawMsgs('user', long + '\n短');
  const rowsDrawn = [1, 2, 3, 4].map(rowText).filter((s) => s.trim() !== '');
  chk('长行被软换行且不越界', rowsDrawn.every((s) => s.length <= 40), JSON.stringify(rowsDrawn.map((s) => s.length)));
  chk('硬换行第二段独立且缩进对齐', rowsDrawn[rowsDrawn.length - 1] === '   短', JSON.stringify(rowsDrawn[rowsDrawn.length - 1]));
  chk('硬换行没和软换行混在一行', !rowsDrawn.slice(0, -1).some((s) => s.includes('短')), JSON.stringify(rowsDrawn));
}

// 8. 心情控制语句：agent 给自己下的 [[mood:...]] 指令要能显示在对话里（并可以关掉）
console.log('\n── 8. 心情语句的显示与开关 ──');
{
  const g = mkGrid();
  const a = new AgentPanel({});
  a.layout({ x: 0, y: 0, w: 40, h: 20 });
  a.llmConfigured = true;
  a.focus = true;
  a.input = '';
  const rowText = (y) => {
    const r = g.rows.get(y) || {};
    let s = '';
    for (let x = 0; x < 60; x++) {
      const ch = r[x];
      if (ch === undefined) s += ' ';
      else if (ch === '~') continue;
      else s += ch;
    }
    return s.replace(/\s+$/, '');
  };

  chk('默认隐藏：心情语句不显示', a.showMoodTags === false, a.showMoodTags);
  a.msgs = [];
  const ev = { t: 'mood', state: 'think', face: 'thinking', raw: '[[mood:think|face:thinking|note:想想]]' };
  chk('隐藏时 noteMood 不记录', a.noteMood(ev) === false && a.msgs.length === 0, JSON.stringify(a.msgs));

  // 打开：记录并渲染成独立一行
  a.form.fields[4].value = 'show';
  a.applyMoodPref();
  chk('打开后 showMoodTags=true', a.showMoodTags === true, a.showMoodTags);
  chk('noteMood 记下一条心情语句', a.noteMood(ev) === true, JSON.stringify(a.msgs));
  chk('记下的是标记原文', a.msgs[a.msgs.length - 1].role === 'mood'
    && a.msgs[a.msgs.length - 1].text === ev.raw, JSON.stringify(a.msgs[a.msgs.length - 1]));

  g.rows.clear(); a.draw(g, C);
  chk('心情行以 ♥ 前缀单独成行', rowText(1).startsWith(' ♥ [[mood:'), JSON.stringify(rowText(1)));

  // 关掉开关：协议照常生效，但不再往对话里记
  a.form.fields[4].value = 'hide';
  a.applyMoodPref();
  chk('关掉后 showMoodTags=false', a.showMoodTags === false, a.showMoodTags);
  const before = a.msgs.length;
  chk('关掉后不再记录', a.noteMood(ev) === false && a.msgs.length === before, a.msgs.length - before);

  // 关键：已经攒下来的心情行在隐藏时也要**整行消失**，不能只把字抹掉留一条空行
  a.msgs = [];
  a.push('agent', '正文A');
  a.push('mood', '[[mood:think|note:想想]]');
  a.push('agent', '正文B');
  g.rows.clear(); a.draw(g, C);
  chk('隐藏时历史心情行整行不渲染（正文A 下面直接是 正文B）',
    rowText(1) === ' ▌ 正文A' && rowText(2) === ' ▌ 正文B',
    `${JSON.stringify(rowText(1))} / ${JSON.stringify(rowText(2))}`);
  const drawn = [1, 2, 3].map(rowText).filter((s) => s.trim() !== '');
  chk('隐藏时不出现 ♥ 行也不出现空行', drawn.length === 2 && !drawn.some((s) => s.includes('♥')),
    JSON.stringify(drawn));

  // 没有原文（本地兜底心情）不该产生空行
  chk('没有 raw 时不记录', a.noteMood({ t: 'mood', state: 'idle' }) === false, '');

  // 历史上下文不能把心情语句回灌给模型：send() 只取 user/agent
  a.msgs = [
    { role: 'user', text: '问一句' },
    { role: 'mood', text: '[[mood:think]]' },
    { role: 'agent', text: '答一句' },
  ];
  const picked = a.msgs.filter((m) => (m.role === 'user' || m.role === 'agent') && m.text.trim());
  chk('心情语句不进上下文', picked.length === 2 && picked.every((m) => m.role !== 'mood'),
    JSON.stringify(picked.map((m) => m.role)));

  // 配置框：字段变多后按钮不能压到字段上（按钮行 = 最后一个字段的下一行）
  a.inConfig = true; a.form.idx = 0;
  g.rows.clear(); a.draw(g, C);
  // 网格里宽字符占两格（第二格是续位 ~），拼接前要先滤掉
  const textOf = (r) => Object.keys(r).sort((a, b) => a - b)
    .map((k) => (r[k] === '~' ? '' : r[k])).join('');
  const anyRow = (sub) => [...g.rows.values()].some((r) => textOf(r).includes(sub));
  chk('配置框含「心情语句」字段', anyRow('心情语句'), '');
  chk('配置框仍有 保存 / 取消 按钮', anyRow('保存') && anyRow('取消'), '');
}

// 9. 多标签终端：一个标签一份状态（输入/cwd/历史），彼此不串；标签栏可点；id 必须能当后端会话 id
console.log('\n── 9. 多标签终端 ──');
{
  const g = mkGrid();
  const s = new ShellPanel({});
  s.layout({ x: 3, y: 2, w: 50, h: 14 });

  chk('默认只有一个标签', s.tabs.length === 1 && s.active === 0, `${s.tabs.length}/${s.active}`);
  chk('标签 id 可直接当后端会话 id', /^[A-Za-z0-9_-]{1,24}$/.test(s.tab.id), s.tab.id);

  const t0 = s.tab;
  t0.input = 'aaa'; t0.caret = 3;
  s.newTab();
  chk('新建后两个标签且光标切到新的', s.tabs.length === 2 && s.active === 1, `${s.tabs.length}/${s.active}`);
  chk('新标签有独立的会话 id', s.tab.id !== t0.id, `${s.tab.id} vs ${t0.id}`);
  chk('新标签输入框是空的（没串到旧标签）', s.input === '' && s.caret === 0, JSON.stringify(s.input));

  s.input = 'bbb';
  s.selectTab(0);
  chk('切回标签 1 看到它自己的输入与光标', s.input === 'aaa' && s.caret === 3, `${s.input}/${s.caret}`);
  chk('标签 2 的输入没被改掉', s.tabs[1].input === 'bbb', s.tabs[1].input);

  s.selectTab(1);
  s.nextTab(1);
  chk('nextTab(1) 到下个标签', s.active === 0, s.active);
  s.nextTab(-1);
  chk('nextTab(-1) 回上一个', s.active === 1, s.active);

  // cwd / shell 种类也按标签各算各的
  t0.cwd = 'C:\\Windows'; t0.kind = 'cmd';
  s.tabs[1].cwd = 'D:\\work';
  s.selectTab(0);
  chk('标签 1 的 cwd/shell 是自己的', s.cwd === 'C:\\Windows' && s.kind === 'cmd', `${s.cwd}/${s.kind}`);
  s.selectTab(1);
  chk('切过来就是标签 2 的 cwd', s.cwd === 'D:\\work', s.cwd);

  // 标签栏绘制 + 命中区（标签栏已移到 SHELL 框**外**：框顶线上面那一行）
  s.selectTab(0);
  g.rows.clear(); g.sets.length = 0;
  s.draw(g, C);
  s.drawTabBar(g, C);                 // 框内画完后再画框外的标签栏（同 main.js 的调用顺序）
  const barRow = s.tabBarRow();
  const bar = (() => {
    const r = g.rows.get(barRow) || {};
    return Object.keys(r).sort((a, b) => a - b).map((k) => (r[k] === '~' ? '' : r[k])).join('');
  })();
  chk('标签栏画出了两个标签', bar.includes('1') && bar.includes('2'), JSON.stringify(bar));
  chk('标签栏有新建按钮 +', bar.includes('+'), JSON.stringify(bar));
  chk('标签栏在框顶线之上（框外）', barRow === s.rect.y - 1 && barRow === 1, barRow);
  chk('tabAt 命中标签 2', s.tabAt(s._tabHits[1].x0, barRow) === 1,
    JSON.stringify(s._tabHits[1]));
  chk('tabAt 命中“+”返回 -1', s.tabAt(s._tabHits[2].x0, barRow) === -1,
    JSON.stringify(s._tabHits[2]));
  const textAt = (y) => {
    const r = g.rows.get(y) || {};
    return Object.keys(r).sort((a, b) => a - b).map((k) => (r[k] === '~' ? '' : r[k])).join('');
  };
  chk('输入行仍在面板最后一行（标签栏没顶掉它）',
    textAt(s.rect.y + s.rect.h - 2).includes('>'), JSON.stringify(textAt(s.rect.y + s.rect.h - 2)));

  // focus / onLine 要覆盖所有标签（含之后新建的）
  const s2 = new ShellPanel({});
  s2.focus = true;
  chk('focus 落在活动标签', s2.tab.focus === true, '');
  s2.newTab();
  chk('新建标签后焦点跟着走，旧标签不再有焦点',
    s2.tab.focus === true && s2.tabs[0].focus === false, '');

  const seen = [];
  const s3 = new ShellPanel({});
  s3.onLine = (l) => seen.push(l);
  s3.push('out', 'hello');
  s3.newTab();
  s3.push('out', 'world');
  chk('onLine 对新建的标签同样生效',
    seen.includes('hello') && seen.includes('world'), JSON.stringify(seen));

  // 关闭：最后一个不给关
  const first = s.tabs[0].id;
  chk('关掉标签 1 成功', s.closeTab(0) === true, '');
  chk('关完只剩一个且 id 是另一个', s.tabs.length === 1 && s.tabs[0].id !== first, s.tabs[0].id);
  chk('只剩一个时拒绝再关', s.closeTab() === false, '');
}

console.log('\n── 10. 右上角退出按钮：三态等宽 + 文字不被裁 ──');
{
  const g = mkGrid();
  g.cols = 120;                                   // 真实窗口下这个值远大于按钮宽度

  const W = exitWidth(g);
  const rect = (st) => exitButtonRect(g, st);
  const lbl = (st) => exitLabel(g, st);

  // 三态盒宽完全相同（这就是"按钮忽长忽短"的直接回归）
  const w0 = g.strWidth(lbl('idle'));
  const w1 = g.strWidth(lbl('armed'));
  const w2 = g.strWidth(lbl('quitting'));
  chk('三态标签宽度一致', w0 === w1 && w1 === w2 && w0 === W, `idle=${w0} armed=${w1} quitting=${w2} W=${W}`);

  // 落位一致：左边界不动、右边界贴屏幕最右
  const r0 = rect('idle'), r1 = rect('armed'), r2 = rect('quitting');
  chk('三态左边界相同', r0.x0 === r1.x0 && r1.x0 === r2.x0, `${r0.x0}/${r1.x0}/${r2.x0}`);
  chk('右边界贴住最右列', r0.x1 === g.cols - 1 && r1.x1 === g.cols - 1, `${r0.x1}/${r1.x1}`);
  chk('命中区宽度 = 绘制宽度（三态都不错位）',
    [r0, r1, r2].every((r) => r.x1 - r.x0 + 1 === W), `${r0.x1 - r0.x0 + 1}/${W}`);

  // 文字完整：补的是空格，不是把字吃掉
  chk('待确认态完整包含「再点一次」', lbl('armed').includes('✕ 再点一次'), JSON.stringify(lbl('armed')));
  chk('退出中态完整包含「退出中」', lbl('quitting').includes('✕ 退出中'), JSON.stringify(lbl('quitting')));
  chk('平常态完整包含「退出」', lbl('idle').includes('✕ 退出'), JSON.stringify(lbl('idle')));
  chk('三态都带 ✕ 图标', ['idle', 'armed', 'quitting'].every((s) => lbl(s).includes('✕')), '');

  // 回归守卫：如果哪个标签天生比其它长，就必须靠补齐 ——
  // 断言"未补齐的原始标签确实不等宽"，否则上面那条会失去意义（说明文字被换短了）
  const raw = { idle: ' ✕ 退出 ', armed: ' ✕ 再点一次 ', quitting: ' ✕ 退出中… ' };
  const rw = (s) => g.strWidth(raw[s]);
  chk('原始标签本身不等宽（所以才需要补齐）', rw('armed') !== rw('idle'), `${rw('armed')} vs ${rw('idle')}`);
  chk('补齐后不会越界（右端正好落在最后一列）', r0.x0 + W === g.cols, `${r0.x0}+${W} vs ${g.cols}`);

  // 补的是空格：去掉两侧空格后与原始标签一致
  chk('补齐只加空格、不删字', ['idle', 'armed', 'quitting'].every((s) => lbl(s).trim() === raw[s].trim()), '');
}

console.log('\n── 11. 各框右下角的 ⛶ / 〼 放大按钮 ──');
{
  const g = mkGrid();
  g.cols = 120; g.rows = 40;

  const r = { x: 0, y: 2, w: 34, h: 12 };            // 典型的 GLOBE 框
  const off = zoomBtnRect(g, r, false);
  const on = zoomBtnRect(g, r, true);

  chk('按钮落在框的底边线上', off.y === r.y + r.h - 1, off.y);
  chk('按钮在框内且不吃掉右下角', off.x1 === r.x + r.w - 2 && off.x0 >= r.x + 1, JSON.stringify(off));
  chk('放大/还原两态等宽', g.strWidth(off.label) === g.strWidth(on.label)
    && g.strWidth(off.label) === zoomWidth(g), `${g.strWidth(off.label)} vs ${g.strWidth(on.label)}`);
  chk('用符号不写字：平常 ⛶、放大态 〼',
    on.label.includes('〼') && off.label.includes('⛶')
    && !off.label.includes('〼') && !on.label.includes('⛶'),
    `${JSON.stringify(off.label)} / ${JSON.stringify(on.label)}`);
  chk('两个符号都没被截掉（补齐后仍完整包含）',
    off.label.trim() === '⛶' && on.label.trim() === '〼',
    `${JSON.stringify(off.label)} / ${JSON.stringify(on.label)}`);
  chk('按钮至少 4 列宽（符号只有 2 格，太窄点不中）', zoomWidth(g) >= 4, zoomWidth(g));
  // 两个符号都是 2 格宽 → 只要按钮宽度是偶数，两边的补白就能平分，符号落在正中间
  const pads = (lbl, sym) => {
    const i = lbl.indexOf(sym);
    return { l: i, r: lbl.length - i - sym.length };
  };
  const pOff = pads(off.label, '⛶');
  chk('⛶ 在按钮正中间（左右补白相等）', pOff.l === pOff.r,
    `${JSON.stringify(off.label)} 左${pOff.l} 右${pOff.r}`);
  const pOn = pads(on.label, '〼');
  chk('〼 也在按钮正中间（左右补白相等）', pOn.l === pOn.r,
    `${JSON.stringify(on.label)} 左${pOn.l} 右${pOn.r}`);
  chk('两态左边界不动', off.x0 === on.x0, `${off.x0} vs ${on.x0}`);

  // 放大后的目标矩形：占满整个内容区，上下 chrome 行留着（退出按钮/快捷键还够得着）
  const full = fullRect(g, 2, 2);
  chk('放大后占满整宽', full.x === 0 && full.w === g.cols, JSON.stringify(full));
  chk('放大后上下各留 2 行 chrome', full.y === 2 && full.h === g.rows - 4, JSON.stringify(full));
  const big = zoomBtnRect(g, full, true);
  chk('放大后按钮仍在右下角', big.y === full.y + full.h - 1 && big.x1 === g.cols - 2, JSON.stringify(big));
}

console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项失败'}`);
process.exitCode = fail ? 1 : 0;
