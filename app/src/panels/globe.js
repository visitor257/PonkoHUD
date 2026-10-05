// GLOBE：球面反投影 + 半块字符（移植自 tools/globe.py，数学已自检）
// 每个字符格 = 上/下两个子像素，各反解一次经纬度回查海陆位图，合成 ▀ 的前景色/背景色
//
// 真实模式：本机公网出口 IP / DNS 递归解析器（含路由器转发的上游 resolver）按真实经纬度打点，
//          本机 → 各 DNS 之间画流动弧线，底部列出 IP · 城市 · 延迟
// 离线模式：拿不到网络地理数据时退回 eDEX 风格的装饰性节点与弧线（下面 DECOR_*）
import { isLand } from '../landmask.js';
import { mix, scale } from '../grid.js';
import { geoLookup } from '../api.js';

const D2R = Math.PI / 180;

const DECOR_ARCS = [
  [39.90, 116.40, 37.77, -122.42],
  [51.51, -0.13, 1.35, 103.82],
  [35.68, 139.69, -33.87, 151.21],
  [52.52, 13.40, 40.71, -74.01],
  [22.30, 114.20, 51.51, -0.13],
];
const DECOR_NODES = [
  [39.90, 116.40], [51.51, -0.13], [40.71, -74.01], [37.77, -122.42],
  [-33.87, 151.21], [1.35, 103.82], [35.68, 139.69], [22.30, 114.20],
];

const GLYPH = { self: '◉', upstream: '◆', dns: '◇', temp: '✦' };
const TEMP_TTL = 180;            // shell 里发现的 IP 标记存活秒数

function toView(x, y, z, yaw, pitch) {
  const a = -yaw * D2R, ca = Math.cos(a), sa = Math.sin(a);
  const x1 = x * ca + z * sa, z1 = -x * sa + z * ca;
  const cp = Math.cos(pitch * D2R), sp = Math.sin(pitch * D2R);
  return [x1, y * cp - z1 * sp, y * sp + z1 * cp];
}
function world(lat, lon, r = 1) {
  const la = lat * D2R, lo = lon * D2R, cl = Math.cos(la);
  return [r * cl * Math.sin(lo), r * Math.sin(la), r * cl * Math.cos(lo)];
}
export function project(lat, lon, yaw, pitch, r = 1) {
  return toView(...world(lat, lon, r), yaw, pitch);
}
function unproject(u, v, yaw, pitch) {
  const r2 = u * u + v * v;
  if (r2 > 1) return null;
  const w = Math.sqrt(1 - r2);
  const cp = Math.cos(pitch * D2R), sp = Math.sin(pitch * D2R);
  const y1 = v * cp + w * sp;
  const z1 = -v * sp + w * cp;
  const b = yaw * D2R, cb = Math.cos(b), sb = Math.sin(b);
  const x0 = u * cb + z1 * sb;
  const z0 = -u * sb + z1 * cb;
  return [Math.asin(Math.max(-1, Math.min(1, y1))) / D2R, Math.atan2(x0, z0) / D2R, w];
}
function slerp(a, b, t) {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const om = Math.acos(dot), so = Math.sin(om);
  if (so < 1e-6) return a;
  const A = Math.sin((1 - t) * om) / so, B = Math.sin(t * om) / so;
  return [a[0] * A + b[0] * B, a[1] * A + b[1] * B, a[2] * A + b[2] * B];
}

// 按显示列切片（中文占 2 列，不劈开字符）：取 [startCol, startCol+maxCols) 区间的整字符子串
function sliceCols(g, s, startCol, maxCols) {
  if (maxCols <= 0) return '';
  let col = 0, out = '';
  for (const ch of s) {
    const w = g.chWidth(ch);
    if (col >= startCol) {
      if (col + w > startCol + maxCols) break;   // 跨边界的整字不切，宁可少画一格
      out += ch;
    }
    col += w;
  }
  return out;
}

