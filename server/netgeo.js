// 网络地理：本机公网出口 IP / 默认网关 / DNS 服务器 —— 让 GLOBE 面板画真实的自己
//
// 数据源：ip-api.com（免费、支持 /batch 一次查多个 IP、IPv4+IPv6、字段全）
//         → ipwho.is（HTTPS 兜底）→ ipify / icanhazip（只拿出口 IP，兼容 IPv6-only 网络）
//
// 换机的可靠性设计：
//   1. 地理位置结果落盘缓存（IP 位置几乎不变），但**每次请求都会廉价体检**：
//      本机 IPv4 变了、或公网出口 IP 变了 → 立刻重算（不等 30 分钟）
//   2. 出口 IP 检测有 IPv4 / IPv6 兜底，IPv6-only 网络也能定位
//   3. DNS 同时采 IPv4 + IPv6，过滤链路本地 / ULA / 站点本地等无地理意义的地址
//   4. 拿不到公网地理时仍返回 LAN / 网关 / DNS 清单，界面不会整块空白
const http = require('http');
const https = require('https');
const dns = require('dns');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CACHE_FILE = path.join(__dirname, 'netgeo-cache.json');
const BATCH_URL = 'http://ip-api.com/batch?fields=status,message,query,countryCode,regionName,city,lat,lon,isp,as&lang=zh-CN';
const IPWHO = (ip) => `https://ipwho.is/${encodeURIComponent(ip)}`;
const IP_API_SELF = 'http://ip-api.com/json/?fields=status,message,query,countryCode,regionName,city,lat,lon,isp,as&lang=zh-CN';
const REFRESH_MS = 30 * 60 * 1000;      // 完整重算周期
const CACHE_MAX = 300;                  // 缓存条目上限
const CACHE_TTL = 60 * 24 * 3600 * 1000; // 60 天没见过的条目淘汰

let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {}; } catch (e) { cache = {}; }

function saveCache() {
  const now = Date.now();
  let keys = Object.keys(cache);
  for (const k of keys) if (!cache[k].ts || now - cache[k].ts > CACHE_TTL) delete cache[k];
  keys = Object.keys(cache);
  if (keys.length > CACHE_MAX) {
    keys.sort((a, b) => (cache[b].ts || 0) - (cache[a].ts || 0));
    const keep = new Set(keys.slice(0, CACHE_MAX));
    for (const k of keys) if (!keep.has(k)) delete cache[k];
  }
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1)); } catch (e) { /* 只读环境就算了 */ }
}

// ── HTTP(S)，超时即放弃
function getJson(url, timeout = 6000) {
  return new Promise((res, rej) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout, headers: { 'User-Agent': 'PonkoHUD/0.1' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        return getJson(r.headers.location, timeout).then(res, rej);
      }
      let b = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { b += c; if (b.length > 1 << 20) { r.destroy(); rej(new Error('too big')); } });
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', rej);
  });
}

function getText(url, timeout = 5000) {
  return new Promise((res, rej) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout, headers: { 'User-Agent': 'PonkoHUD/0.1' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        return getText(r.headers.location, timeout).then(res, rej);
      }
      let b = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { b += c; });
      r.on('end', () => res(b.trim()));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', rej);
  });
}

function postJson(url, body, timeout = 8000) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const req = (u.protocol === 'https:' ? https : http).request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST', timeout,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (r) => {
      let b = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { b += c; });
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', rej);
    req.end(payload);
  });
}

// ── 私有/无效地址判断（这些 IP 没有地理意义），IPv4 + IPv6
function isPrivate(ip) {
  const s = String(ip).split('%')[0].toLowerCase();     // IPv6 可能带 %接口序号
  if (s.includes(':')) {
    if (s === '::' || s === '::1') return true;
    if (/^fe[89ab]/.test(s)) return true;               // fe80::/10 链路本地
    if (/^f[cd]/.test(s)) return true;                  // fc00::/7 唯一本地地址
    if (/^fec0/.test(s)) return true;                   // 站点本地（Windows 伪接口常见）
    if (/^ff/.test(s)) return true;                     // 组播
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivate(mapped[1]);            // IPv4-mapped
    return false;
  }
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return true;
  const a = +m[1], b = +m[2];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT
  if (a >= 224) return true;                           // 组播/保留
  return false;
}

