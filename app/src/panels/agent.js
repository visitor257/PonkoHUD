// AGENT：对话流（thinking 块 / tool_call 卡 / 流式回复）+ 底部状态条
//        未接入 LLM 时，面板正中弹配置框（API 地址 / Key / 模型 + 保存）
import { ATTR } from '../grid.js';
import { askAgent, getLlmConfig, saveLlmConfig, testLlmConfig } from '../api.js';

// 作为上下文回灌给 LLM 的近期消息条数（约等于一半轮数的对话）
const MAX_CTX_MSGS = 20;

export class AgentPanel {
  constructor(mood) {
    this.rect = null;
    this.mood = mood;
    this.msgs = [];             // {role:'user'|'agent'|'think'|'tool', text, done}
    this.busy = false;
    this.tokens = 0;
    this.scroll = 0;
    this.input = '';
    this.caret = 0;
    this.focus = true;
    this._cancel = null;
    this.llmConfigured = false; // 后端是否配好了真 LLM
    this.inConfig = false;      // 是否正在显示配置框
    this._clearHidden = null;   // main.js 注入：关闭配置框时清空隐藏输入框
    this.form = {
      fields: [
        { key: 'baseUrl', label: 'API地址', value: '', ph: 'https://api.openai.com/v1', mask: false },
        { key: 'apiKey', label: 'API Key', value: '', ph: 'sk-...', mask: true },
        { key: 'model', label: '模型名', value: '', ph: 'gpt-3.5-turbo', mask: false },
        // 循环选择字段（←→ 切换，不接受文本输入）：
        // auto=两种协议各试一次谁通用谁；openai/anthropic=手动指定，跳过识别
        {
          key: 'provider', label: '协议', value: 'auto', mask: false, cycle: true,
          opts: [['auto', '自动识别'], ['openai', 'OpenAI 兼容'], ['anthropic', 'Anthropic']],
        },
        // 心情控制语句 [[mood:...]] 是否原样显示在对话里（默认隐藏：多数时候只看正文；
        // 想确认 agent 给自己下了什么指令时再打开）。它只影响显示，不影响协议本身 ——
        // 隐藏是**整行不渲染**，不是把文字抹成空白（那会留下一条空行）。
        {
          key: 'moodTags', label: '心情语句', value: 'hide', mask: false, cycle: true,
          opts: [['show', '显示'], ['hide', '隐藏']],
        },
      ],
      idx: -1,                 // -1 未编辑；0..3 字段；4 保存；5 取消
      caret: 0,                // 当前字段里的光标位置（字符索引）
      msg: '',
      busy: false,
    };
    // 心情语句显示开关：本地偏好，不进 LLM 配置（跟后端无关），存 localStorage
    this.showMoodTags = readMoodPref();
    this.form.fields[4].value = this.showMoodTags ? 'show' : 'hide';
    this.push('agent', '已就绪。左边敲 shell 命令，这儿直接跟我说话。');
    // 启动即拉一次后端配置：没配过就自动弹配置框
    getLlmConfig().then((s) => {
      if (!s) return;
      this.llmConfigured = !!s.configured;
      if (s.baseUrl) this.form.fields[0].value = s.baseUrl;
      if (s.model) this.form.fields[2].value = s.model;
      if (s.provider) this.form.fields[3].value = normProvider(s.provider);
      if (!this.llmConfigured) this.configOpen();
    }).catch(() => { this.configOpen(); });
  }

  // ── 配置框 ────────────────────────────────────────
  configOpen() {
    this.inConfig = true;
    this.form.idx = 0;
    this.form.bad = false;
    this.form.msg = '填地址 / Key / 模型后回车保存（会先验证连通）';
    if (this._clearHidden) this._clearHidden();   // 清空可能残留的聊天输入框文本
  }
  configClose() {
    this.inConfig = false;
    this.form.idx = -1;
    this.form.msg = '';
    if (this._clearHidden) this._clearHidden();   // 清掉残留的字段文本，免得污染聊天输入框
  }
  configNav(dir) {
    const n = this.form.fields.length + 2;     // 4 字段 + 保存 + 取消
    this.form.idx = (this.form.idx + dir + n) % n;
  }
  // 循环字段（协议 / 心情语句）：←→ 在候选值里转一圈
  configCycle(dir) {
    const f = this.form.fields[this.form.idx];
    if (!f || !f.cycle || !f.opts) return;
    const i = f.opts.findIndex((o) => o[0] === f.value);
    const n = (i + dir + f.opts.length) % f.opts.length;
    f.value = f.opts[n][0];
    if (f.key === 'moodTags') this.applyMoodPref();     // 立刻生效，不用等保存
  }