export class GlobePanel {
  constructor() {
    this.rect = null;
    this.yaw = 116;
    this.pitch = 18;
    this.dragging = null;
    this.focus = false;
    this.speed = 360 / 45;      // 与 eDEX 一致：45 秒一圈
    this.userDragged = false;
    this.geo = null;            // /api/netgeo 快照
    this.selfNode = null;       // {lat,lon,ip,city,isp}
    this.nodes = [];            // DNS / 上游 resolver（有真实经纬度）
    this.temps = [];            // shell 输出里扫到的 IP
    this._queried = new Set();  // 已查询过的临时 IP，别重复打 api
    this.hscroll = 0;           // 底部 IP/位置说明的横向滚动偏移（列，渲染用，可为小数）
    this._maxScroll = 0;        // 最大可滚列数
    this._scrollable = false;   // 内容是否超宽、需要横滚
    this._autoClock = 0;        // 自动横滚累计时间
    this._manualTarget = 0;     // 用户滚轮设定的目标偏移
    this._manualUntil = -1;     // 此 app 时间之前由用户手动控制（之后交回自动跑马灯）
    this._now = 0;              // 当前 app 时间（draw 每帧写入，onWheel 用）
    this._frozen = false;       // 调试(?sphase)定格用，正常为 false
  }

  layout(r) { this.rect = r; }

  // ── 塞入真实网络地理数据
  setGeo(g) {
    if (!g) { this.geo = null; return; }
    this.geo = g;
    const nodes = [];
    let self = null;
    if (g.self && g.self.lat != null && g.self.lon != null) {
      self = { lat: g.self.lat, lon: g.self.lon, ip: g.self.ip, city: g.self.city || '', isp: g.self.isp || '' };
    }
    this.selfNode = self;

    for (const d of g.dns || []) {
      // kind==='lan' 的本地 DNS 位置就是本机本身，画上去只是叠个点 —— 交给底部文字说明
      if (d.positioned === false || d.kind === 'lan' || d.lat == null) continue;
      nodes.push({ lat: d.lat, lon: d.lon, kind: d.kind, ip: d.ip, city: d.city || '', rtt: d.rtt, via: d.iface || '' });
    }
    this.nodes = nodes;

    // 第一次拿到真实数据时把镜头转到自己头上（用户手动拖过就不抢）
    if (self && !this.userDragged && !this._yawSet) { this.yaw = self.lon; this._yawSet = true; }
  }

  // ── shell 输出里发现的公网 IP → 打一个临时标记（eDEX 的原版交互）
  async noteIp(ip) {
    if (this._queried.has(ip)) return;
    this._queried.add(ip);
    if (this._queried.size > 64) this._queried.clear();      // 防止长期运行无限增长
    try {
      const g = await geoLookup(ip);
      if (!g || g.none || g.private || g.lat == null) return;
      this.temps.push({ lat: g.lat, lon: g.lon, ip, city: g.city || '', born: -1 });   // born 在首次 draw 时填
      if (this.temps.length > 8) this.temps.shift();
    } catch (e) { /* 离线就算了 */ }
  }