// ── 本机网络信息
function lanAddrs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ ip: ni.address, iface: ni.iface || '' });
    }
  }
  return out;
}

// 换网络的廉价体检指纹：IPv4 内网地址集合
// （IPv6 有隐私扩展会频繁变，不能进指纹，否则会不停地全量重算）
function lanFingerprint() {
  return Object.values(os.networkInterfaces())
    .flatMap((l) => (l || []).filter((n) => n.family === 'IPv4' && !n.internal).map((n) => n.address))
    .sort().join(',');
}

// PowerShell 的默认输出是 ANSI(936)，含中文的接口名会被解烂 —— 强制 UTF-8 输出
const PS_UTF8 = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ';
function psLines(cmd, timeout = 10000) {
  return new Promise((res) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_UTF8 + cmd],
      { windowsHide: true, timeout, maxBuffer: 1 << 20 },
      (err, out) => {
        if (err || !out) return res([]);
        res(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
      });
  });
}

// DNS：IPv4 + IPv6 都要（IPv6-only 网络里 IPv4 那份可能压根不存在）
const dnsServers = () => psLines(
  'Get-DnsClientServerAddress -ErrorAction SilentlyContinue | ' +
  'Where-Object { $_.ServerAddresses -and ' +
  '(Get-NetAdapter -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue).Status -eq \'Up\' } | ' +
  'ForEach-Object { $a = $_.InterfaceAlias; foreach ($s in $_.ServerAddresses) { "$a|$s" } }'
);

const gateways = () => psLines(
  "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | " +
  'Sort-Object RouteMetric | Select-Object -First 1 -ExpandProperty NextHop), ' +
  "(Get-NetRoute -DestinationPrefix '::/0' -ErrorAction SilentlyContinue | " +
  'Sort-Object RouteMetric | Select-Object -First 1 -ExpandProperty NextHop)'
);

// ── DNS 探活：向指定服务器发一次查询测往返延迟（IPv6 要加方括号）
function probeDns(ip, host = 'example.com', timeout = 2500) {
  return new Promise((res) => {
    const r = new dns.Resolver();
    const server = String(ip).includes(':') ? `[${ip}]` : ip;
    try { r.setServers([server]); } catch (e) { return res(null); }
    let settled = false;
    const fin = (v) => { if (!settled) { settled = true; res(v); } };
    const t = Date.now();
    const to = setTimeout(() => { fin(null); try { r.cancel(); } catch (e) {} }, timeout);
    r.resolve4(host, (err) => { clearTimeout(to); fin(err ? null : Date.now() - t); });
  });
}

// ── 挖出 LAN DNS（通常是路由器）实际转发给的上游递归解析器
//
// 原理：whoami 类 TXT 记录由权威服务器把「看到的那台解析器」的 IP 回给你。
// 当我们向本地 DNS 发问时，最终去问权威服务器的是它转发链上的**上游 resolver**，
// 所以拿到的不是我们自己，而是真正做递归的那台机器 —— 这才有地理位置意义。
//
// 注意：这类记录常常把 ECS（我们自己的子网）也一起返回，必须连同自身 IP 一起排除。
const UPSTREAM_NAMES = ['resolver.dnscrypt.info', 'whoami.ds.akahelp.net', 'o-o.myaddr.l.google.com'];

function txtQuery(ip, name, timeout = 4000) {
  return new Promise((res) => {
    const r = new dns.Resolver();
    const server = String(ip).includes(':') ? `[${ip}]` : ip;
    try { r.setServers([server]); } catch (e) { return res([]); }
    let settled = false;
    const fin = (v) => { if (!settled) { settled = true; res(v); } };
    const to = setTimeout(() => { fin([]); try { r.cancel(); } catch (e) {} }, timeout);
    r.resolveTxt(name, (err, txt) => { clearTimeout(to); fin(err ? [] : txt || []); });
  });
}

async function discoverUpstream(ip, selfIp, timeout = 4000) {
  const found = new Set();
  const selfNet = (selfIp && !String(selfIp).includes(':'))
    ? selfIp.split('.').slice(0, 3).join('.') : null;
  for (const name of UPSTREAM_NAMES) {
    const rows = await txtQuery(ip, name, timeout);
    for (const row of rows) {
      for (const s of row) {
        for (const c of String(s).match(/\d+\.\d+\.\d+\.\d+/g) || []) {
          if (isPrivate(c)) continue;
          if (selfIp && c === selfIp) continue;                    // 就是自己
          if (selfNet && c.startsWith(selfNet + '.')) continue;    // ECS 回传的自身子网
          found.add(c);
        }
      }
    }
  }
  // 同一个转发池里可能有多台：每台 LAN DNS 最多取 2 个
  // （顺序 = 探测可靠性：dnscrypt 的 Resolver IP 最可信）
  return [...found].slice(0, 2);
}

