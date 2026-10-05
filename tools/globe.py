# -*- coding: utf-8 -*-
"""
globe.py —— 把海陆位图渲染成"方块地球"（字符画版 WebGL Globe）。

复刻 eDEX-UI 的 locationGlobe：深色球体 + 陆地着色 + 经线纬线 + 网络连接弧 + 自转。
核心是球面反投影：对屏幕每个子像素反解出球面经纬度，再回查 landmask，
所以任意视角都能实时转（对应 eDEX-UI 的 dayLength=45s）。

坐标约定：
  世界坐标 world = Ry(yaw) · Rx(-pitch) 之后得到视空间 view
  view.x 向右、view.y 向上、view.z 朝观察者；z>0 即正面可见
  screen 坐标 sx=view.x, sy=view.y，球外 r2>1

输出：
  globe.txt   纯文本（* 弧线、o 节点，任何等宽环境可看）
  globe.ans   ANSI 24bit 真彩
  frames/     自转逐帧（--spin）
"""
import argparse
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
WORLD = os.path.join(HERE, "_world")


# ---------------------------------------------------------------- 数据
def load_mask():
    with open(os.path.join(WORLD, "landmask.json"), encoding="utf-8") as f:
        d = json.load(f)
    return d["w"], d["h"], [[int(c) for c in row] for row in d["rows"]]


MW, MH, MASK = load_mask()


def is_land(lat, lon):
    x = int((lon + 180.0) / 360.0 * MW) % MW
    y = int((90.0 - lat) / 180.0 * MH)
    y = 0 if y < 0 else (MH - 1 if y >= MH else y)
    return MASK[y][x]


# ---------------------------------------------------------------- 投影
def world_from_latlon(lat, lon):
    la, lo = math.radians(lat), math.radians(lon)
    return math.cos(la) * math.sin(lo), math.sin(la), math.cos(la) * math.cos(lo)


def to_view(x, y, z, yaw, pitch):
    """yaw = 画面正中那条经线（正值=东经），pitch>0 = 北极朝观察者俯过来"""
    a = math.radians(-yaw)
    ca, sa = math.cos(a), math.sin(a)
    x1, z1 = x * ca + z * sa, -x * sa + z * ca
    cp, sp = math.cos(math.radians(pitch)), math.sin(math.radians(pitch))
    return x1, y * cp - z1 * sp, y * sp + z1 * cp


def project(lat, lon, yaw, pitch):
    return to_view(*world_from_latlon(lat, lon), yaw, pitch)


def unproject(sx, sy_, yaw, pitch):
    """屏幕坐标(in [-1,1]) -> (lat, lon, 该点在球面朝观察者的程度)；球外 None"""
    r2 = sx * sx + sy_ * sy_
    if r2 > 1.0:
        return None
    sz = math.sqrt(1.0 - r2)
    cp, sp = math.cos(math.radians(pitch)), math.sin(math.radians(pitch))
    y1 = sy_ * cp + sz * sp
    z1 = -sy_ * sp + sz * cp
    b = math.radians(yaw)
    x0 = sx * math.cos(b) + z1 * math.sin(b)
    z0 = -sx * math.sin(b) + z1 * math.cos(b)
    lat = math.degrees(math.asin(max(-1.0, min(1.0, y1))))
    lon = math.degrees(math.atan2(x0, z0))
    return lat, lon, sz


# ---------------------------------------------------------------- 弧线
ARCS = [
    (39.90, 116.40, 37.77, -122.42),   # 北京 - 旧金山
    (51.51, -0.13, 1.35, 103.82),      # 伦敦 - 新加坡
    (35.68, 139.69, -33.87, 151.21),   # 东京 - 悉尼
    (52.52, 13.40, 40.71, -74.01),     # 柏林 - 纽约
    (22.30, 114.17, 51.51, -0.13),     # 香港 - 伦敦
]
NODES = [(39.90, 116.40), (51.51, -0.13), (1.35, 103.82), (40.71, -74.01),
         (37.77, -122.42), (-33.87, 151.21), (52.52, 13.40), (22.30, 114.17)]


