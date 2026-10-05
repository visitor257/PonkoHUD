// SYS：真实系统数据（后端 /api/sys 提供）
import { ATTR } from '../grid.js';

function bar(v, w) {
  const pct = Math.max(0, Math.min(1, v / 100));
  const n = Math.round(pct * w);
  return '█'.repeat(n) + '░'.repeat(Math.max(0, w - n));
}
function bytes(n) {
  if (n == null) return '--';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (n < 10 ? n.toFixed(1) : Math.round(n)) + u[i];
}
function uptime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export class SysPanel {
  constructor() { this.rect = null; this.cpuHist = new Array(40).fill(0); }
  layout(r) { this.rect = r; }

  draw(g, C) {
    const r = this.rect, T = C.theme, s = C.sys;
    if (!r || r.w < 8 || r.h < 5) return;
    g.box(r.x, r.y, r.w, r.h, T.accent, T.panel, 'SYS', T.accent, 'live');
    const iw = r.w - 2, x = r.x + 1;
    let y = r.y + 1;

    if (!s) { g.text(x, y, 'waiting…', T.dim); return; }

    const rows = [
      ['CPU', Math.round(s.cpu.usage) + '%', s.cpu.usage, T.accent],
      ['MEM', `${(s.mem.used / 1073741824).toFixed(1)}/${(s.mem.total / 1073741824).toFixed(0)}G`, s.mem.pct, T.accent],
      ['GPU', s.gpu ? Math.round(s.gpu.util) + '%' : 'n/a', s.gpu ? s.gpu.util : 0, s.gpu ? T.accent : T.darker],
      ['DSK', s.disk ? Math.round(s.disk.pct) + '%' : '--', s.disk ? s.disk.pct : 0, s.disk && s.disk.pct > 85 ? T.err : T.accent],
    ];
    this.cpuHist.push(s.cpu.usage);
    if (this.cpuHist.length > 40) this.cpuHist.shift();

    for (const [name, val, pct, col] of rows) {
      const bw = Math.max(4, iw - name.length - 7);
      g.text(x, y, name, T.dim);
      g.text(x + name.length + 1, y, val.padStart(4), col === T.darker ? T.dim : T.text);
      const bx = x + name.length + 6;
      g.text(bx, y, bar(pct, bw), pct > 85 ? T.err : pct > 65 ? T.warn : col);
      y++;
    }

    // 网络速率
    const net = s.net;
    g.text(x, y, 'NET ', T.dim);
    g.text(x + 4, y, '↑', T.dim);
    g.text(x + 5, y, (net ? bytes(net.tx) + '/s' : '--').padEnd(10), T.text);
    g.text(x + 15, y, '↓', T.dim);
    g.text(x + 16, y, net ? bytes(net.rx) + '/s' : '--', T.text);
    y++;

    if (y < r.y + r.h - 1) {
      const spark = sparkline(this.cpuHist.slice(-Math.max(4, iw - 2)));
      g.text(x, y, spark, T.accentDim);
      y++;
    }
    if (y < r.y + r.h - 1) {
      g.text(x, y, 'UP ' + uptime(s.uptime), T.dim);
      const cores = `${s.cpu.cores}C`;
      g.text(r.x + r.w - 1 - cores.length, y, cores, T.dim);
    }
  }
}

/** 数值序列 → ▁▂▃▄▅▆▇ */
export function sparkline(vals) {
  const CH = '▁▂▃▄▅▆▇';
  let lo = Infinity, hi = -Infinity;
  for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (hi - lo < 1e-6) hi = lo + 1;
  return vals.map((v) => CH[Math.min(6, Math.floor(((v - lo) / (hi - lo)) * 6.999))]).join('');
}