  /** 把配置框里的「心情语句」选择落到运行时偏好并记住 */
  applyMoodPref() {
    const f = this.form.fields.find((x) => x.key === 'moodTags');
    this.showMoodTags = (f ? f.value : 'hide') === 'show';   // 兜底也走隐藏，跟默认值一致
    writeMoodPref(this.showMoodTags);
  }
  // 当前字段是否接受文本输入（循环字段不接受，交给 ←→）
  cfgFieldEditable() {
    const f = this.form.fields[this.form.idx];
    return !!(f && !f.cycle);
  }
  /** 当前字段是不是"循环选择"型（协议）——只有它才吃 ←→ */
  cfgCycleField() {
    const f = this.form.fields[this.form.idx];
    return !!(f && f.cycle);
  }
  /** 隐藏输入框的光标变了（←→ / Home / End / 点击），同步到当前字段 */
  syncFormCaret(pos) {
    const f = this.form.fields[this.form.idx];
    if (!f || f.cycle) return;
    const n = (f.value || '').length;
    this.form.caret = Math.max(0, Math.min(n, pos ?? n));
  }
  /** 切到另一个字段时，光标默认停在该字段末尾 */
  formCaretToEnd() {
    const f = this.form.fields[this.form.idx];
    this.form.caret = f ? (f.value || '').length : 0;
  }
  configEnter() {
    const b = this.form.fields.length;
    if (this.form.idx >= 0 && this.form.idx < b) {
      // 字段上回车：最后一个字段→跳到保存按钮，否则下一个字段
      this.form.idx = (this.form.idx === b - 1) ? b : this.form.idx + 1;
    } else if (this.form.idx === b) {
      this.configSave();
    } else if (this.form.idx === b + 1) {
      if (this.llmConfigured) this.configClose();
    }
  }
  // 保存前必须先连通验证；验证不过就**不写盘**——只放过一个真能用的配置
  async configSave() {
    if (this.form.busy) return;
    const get = (k) => {
      const f = this.form.fields.find((x) => x.key === k);
      return (f ? f.value : '').trim();
    };
    const body = {
      baseUrl: get('baseUrl'),
      apiKey: get('apiKey'),
      model: get('model'),
      provider: normProvider(get('provider')),
    };
    if (!body.baseUrl || !body.apiKey) { this.form.bad = true; this.form.msg = '地址和 Key 都不能为空'; return; }

    this.form.busy = true;
    this.form.bad = false;
    this.form.msg = '正在验证连接…';
    let t;
    try { t = await testLlmConfig(body); } catch (e) { t = { ok: false, error: String(e.message) }; }

    if (!t || !t.ok) {
      // 验证失败：保留原输入框内容让用户改，已有配置（若之前配通过）不受影响
      this.form.busy = false;
      this.form.bad = true;
      this.form.msg = '连接失败：' + ((t && t.error) || '未知错误');
      return;
    }

    try {
      // 自动识别成功时把认出来的协议一起存下来，之后对话就不用再猜
      if (t && t.provider) body.resolved = t.provider;
      const r = await saveLlmConfig(body);
      this.llmConfigured = !!(r && r.configured);
      if (this.llmConfigured) {
        if (r.baseUrl) this.form.fields[0].value = r.baseUrl;
        if (r.model) this.form.fields[2].value = r.model;
        this.form.busy = false;
        this.form.bad = false;
        const via = t.via === 'models' ? ' · 模型已核对' : '';
        const pname = t.provider ? ` · ${providerLabel(t.provider)}` : '';
        this.form.msg = `验证通过（${t.ms}ms${via}${pname}）✓ 已保存`;
        setTimeout(() => {
          this.configClose();
          this.push('info', `已接入 LLM（${r.model || ''}），直接跟我说吧。`);
        }, 900);
      } else { this.form.busy = false; this.form.bad = true; this.form.msg = '保存失败：缺少字段'; }
    } catch (e) { this.form.busy = false; this.form.bad = true; this.form.msg = '保存出错：' + e.message; }
  }

