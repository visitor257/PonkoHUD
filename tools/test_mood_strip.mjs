// 心情标记剥离回归：真模型写标记从来不规矩，任何"没认出来就原样吐回正文"的路径
// 都会让用户直接在对话里看到 [[mood:...]] 这种控制符。
// 这里把常见畸形写法（全角冒号、中文逗号、单括号、中文键名、自创 state、未闭合）
// 逐字符喂给流式解析器，断言正文里一个控制符都不留。
//   用法：node tools/test_mood_strip.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const moodp = require(path.join(ROOT, 'server', 'moodprotocol.js'));

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   → ' + detail : ''}`);
}

/** 把整段文本按随机 1~3 字切片喂进去（模拟 token 边界），返回拼回来的正文与心情 */
function feed(s, step = 1) {
  const p = new moodp.MoodStreamParser([]);
  let text = '';
  const moods = [];
  for (let i = 0; i < s.length; i += step) {
    const r = p.feed(s.slice(i, i + step));
    text += r.text;
    moods.push(...r.moods);
  }
  const t = p.flush();
  text += t.text;
  moods.push(...t.moods);
  return { text, moods };
}

const CASES = [
  ['标准写法', '[[mood:think|face:thinking|i:0.6|note:让我想想]]正文来了', 'think'],
  ['全角冒号', '[[mood：stream|face:smile]]正文', 'stream'],
  ['中文逗号分隔', '[[mood:think，face:thinking，i:0.5]]正文', 'think'],
  ['单侧括号', '[mood:idle|face:idle]正文', 'idle'],
  ['中文键名', '[[心情:error|face:error|note:糟了]]正文', 'error'],
  ['state 键名', '[[state:sleepy|face:sleep]]正文', 'sleepy'],
  ['自创 state（猜）', '[[mood:专注|face:thinking]]正文', 'think'],
  ['自创 state 英文（猜）', '[[mood:explaining|face:streaming]]正文', 'stream'],
  ['自创 state 完全猜不出', '[[mood:zzzqqq|face:smile]]正文', null],
  ['标记前后带空行', '[[mood:think|note:想想]]\n\n正文', 'think'],
  ['嵌套多余空格', '[[ mood : idle | face : idle ]]正文', 'idle'],
  ['等号分隔', '[[mood=stream|face:smile]]正文', 'stream'],
  ['note 里含全角冒号', '[[mood:idle|note:我说：好了]]正文', 'idle'],
  ['大写的 MOOD', '[[MOOD:idle|face:idle]]正文', 'idle'],
  ['emo 键名', '[[emo:error|note:出错]]正文', 'error'],
  // 情绪词：模型直接拿"感受"当 state 写（被骂→沮丧、被夸→来劲），必须接得住，
  // 否则标记会被静默丢掉、界面永远停在平静（用户报"骂它它都是平静的"）。
  ['情绪词·委屈', '[[mood:委屈]]正文', 'error'],
  ['情绪词·被骂', '[[心情：被骂]]正文', 'error'],
  ['情绪词·难过', '[[mood:难过|face:error]]正文', 'error'],
  ['情绪词·开心', '[[mood:开心|face:streaming]]正文', 'stream'],
  ['情绪词·得意', '[[mood:得意]]正文', 'stream'],
  ['情绪词·被晾', '[[mood:被晾]]正文', 'sleepy'],
];

