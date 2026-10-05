# -*- coding: utf-8 -*-
"""charpack —— 素材管线核心：把用户图片转成终端方块字符帧。

这是「用户自定义表情」链路里唯一需要动算法的一步，产出两种格式：

  <label>.json   渲染器直接消费：cells[r][c] = [top_rgb, bottom_rgb]，null 表示透明格
  <label>.ans    标准 ANSI 24bit 序列，可直接 cat / type 到任何真彩终端验证效果
  preview.html   带颜色的网页预览（用浏览器看转换效果，调参数用）
  pack.json      角色素材包清单：表情标签 -> 帧文件映射

用法：
  python charpack.py --src ../characters/ds-whale/src --out ../characters/ds-whale/frames

关键参数：
  --cols 48        水平字符数（=水平像素数），越大越清晰，越小越"像素画"
  --rows 0         垂直字符数；0=按图片宽高比自动算（默认字符格宽:高=1:2）
  --cell-aspect 2  终端字符宽:高比，Windows Terminal 默认约 1:2
  --charset block  block=▀半块(默认) / shade=░▒▓█ / ascii=#@%*+=-:.
  --posterize 0    每通道色阶数，0=不量化；设 4~6 会更有"大色块"味、文件更小
  --bg "#0b1a26"   透明像素在 .ans 里填充的底色（JSON 里保留透明）
  --emit-pack      同时生成/更新 pack.json

帧命名约定：idle.png = 标签 idle 的单帧；idle_0.png / idle_1.png = 标签 idle 的逐帧动画。
"""
import argparse
import json
import os
import re
import sys

from PIL import Image

CHARSETS = {
    "block": ["▀"],
    "shade": ["█", "▓", "▒", "░"],
    "ascii": list("#@%*+=-:. "),
}


def parse_color(s):
    s = s.strip().lstrip("#")
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))


def posterize(px, levels):
    if levels <= 1:
        return (0, 0, 0)
    step = 255 / (levels - 1)
    return tuple(int(round(c / step) * step) for c in px)


def to_cells(img, cols, rows, charset, levels):
    """返回 cells[rows][cols] = (top, bottom)，每个是 (r,g,b) 或 None（透明）"""
    if charset == "block":
        small = img.resize((cols, rows * 2), Image.Resampling.LANCZOS)
    else:
        small = img.resize((cols, rows), Image.Resampling.LANCZOS)
    px = small.load()
    alpha = small.split()[-1].load()

    cells = []
    for cy in range(rows):
        row = []
        for cx in range(cols):
            if charset == "block":
                top, bot = px[cx, cy * 2], px[cx, cy * 2 + 1]
                t = None if alpha[cx, cy * 2] < 16 else posterize(top[:3], levels)
                b = None if alpha[cx, cy * 2 + 1] < 16 else posterize(bot[:3], levels)
                row.append([t, b])
            else:
                a = alpha[cx, cy]
                if a < 16:
                    row.append([None])
                else:
                    r, g, b = posterize(px[cx, cy][:3], levels)
                    lum = 0.299 * r + 0.587 * g + 0.114 * b
                    if charset == "shade":
                        idx = min(3, int((255 - lum) / 64))
                    else:
                        idx = min(len(CHARSETS["ascii"]) - 1, int((255 - lum) / 256 * len(CHARSETS["ascii"])))
                    row.append([(r, g, b), CHARSETS[charset][idx]])
        cells.append(row)
    return cells


def write_ans(cells, path, bg, charset):
    br, bgc, bb = bg
    out = []
    for row in cells:
        last = None
        line = []
        for cell in row:
            if charset == "block":
                t, b = cell
                if t is None and b is None:
                    style = ("reset",)
                    ch = " "
                else:
                    ft = bg if t is None else t
                    fb = bg if b is None else b
                    style = (ft, fb)
                    ch = "▀"
            else:
                if cell[0] is None:
                    style = ("reset",)
                    ch = " "
                else:
                    style = (cell[0],)
                    ch = cell[1]
            if style != last:
                if style == ("reset",):
                    line.append("\x1b[0m")
                elif len(style) == 2:
                    line.append("\x1b[38;2;%d;%d;%d;48;2;%d;%d;%dm" % (style[0] + style[1]))
                else:
                    line.append("\x1b[38;2;%d;%d;%dm" % style)
                last = style
            line.append(ch)
        line.append("\x1b[0m\n")
        out.append("".join(line))
    with open(path, "w", encoding="utf-8") as f:
        f.write("".join(out))


def write_json(cells, path, meta):
    data = dict(meta)
    data["cells"] = [[list(c) for c in row] for row in cells]
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)