  // 鼠标点击配置框：命中字段→聚焦该字段；命中保存/取消→执行对应动作
  configMouse(c) {
    const h = this._cfg;
    if (!h) return false;
    for (const fd of h.fields) {
      if (c.y === fd.y && c.x >= fd.x0 && c.x < fd.x1) {
        this.form.idx = this.form.fields.findIndex((f) => f.key === fd.key);
        // 循环字段：点 ‹ 往回翻、点 › 往后翻，点中间的文字只是聚焦
      // cols 只在文本字段上有值（循环字段没有 text 区，见 drawConfig）
      if (fd.cycle) {
        if (c.x < fd.txtStart) this.configCycle(-1);
        else if (c.x >= fd.txtEnd + 1) this.configCycle(1);
      } else if (fd.cols) {
        const rel = c.x - fd.txtStart;
        // 点在字符起始列 → 光标落在它**前面**；点在后半格（宽字符）→ 落在它后面
        let i = 0;
        for (let k = 0; k < fd.cols.length; k++) { if (fd.cols[k] < rel) i = k + 1; else break; }
        this.form.caret = Math.min(fd.val.length, fd.off + i);
      }
        return true;
      }
    }
    if (c.y === h.save.y && c.x >= h.save.x0 && c.x < h.save.x1) { this.configSave(); return true; }
    if (c.y === h.cancel.y && c.x >= h.cancel.x0 && c.x < h.cancel.x1) {
      if (this.llmConfigured) this.configClose();
      else this.form.msg = '未配置时不能取消';
      return true;
    }
    return false;
  }

  layout(r) { this.rect = r; }

  // ── 多行输入 ─────────────────────────────────────────────────
  // Enter 换行 / Ctrl+Enter 发送，所以输入框要能容多行：先按 '\n' 切硬行，
  // 每行再按面板宽度软换行；caret 落在（第几显示行, 第几列）由此推出。
  // 行数超过上限时以光标所在行为准开一个纵向滚动窗口。
  inputLines(g, w) {
    const out = [];
    let base = 0;
    for (const seg of this.input.split('\n')) {
      for (const p of wrapIndexed(g, seg, w)) out.push({ text: p.text, start: base + p.start });
      base += seg.length + 1;
    }
    return out;
  }

  /** 输入框最多占几行（给上方对话至少留 3 行） */
  maxInputRows() {
    const r = this.rect;
    if (!r) return 1;
    return Math.max(1, Math.min(6, r.h - 6));
  }

  /** 当前输入应该占几行（供 main.js 同步隐藏输入框的高度） */
  inputRows(g) {
    if (this.inConfig || !this.rect) return 1;
    const avail = Math.max(4, this.rect.w - 5);
    return Math.min(this.maxInputRows(), Math.max(1, this.inputLines(g, avail).length));
  }

  /** 输入框的显示布局：可视行、滚动偏移、文本起始列… 绘制和点击定位共用一份算法 */
  inputWindow(g) {
    const r = this.rect;
    const x = r.x + 1, iw = r.w - 2;
    const tx0 = x + 2, avail = Math.max(1, iw - 3);
    const lines = this.inputLines(g, avail);
    const rows = Math.min(this.maxInputRows(), Math.max(1, lines.length));
    const caret = Math.max(0, Math.min(this.caret, this.input.length));
    let cRow = 0;
    for (let i = 0; i < lines.length; i++) { if (lines[i].start <= caret) cRow = i; else break; }
    let top = 0;
    if (cRow >= rows) top = cRow - rows + 1;
    if (top > lines.length - rows) top = Math.max(0, lines.length - rows);
    return { lines, rows, top, cRow, iyTop: r.y + r.h - 3 - (rows - 1), tx0, avail, x, iw, caret };
  }