// ── 地理查询（带缓存），IPv4 / IPv6 都支持
async function geoMany(ips) {
  const need = ips.filter((ip) => !cache[ip]);
  const out = {};
  for (const ip of ips) if (cache[ip]) out[ip] = cache[ip];

  if (need.length) {
    try {
      const rows = await postJson(BATCH_URL, need);
      for (const row of rows || []) {
        if (row.status !== 'success') continue;
        cache[row.query] = {
          ip: row.query, country: row.countryCode || '', region: row.regionName || '',
          city: row.city || '', lat: row.lat, lon: row.lon,
          isp: row.isp || '', as: row.as || '', via: 'ip-api', ts: Date.now(),
        };
        out[row.query] = cache[row.query];
      }
    } catch (e) { /* 换下一家 */ }

    const still = need.filter((ip) => !out[ip]);
    if (still.length) {
      const got = await Promise.all(still.map(async (ip) => {
        try {
          const j = await getJson(IPWHO(ip), 5000);
          if (!j || j.success === false) return null;
          return [ip, {
            ip, country: j.country_code || '', region: j.region || '',
            city: j.city || '', lat: j.latitude, lon: j.longitude,
            isp: (j.connection && (j.connection.isp || j.connection.org)) || '',
            as: (j.connection && j.connection.asn) ? String(j.connection.asn) : '',
            via: 'ipwho', ts: Date.now(),
          }];
        } catch (e2) { return null; }
      }));
      for (const kv of got) {
        if (kv) { cache[kv[0]] = kv[1]; out[kv[0]] = kv[1]; }
      }
    }
    saveCache();
  }
  return out;
}

// ── 自己的公网出口：IPv4 优先，一路兜底到能返回 IPv6 的数据源
//    （IPv6-only 网络里 ip-api / ipwho.is 这种 IPv4-only 域名可能连不上）
async function ownIp() {
  try {
    const j = await getJson(IP_API_SELF, 5000);
    if (j && j.status === 'success' && j.query) {
      return {
        ip: j.query, v6: false, country: j.countryCode || '', region: j.regionName || '',
        city: j.city || '', lat: j.lat, lon: j.lon, isp: j.isp || '', as: j.as || '',
      };
    }
  } catch (e) { /* 兜底 */ }
  try {
    const j = await getJson('https://ipwho.is/', 5000);
    if (j && j.success !== false && j.ip) {
      return {
        ip: j.ip, v6: String(j.ip).includes(':'), country: j.country_code || '',
        region: j.region || '', city: j.city || '', lat: j.latitude, lon: j.longitude,
        isp: (j.connection && j.connection.isp) || '',
      };
    }
  } catch (e2) { /* 再兜底 */ }
  // 只给 IP 的数据源（可能回 IPv6），拿到后再查一次地理
  for (const url of ['https://api64.ipify.org?format=json', 'https://icanhazip.com', 'https://api.ipify.org?format=json']) {
    try {
      const raw = await getText(url, 4000);
      let ip = null;
      try { ip = JSON.parse(raw).ip; } catch (e) { ip = raw; }
      if (!ip) continue;
      ip = String(ip).trim();
      if (isPrivate(ip)) continue;
      const map = await geoMany([ip]);
      const g = map[ip];
      if (g && g.lat != null) {
        return { ip, v6: ip.includes(':'), country: g.country, region: g.region, city: g.city, lat: g.lat, lon: g.lon, isp: g.isp, as: g.as };
      }
      return { ip, v6: ip.includes(':'), city: '', lat: null, lon: null, isp: '' };
    } catch (e3) { /* 下一个 */ }
  }
  return null;
}

// ── 对外快照
let last = null, lastAt = 0, inflight = null;