def write_preview(frames, path, bg):
    bgs = "#%02x%02x%02x" % bg
    parts = ["""<!DOCTYPE html><html><head><meta charset="utf-8">
<title>charpack 预览</title><style>
body{background:#050c14;color:#8fb0c4;font-family:Consolas,"Cascadia Mono",monospace;margin:20px}
h2{font-size:13px;color:#35d0e0;font-weight:500;margin:26px 0 6px}
.frame{display:inline-block;background:%s;padding:8px;border:1px solid #14344a}
pre{margin:0;font-size:12px;line-height:12px}
.ctrl{position:sticky;top:0;background:#050c14;padding:8px 0;font-size:13px}
input[type=range]{vertical-align:middle}
</style></head><body>
<div class="ctrl">格子大小 <input id="sz" type="range" min="6" max="20" value="12">
<span id="szv">12px</span>　（等宽字体渲染半块字符 ▀，fg=上像素 bg=下像素）</div>""" % bgs]
    for label, cols, rows, html in frames:
        parts.append("<h2>%s <span style='color:#5f8299'>· %d×%d 格</span></h2>" % (label, cols, rows))
        parts.append('<div class="frame"><pre>%s</pre></div>' % html)
    parts.append("""<script>
const sz=document.getElementById('sz'),sv=document.getElementById('szv');
sz.oninput=()=>{document.querySelectorAll('pre').forEach(p=>{p.style.fontSize=sz.value+'px';p.style.lineHeight=sz.value+'px'});sv.textContent=sz.value+'px'};
</script></body></html>""")
    with open(path, "w", encoding="utf-8") as f:
        f.write("".join(parts))


def cells_to_html(cells, charset):
    out = []
    for row in cells:
        for cell in row:
            if charset == "block":
                t, b = cell
                fg = "#0b1a26" if t is None else "#%02x%02x%02x" % t
                bgc = "#0b1a26" if b is None else "#%02x%02x%02x" % b
                out.append('<span style="color:%s;background:%s">▀</span>' % (fg, bgc))
            else:
                if cell[0] is None:
                    out.append(" ")
                else:
                    out.append('<span style="color:#%02x%02x%02x">%s</span>' % (cell[0][0], cell[0][1], cell[0][2], cell[1]))
        out.append("\n")
    return "".join(out)


def main():
    ap = argparse.ArgumentParser(description="图片 → 终端方块字符帧")
    ap.add_argument("--src", required=True, help="图片目录（PNG/JPG/GIF）")
    ap.add_argument("--out", required=True, help="帧输出目录")
    ap.add_argument("--cols", type=int, default=48)
    ap.add_argument("--rows", type=int, default=0, help="0=按宽高比自动")
    ap.add_argument("--cell-aspect", type=float, default=2.0)
    ap.add_argument("--charset", choices=list(CHARSETS), default="block")
    ap.add_argument("--posterize", type=int, default=0)
    ap.add_argument("--bg", default="#0b1a26")
    ap.add_argument("--emit-pack", action="store_true")
    args = ap.parse_args()

    bg = parse_color(args.bg)
    os.makedirs(args.out, exist_ok=True)
    files = sorted(f for f in os.listdir(args.src)
                   if f.lower().endswith((".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp")))
    if not files:
        sys.exit("no images in " + args.src)

    packs = {}
    frames_for_preview = []
    for fn in files:
        label = re.sub(r"_\d+$", "", os.path.splitext(fn)[0])
        img = Image.open(os.path.join(args.src, fn)).convert("RGBA")
        cols = args.cols
        rows = args.rows or max(4, round(cols * img.height / img.width / args.cell_aspect))
        cells = to_cells(img, cols, rows, args.charset, args.posterize)

        meta = {"label": label, "file": fn, "cols": cols, "rows": rows,
                "charset": args.charset, "cellAspect": args.cell_aspect}
        write_json(cells, os.path.join(args.out, label + ".json"), meta)
        write_ans(cells, os.path.join(args.out, label + ".ans"), bg, args.charset)
        frames_for_preview.append((label, cols, rows, cells_to_html(cells, args.charset)))

        m = packs.setdefault(label, [])
        m.append(label + ".ans")

    write_preview(frames_for_preview, os.path.join(args.out, "preview.html"), bg)

    if args.emit_pack:
        pack = {
            "id": os.path.basename(os.path.normpath(os.path.join(args.src, ".."))),
            "name": os.path.basename(os.path.normpath(os.path.join(args.src, ".."))),
            "grid": {"cols": args.cols, "rows": frames_for_preview[0][2], "charset": args.charset},
            "moods": {k: {"frames": v, "fps": 3 if len(v) > 1 else 0, "loop": len(v) > 1} for k, v in packs.items()},
        }
        with open(os.path.join(args.out, "pack.json"), "w", encoding="utf-8") as f:
            json.dump(pack, f, ensure_ascii=False, indent=2)
        print("wrote", os.path.join(args.out, "pack.json"))

    print("done: %d frames -> %s" % (len(files), os.path.normpath(args.out)))


if __name__ == "__main__":
    main()