  /** 鼠标点在哪一格 → 对应的字符索引（点了输入框外返回 null） */
  caretFromPoint(g, cx, cy) {
    if (!this.rect) return null;
    const w = this.inputWindow(g);
    if (cy < w.iyTop || cy > this.rect.y + this.rect.h - 3) return null;
    const L = w.lines[w.top + (cy - w.iyTop)];
    if (!L) return this.input.length;
    const rel = cx - w.tx0;
    let acc = 0, i = 0;
    for (; i < L.text.length; i++) {
      const cw = g.chWidth(L.text[i]);
      if (rel < acc + cw) { if (rel > acc) i++; break; }   // 点在后半格（宽字符）→ 落在该字符之后
      acc += cw;
    }
    return L.start + i;
  }
  push(role, text) {
    this.msgs.push({ role, text: String(text || ''), t: performance.now() });
    if (this.msgs.length > 300) this.msgs.splice(0, this.msgs.length - 300);
  }

  /** 把 agent 的心情控制语句记进对话流（开关关掉就不记，协议本身照常生效） */
  noteMood(e) {
    if (!this.showMoodTags) return false;
    if (!e || !e.raw) return false;              // 没有原文（本地兜底心情）就没什么可显示的
    this.push('mood', e.raw);
    return true;
  }

  send(text) {
    const t = text.trim();
    if (!t || this.busy) return;
    if (!this.llmConfigured) { this.configOpen(); return; }   // 没接 LLM：先弹配置框
    this.push('user', t);
    this.busy = true;
    this.tokens = 0;
    this.mood.touch();            // 用户活动只记时间戳，情绪不该由界面推断
    // 近期对话作为上下文发给真 LLM（剥掉 [[mood:...]] 标记，别把情绪回灌给模型）。
    // 两个必须小心的地方：
    //   ① 后端会自己把本次提问追加到 messages 末尾，所以这里要排除刚 push 的那条，
    //      否则同一句提问会被发两遍（模型的表现是复读 / 答非所问）。
    //   ② 这条 history 必须真的传给 askAgent —— 之前漏传，导致每轮都是全新会话，
    //      用户体感就是"对面完全没有记忆"。
    const history = this.msgs
      .slice(0, -1)
      .filter((m) => (m.role === 'user' || m.role === 'agent') && m.text.trim())
      .slice(-MAX_CTX_MSGS)
      .map((m) => ({ role: m.role, content: stripMood(m.text).trim() }))
      .filter((m) => m.content);
    this._cancel = askAgent(t, (e) => {
      switch (e.t) {
        case 'mood':
          // 心情是 agent 的声明直接落地：state 决定配色，face 决定角色立绘
          if (!this.mood.fromAgent(e)) break;
          this.moodTag = this.mood.face || this.mood.state;
          // 控制语句本身也显示出来（后端随心情事件带回 raw = 标记原文）：
          // 用户要看见 agent 到底给自己下了什么指令，而不是只看见被剥干净的正文。
          this.noteMood(e);
          break;
        case 'thinking':
          this.push('think', e.text);
          break;
        case 'tool':
          this.push('tool', `${e.name}(${e.arg})`);
          break;
        case 'tool_result': {
          const last = this.msgs[this.msgs.length - 1];
          if (last && last.role === 'tool') last.result = e.text;
          else this.push('tool', e.text);
          break;
        }
        case 'token': {
          if (this.onToken) this.onToken();
          let last = this.msgs[this.msgs.length - 1];
          if (!last || last.role !== 'agent' || last.streamDone) { this.push('agent', ''); last = this.msgs[this.msgs.length - 1]; last.stream = true; }
          last.text += e.text;
          this.tokens++;
          break;
        }
        case 'done': {
          this.busy = false;
          this.tokens = e.tokens || this.tokens;
          // 收尾心情：后端把本轮最后一条心情声明随 done 带回来，这里重新落地一次，
          // 让"输出过程中"声明的表情/配色在回复结束后继续站住（不会立刻回落成待机）。
          // agent 没声明就不替它收尾 —— 仍然是 agent 唯一权威。
          const fin = (e.mood && typeof e.mood === 'object') ? e.mood : e;
          if (fin && fin.state) {
            this.mood.fromAgent(fin);
            this.moodTag = this.mood.face || this.mood.state;
          }
          break;
        }
        case 'error':
          this.busy = false;
          this.push('think', '后端错误：' + e.text);
          this.mood.fromLocal('error', '连不上 agent 后端');   // 标清是本地兜底
          break;
      }
      this.scroll = 0;
    }, () => { this.busy = false; }, history);
  }

