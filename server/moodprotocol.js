'use strict';

// 心情协议：agent 是心情的唯一权威，前端/后端都不再"推断"情绪。
//
//   ┌────────────┐   行内标记 [[mood:...]] / JSON {"mood":{...}}   ┌─────────┐
//   │  agent/LLM │ ─────────────────────────────────────────────▶ │ 后端解析 │
//   └────────────┘                                                └────┬────┘
//                                                                      │ NDJSON {t:'mood',...}
//                                                                      ▼
//                                                              前端 Mood.fromAgent()
//
// 三个字段的分工：
//   state     内部状态（idle/think/stream/sleepy/error）—— 决定全局配色
//   face      表情标签（素材包 characters/*/src/*.png 的文件名）—— 决定角色立绘
//   note      第一人称短句 —— 显示在 MOOD 面板；intensity 影响数值与曲线
//
// face 是开放词汇（用户自己起名），state 是封闭枚举（要和主题对应）。

// 内部状态枚举（封闭）
const STATES = {
  idle:   { label: '待机', hint: '空闲等待，或已经给出结论、心里有底' },
  think:  { label: '思考', hint: '正在推理 / 分析 / 检索，还没有结论' },
  stream: { label: '输出', hint: '正在产出内容、逐字输出' },
  sleepy: { label: '瞌睡', hint: '长时间没被唤起，低功耗待机' },
  error:  { label: '出错', hint: '刚才失败、卡住，或发现了严重问题' },
};
const STATE_KEYS = Object.keys(STATES);

// agent 口误时的别名收敛（不影响合法 face）
const STATE_ALIAS = {
  thinking: 'think', 思考: 'think', reasoning: 'think', analyze: 'think', busy: 'think',
  streaming: 'stream', 输出: 'stream', speaking: 'stream', reply: 'stream',
  待机: 'idle', ok: 'idle', ready: 'idle', done: 'idle', calm: 'idle', happy: 'idle', proud: 'idle',
  sleep: 'sleepy', asleep: 'sleepy', 瞌睡: 'sleepy', dozing: 'sleepy', bored: 'sleepy', idle_sleep: 'sleepy',
  fail: 'error', failed: 'error', panic: 'error', worried: 'error', sad: 'error',
  出错: 'error', 失败: 'error', frustrated: 'error', confused: 'think',
};

// agent 允许以命名参数写的键（短名优先，兼容长名）
const KEY_ALIAS = {
  face: 'face', f: 'face', emo: 'face', emoji: 'face', tag: 'face', label: 'face', 表情: 'face',
  i: 'intensity', intensity: 'intensity', level: 'intensity', strength: 'intensity', 强度: 'intensity',
  note: 'note', msg: 'note', desc: 'note', say: 'note', text: 'note', 备注: 'note',
  until: 'until', for: 'until', ms: 'until', hold: 'until', ttl: 'until',
};

const ALIAS_FACE_TO_STATE = null; // face 不反推 state，保持二者正交

function clamp01(n) { return Math.max(0, Math.min(1, Number(n) || 0)); }

/** state 归一化：非法值返回 null（调用方决定是丢弃还是降级） */
function normState(s) {
  if (!s) return null;
  const k = String(s).trim().toLowerCase();
  if (STATES[k]) return k;
  if (STATE_ALIAS[k]) return STATE_ALIAS[k];
  const hit = STATE_KEYS.find((x) => x === k.replace(/[^\w]/g, ''));
  return hit || null;
}

/**
 * 归一化一个心情声明。入参可以是：
 *   'stream'                                 字符串
 *   { mood:'think', face:'得意', i:0.8 }     对象（兼容旧字段名）
 *   { t:'mood', state:'idle', note:'…' }
 * 返回 { state, face, intensity, note, until } 或 null。
 */
function normalize(input) {
  if (!input) return null;
  let raw = input;
  if (typeof raw === 'string') raw = { mood: raw };
  if (typeof raw !== 'object') return null;

  const bag = {};
  for (const [k, v] of Object.entries(raw)) {
    const canon = KEY_ALIAS[String(k).toLowerCase()];
    if (canon && v !== undefined && v !== null && v !== '') bag[canon] = v;
  }

  const state = normState(raw.state ?? raw.mood ?? raw.status ?? (typeof input === 'string' ? input : null));
  if (!state) return null;

  const out = { state };
  // face：开放词汇，不做白名单过滤（素材可以随时加），但去掉标记里的分隔符
  if (bag.face) out.face = String(bag.face).replace(/[\[\]|]/g, '').trim().slice(0, 24);
  if (bag.intensity !== undefined) out.intensity = clamp01(bag.intensity);
  if (bag.note) out.note = String(bag.note).replace(/[\[\]]/g, '').trim().slice(0, 40);
  if (bag.until !== undefined) {
    const ms = Number(String(bag.until).replace(/[^\d]/g, ''));
    if (ms > 0) out.until = Math.min(600000, ms);   // 上限 10 分钟，防止锁死
  }
  return out;
}

/** 行内控制标记：[[mood:stream|face:grin|i:0.9|until:15000|note:看到关键日志了]] */
const TAG_RE = /\[\[\s*mood\s*:\s*([^|\]]+?)\s*((?:\|\s*[^[\]]*?)*)\s*\]\]/gi;

