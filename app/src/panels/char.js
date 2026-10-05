// MOOD：角色（方块字符立绘）+ 心情数值 + 历史曲线 + 表情标签
// 立绘来自素材包：characters/<pack>/frames/*.json，标签由文件名决定，用户可自定义
import { blit } from '../charpack.js';
import { ATTR } from '../grid.js';
import { sparkline } from './sys.js';

export class CharPanel {
  constructor(mood, pack) {
    this.rect = null;
    this.mood = mood;
    this.pack = pack;
    this.frame = null;
    this._want = '';
    this._t = 0;
  }

  layout(r) { this.rect = r; }

  async ensureFrame(cols, tSec = 0) {
    const tag = this.pack ? this.pack.tagFor(this.mood.frameTag()) : null;
    if (!tag) return;
    const entry = this.pack.moods && this.pack.moods[tag];
    const multi = entry && Array.isArray(entry.frames) && entry.frames.length > 1;
    const key = multi
      ? `${tag}@${cols}@${Math.floor(tSec * (entry.fps || 2))}`
      : `${tag}@${cols}`;
    if (key === this._want && this.frame) return;
    this._want = key;
    const f = await this.pack.frame(tag, cols, tSec);
    if (f && this._want === key) this.frame = f;
  }

  draw(g, C) {
    const r = this.rect, T = C.theme, m = this.mood;
    if (!r || r.w < 10 || r.h < 8) return;
    g.box(r.x, r.y, r.w, r.h, T.accent, T.panel, (this.pack && this.pack.id ? this.pack.id : 'CHAR').toUpperCase(),
      T.accent, '方块字符');
    this._t = C.t;
    const x = r.x + 1, iw = r.w - 2;
    let y = r.y + 1;

    // 角色：按面板宽度自适应，保持 1:2 字符宽高比
    if (this.frame) {
      const fx = x + Math.max(0, Math.floor((iw - this.frame.cols) / 2));
      blit(g, fx, y, this.frame, T.panel);
      y += this.frame.rows + 1;
    } else {
      g.text(x + Math.floor(iw / 2) - 5, y + 2, 'loading…', T.dim, T.panel);
      y += 5;
    }

    const mid = r.x + Math.floor(r.w / 2);
    const ctr = (s, col, attr) => {
      const w = g.strWidth(s);
      g.text(Math.max(r.x + 1, mid - Math.floor(w / 2)), y, s, col, T.panel, attr || 0);
      y++;
    };

    if (y < r.y + r.h - 1) ctr(T.moodName, T.accent, ATTR.BOLD);
    if (y < r.y + r.h - 1) {
      // 谁说了算：AGENT = agent 自己声明的，其余是本地兜底 / 手动调试
      const faceTag = this.pack ? this.pack.tagFor(m.frameTag()) : '';
      const hot = m.source === 'agent';
      const miss = hot && m.face && !m.faceOk() ? ' ✗未收录' : '';
      ctr(`${m.sourceTag}${miss} · ${faceTag}`, hot ? T.accentDim : T.dim);
    }
    if (y < r.y + r.h - 1) {
      const v = Math.round(m.value);
      const w = Math.max(6, iw - 8);
      const n = Math.round((v / 100) * w);
      const s = '▐' + '█'.repeat(n) + '░'.repeat(w - n) + '▌';
      ctr(s, T.accent);
    }
    if (y < r.y + r.h - 1) ctr(`mood ${Math.round(m.value)} / 100`, T.dim);
    if (y < r.y + r.h - 1) { y++; ctr('情绪历史', T.dim); }
    if (y < r.y + r.h - 1) {
      const n = Math.max(4, iw - 2);
      ctr(sparkline(m.history.slice(-n)), T.accentDim);
    }

    // 表情标签（可点击 → 手动切心情）
    if (y < r.y + r.h - 1) {
      y++;
      const keys = ['idle', 'think', 'stream', 'sleepy', 'error'];
      const labels = ['待机', '思考', '输出', '瞌睡', '出错'];
      this._chips = [];
      this._chipY = y;
      let cx = r.x + 1;
      for (let i = 0; i < keys.length; i++) {
        const s = labels[i];
        const w = g.strWidth(s);
        if (cx + w + 1 > r.x + r.w - 1) break;
        const on = m.key === keys[i];
        g.text(cx, y, s, on ? T.panel : T.dim, on ? T.accent : T.panel, on ? ATTR.BOLD : 0);
        this._chips.push({ x: cx, w, key: keys[i] });
        cx += w + 1;
      }
      y += 2;
    }

    if (y < r.y + r.h - 1) {
      const note = m.note || '';
      const max = iw;
      g.text(x, y, note.slice(0, max), T.dim, T.panel);
    }
  }

  /** 命中表情标签 → 返回心情 key */
  chipAt(gx, gy) {
    if (!this._chips) return null;
    for (const c of this._chips) if (gy === this._chipY && gx >= c.x && gx < c.x + c.w) return c.key;
    return null;
  }
}