  draw(g, C) {
    const r = this.rect, T = C.theme;
    if (!r || r.w < 8 || r.h < 5) return;
    const real = !!(this.selfNode || this.nodes.length || this.temps.length);

    if (!this.dragging) this.yaw = (this.yaw + C.dt * this.speed + 360) % 360;

    const cols = r.w - 2, rows = r.h - 2;
    const x0 = r.x + 1, y0 = r.y + 1;
    const aspect = g.cellH / g.cellW;          // 真实字符宽高比 → 保证正圆
    const yaw = this.yaw, pitch = this.pitch;

    // ── 底部说明：真实数据优先列 IP / 城市 / 延迟，否则退回装饰计数
    const legend = this.buildLegend(real, T);
    // 横向滚动：超宽内容自动左右平移（跑马灯），无需用户操作也能看全；滚轮可临时手动覆盖
    const textCols = cols - 3;                 // 图标占 1 列 + 1 空格，右侧留 1 列给边框
    let maxTextW = 0;
    for (const L of legend) maxTextW = Math.max(maxTextW, g.strWidth(L.t));
    this._maxScroll = Math.max(0, maxTextW - textCols);
    this._scrollable = this._maxScroll > 0;
    this._now = C.t;
    if (this._scrollable) {
      if (C.t < this._manualUntil) {
        // 用户最近滚过：优先手动目标
        this.hscroll = Math.max(0, Math.min(this._maxScroll, this._manualTarget));
      } else {
        // 自动跑马灯：两端各停一会儿，平滑往返，保证长内容最终完整露出
        if (!this._frozen) this._autoClock += C.dt;   // _frozen 仅调试(?sphase)用，定格某一相位
        this.hscroll = GlobePanel._autoPos(this._maxScroll, this._autoClock);
      }
    } else {
      this.hscroll = 0;
    }

    let lg = rows >= 22 ? 3 : rows >= 18 ? 2 : rows >= 14 ? 1 : rows >= 10 ? 1 : 0;
    lg = Math.min(legend.length, lg, Math.max(0, rows - 6));
    const grows = Math.max(5, rows - lg);

    const count = this.nodes.length + (this.selfNode ? 1 : 0);
    const right = this._scrollable
      ? `↔ ${this._maxScroll ? Math.round(100 * this.hscroll / this._maxScroll) : 0}%`
      : (real ? `${count} ip` : '装饰');
    g.box(r.x, r.y, r.w, r.h, this.focus || this.dragging ? T.accent : T.line, T.panel,
      'GLOBE', T.accent, right);

    // ── 弧线与节点
    const marks = new Map();                   // "col,row,half" -> {ch, col}
    const put = (p, ch, col) => {
      if (!p || p[2] <= 0.02) return;
      const cx = Math.round((p[0] + 1) / 2 * (cols - 1));
      const cy = Math.round((1 - p[1]) / 2 * (grows * 2 - 1));
      const gx = x0 + cx, gy = y0 + Math.floor(cy / 2), half = cy % 2;
      if (gx < x0 || gx >= x0 + cols || gy < y0 || gy >= y0 + grows) return;
      marks.set(`${gx},${gy},${half}`, { ch, col });
    };

    if (real) {
      // 本机 → 每个 DNS / 上游 resolver 一条流动弧线
      const pairs = [];
      if (this.selfNode) for (const n of this.nodes) pairs.push([this.selfNode, n]);
      for (let i = 0; i < pairs.length; i++) {
        const [a, b] = pairs[i];
        const A = world(a.lat, a.lon), B = world(b.lat, b.lon);
        for (let k = 0; k <= 48; k++) {
          const t = k / 48;
          const p = slerp(A, B, t);
          const lift = 1 + 0.05 * Math.sin(Math.PI * t);
          const v = toView(p[0] * lift, p[1] * lift, p[2] * lift, yaw, pitch);
          const beat = Math.abs(((C.t * 0.32 + i * 0.21) % 1) - t) < 0.025;
          put(v, beat ? '·' : '·', beat ? T.arc : mix(T.arc, T.seaLit, 0.62));
        }
      }
      for (const n of this.nodes) {
        put(project(n.lat, n.lon, yaw, pitch),
          n.kind === 'upstream' ? GLYPH.upstream : GLYPH.dns, T.node);
      }
      // 自己的抖动光圈
      if (this.selfNode) {
        const pulse = 0.5 + 0.5 * Math.sin(C.t * 3.2);
        put(project(this.selfNode.lat, this.selfNode.lon, yaw, pitch), GLYPH.self,
          mix(T.accent, 0xffffff, 0.25 + 0.5 * pulse));
      }
      // 临时标记（shell 里扫到的 IP），有寿命
      for (const tm of this.temps) {
        if (tm.born < 0) tm.born = C.t;
        if (C.t - tm.born > TEMP_TTL) continue;
        const fade = 1 - (C.t - tm.born) / TEMP_TTL;
        put(project(tm.lat, tm.lon, yaw, pitch), GLYPH.temp, mix(T.seaLit, T.arc, 0.3 + 0.7 * fade));
      }
    } else {
      for (let i = 0; i < DECOR_ARCS.length; i++) {
        const [la1, lo1, la2, lo2] = DECOR_ARCS[i];
        const A = world(la1, lo1), B = world(la2, lo2);
        for (let k = 0; k <= 48; k++) {
          const t = k / 48;
          const p = slerp(A, B, t);
          const lift = 1 + 0.06 * Math.sin(Math.PI * t);
          const v = toView(p[0] * lift, p[1] * lift, p[2] * lift, yaw, pitch);
          const beat = Math.abs(((C.t * 0.35 + i * 0.17) % 1) - t) < 0.02;
          put(v, '·', beat ? T.arc : mix(T.land, T.seaLit, 0.35));
        }
      }
      for (const [la, lo] of DECOR_NODES) put(project(la, lo, yaw, pitch), 'o', T.node);
    }

    // ── 球体
    for (let cy = 0; cy < grows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        let top = null, bot = null;
        for (let half = 0; half < 2; half++) {
          const j = cy * 2 + half;
          const u = ((cx + 0.5) / cols) * 2 - 1;
          const v = aspect * (grows - j - 0.5) / cols;
          const hit = unproject(u, v, yaw, pitch);
          if (!hit) continue;
          const [lat, lon, w] = hit;
          const land = isLand(lat, lon);
          const light = 0.22 + 0.78 * Math.pow(w, 0.85);     // 边缘压暗做体积感
          const base = land
            ? mix(T.landDim, T.land, light)
            : mix(scale(T.sea, 0.7), T.seaLit, light * 0.9);
          const m = marks.get(`${x0 + cx},${y0 + cy},${half}`);
          const col = m ? m.col : base;
          if (half === 0) top = col; else bot = col;
        }
        if (top === null && bot === null) continue;
        g.set(x0 + cx, y0 + cy, '▀', top === null ? T.panel : top, bot === null ? T.panel : bot);
      }
    }