def arc_points(a, b, steps=160):
    """球面两点之间的抬升弧（越远抬得越高），返回世界坐标点列"""
    p0 = world_from_latlon(*a)
    p1 = world_from_latlon(*b)
    dot = max(-1.0, min(1.0, sum(u * v for u, v in zip(p0, p1))))
    ang = math.acos(dot)
    mx, my, mz = (p0[0] + p1[0], p0[1] + p1[1], p0[2] + p1[2])
    n = math.sqrt(mx * mx + my * my + mz * mz) or 1.0
    lift = 1.0 + 0.05 + 0.45 * (ang / math.pi)
    c = (mx / n * lift, my / n * lift, mz / n * lift)
    out = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        out.append((u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0],
                    u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1],
                    u * u * p0[2] + 2 * u * t * c[2] + t * t * p1[2], t))
    return out


# ---------------------------------------------------------------- 渲染
PLAIN = {0: " ", 1: "▒", 2: "█"}          # 空 / 海 / 陆
C_SEA = (14, 52, 84)
C_SEA_LIT = (30, 104, 148)
C_LAND = (78, 224, 142)
C_LAND_DIM = (22, 100, 62)
C_ARC = (240, 222, 96)
C_ARC_DIM = (150, 138, 60)
C_NODE = (255, 92, 92)
C_GRID = (44, 150, 180)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def render(cols=64, rows=30, yaw=0.0, pitch=18.0, *, grid=True, arcs=True, spin_light=True):
    SW, SH = cols, rows * 2
    top = [[None] * cols for _ in range(rows)]
    bot = [[None] * cols for _ in range(rows)]
    plain = [[" "] * cols for _ in range(rows)]

    for cy in range(rows):
        for cx in range(cols):
            up = dn = None
            lu = ld = 0
            for half in (0, 1):
                j = cy * 2 + half
                sx = (cx + 0.5) / SW * 2 - 1
                sy = 1 - (j + 0.5) / SH * 2
                hit = unproject(sx, sy, yaw, pitch)
                if hit is None:
                    continue
                lat, lon, sz = hit
                land = is_land(lat, lon)
                # 体积感：连续的边缘压暗（球面朝向观察者的程度）
                light = 0.22 + 0.78 * (sz ** 0.85)
                if land:
                    col = lerp(C_LAND_DIM, C_LAND, light)
                    lvl = 2 if light > 0.42 else 1
                else:
                    col = lerp(C_SEA, C_SEA_LIT, light)
                    lvl = 1 if light > 0.5 else 0
                    if grid:
                        dlat = abs(((lat + 90) % 30) - 15)
                        dlon = abs(((lon + 180) % 30) - 15)
                        if dlat > 13.7 or dlon > 13.7:
                            col = lerp(col, C_GRID, 0.85)
                            lvl = 1
                if half == 0:
                    up, lu = col, lvl
                else:
                    dn, ld = col, lvl
            if up is None and dn is None:
                plain[cy][cx] = " "
            else:
                plain[cy][cx] = PLAIN[min(lu, ld) if (lu and ld) else max(lu, ld)]
            top[cy][cx], bot[cy][cx] = up, dn

    def blit(px, py, color, ch, force=True):
        col, row = px, py // 2
        if not (0 <= col < cols and 0 <= row < rows):
            return
        if top[row][col] is None and bot[row][col] is None:
            return
        if ch:                      # 纯文本层
            if ch == "*":
                plain[row][col] = "*"
        if py % 2 == 0:
            top[row][col] = color
        else:
            bot[row][col] = color
            if top[row][col] is None:
                top[row][col] = color

    if arcs:
        for i, a in enumerate(ARCS):
            for x, y, z, t in arc_points((a[0], a[1]), (a[2], a[3])):
                vx, vy, vz = to_view(x, y, z, yaw, pitch)
                if vz <= 0.02:
                    continue
                if (((1 - t) ** 2 + t ** 2) ** 0.5) < 0.02:
                    continue
                py = int((1 - vy) / 2 * SH)
                # 移动的光点：让弧线有"数据流动"的暗示
                beat = 0.5 + 0.5 * math.sin(i * 1.7 + math.pi * 8 * (t - 0.5))
                c = C_ARC if beat > 0.35 else C_ARC_DIM
                blit(int((vx + 1) / 2 * SW), py, c, "*")
        for n in NODES:
            vx, vy, vz = project(n[0], n[1], yaw, pitch)
            if vz <= 0.02:
                continue
            col = max(0, min(cols - 1, int((vx + 1) / 2 * SW)))
            row = max(0, min(rows - 1, int((1 - vy) / 2 * SH) // 2))
            if top[row][col] is None and bot[row][col] is None:
                continue
            top[row][col] = C_NODE
            bot[row][col] = C_NODE
            plain[row][col] = "o"
    return top, bot, plain


def to_ansi(top, bot, cols, rows):
    out = []
    for cy in range(rows):
        line = []
        for cx in range(cols):
            t, b = top[cy][cx], bot[cy][cx]
            if t is None and b is None:
                line.append(" ")
                continue
            t = t or (0, 0, 0)
            b = b or (0, 0, 0)
            line.append(f"\x1b[38;2;{t[0]};{t[1]};{t[2]}m\x1b[48;2;{b[0]};{b[1]};{b[2]}m▀")
        out.append("".join(line) + "\x1b[0m")
    return "\n".join(out)


def to_plain(plain):
    return "\n".join("".join(r) for r in plain)


def save_png(path, top, bot, cols, rows, cw=14, ch=28, bg=(6, 10, 14)):
    """把颜色网格画成 PNG：每格上下两块实心矩形（就是 ▀ 的像素级等价物）"""
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (cols * cw, rows * ch), bg)
    d = ImageDraw.Draw(img)
    for r in range(rows):
        for c in range(cols):
            for half, col in ((0, top[r][c]), (1, bot[r][c])):
                if col is None:
                    continue
                x0, y0 = c * cw, r * ch + half * (ch // 2)
                d.rectangle([x0, y0, x0 + cw - 1, y0 + ch // 2 - 1], fill=tuple(col))
    img.save(path)
    return path


VIEWS = [("太平洋 / 东亚", 116.0, 18.0), ("欧洲 / 非洲", 20.0, 18.0), ("美洲", -75.0, 18.0)]

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--cols", type=int, default=64)
    ap.add_argument("--rows", type=int, default=30)
    ap.add_argument("--pitch", type=float, default=18.0)
    ap.add_argument("--lon", type=float, default=None)
    ap.add_argument("--spin", action="store_true")
    ap.add_argument("--png", action="store_true", help="另外导出 globe.png 便于肉眼检查")
    args = ap.parse_args()

    parts = []
    for name, lon, _ in VIEWS:
        v = args.lon if args.lon is not None else lon
        top, bot, plain = render(args.cols, args.rows, v, args.pitch)
        parts.append((name, plain, to_ansi(top, bot, args.cols, args.rows)))
        if args.png:
            save_png(os.path.join(HERE, f"globe_{int(v)}.png"), top, bot, args.cols, args.rows)

    with open(os.path.join(HERE, "globe.txt"), "w", encoding="utf-8") as f:
        f.write("\n\n".join(f"[{n}]\n{to_plain(p)}" for n, p, _ in parts))
    with open(os.path.join(HERE, "globe.ans"), "w", encoding="utf-8") as f:
        f.write("\n\n".join(f"[{n}]\n{a}" for n, _, a in parts))

    if args.spin:
        fd = os.path.join(HERE, "frames")
        os.makedirs(fd, exist_ok=True)
        for i in range(12):
            top, bot, _ = render(args.cols, args.rows, i * 30.0, args.pitch)
            with open(os.path.join(fd, f"spin_{i:02d}.ans"), "w", encoding="utf-8") as f:
                f.write(to_ansi(top, bot, args.cols, args.rows))

    print(f"cols={args.cols} rows={args.rows}  ->  globe.txt / globe.ans")
    for name, plain, _ in parts:
        print(f"\n[{name}]")
        print("+" + "-" * args.cols + "+")
        for ln in to_plain(plain).split("\n"):
            print("|" + ln + "|")
        print("+" + "-" * args.cols + "+")
