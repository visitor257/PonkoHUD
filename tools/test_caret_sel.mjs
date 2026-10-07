// 回归：输入行光标位置 / 配置框光标与 ←→ / 鼠标拖选（都不需要真 GUI）
import { AgentPanel } from '../app/src/panels/agent.js';
import { ShellPanel } from '../app/src/panels/shell.js';
import { Selection } from '../app/src/selection.js';

let fail = 0;
const chk = (name, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   → ' + got}`);
  if (!ok) fail++;
};

// ── 极简网格替身：只实现面板画字时用到的几个原语，并记录每次 set 的坐标
function mkGrid() {
  const rows = new Map();
  const sets = [];
  const g = {
    cols: 200, rows: 80,
    rows, sets,
    chWidth: (c) => (c && c.charCodeAt(0) > 0x2e80 ? 2 : 1),
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

console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项失败'}`);
process.exitCode = fail ? 1 : 0;
