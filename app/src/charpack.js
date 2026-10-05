// 素材包加载器：用户自定义表情的入口
//
// 约定（与 tools/charpack.py 对齐）：
//   characters/<pack>/src/*.png        用户放的图，文件名 = 表情标签，label_0/label_1 = 同标签逐帧
//   characters/<pack>/frames/pack.json 标签 → 帧文件映射
//   characters/<pack>/frames/<label>.json  帧数据：cells[row][col] = [上半RGB, 下半RGB] | [null,null]
//
// 标签不预设枚举：proud / confused / 开心 都行，运行时查不到就回退 idle。
import { rgb } from './grid.js';

// 状态机键 → 素材包标签（素材是用户起的名，这里只做兜底别名）
const ALIAS = {
  idle: ['idle', '待机', 'normal', 'default'],
  think: ['thinking', 'think', '思考'],
  stream: ['streaming', 'stream', '输出', 'talk'],
  sleepy: ['sleepy', '瞌睡', 'sleep'],
  error: ['error', '出错', 'sad'],
};

export class CharPack {
  constructor(meta) {
    Object.assign(this, meta);            // id, name, grid, moods, base
    this._frames = new Map();             // tag -> {cols, rows, cells}
    this._scaled = new Map();             // `${tag}@${cols}` -> cells
    this.loaded = false;
  }

  tags() { return Object.keys(this.moods || {}); }

  has(tag) {
    return this.tags().some((h) => String(h).toLowerCase() === String(tag).toLowerCase());
  }

  /**
   * 标签解析：input 可以是 agent 指定的任意 face（开放词汇），也可以是心情 state。
   * 命中素材就用素材；查不到才按 state 别名兜底，最后落到 idle。
   */
  tagFor(input) {
    const have = this.tags();
    if (!have.length) return null;
    const direct = have.find((h) => String(h).toLowerCase() === String(input).toLowerCase());
    if (direct) return direct;
    const want = ALIAS[input] || [];
    for (const w of want) {
      const hit = have.find((h) => h.toLowerCase() === String(w).toLowerCase());
      if (hit) return hit;
    }
    return have.includes('idle') ? 'idle' : have[0];
  }

  async ensure(tag) {
    if (this._frames.has(tag)) return this._frames.get(tag);
    const entry = this.moods && this.moods[tag];
    if (!entry) return null;
    const files = Array.isArray(entry.frames) ? entry.frames : [entry.frames];
    const frames = [];
    for (const f of files) {
      const url = this.base + String(f).replace(/\.(ans|txt)$/i, '.json');
      try {
        const r = await fetch(url);
        if (!r.ok) continue;
        const j = await r.json();
        frames.push({ cols: j.cols, rows: j.rows, cells: j.cells, fps: entry.fps || 0 });
      } catch (e) { /* 坏帧跳过 */ }
    }
    if (!frames.length) return null;
    this._frames.set(tag, frames);
    return frames;
  }

  /** 取某一心情的帧（按目标列宽缩放，结果缓存） */
  async frame(moodKey, cols, tSec = 0) {
    const tag = this.tagFor(moodKey);
    const frames = await this.ensure(tag);
    if (!frames || !frames.length) return null;
    const f = frames.length > 1 && frames[0].fps > 0
      ? frames[Math.floor(tSec * frames[0].fps) % frames.length]
      : frames[0];
    const key = `${tag}@${cols}@${frames.indexOf(f)}`;
    let s = this._scaled.get(key);
    if (!s) { s = scaleCells(f.cells, f.cols, cols); this._scaled.set(key, s); }
    return { cols, rows: s.length, cells: s };
  }
}

/** 最近邻缩放（横向按目标列数，纵向保持 1:2 字符宽高比） */
function scaleCells(cells, srcCols, dstCols) {
  if (!cells || !cells.length || dstCols === srcCols) return cells;
  const srcRows = cells.length;
  const k = dstCols / srcCols;
  const dstRows = Math.max(1, Math.round(srcRows * k));
  const out = [];
  for (let y = 0; y < dstRows; y++) {
    const sy = Math.min(srcRows - 1, Math.floor(y / k));
    const row = [];
    for (let x = 0; x < dstCols; x++) {
      const sx = Math.min(srcCols - 1, Math.floor(x / k));
      row.push(cells[sy][sx]);
    }
    out.push(row);
  }
  return out;
}

/** 把帧画进网格：每格一个 ▀，上半 fg 下半 bg */
export function blit(grid, x, y, frame, bgColor) {
  if (!frame) return;
  for (let r = 0; r < frame.rows; r++) {
    const row = frame.cells[r];
    for (let c = 0; c < frame.cols; c++) {
      const cell = row[c];
      if (!cell) continue;
      const top = cell[0], bot = cell[1];
      if (!top && !bot) continue;
      grid.set(x + c, y + r, '▀',
        top ? rgb(top[0], top[1], top[2]) : bgColor,
        bot ? rgb(bot[0], bot[1], bot[2]) : bgColor);
    }
  }
}

export async function loadPacks() {
  const r = await fetch('/api/charpacks');
  const list = await r.json();
  return list.map((m) => new CharPack(m));
}