async function netgeo(force = false) {
  const now = Date.now();
  if (inflight) return inflight;

  // 缓存期内也做一次廉价体检：换了网段 / 换了公网 IP 就要立刻重算，
  // 否则换 WiFi、插网线、开 VPN、DHCP 续租都要最多等 30 分钟才刷新
  if (!force && last && now - lastAt < REFRESH_MS) {
    let changed = lanFingerprint() !== last.fp;
    if (!changed) {
      const fresh = await ownIp().catch(() => null);
      if (fresh) {
        if (!last.self) changed = true;                          // 之前离线，现在通了
        else if (fresh.ip !== last.self.ip) changed = true;      // 出口 IP 变了（DHCP / VPN）
      }
    }
    if (!changed) return last;
  }

  inflight = (async () => {
    const lan = lanAddrs();
    const [gwLines, dnsLines, self] = await Promise.all([gateways(), dnsServers(), ownIp()]);
    const gw = gwLines.filter(Boolean);
    const gw4 = gw.find((x) => !x.includes(':')) || null;
    const gw6 = gw.find((x) => x.includes(':')) || null;
    const selfIp = self ? self.ip : null;
    const selfPos = (self && self.lat != null) ? { lat: self.lat, lon: self.lon } : null;

    // 解析 "接口别名|IP"，去重（同一 DNS 常出现在多个网卡上）
    const seen = new Set();
    const raw = [];
    for (const line of dnsLines) {
      const cut = line.indexOf('|');
      const iface = cut > 0 ? line.slice(0, cut) : '';
      const ip = (cut > 0 ? line.slice(cut + 1) : line).trim();
      if (!ip || seen.has(ip)) continue;
      const v6 = ip.includes(':');
      if (!v6 && !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) continue;
      if (v6 && isPrivate(ip)) continue;                       // fe80:: 这类链路本地没法定位
      seen.add(ip);
      raw.push({ ip, iface: iface.trim() });
    }

    // LAN DNS → 试着挖出它转发的上游 resolver；本机自己/网关也算 LAN
    const isLanOwn = (ip) => isPrivate(ip) || gw.includes(ip) || lan.some((x) => x.ip === ip);
    const upMap = {};
    await Promise.all(raw.filter((x) => isLanOwn(x.ip)).map(async (x) => {
      upMap[x.ip] = await discoverUpstream(x.ip, selfIp);
    }));
    const upAll = new Set();
    for (const k in upMap) upMap[k].forEach((i) => upAll.add(i));

    const geoMap = await geoMany([...raw.map((x) => x.ip), ...upAll]);

    const mkNode = (x, kind, g, rtt, viaGateway) => ({
      ip: x.ip,
      iface: x.iface || '',
      kind,                                        // dns | lan | upstream
      v6: String(x.ip).includes(':'),
      lat: (g && g.lat != null) ? g.lat : (selfPos ? selfPos.lat : null),
      lon: (g && g.lon != null) ? g.lon : (selfPos ? selfPos.lon : null),
      city: kind === 'lan' ? 'LAN' : ((g && g.city) || '?'),
      region: (g && g.region) || '',
      country: (g && g.country) || '',
      isp: kind === 'lan' ? (viaGateway ? '本机/网关' : '本机') : ((g && g.isp) || ''),
      positioned: !!(g && g.lat != null),          // 坐标是它自己的地理位置（false=退化到本机）
      rtt,
    });

    const nodes = [];
    for (const x of raw) {
      const lanOwn = isLanOwn(x.ip);
      const g = lanOwn ? null : geoMap[x.ip];
      nodes.push(mkNode(x, lanOwn ? 'lan' : 'dns', g, await probeDns(x.ip), lanOwn));
      // 路由器 DNS 转发的上游 resolver：延迟单独探（多数从 LAN 不可达，超时就 null）
      for (const up of upMap[x.ip] || []) {
        nodes.push(mkNode({ ip: up, iface: x.ip }, 'upstream', geoMap[up],
          await probeDns(up, 'example.com', 1500)));
      }
    }

    last = {
      ok: !!self || nodes.length > 0,
      ts: Date.now(),
      fp: lanFingerprint(),
      self,
      lan,
      gateway: gw4,
      gateway6: gw6,
      dns: nodes,
      offline: !self,
    };
    lastAt = Date.now();
    return last;
  })().finally(() => { inflight = null; });

  return inflight;
}

module.exports = { netgeo, geoMany, isPrivate, probeDns, discoverUpstream, lanFingerprint };
