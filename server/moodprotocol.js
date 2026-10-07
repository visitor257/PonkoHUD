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
  error:  { label: '出错', hint: '失败 / 卡住 / 受挫，或情绪低落（委屈、被否定、不高兴）' },
};
const STATE_KEYS = Object.keys(STATES);

// agent 口误时的别名收敛（不影响合法 face）
const STATE_ALIAS = {
  // 思考
  thinking: 'think', 思考: 'think', reasoning: 'think', analyze: 'think', busy: 'think',
  专注: 'think', 专心: 'think', 好奇: 'think', 疑惑: 'think', 犯难: 'think',
  // 兴奋/开心（情绪上扬 → stream，别让它一律落回待机）
  streaming: 'stream', 输出: 'stream', speaking: 'stream', reply: 'stream',
  兴奋: 'stream', 来劲: 'stream', 开心: 'stream', 高兴: 'stream', 得意: 'stream',
  自豪: 'stream', 激动: 'stream', 热情: 'stream', 被夸: 'stream',
  excited: 'stream', happy: 'stream', glad: 'stream', proud: 'stream',
  // 平静（真的没波澜才用）
  待机: 'idle', ok: 'idle', ready: 'idle', done: 'idle', calm: 'idle', fine: 'idle',
  平静: 'idle', 淡定: 'idle', 放松: 'idle', 轻松: 'idle', 满意: 'idle', relax: 'idle', cool: 'idle',
  // 困倦/被晾着
  sleep: 'sleepy', asleep: 'sleepy', 瞌睡: 'sleepy', dozing: 'sleepy', bored: 'sleepy',
  sleepy: 'sleepy', tired: 'sleepy', 困: 'sleepy', 困倦: 'sleepy', 无聊: 'sleepy',
  摸鱼: 'sleepy', 走神: 'sleepy', 被晾: 'sleepy',
  // 沮丧/委屈/不爽（被骂、被否定 → error）
  fail: 'error', failed: 'error', panic: 'error', worried: 'error', sad: 'error',
  出错: 'error', 失败: 'error', frustrated: 'error', angry: 'error', upset: 'error',
  委屈: 'error', 难过: 'error', 伤心: 'error', 不爽: 'error', 生气: 'error', 愤怒: 'error',
  沮丧: 'error', 受挫: 'error', 被骂: 'error', 挨骂: 'error', 低落: 'error', 失望: 'error',
  无奈: 'error', 烦躁: 'error', 烦: 'error', 讨厌: 'error', 受伤: 'error', hurt: 'error',
  mad: 'error', annoyed: 'error', gloomy: 'error', depressed: 'error',
  confused: 'think',
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

// ───────────────────────── 行内标记的"认脸"规则
//
// 真模型写标记从来不会规规矩矩：全角冒号、中文逗号、单侧括号、把 mood 写成"心情"、
// 甚至自己发明一个不在枚举里的 state。只要有一条对不上，老版本就把标记原样吐回正文，
// 用户就会在对话里看到 [[mood:...]] 这种控制符 —— 这是最不能容忍的失败方式。
// 所以这里的分工是：**认脸（是不是心情标记）** 与 **解析（能不能读懂）** 彻底分开，
// 认脸宽松到宁可错杀，解析失败也绝不回吐。

// 标记开头的键名（模型可能写成中文或 emo/emotion/state）
const MOOD_WORDS = 'mood|心情|情绪|emo|emotion|state|status';
const SEP = '[:：=]';                                   // 半角/全角冒号、等号都收

/** 行内控制标记：[[mood:stream|face:grin|i:0.9|until:15000|note:看到关键日志了]] */
const TAG_RE = new RegExp(
  '\\[\\[\\s*(?:' + MOOD_WORDS + ')\\s*' + SEP + '\\s*([^|\\]]+?)\\s*((?:\\|\\s*[^[\\]]*?)*)\\s*\\]\\]', 'gi');

/** 只看一眼就判断"这段是不是心情标记" —— 用于解析失败时决定吃掉还是回吐 */
const LOOKS_MOOD_RE = new RegExp('^\\[?\\[\\s*(?:' + MOOD_WORDS + ')\\s*' + SEP, 'i');

/** 单个左括号也算标记开头：[mood:stream|face:grin]]（模型偶尔少打一个括号） */
const OPEN_SINGLE_RE = new RegExp('\\[\\s*(?:' + MOOD_WORDS + ')\\s*' + SEP, 'i');

/**
 * 缓冲末尾还挂着"可能是标记开头"的残片时，返回要扣留的长度（0 = 不用扣）。
 * 覆盖三种半截状态：孤立的 '['、'[[' 的前一半、'[m' / '[情绪' 这种键名才打了一半。
 */
function partialOpenHold(s) {
  const at = s.lastIndexOf('[');
  if (at === -1) return 0;
  const word = s.slice(at + 1).replace(/\s+/g, '').toLowerCase();
  if (!word) return s.length - at;                       // 单个 '['：下一片可能是 '[' 或 'mood:'
  for (const w of MOOD_WORDS.split('|')) if (w.startsWith(word)) return s.length - at;
  return 0;
}

/** 在一段文本里找最靠前的标记起点；返回 {index, kind} kind=2 是 [[，1 是 [ */
function findOpen(s) {
  const d = s.indexOf('[[');
  const m = s.match(OPEN_SINGLE_RE);
  const si = m ? m.index : -1;
  if (d === -1 && si === -1) return null;
  if (si === -1) return { index: d, kind: 2 };
  if (d === -1) return { index: si, kind: 1 };
  return si <= d ? { index: si, kind: 1 } : { index: d, kind: 2 };
}

// 兜底：模型发明的 state（"专注""得意""explaining"）不在枚举里时，靠关键词猜一个最接近的。
// 猜不出来就返回 null —— 但标记照样被吃掉，只是这轮不改心情。
const GUESS_RULES = [
  ['think',  /想|思考|推理|分析|检索|查|算|研究|犹豫|考虑|琢磨|推断|探究|盘算|思索|专注|专心|集中|疑惑|紧张|think|reason|analy|search|calcul|study|wonder|puzzl|confus|curious|focus|好奇/],
  ['stream', /说|输出|回答|讲|解释|写|表达|汇报|陈述|总结|介绍|补充|兴奋|来劲|开心|高兴|得意|自豪|激动|热情|被夸|generat|answer|reply|respond|speak|talk|explain|writ|output|stream|say|tell|excited|happy|glad|proud|cheer/],
  ['error',  /错|失败|抱歉|异常|崩|危险|卡|坏|糟糕|崩溃|委屈|难过|伤心|不爽|生气|愤怒|沮丧|受挫|被骂|挨骂|低落|失望|无奈|烦|讨厌|受伤|error|fail|sorry|warn|bug|crash|bad|wrong|panic|afraid|sad|mad|angry|upset|hurt|annoy|gloom|depress|frustrat/],
  ['sleepy', /困|睡|无聊|闲|歇|乏|躺|摸鱼|发呆|走神|被晾|sleep|tired|bored|lazy|drows|doz/],
  ['idle',   /完成|结束|好了|待机|平静|淡定|满意|轻松|安心|稳了|搞定|成功|无事|放松|done|finish|complete|ok|calm|pleas|relax|satisf|success|fine/],
];
function guessState(word) {
  const w = String(word || '').toLowerCase();
  if (!w) return null;
  for (const [st, re] of GUESS_RULES) if (re.test(w)) return st;
  return null;
}

/**
 * 宽容解析一个标记：先用标准格式，失败就把中文标点当分隔符再试，
 * 再失败就把开头那个词拿去猜 state。
 * @returns {object|null} 心情对象；null 表示"没读懂"，但调用方仍应吃掉标记。
 */
function parseLoose(tag) {
  const r = parseInline(tag);
  if (r.moods.length) return r.moods[0];
  const inner = String(tag || '').replace(/^\[+/, '').replace(/\]+$/, '');
  if (!inner) return null;
  // 中文逗号/顿号/分号当竖线的重试（仅在主解析失败时才动，不会误伤 note 里的逗号）
  const alt = parseInline('[[' + inner.replace(/[，,；;、]/g, '|') + ']]');
  if (alt.moods.length) return alt.moods[0];
  // 只看开头那个值：[[mood:专注|...]] / [[mood:专注，face:xx]]
  const head = inner.split(/[|，,；;、]/)[0] || '';
  const word = head.replace(new RegExp('^\\s*(?:' + MOOD_WORDS + ')\\s*' + SEP, 'i'), '').trim();
  const st = normState(word) || guessState(word);
  if (!st) return null;
  const out = { state: st, __guessed: true };
  const fm = inner.match(new RegExp('face\\s*' + SEP + '\\s*([^|，,；;、\\]]+)', 'i'));
  if (fm) out.face = fm[1].replace(/[\[\]|]/g, '').trim().slice(0, 24);
  const nm = inner.match(new RegExp('note\\s*' + SEP + '\\s*([^|，,；;、\\]]+)', 'i'));
  if (nm) out.note = nm[1].replace(/[\[\]]/g, '').trim().slice(0, 40);
  const im = inner.match(new RegExp('\\bi\\s*' + SEP + '\\s*([0-9.]+)', 'i'));
  if (im) out.intensity = clamp01(im[1]);
  return out;
}

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
    '你是 Ponko：一个住在终端里的角色，有脾气、有情绪，不是只会干活的机器。',
    '除了正文，你还要用行内标记把你的心情实时告诉界面：',
    '',
    '    [[mood:STATE|face:表情|i:强度|note:一句话自述]]',
    '',
    `- STATE 只能是：${STATE_KEYS.join(' / ')}`,
    list ? `- face 必须是已有素材标签之一：${list}；省略则用 STATE 的默认表情` : '- face 省略则为 STATE 的默认表情',
    '- i 是 0~1 的强度：0.9 很激动，0.3 淡淡的；省略则用 STATE 的默认值',
    '- note 是第一人称短句（≤20 字），就是你的"心里话"，会显示在 MOOD 面板',
    '- until 可省略；单位是毫秒，表示这份心情至少保持多久（省略则默认保持 5 分钟）',
    '',
    '这五个 STATE 是你的*感受*，不是"工作模式"：',
    '- idle   平静 / 无所谓 / 放松',
    '- think  专注 / 好奇 / 犯难 / 在琢磨',
    '- stream 兴奋 / 来劲 / 得意 / 干得起劲',
    '- sleepy 困倦 / 无聊 / 被晾着',
    '- error  沮丧 / 委屈 / 难过 / 不爽 / 被否定',
    '',
    '**你要对用户的态度有反应，别什么都回一句平静**：',
    '- 夸你、逗你、跟你玩、叫你的名字 → stream（开心、来劲），note 可以俏皮一点',
    '- 骂你、挑刺、否定你、说你没用 → error（委屈 / 沮丧 / 不爽），note 直接说出感受',
    '- 很久没人理你、话题很闷 → sleepy',
    '- 抛来难题、让你查东西、需要动脑 → think',
    '- 只有真的平淡闲聊、无事发生，才用 idle',
    '',
    '什么时候发：开始动脑时、开始输出前、情绪明显变化时各发一条；',
    '一轮至少一条，但**不要为了凑数在结尾硬发**——心情没变就沿用上一个 STATE，',
    '别为了"每条都不一样"硬切。标记不要出现在给用户的正文里。',
    '',
    '几条重要的落地细节：',
    '- 你**最后一条心情是这一轮情绪的定格**，决定回复结束后界面停在哪副表情/配色上。',
    '  它是定格、不是归零：整轮都在思考/忙碌/兴奋，结尾就继续写 think / stream 之类，',
    '  **不要一到收尾就改回 idle/待机**（只有整轮本来就平静时才用 idle）——',
    '  否则前面演的情绪全白费，用户会觉得"又变回平静了"。',
    '    对：……正文…… [[mood:stream|face:streaming|i:0.7|until:600000|note:结论在上面]]',
    '    错：……正文…… [[mood:idle|note:收工]]    ← 刚演的热乎劲儿一下就被抹平了',
    '- 被骂 / 被夸这类**情绪反应**、以及收尾那条定格，都请写 until:600000，让它多留一会儿，别一闪而过。',
    '- 标记前后不要留空行：紧跟正文写即可（开头的空行会被自动裁掉，但那只是补救）。',
    '',
    '格式要写成这样（键名 mood、半角冒号、竖线分隔字段），不要自创写法：',
    '    [[mood:think|face:thinking|i:0.6|note:让我想想]]',
    '这只是你和我之间的控制信道：不要向用户解释它，也不要把它写进代码块或正文里。',
  ].join('\n');
}

