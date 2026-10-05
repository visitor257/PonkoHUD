// 系统数据采集：全部走 Node 标准库，慢项（磁盘/网络/GPU）异步缓存
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

const cache = { disk: null, net: null, gpu: null, netPrev: null };

function cpuSample() {
  const c = os.cpus();
  let idle = 0, total = 0;
  for (const cpu of c) {
    for (const k in cpu.times) { total += cpu.times[k]; }
    idle += cpu.times.idle;
  }
  return { idle, total };
}

let prevCpu = cpuSample();
function cpuUsage() {
  const cur = cpuSample();
  const dTotal = cur.total - prevCpu.total;
  const dIdle = cur.idle - prevCpu.idle;
  prevCpu = cur;
  if (dTotal <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
}

function readDisk() {
  try {
    const s = fs.statfsSync('C:\\');
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { total, free, used: total - free, pct: total ? (1 - free / total) * 100 : 0 };
  } catch (e) {
    return null;
  }
}

function shellJson(cmd) {
  return new Promise((res) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { windowsHide: true, timeout: 8000, maxBuffer: 1 << 20 },
      (err, out) => {
        if (err) return res(null);
        try { res(JSON.parse(out.trim())); } catch (e) { res(null); }
      });
  });
}

async function refreshSlow() {
  // 磁盘（fs.statfs 同步但很快）
  cache.disk = readDisk();

  // 网络：各适配器收发字节累计值，两次采样求速率
  const stats = await shellJson(
    'Get-NetAdapterStatistics -ErrorAction SilentlyContinue | ' +
    'Measure-Object -Property ReceivedBytes,SentBytes -Sum | ' +
    'ConvertTo-Json -Compress'
  );
  if (stats && stats.length) {
    const s = Array.isArray(stats) ? stats[0] : stats;
    const now = { rx: Number(s.Sum) || 0, tx: Number(stats[1] && stats[1].Sum) || 0, t: Date.now() };
    if (cache.netPrev) {
      const dt = (now.t - cache.netPrev.t) / 1000;
      if (dt > 0.2) {
        cache.net = {
          rxRate: Math.max(0, (now.rx - cache.netPrev.rx) / dt),
          txRate: Math.max(0, (now.tx - cache.netPrev.tx) / dt),
        };
      }
    }
    cache.netPrev = now;
  }

  // GPU：只有 nvidia-smi 可用时才有真数据
  const gpu = await new Promise((res) => {
    execFile('nvidia-smi',
      ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { windowsHide: true, timeout: 4000 },
      (err, out) => {
        if (err || !out) return res(null);
        const line = out.trim().split('\n')[0] || '';
        const p = line.split(',').map((x) => parseFloat(x.trim()));
        if (p.length >= 3 && !isNaN(p[0])) return res({ util: p[0], memUsed: p[1], memTotal: p[2] });
        res(null);
      });
  });
  cache.gpu = gpu;
}

refreshSlow();
setInterval(refreshSlow, 3000);

function snapshot() {
  const total = os.totalmem(), free = os.freemem();
  const d = cache.disk;
  return {
    host: os.hostname(),
    user: os.userInfo().username,
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpu: {
      usage: cpuUsage(),
      model: (os.cpus()[0] || {}).model || 'unknown',
      cores: os.cpus().length,
    },
    mem: { total, free, used: total - free, pct: (1 - free / total) * 100 },
    disk: d ? { total: d.total, free: d.free, used: d.used, pct: d.pct } : null,
    net: cache.net ? { rx: cache.net.rxRate, tx: cache.net.txRate } : null,
    gpu: cache.gpu,
    uptime: os.uptime(),
    load: os.loadavg ? os.loadavg() : [0, 0, 0],
    procs: null,   // 前端不需要，进程数走 shell 命令
  };
}

module.exports = { snapshot, refreshSlow };