for (const [name, body, wantState] of CASES) {
  for (const step of [1, 3]) {
    const r = feed(body, step);
    const leaks = /\[\[|mood\s*[:：=]|心情\s*[:：=]|^\[mood/.test(r.text);
    const gotBody = r.text.includes('正文') && !leaks;
    const stateOk = wantState === null ? true : (r.moods[0] && r.moods[0].state === wantState);
    record(`切片${step}字 · ${name}：不漏控制符且正文完整`, gotBody, JSON.stringify(r.text));
    if (wantState !== null) {
      record(`切片${step}字 · ${name}：心情识别为 ${wantState}`, stateOk, JSON.stringify(r.moods[0] || null));
    }
  }
}

// 未闭合的半截标记：流结束时必须整段丢弃
{
  const r = feed('前面正文[[mood:think|face:think', 2);
  record('流尾未闭合标记被丢弃', r.text === '前面正文', JSON.stringify(r.text));
}
{
  const r = feed('正文A[[心情：开心', 1);
  record('中文键名未闭合也被丢弃', r.text === '正文A', JSON.stringify(r.text));
}

// 不能误伤：正文里正常的双括号（wiki 链接式、数组下标）要原样保留
{
  const r = feed('参考 [[双括号]] 与 [[另一条]] 的说明', 2);
  record('普通 [[...]] 不被误删', r.text === '参考 [[双括号]] 与 [[另一条]] 的说明', JSON.stringify(r.text));
}

// 一条消息里多次声明：都要生效，且一个都不显示
{
  const r = feed('[[mood:think|note:想想]]先说结论。[[mood:idle|face:idle|note:收工]]以上', 2);
  const ok = r.text === '先说结论。以上' && r.moods.length === 2
    && r.moods[0].state === 'think' && r.moods[1].state === 'idle';
  record('一轮多次声明：全部生效且全部剥除', ok, JSON.stringify({ text: r.text, moods: r.moods.map((m) => m.state) }));
}

// raw：标记被剥掉的同时要把原文带出去 —— 界面要显示"agent 下了什么心情指令"就靠它
{
  const r = feed('[[mood:think|face:thinking|note:想想]]正文', 2);
  record('心情事件带 raw 原文', r.moods[0] && r.moods[0].raw === '[[mood:think|face:thinking|note:想想]]',
    JSON.stringify(r.moods[0] && r.moods[0].raw));
}
{
  // 歪写的标记也要带原文（前端显示的就是模型自己写的那句）
  const r = feed('[[心情：专注，face:thinking]]正文', 1);
  record('畸形标记的 raw 也是原文', r.moods[0] && /^\[\[心情/.test(r.moods[0].raw || ''),
    JSON.stringify(r.moods[0] && r.moods[0].raw));
}

// stripTags 兜底：直接给一段带标记的成品文本也要清干净
{
  const s = moodp.stripTags('你好[[mood:idle|face:idle]]世界[[心情：开心|note:好]]结束');
  record('stripTags 清掉成品文本里的标记', s === '你好世界结束', JSON.stringify(s));
}

// 提示词：结尾不许"归零"，也不许为了凑数硬发一条
// 之前写的是"回复收尾时各一条 + 不要连续重复同一个 STATE + 收尾那条决定结束态"，
// 三条叠加逼着模型收尾必换成 idle，前面演的情绪全白费（用户：结尾又把心情设回去）。
{
  const sys = moodp.buildSystemPrompt(['idle', 'thinking', 'smile']);
  record('提示词不再逼模型"不许重复 STATE"', !sys.includes('不要连续重复同一个 STATE'), '');
  record('提示词明确收尾不要改回 idle', sys.includes('不要一到收尾就改回'), '');
  record('提示词把收尾定义成"定格不是归零"', sys.includes('定格') && sys.includes('归零'), '');
  record('提示词不再要求结尾硬发一条', !sys.includes('回复收尾时各一条') && sys.includes('不要为了凑数在结尾硬发'), '');

  // 人格 + 情绪反应：不能只有"工作模式"，要教它对用户的态度有反应
  record('提示词给了角色人格（有脾气/有情绪）', sys.includes('有脾气') && sys.includes('不是只会干活的机器'), '');
  record('提示词把 STATE 解释成感受而非工作模式', sys.includes('感受') && sys.includes('工作模式'), '');
  record('提示词明确"别什么都回一句平静"', sys.includes('别什么都回一句平静'), '');
  record('被骂 → error 的触发规则在', sys.includes('骂你') && /骂你[^\n]*error/.test(sys), '');
  record('被夸 → stream 的触发规则在', sys.includes('夸你') && /夸你[^\n]*stream/.test(sys), '');
}

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
process.exitCode = failed.length ? 1 : 0;
