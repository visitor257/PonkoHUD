// AGENT：对话流（thinking 块 / tool_call 卡 / 流式回复）+ 底部状态条
//        未接入 LLM 时，面板正中弹配置框（API 地址 / Key / 模型 + 保存）
import { ATTR } from '../grid.js';
import { askAgent, getLlmConfig, saveLlmConfig, testLlmConfig } from '../api.js';

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
      ],
      idx: -1,                 // -1 未编辑；0..3 字段；4 保存；5 取消
      msg: '',
      busy: false,
    };
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
  // 循环字段（协议）：←→ 在候选值里转一圈
  configCycle(dir) {
    const f = this.form.fields[this.form.idx];
    if (!f || !f.cycle || !f.opts) return;
    const i = f.opts.findIndex((o) => o[0] === f.value);
    const n = (i + dir + f.opts.length) % f.opts.length;
    f.value = f.opts[n][0];
  }
  // 当前字段是否接受文本输入（循环字段不接受，交给 ←→）
  cfgFieldEditable() {
    const f = this.form.fields[this.form.idx];
    return !!(f && !f.cycle);
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
        if (fd.cycle) {
          if (c.x < fd.txtStart) this.configCycle(-1);
          else if (c.x >= fd.txtEnd + 1) this.configCycle(1);
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
  push(role, text) {
    this.msgs.push({ role, text: String(text || ''), t: performance.now() });
    if (this.msgs.length > 300) this.msgs.splice(0, this.msgs.length - 300);
  }

  send(text) {
    const t = text.trim();
    if (!t || this.busy) return;
    if (!this.llmConfigured) { this.configOpen(); return; }   // 没接 LLM：先弹配置框
    this.push('user', t);
    this.busy = true;
    this.tokens = 0;
    this.mood.touch();            // 用户活动只记时间戳，情绪不该由界面推断
    // 把近期对话（剥掉 [[mood:...]] 标记）作为上下文发给真 LLM
    const history = this.msgs
      .filter((m) => (m.role === 'user' || m.role === 'agent') && m.text.trim())
      .map((m) => ({ role: m.role, content: stripMood(m.text) }))
      .slice(-10);
    this._cancel = askAgent(t, (e) => {
      switch (e.t) {
        case 'mood':
          // 心情是 agent 的声明直接落地：state 决定配色，face 决定角色立绘
          if (!this.mood.fromAgent(e)) break;
          this.moodTag = this.mood.face || this.mood.state;
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
        case 'done':
          this.busy = false;
          this.tokens = e.tokens || this.tokens;
          // 尊重 agent：它没在正文里声明收尾心情，前端就不替它收尾
          if (e.state || e.mood) this.mood.fromAgent(e);
          break;
        case 'error':
          this.busy = false;
          this.push('think', '后端错误：' + e.text);
          this.mood.fromLocal('error', '连不上 agent 后端');   // 标清是本地兜底
          break;
      }
      this.scroll = 0;
    }, () => { this.busy = false; });
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
    const viewH = r.h - 4;                  // 输入行 + 状态条

    // 展开成可显示行
    const lines = [];
    for (const m of this.msgs) {
      const pre = m.role === 'user' ? '› '
        : m.role === 'think' ? '◐ '
        : m.role === 'tool' ? '⚙ ' : '▌ ';
      const col = m.role === 'user' ? T.accent : m.role === 'think' ? T.dim : m.role === 'tool' ? T.warn : T.text;
      const wrap = wrapText(g, pre + m.text, iw);
      for (const l of wrap) lines.push({ text: l, col, role: m.role });
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
    while (y < r.y + r.h - 3) { g.text(x, y, ' '.repeat(iw), T.text, T.panel); y++; }

    // 输入行
    const iy = r.y + r.h - 3;
    let cx = g.text(x, iy, '▌ ', T.accent, T.panel);
    const maxLen = Math.max(1, r.x + r.w - 1 - cx - 1);
    const off = Math.max(0, this.caret - maxLen + 1);
    cx = g.text(cx, iy, this.input.slice(off, off + maxLen), T.text, T.panel);
    if (this.focus && Math.floor(C.t * 2) % 2 === 0) g.set(cx, iy, '█', T.accent, T.accent);

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
    const rowHits = [];
    for (let k = 0; k < f.length; k++) {
      const field = f[k];
      const active = this.form.idx === k;
      let disp = field.value;
      let txtStart = 0, txtEnd = 0;                 // 循环字段：候选文本的起止列（供点击箭头命中）
      if (field.cycle) {
        // 箭头始终画出来（未选中也画，用暗色），否则用户看不出这两个字符是可点的
        const wOf = (s) => [...s].reduce((n, ch) => n + g.chWidth(ch), 0);
        // 按最长候选名占列：切换时 › 的位置要恒定，否则鼠标点一次就得换个地方点
        const maxW = Math.max(1, ...(field.opts || []).map((o) => wOf(o[1])));
        const txt = providerLabel(disp);
        const txtW = wOf(txt);
        const base = x + 2 + 2 + 7;                 // 行首 = 光标(1) + 空格(1) + 标签(7)
        txtStart = base + 2;
        txtEnd = txtStart + maxW;
        // 文本在固定宽度的格子内居中：箭头位置不动，同时名字也不会偏到一边
        const padL = Math.max(0, Math.floor((maxW - txtW) / 2));
        const padR = Math.max(0, maxW - txtW - padL);
        const cell = ' '.repeat(padL) + txt + ' '.repeat(padR);
        g.text(x + 2, midY - 3 + k, `${active ? '▸' : ' '} ${field.label.padEnd(7, ' ')}`, active ? T.accent : T.text, T.panel);
        g.text(base, midY - 3 + k, '‹', active ? T.accent : T.dim, T.panel);
        g.text(txtStart, midY - 3 + k, cell, active ? T.accent : T.text, T.panel);
        g.text(txtEnd + 1, midY - 3 + k, '›', active ? T.accent : T.dim, T.panel);
      } else {
        if (field.mask && !active) disp = '*'.repeat(Math.min(disp.length, 22));   // 非编辑态遮住 Key
        const lbl = field.label.padEnd(7, ' ');
        const line = `${active ? '▸' : ' '} ${lbl}${disp}${active ? '█' : ''}`;
        g.text(x + 2, midY - 3 + k, line, active ? T.accent : T.text, T.panel);
        if (!field.value) g.text(x + 2 + 9, midY - 3 + k, '(' + field.ph + ')', T.darker, T.panel);
      }
      rowHits.push({ key: field.key, cycle: !!field.cycle, txtStart, txtEnd });
    }

    const bY = midY + 1;
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
    g.text(x + 2, bY + 4, 'TAB/↑↓ 切换 · ←→ 改协议 · 回车 保存 · 鼠标点击也可', T.dim, T.panel);
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

// 剥掉心情标记 [[mood:...]]，发历史给真 LLM 时避免把标记回灌给模型
function stripMood(s) { return String(s || '').replace(/\[\[mood:[^\]]*\]\]/g, '').trim(); }

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