  abort() {
    if (!this.busy) return;
    try { this._cancel && this._cancel(); } catch (e) {}
    this.busy = false;
    this.push('think', '已中断');
  }

  draw(g, C) {
    const r = this.rect, T = C.theme;
    if (!r || r.w < 10 || r.h < 5) return;
    const hdr = !this.llmConfigured ? '未接LLM' : (this.busy ? 'streaming' : 'llm');
    g.box(r.x, r.y, r.w, r.h, this.focus ? T.accent : T.line, T.panel, 'AGENT', T.accent, hdr);
    if (this.inConfig) { this.drawConfig(g, C); return; }   // 配置框盖住对话区

    const x = r.x + 1, iw = r.w - 2;
    const win = this.inputWindow(g);
    const viewH = win.iyTop - (r.y + 1);        // 消息区行数（输入框变高就自动让位）

    // 展开成可显示行
    const lines = [];
    for (const m of this.msgs) {
      // 心情语句隐藏时是**整行不生成**（对已经攒下来的历史行同样生效）——
      // 只在绘制时把文字换成空白的话，对话里会留下一条莫名其妙的空行。
      if (m.role === 'mood' && !this.showMoodTags) continue;
      const pre = m.role === 'user' ? '› '
        : m.role === 'mood' ? '♥ '
        : m.role === 'think' ? '◐ '
        : m.role === 'tool' ? '⚙ ' : '▌ ';
      const col = m.role === 'user' ? T.accent
        : m.role === 'mood' ? T.warn
        : m.role === 'think' ? T.dim : m.role === 'tool' ? T.warn : T.text;
      // 正文里的 '\n' 必须切成硬行：直接喂给 wrapText 的话换行符会被当成 1 列宽的普通字符
      // 画进网格（用户发 "1\n2" 就显示成 "1  2"，换行丢了只剩一格空白）。
      // 续行前缀用等宽空格对齐，保证视觉上是一个块。
      const indent = ' '.repeat(g.strWidth(pre));
      // 心情标记被剥掉后，它占的那一行会留下一段纯空白 —— 3 个以上连续换行压成 2 个，
      // 免得回复里出现莫名其妙的一大段空行（正文里正常的单/双换行不受影响）。
      const parts = String(m.text).replace(/\n{3,}/g, '\n\n').split('\n');
      for (let pi = 0; pi < parts.length; pi++) {
        const wrap = wrapText(g, (pi === 0 ? pre : indent) + parts[pi], iw);
        for (const l of wrap) lines.push({ text: l, col, role: m.role });
      }
      if (m.result) {
        for (const l of String(m.result).split('\n').slice(0, 3)) {
          lines.push({ text: '  ✓ ' + l.slice(0, Math.max(0, iw - 4)), col: T.ok, role: 'tool' });
        }
      }
    }
    const start = Math.max(0, lines.length - viewH - this.scroll);
    let y = r.y + 1;
    for (let i = start; i < Math.min(lines.length, start + viewH); i++) {
      g.text(x, y, lines[i].text, lines[i].col, T.panel);
      y++;
    }
    while (y < win.iyTop) { g.text(x, y, ' '.repeat(iw), T.text, T.panel); y++; }

    // 输入框：整块用 panelHi 底色画成一个真输入框（之前只有孤零零一个 ▌，
    // 看不出哪里能打字 —— 用户报"能输入但没有输入框 UI"）。多行时向上长高。
    for (let k = 0; k < win.rows; k++) g.text(x, win.iyTop + k, ' '.repeat(iw), T.text, T.panelHi);
    g.text(x, win.iyTop, '▌', this.focus ? T.accent : T.dim, T.panelHi);
    const blink = this.focus && Math.floor(C.t * 2) % 2 === 0;
    for (let k = 0; k < win.rows; k++) {
      const idx = win.top + k;
      const L = win.lines[idx];
      const yy = win.iyTop + k;
      if (!this.input) {
        // 空输入：占位提示（暗色），按可用宽度截断
        let s = '', wsum = 0;
        for (const ch of '输入内容...（Ctrl+回车发送）') {
          const cw = g.chWidth(ch);
          if (wsum + cw > win.avail) break;
          s += ch; wsum += cw;
        }
        g.text(win.tx0, yy, s, T.darker, T.panelHi);
      } else if (L) {
        g.text(win.tx0, yy, L.text, T.text, T.panelHi);
      }
      // 光标跟着 caret 走（原来画在 g.text 的返回列，等于永远贴在末尾）
      if (blink && idx === win.cRow) {
        const col = win.tx0 + g.strWidth(L ? L.text.slice(0, win.caret - L.start) : '');
        if (col < r.x + r.w - 1) g.set(col, yy, '█', T.accent, T.accent);
      }
    }

    // 状态条
    const sy = r.y + r.h - 2;
    g.text(x, sy, '╌'.repeat(iw), T.line);
    const st = this.busy ? `流式输出中 · ${C.tokRate || 0} tok/s` : '待机';
    g.text(x, sy, ` ${st}`, this.busy ? T.accent : T.dim, T.panel);
    const right = `tokens ${this.tokens}  ¥0.00`;
    g.text(Math.max(0, r.x + r.w - 1 - g.strWidth(right)), sy, right, T.dim, T.panel);
  }

