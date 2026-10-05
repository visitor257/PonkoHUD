# -*- coding: utf-8 -*-
"""
make_landmask.py —— 把等距圆柱投影(equirectangular)的世界地图压成海陆位图。

输入：_world/land_shallow_topo_2048.jpg (NASA Blue Marble, 2048x1024, 覆盖 -180..180 / 90..-90)
输出：
  _world/landmask.json   人类可读的 0/1 行文本（360x180，row 0 = 北纬 90°）
  _world/landmask.b64    packed bits 的 base64，供前端内联（8100 bytes -> 10800 chars）

判据：海洋是均匀的蓝色（B 明显大于 R/G），陆地/冰雪是其他任何色。
"""
import base64
import json
import os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "_world", "land_shallow_topo_2048.jpg")
OUT_JSON = os.path.join(HERE, "_world", "landmask.json")
OUT_B64 = os.path.join(HERE, "_world", "landmask.b64")

W, H = 360, 180  # 1° x 1°

img = Image.open(SRC).convert("RGB")
iw, ih = img.size
px = img.load()

grid = []
for y in range(H):
    # 纬度：row 0 = +90 度（北极），映射到图片顶部
    iy = min(ih - 1, int((y + 0.5) * ih / H))
    row = []
    for x in range(W):
        ix = min(iw - 1, int((x + 0.5) * iw / W))
        r, g, b = px[ix, iy]
        # 海水：蓝色分量占优且整体偏暗；其余（陆地/沙漠/冰盖）都算陆地
        water = (b > r + 8) and (b > g + 4)
        row.append(0 if water else 1)
    grid.append(row)

# 极区修正：Blue Marble 的南北极边界有硬切，把最上面/最下几行强制为陆地（冰盖）
for y in (0, 1):
    grid[y] = [1] * W
for y in (H - 2, H - 1):
    grid[y] = [1] * W

with open(OUT_JSON, "w", encoding="utf-8") as f:
    json.dump({"w": W, "h": H, "note": "row0=+90lat, col0=180W", "rows": ["".join(map(str, r)) for r in grid]},
              f, ensure_ascii=False)

# packed bits: 逐行左->右按位打包，MSB 在左
buf = bytearray()
acc = 0
nbit = 0
for row in grid:
    for v in row:
        acc = (acc << 1) | v
        nbit += 1
        if nbit == 8:
            buf.append(acc)
            acc = 0
            nbit = 0
if nbit:
    buf.append(acc << (8 - nbit))
with open(OUT_B64, "w", encoding="utf-8") as f:
    f.write(base64.b64encode(bytes(buf)).decode("ascii"))


def preview():
    """把位图按 2:1 字符长宽比降采样成 ASCII，肉眼确认大陆轮廓"""
    pw, ph = 118, 30
    out = []
    for cy in range(ph):
        line = ""
        for cx in range(pw):
            y0, y1 = int(cy * H / ph), max(int(cy * H / ph) + 1, int((cy + 1) * H / ph))
            x0, x1 = int(cx * W / pw), max(int(cx * W / pw) + 1, int((cx + 1) * W / pw))
            land = 0
            tot = 0
            for yy in range(y0, y1):
                for xx in range(x0, x1):
                    tot += 1
                    land += grid[yy][xx]
            frac = land / max(1, tot)
            line += " " if frac < 0.15 else ("." if frac < 0.4 else ("+" if frac < 0.7 else "#"))
        out.append(line)
    return out


if __name__ == "__main__":
    land_pct = sum(sum(r) for r in grid) / (W * H) * 100
    print(f"landmask {W}x{H}  陆地占比 {land_pct:.1f}%  (真实地球约 29%)")
    print("+" + "-" * 118 + "+")
    for ln in preview():
        print("|" + ln + "|")
    print("+" + "-" * 118 + "+")
    print("saved:", OUT_JSON, OUT_B64)
