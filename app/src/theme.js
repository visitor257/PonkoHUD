// 主题：一套心情 = 一套配色。心情变化时整个界面（含地球陆地、角色、光标）一起换色。
import { rgb } from './grid.js';

const BASE = {
  bg: rgb(8, 12, 16),
  panel: rgb(12, 18, 24),
  panelHi: rgb(16, 24, 32),
  line: rgb(34, 52, 62),
  lineHi: rgb(52, 78, 92),
  text: rgb(206, 226, 234),
  dim: rgb(104, 132, 146),
  darker: rgb(60, 82, 94),
  ok: rgb(88, 214, 141),
  warn: rgb(240, 190, 80),
  err: rgb(240, 88, 88),
  sea: rgb(18, 46, 68),
  seaLit: rgb(38, 88, 118),
  grid: rgb(30, 70, 92),
  arc: rgb(240, 222, 96),
  node: rgb(255, 108, 108),
};

const MOODS = {
  idle:   { accent: rgb(72, 214, 208), land: rgb(46, 176, 168), name: '平静 · 待机',   glow: 0.6 },
  think:  { accent: rgb(240, 186, 80), land: rgb(206, 156, 62), name: '专注 · 思考',   glow: 0.8 },
  stream: { accent: rgb(96, 232, 128), land: rgb(78, 206, 110), name: '兴奋 · 输出',   glow: 1.0 },
  sleepy: { accent: rgb(158, 130, 240), land: rgb(134, 108, 214), name: '困倦 · 低功耗', glow: 0.35 },
  error:  { accent: rgb(240, 92, 92), land: rgb(206, 78, 78), name: '沮丧 · 出错',   glow: 0.7 },
};

export const MOOD_KEYS = Object.keys(MOODS);

export function themeFor(mood) {
  const m = MOODS[mood] || MOODS.idle;
  return {
    ...BASE,
    accent: m.accent,
    accentDim: (
      (Math.round(((m.accent >> 16) & 255) * 0.45) << 16) |
      (Math.round(((m.accent >> 8) & 255) * 0.45) << 8) |
      Math.round((m.accent & 255) * 0.45)
    ),
    land: m.land,
    landDim: (
      (Math.round(((m.land >> 16) & 255) * 0.45) << 16) |
      (Math.round(((m.land >> 8) & 255) * 0.45) << 8) |
      Math.round((m.land & 255) * 0.45)
    ),
    moodName: m.name,
    glow: m.glow,
    key: mood in MOODS ? mood : 'idle',
  };
}

export { MOODS };