/**
 * 从一段 LLM 正文里剥出行内心情标记。
 * @returns {{clean:string, moods:object[]}}
 */
function parseInline(text) {
  const moods = [];
  if (!text || typeof text !== 'string') return { clean: text || '', moods };
  const clean = text.replace(TAG_RE, (_all, head, tail) => {
    const fields = { mood: head.trim() };
    for (const seg of String(tail || '').split('|')) {
      const m = seg.match(/^\s*([^:：]+)\s*[:：]\s*(.+?)\s*$/);
      if (m) fields[m[1]] = m[2];
    }
    const n = normalize(fields);
    if (n) moods.push(n);
    return '';
  });
  return { clean, moods };
}

/** JSON 行控制：{"mood":{"state":"think",...}} 或 {"type":"mood","state":...} */
function maybeJsonLine(line) {
  const s = String(line || '').trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return null;
  let obj;
  try { obj = JSON.parse(s); } catch (e) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (obj.type && obj.type !== 'mood') return null;
  const body = obj.mood && typeof obj.mood === 'object' ? { state: obj.mood.state, ...obj.mood } : obj;
  return normalize(body.state ? body : { ...body, state: body.mood || body.state });
}

/** 给 LLM 的 system 提示词片段；faces 用当前素材包的标签列表注入 */
function buildSystemPrompt(faces) {
  const list = (faces && faces.length ? faces : []).map((f) => `"${f}"`).join(' / ');
  return [
    '你控制着界面的表情显示。除正文外，你需要用行内标记显式声明自己的心情：',
    '',
    '    [[mood:STATE|face:表情|i:强度|note:一句话自述]]',
    '',
    `- STATE 只能是：${STATE_KEYS.join(' / ')}（${STATE_KEYS.map((k) => k + '=' + STATES[k].label).join('、')}）`,
    list ? `- face 必须是已有素材标签之一：${list}；省略则用 STATE 的默认表情` : '- face 省略则为 STATE 的默认表情',
    '- i 是 0~1 的强度：0.9 很兴奋，0.3 淡淡的；省略则用 STATE 的默认值',
    '- note 是第一人称短句（≤20 字），会直接显示给用户在 MOOD 面板',
    '- until 可省略；单位是毫秒，表示这段心情至少保持多久',
    '',
    '什么时候发：开始思考时、开始输出前、情绪明显变化时、回复收尾时各一条；',
    '一轮至少一条，不要连续重复同一个 STATE。标记不要出现在给用户的正文里。',
  ].join('\n');
}

/** 流结束后仍未闭合的半截标记：丢掉，别让用户看到控制符号 */
function stripTags(s) {
  return String(s || '').replace(/\[\[mood[\s\S]*?(\]\]|$)/gi, '');
}

/**
 * 流式心情解析器。
 * 真 LLM 的 token 边界会随意切开 [[mood:...]]，所以这里必须跨片段缓冲：
 * 见到 "[[mood" 开头却没收尾时，把标记本体留在缓冲里等下一片。
 */
class MoodStreamParser {
  constructor(faces = null) {
    this.pending = '';
    this.faces = faces;
  }

  /** 喂入一个流式片段，返回 {text: 剥离标记后的正文, moods: 这次识别到的心情[]} */
  feed(chunk) {
    if (chunk) this.pending += chunk;
    let text = '';
    const moods = [];
    for (;;) {
      const open = this.pending.indexOf('[[');
      if (open === -1) {
        // 关键：token 边界可能刚好把 "[[" 劈成两半。若缓冲结尾是孤立的 '['，
        // 必须留到下一片再判断，否则 "[[" 会被当成正文吐出去、标记就此报废。
        const tail = this.pending.match(/\[+$/);
        const keep = tail ? Math.min(tail[0].length, 2) : 0;
        if (keep > 0) {
          text += this.pending.slice(0, this.pending.length - keep);
          this.pending = this.pending.slice(this.pending.length - keep);
        } else {
          text += this.pending;
          this.pending = '';
        }
        break;
      }
      const close = this.pending.indexOf(']]', open);
      if (close === -1) {                      // 标记没到齐：正文先走，标记本体留下
        if (open > 0) { text += this.pending.slice(0, open); this.pending = this.pending.slice(open); }
        break;
      }
      text += this.pending.slice(0, open);
      const tag = this.pending.slice(open, close + 2);
      this.pending = this.pending.slice(close + 2);
      const m = parseInline(tag).moods[0] || maybeJsonLine(tag);
      if (m) moods.push(m);
      else text += tag;                        // 不是合法心情标记，原样还给正文
    }
    return { text, moods };
  }

  /** 流收尾：冲刷缓冲，剩下的半截标记直接丢弃 */
  flush() {
    const r = this.feed('');
    if (this.pending) { r.text += stripTags(this.pending); this.pending = ''; }
    return r;
  }
}

module.exports = {
  STATES, STATE_KEYS, STATE_ALIAS, KEY_ALIAS,
  normalize, normState, parseInline, maybeJsonLine, buildSystemPrompt,
  stripTags, MoodStreamParser,
  TAG_RE, ALIAS_FACE_TO_STATE,
};