  onWheel(d) { this.scroll = Math.max(0, Math.min(400, this.scroll + (d > 0 ? -1 : 1))); return true; }
  onArrow(dir) { return this.onWheel(-dir); }

  // 配置框：在面板正中画一个表单（字段 + 保存/取消 + 状态），盖住对话区
  drawConfig(g, C) {
    const r = this.rect, T = C.theme;
    const x = r.x + 1, iw = r.w - 2;
    // 先把对话区刷成面板底色，避免文字从背后漏出来
    for (let yy = r.y + 1; yy < r.y + r.h - 1; yy++) g.text(x, yy, ' '.repeat(iw), T.text, T.panel);

    const cx = r.x + Math.floor((r.w - 2) / 2);
    const midY = r.y + Math.floor((r.h - 1) / 2);
    const title = '⚙ 接入 LLM';
    g.text(cx - Math.floor(title.length / 2), midY - 6, title, T.accent, T.panel);
    g.text(x + 2, midY - 5, '─'.repeat(Math.max(0, iw - 4)), T.line, T.panel);

    const f = this.form.fields;
    // 标签列宽取最长标签（'心情语句' 比 '协议' 宽），箭头与输入框才不会各歪一列
    const labelW = Math.max(1, ...f.map((x) => g.strWidth(x.label)));
    const rowHits = [];
    for (let k = 0; k < f.length; k++) {
      const field = f[k];
      const active = this.form.idx === k;
      let disp = field.value;
      let txtStart = 0, txtEnd = 0, off0 = 0;       // 文本区起止列（点击命中/定位光标）；off0 = 长值的滚动偏移
      let cols = null;                              // 每个可见字符的起始列（只有文本字段有）
      if (field.cycle) {
        // 箭头始终画出来（未选中也画，用暗色），否则用户看不出这两个字符是可点的
        const wOf = (s) => [...s].reduce((n, ch) => n + g.chWidth(ch), 0);
        // 按最长候选名占列：切换时 › 的位置要恒定，否则鼠标点一次就得换个地方点
        const maxW = Math.max(1, ...(field.opts || []).map((o) => wOf(o[1])));
        const txt = cycleLabel(field, disp);
        const txtW = wOf(txt);
        const base = x + 2 + 2 + labelW;            // 行首 = 光标(1) + 空格(1) + 标签列
        txtStart = base + 2;
        txtEnd = txtStart + maxW;
        // 文本在固定宽度的格子内居中：箭头位置不动，同时名字也不会偏到一边
        const padL = Math.max(0, Math.floor((maxW - txtW) / 2));
        const padR = Math.max(0, maxW - txtW - padL);
        const cell = ' '.repeat(padL) + txt + ' '.repeat(padR);
        g.text(x + 2, midY - 3 + k, `${active ? '▸' : ' '} ${padToWidth(g, field.label, labelW)}`, active ? T.accent : T.text, T.panel);
        g.text(base, midY - 3 + k, '‹', active ? T.accent : T.dim, T.panel);
        g.text(txtStart, midY - 3 + k, cell, active ? T.accent : T.text, T.panel);
        g.text(txtEnd + 1, midY - 3 + k, '›', active ? T.accent : T.dim, T.panel);
      } else {
        if (field.mask && !active) disp = '*'.repeat(Math.min(disp.length, 22));   // 非编辑态遮住 Key
        const lbl = padToWidth(g, field.label, labelW);
        const tx0 = x + 2 + 2 + labelW;        // 行 = 光标(1) + 空格(1) + 标签列
        const avail = Math.max(1, r.x + r.w - 1 - tx0 - 1);
        // 值长过一行就让可视窗口跟着光标滑，光标落在哪一列由 caret 决定
        const c = active ? Math.max(0, Math.min(disp.length, this.form.caret)) : 0;
        const off = Math.max(0, c - avail + 1);
        g.text(x + 2, midY - 3 + k, `${active ? '▸' : ' '} ${lbl}`, active ? T.accent : T.text, T.panel);
        const vis = disp.slice(off, off + avail);
        // 记录每个可见字符的起始列，鼠标点击才能把光标放到点到那个字符
        cols = [];
        for (let acc = 0, i = 0; i < vis.length; i++) { cols.push(acc); acc += g.chWidth(vis[i]); }
        g.text(tx0, midY - 3 + k, vis, active ? T.accent : T.text, T.panel);
        if (active) {
          const col = tx0 + g.strWidth(disp.slice(off, c));
          if (col < r.x + r.w - 1 && Math.floor(C.t * 2) % 2 === 0) {
            // 光标压在字符上（末尾则是空格），用反色块表示，比固定追加 █ 更接近真输入框
            g.set(col, midY - 3 + k, c < disp.length ? disp[c] : ' ', T.panel, T.accent);
          }
        } else if (!field.value) g.text(tx0, midY - 3 + k, '(' + field.ph + ')', T.darker, T.panel);
        txtStart = tx0; txtEnd = tx0 + avail; off0 = off;
      }
      rowHits.push({ key: field.key, cycle: !!field.cycle, txtStart, txtEnd, off: off0, val: disp, cols });
    }

    // 按钮紧跟最后一个字段（字段数量会变，别写死在 midY+1，否则第 5 行会压到按钮上）
    const bY = midY - 3 + f.length;
    const b = f.length;
    const saveLabel = this.form.busy ? '[ 验证中 ]' : '[  保存  ]';
    const cancelLabel = '[  取消  ]';
    this._btn(g, T, x + 2, bY, saveLabel, this.form.idx === b);
    this._btn(g, T, x + 2 + 14, bY, cancelLabel, this.form.idx === b + 1);

    // 提示可能很长（比如可用模型清单）：折两行、超出面板宽度截断，别溢到邻面板
    const msgW = Math.max(4, iw - 4);
    const mLines = wrapText(g, this.form.msg || '', msgW).slice(0, 2);
    const mColor = this.form.bad ? T.err : T.warn;
    for (let i = 0; i < mLines.length; i++) g.text(x + 2, bY + 2 + i, mLines[i], mColor, T.panel);
    g.text(x + 2, bY + 4, 'TAB/↑↓ 切换 · ←→ 改值 · 回车 保存 · 鼠标点击也可', T.dim, T.panel);
    // 记录可点击区域（网格坐标），供鼠标点击命中
    this._cfg = {
      fields: rowHits.map((h, k) => ({ ...h, y: midY - 3 + k, x0: x + 1, x1: r.x + r.w - 1 })),
      save: { y: bY, x0: x + 2, x1: x + 2 + saveLabel.length },
      cancel: { y: bY, x0: x + 2 + 14, x1: x + 2 + 14 + cancelLabel.length },
    };
  }