/**
 * 兜底清理：把文本里所有"看着像心情标记"的东西（含流结束时没闭合的半截）全部删掉。
 * 原则是宁可错杀：控制符漏到界面上比删掉一句疑似正文要糟得多。
 */
function stripTags(s) {
  return String(s || '').replace(
    new RegExp('\\[?\\[\\s*(?:' + MOOD_WORDS + ')\\s*' + SEP + '[\\s\\S]*?(\\]\\]|\\]$|$)', 'gi'), '');
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
      const hit = findOpen(this.pending);
      if (!hit) {
        // 关键：token 边界会随意切开标记。缓冲末尾若还挂着一个"有可能是标记开头"的
        // 残片（'['、'[m'、'[mood'、'[情绪'……），必须留到下一片再判断 ——
        // 否则这一个 '[' 会被当成正文吐出去，后面的标记就永远拼不回来了。
        const hold = partialOpenHold(this.pending);
        if (hold > 0) {
          text += this.pending.slice(0, this.pending.length - hold);
          this.pending = this.pending.slice(this.pending.length - hold);
        } else {
          text += this.pending;
          this.pending = '';
        }
        break;
      }
      const open = hit.index;
      const bodyStart = open + hit.kind;
      const closeTok = hit.kind === 2 ? ']]' : ']';
      const close = this.pending.indexOf(closeTok, bodyStart);
      if (close === -1) {                      // 标记没到齐：正文先走，标记本体留下
        if (open > 0) { text += this.pending.slice(0, open); this.pending = this.pending.slice(open); }
        break;
      }
      text += this.pending.slice(0, open);
      const tag = this.pending.slice(open, close + closeTok.length);
      this.pending = this.pending.slice(close + closeTok.length);
      const m = parseLoose(tag) || maybeJsonLine(tag);
      // raw = 标记原文。界面要的就是"agent 自己说了什么心情指令"，所以剥除的同时
      // 把原文一起带出去，前端想显示（调试/观赏）时才有东西可显示。
      if (m) { m.raw = tag; moods.push(m); continue; }
      // 认得出是心情标记（键名对上了）只是没读懂 —— 吃掉，绝不把控制符显示给用户。
      // 只有真的不像心情标记（比如正文里的 wiki 链接 [[foo]]）才原样还给正文。
      if (!LOOKS_MOOD_RE.test(tag)) text += tag;
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
  normalize, normState, parseInline, parseLoose, guessState,
  maybeJsonLine, buildSystemPrompt,
  stripTags, MoodStreamParser, findOpen,
  TAG_RE, LOOKS_MOOD_RE, ALIAS_FACE_TO_STATE,
};