    // ── 底部说明（图标固定；超宽行随 hscroll 自动/手动横移，右侧留 1 列给 … 提示）
    const iy = y0 + grows;
    const edgeCol = x0 + r.w - 3;              // 面板内最后一列，用于放 … 提示
    for (let i = 0; i < lg; i++) {
      const L = legend[i];
      const yy = iy + i;
      if (yy >= r.y + r.h - 1) break;
      g.text(x0, yy, L.g, L.c !== undefined ? L.c : T.dim, T.panel);
      const w = g.strWidth(L.t);
      const start = w > textCols ? Math.min(this.hscroll, w - textCols) : 0;  // 每行夹到自身末端，避免越过最后字后留空白
      const sub = sliceCols(g, L.t, start, textCols);
      g.text(x0 + 2, yy, sub, L.dim ? T.dim : T.text, T.panel);
      if (w > textCols && this.hscroll < w - textCols)
        g.text(edgeCol, yy, '…', T.dim, T.panel);        // 右侧还有没露出的内容
    }
    if (lg === 0 && rows >= 6) {
      const n = real ? this.nodes.length : DECOR_ARCS.length;
      g.text(x0, r.y + r.h - 2, `NETLINK ${n} arcs`, T.dim, T.panel);
      const lonS = `中心 ${Math.round(((yaw + 180) % 360 + 360) % 360 - 180)}°`;
      g.text(r.x + r.w - 1 - g.strWidth(lonS), r.y + r.h - 2, lonS, T.dim, T.panel);
    }
  }

  buildLegend(real, T) {
    T = T || {};
    const out = [];
    const node = T.node !== undefined ? T.node : 0x000000;
    const dim = T.dim !== undefined ? T.dim : 0x000000;
    if (!real) {
      // 没有可定位的点：仍然把已知的本机信息列出来，别整块空掉
      out.push({ g: 'o', c: dim, t: this.geo ? '未取到公网地理 · 离线或受限网络' : '正在获取网络地理…', dim: true });
      out.push(...this.lanLines(dim));
      return out;
    }
    if (this.selfNode) {
      const s = this.selfNode;
      out.push({ g: GLYPH.self, c: node, t: `${s.ip}  ${[s.city, s.isp].filter(Boolean).join(' · ')}` });
    }
    for (const n of this.nodes) {
      const via = n.kind === 'upstream' && n.via ? ` ← ${n.via}` : '';
      const rtt = n.rtt != null ? `${n.rtt}ms` : '从本机不可直连';
      out.push({
        g: n.kind === 'upstream' ? GLYPH.upstream : GLYPH.dns, c: node,
        t: `${n.kind === 'upstream' ? 'DNS↑' : 'DNS '} ${n.ip}  ${n.city}${via}  ${rtt}`,
      });
    }
    out.push(...this.lanLines(dim));
    return out;
  }

  // 本机 / 网关 / LAN DNS 这些没有独立地理位置的，只列数字
  lanLines(dim) {
    const geo = this.geo;
    if (!geo) return [];
    const parts = [];
    if (geo.lan && geo.lan.length) parts.push(`本机 ${geo.lan[0].ip}`);
    const gw = geo.gateway6 && !geo.gateway ? geo.gateway6 : geo.gateway;
    if (gw) parts.push(`网关 ${gw}`);
    if (geo.gateway && geo.gateway6) parts.push('v6 ' + geo.gateway6.split(':').slice(0, 3).join(':'));
    const lanDns = (geo.dns || []).filter((d) => d.kind === 'lan');
    if (lanDns.length) parts.push(`DNS ${lanDns.map((d) => `${d.ip}${d.rtt != null ? ` ${d.rtt}ms` : ''}`).join(', ')}`);
    return parts.length ? [{ g: '⌂', c: dim, t: parts.join(' · '), dim: true }] : [];
  }

  hit(mx, my) { const r = this.rect; return r && mx >= r.x && mx < r.x + r.w && my >= r.y && my < r.y + r.h; }

  // 横向滚动：鼠标在地球面板上滚轮 → 左右平移 IP/位置说明（地球旋转仍用拖拽，不冲突）
  onWheel(dy, dx = 0) {
    if (!this._scrollable) return false;
    const d = (Math.abs(dx) > Math.abs(dy)) ? dx : dy;
    if (d === 0) return false;
    this._manualTarget = Math.max(0, Math.min(this._maxScroll, this._manualTarget + Math.sign(d) * 3));
    this._manualUntil = this._now + 5;          // 滚轮后 5s 内手动控制，过后交回自动跑马灯
    this.hscroll = this._manualTarget;
    return true;
  }

  // 自动跑马灯：0→max→0 往返，两端各停片刻；恒定速度（无加速度：起步即满速，到头即停）
  static _autoPos(max, t) {
    const scrollT = 8;
    const dwellMax = 1.8;        // 抵达末端（去程结束）后停留：短一点
    const dwellHome = 3.2;       // 回到起点（回程结束，可读初始位置）后停留：长一点（自然阅读位）
    const period = 2 * scrollT + dwellMax + dwellHome;
    const tp = t % period;
    // 纯线性推进：每个行程内位置随时间匀速变化，速度从第一个时间步起就恒定，
    // 不存在“0→半速→全速”的渐加速，也不存在到头渐减速；到末端即停、停完即满速反向。
    if (tp < scrollT) return (tp / scrollT) * max;                                       // 去程 0→max（匀速）
    if (tp < scrollT + dwellMax) return max;                                             // 末端短停
    if (tp < 2 * scrollT + dwellMax) return (1 - (tp - scrollT - dwellMax) / scrollT) * max; // 回程 max→0（匀速）
    return 0;                                                                           // 起点长停
  }

  onDown(cellX, cellY) { this.dragging = { x: cellX, y: cellY, yaw: this.yaw, pitch: this.pitch }; return true; }
  onMove(cellX, cellY) {
    if (!this.dragging) return false;
    this.userDragged = true;
    this.yaw = this.dragging.yaw + (cellX - this.dragging.x) * 4;
    this.pitch = Math.max(-85, Math.min(85, this.dragging.pitch + (cellY - this.dragging.y) * 2.5));
    return true;
  }
  onUp() { this.dragging = null; }
}