  // 按钮：选中态用反色（panel 字 + accent 底），未选中用暗字
  _btn(g, T, col, y, label, active) {
    if (active) { for (let i = 0; i < label.length; i++) g.set(col + i, y, label[i], T.panel, T.accent); }
    else g.text(col, y, label, T.dim, T.panel);
  }
}

// 剥掉心情标记，发历史给真 LLM 时避免把标记回灌给模型。
// 后端流式解析已经剥过一遍，这里是双保险：模型偶尔会写出全角冒号 / 单括号 / 中文键名
// 之类的变体（后端认得，但这条历史可能是旧版本留下来的），所以正则要写得跟后端一样宽：
// 宁可多删一句疑似正文，也不能让 [[mood:...]] 这种控制符在界面上或回灌给模型。
const MOOD_TAG_RE = /\[?\[\s*(?:mood|心情|情绪|emo|emotion|state|status)\s*[:：=][\s\S]*?(?:\]\]|\]|$)/gi;
function stripMood(s) { return String(s || '').replace(MOOD_TAG_RE, '').trim(); }

// 「心情语句 显示/隐藏」是纯本地偏好（跟后端无关），记在 localStorage 里跨会话保留。
// WebView2 里 localStorage 未必可用（隐私模式/异常状态），所以读写都要裹 try。
const MOOD_PREF_KEY = 'ponko.moodTags';
// 默认隐藏：只有用户显式选过「显示」才显示（记不住时回到隐藏，不给正文添乱）
function readMoodPref() {
  try { return localStorage.getItem(MOOD_PREF_KEY) === 'show'; } catch (e) { return false; }
}
function writeMoodPref(show) {
  try { localStorage.setItem(MOOD_PREF_KEY, show ? 'show' : 'hide'); } catch (e) { /* 记不住就算了 */ }
}

