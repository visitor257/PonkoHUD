// 心情：agent 是唯一权威。前端不推断情绪，只做三件事——
//   1) 执行 agent 的声明（state / face / intensity / note）
//   2) 把数值平滑友（避免配色跳变）
//   3) agent 沉默时的兜底，且必须标注来源，agent 一开口立刻让位
//
// state  内部状态 → 决定全局配色（封闭枚举）
// face   表情标签 → 决定角色立绘（开放词汇，素材文件名）
// 二者正交：agent 可以"state=error 却配一副 thinking 的脸"（正为难地查问题）。

export const MOOD_STATES = {
  idle:   { label: '待机', base: 62 },
  think:  { label: '思考', base: 70 },
  stream: { label: '输出', base: 88 },
  sleepy: { label: '瞌睡', base: 30 },
  error:  { label: '出错', base: 24 },
};
export const MOOD_KEYS = Object.keys(MOOD_STATES);
export const MOOD_LABEL = Object.fromEntries(MOOD_KEYS.map((k) => [k, MOOD_STATES[k].label]));

const SOURCE_TAG = { agent: 'AGENT', auto: '本地兜底', manual: '手动' };
const SILENCE_MS = 120000;      // 无 agent 活动这么久 → 本地兜底进入低功耗
const DEFAULT_HOLD = 20000;     // agent 没给 until 时的默认保持时长

export class Mood {
  constructor() {
    this.state = 'idle';
    this.face = null;            // null → 由 state 推导素材标签
    this.value = 62;
    this.intensity = 0.45;
    this.note = '等待 agent 接管';
    this.source = 'auto';        // agent | auto | manual
    this.lastAgent = 0;
    this.lastInput = performance.now();
    this.holdUntil = 0;
    this.autoFallback = true;    // 关掉后连 Sleepy 兜底也不做，完全交给 agent
    this.localSignals = false;   // shell 成败是否反向影响心情（默认否：那是 agent 的活）
    this.faces = [];             // 素材包可用标签，注入后用于提示 face 是否命中
    this._forced = null;
    this.history = new Array(64).fill(62);
  }

  /** 用户的活动：只记时间戳，不推情绪 */
  touch() { this.lastInput = performance.now(); }

  setFaces(list) { this.faces = Array.isArray(list) ? list : []; }

  /**
   * agent 权威写入。ev = {state, face, intensity, note, until}
   * @returns {boolean} 是否生效（state 非法则丢弃，绝不猜）
   */
  fromAgent(ev = {}) {
    const s = MOOD_STATES[ev.state] ? ev.state : null;
    if (!s) return false;
    const now = performance.now();
    this.state = s;
    this.source = 'agent';
    this.lastAgent = now;
    this.intensity = typeof ev.intensity === 'number'
      ? Math.max(0, Math.min(1, ev.intensity))
      : MOOD_STATES[s].base / 100;
    if (ev.face !== undefined) this.face = ev.face ? String(ev.face) : null;
    if (ev.note !== undefined) this.note = String(ev.note || '');
    this.holdUntil = now + Math.min(600000, Number(ev.until) || DEFAULT_HOLD);
    return true;
  }

  /** 本地兜底通道（断连、超时展示等），明确标成「本地」，被任何 agent 声明覆盖 */
  fromLocal(state, note, ms = 6000) {
    if (this._forced) return;
    if (this.source === 'agent' && performance.now() < this.holdUntil) return;
    if (!MOOD_STATES[state]) return;
    this.state = state;
    this.source = 'auto';
    this.note = note || '';
    this.intensity = MOOD_STATES[state].base / 100;
    this.holdUntil = performance.now() + ms;
  }

  /** 手动覆盖（?mood= / 点表情标签 / ^M）。有 lock 时不让位给兜底，但 agent 仍优先 */
  force(key) {
    if (!MOOD_STATES[key]) return;
    this._forced = key;
    this.state = key;
    this.source = 'manual';
    this.face = null;
    this.note = '手动覆盖（调试）';
    this.holdUntil = performance.now() + 1e9;
  }

  clearForce() { this._forced = null; this.holdUntil = 0; }

  /** 给素材包的表情标签：优先 agent 指定的 face，不存在则回退 state 默认 */
  frameTag() { return this.face || this.state; }

  faceOk() {
    if (!this.face || !this.faces.length) return true;
    return this.faces.some((f) => f.toLowerCase() === this.face.toLowerCase());
  }

  /** 面板上的来源标记 */
  get sourceTag() { return SOURCE_TAG[this.source] || this.source; }

  get label() { return (MOOD_STATES[this.state] || {}).label || this.state; }
  get key() { return this.state; }        // 兼容 themeFor(mood.key)

  tick(dt) {
    const now = performance.now();
    if (this._forced) {
      // 手动覆盖期间不接受任何推断，但 agent 可以抢
    } else if (this.source === 'agent' && now > this.holdUntil) {
      this.source = 'auto';
      this.state = 'idle';
      this.intensity = 0.45;
      this.note = '（本地）agent 没再更新心情';
    } else if (this.autoFallback
      && this.source !== 'agent'
      && now - Math.max(this.lastAgent, this.lastInput) > SILENCE_MS
      && this.state !== 'sleepy') {
      this.state = 'sleepy';
      this.source = 'auto';
      this.intensity = 0.2;
      this.note = '（本地）长时间没有 agent 活动';
      this.holdUntil = now + SILENCE_MS;
    }

    const st = MOOD_STATES[this.state] || MOOD_STATES.idle;
    const tgt = Math.max(2, Math.min(100, st.base + (this.intensity - 0.45) * 40));
    this.value += (tgt - this.value) * Math.min(1, dt * 1.6);
    this.history.push(this.value);
    if (this.history.length > 64) this.history.shift();
  }
}
