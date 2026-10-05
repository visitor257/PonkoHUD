# -*- coding: utf-8 -*-
"""从 mockup/index.html 抽出已注入的 MASK_B64，生成 app/src/landmask.js 模块。
这样正式工程和视觉稿共用同一份海陆位图，不用重复注入。
"""
import os
import re
import base64

HERE = os.path.dirname(os.path.abspath(__file__))
HTML = os.path.join(HERE, "..", "mockup", "index.html")
OUT = os.path.join(HERE, "..", "app", "src", "landmask.js")

html = open(HTML, encoding="utf-8").read()
m = re.search(r'const\s+MASK_B64\s*=\s*"([A-Za-z0-9+/=]+)"', html)
if not m:
    raise SystemExit("没找到 MASK_B64")
b64 = m.group(1)
raw = base64.b64decode(b64)
print("base64 %d chars -> %d bytes" % (len(b64), len(raw)))

# 校验：能解出海陆比例，说明没抽错
bits = sum(bin(b).count("1") for b in raw)
total = len(raw) * 8
print("land bits %d / %d = %.1f%%" % (bits, total, bits * 100.0 / total))

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    f.write("// 自动生成（tools/extract_mask.py）—— 海陆位图，来自 NASA Blue Marble\n")
    f.write("// 1 bit = 1 度网格（360x180 = 8100 字节 packed，1=陆 0=海）\n")
    f.write("export const MASK_B64 =\n  \"%s\";\n\n" % b64)
    f.write("""let _m = null;
export function landmask() {
  if (_m) return _m;
  const bin = atob(MASK_B64);
  const m = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) m[i] = bin.charCodeAt(i);
  _m = m;
  return m;
}

/** 经纬度 -> 是否陆地（lat: -90..90, lon: -180..180） */
export function isLand(lat, lon) {
  const M = landmask();
  let x = Math.floor(((lon + 180) % 360 + 360) % 360);
  let y = Math.floor(90 - lat);
  if (y < 0) y = 0; if (y > 179) y = 179;
  const i = y * 45 + (x >> 3);
  if (i >= M.length) return false;
  return (M[i] >> (7 - (x & 7))) !== 0;
}
""")
print("wrote", OUT, os.path.getsize(OUT), "bytes")