// 协议字段：只认这三个值，脏值一律回落 auto（后端也做同样的规范化，两边不会各说各话）
const PROVIDER_KEYS = ['auto', 'openai', 'anthropic'];
function normProvider(p) {
  const s = String(p || '').trim().toLowerCase();
  return PROVIDER_KEYS.includes(s) ? s : 'auto';
}
function providerLabel(v) {
  const k = normProvider(v);
  return k === 'anthropic' ? 'Anthropic' : (k === 'openai' ? 'OpenAI 兼容' : '自动识别');
}

/** 循环字段当前值的显示名（协议、心情语句都走这里，别再写死成 providerLabel） */
function cycleLabel(field, value) {
  const o = (field.opts || []).find((x) => x[0] === value);
  return o ? o[1] : String(value);
}

/** 按**显示列宽**补空格（自绘网格里汉字占 2 列，padEnd 按字符数补会对不齐） */
function padToWidth(g, s, w) {
  let out = String(s || '');
  let n = g.strWidth(out);
  while (n < w) { out += ' '; n++; }
  return out;
}

// 像 wrapText，但额外记录每行首字符在原串里的索引 —— 多行输入要靠它把
// 屏幕上的第几行第几列换算回 input 的字符下标。
function wrapIndexed(g, s, w) {
  const out = [];
  let cur = '', cw = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = g.chWidth(s[i]);
    if (cw + c > w && cur !== '') { out.push({ text: cur, start }); start = i; cur = ''; cw = 0; }
    cur += s[i]; cw += c;
  }
  out.push({ text: cur, start });
  return out.length ? out : [{ text: '', start: 0 }];
}

function wrapText(g, s, w) {
  const out = [];
  let cur = '', cw = 0;
  for (const ch of s) {
    const c = g.chWidth(ch);
    if (cw + c > w) { out.push(cur); cur = ''; cw = 0; }
    cur += ch; cw += c;
  }
  out.push(cur);
  return out.length ? out : [''];
}
