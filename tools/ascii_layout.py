# -*- coding: utf-8 -*-
"""把界面布局渲染成等宽字符画（对齐到 104 列）。

中文字符占 2 列，所以必须用显示宽度计算，不能直接数 len()。
左栏下部的 GLOBE 面板直接复用 globe.py 的球面渲染器（真海陆数据）。
输出：stdout + layout.txt

用法：python ascii_layout.py
"""
import os
import sys

import globe

W, H = 104, 34
CANVAS = [[" "] * W for _ in range(H)]

# 面板位置（左右两列的上下两块对齐：上 3..15，下 16..30）
LX, LW = 0, 34          # 左列：SYS / GLOBE
CX, CW = 35, 42         # 中列：SHELL / AGENT
RX, RW = 78, 26         # 右列：MOOD
TOP_Y, TOP_H = 3, 13
BOT_Y, BOT_H = 16, 15


def cw(ch):
    if not ch:
        return 0
    c = ord(ch)
    if c < 0x1100:
        return 1
    if (0x2E80 <= c <= 0xA4CF) or (0xAC00 <= c <= 0xD7A3) or (0xF900 <= c <= 0xFAFF) \
       or (0xFE30 <= c <= 0xFE6F) or (0xFF00 <= c <= 0xFF60) or (0xFFE0 <= c <= 0xFFE6):
        return 2
    return 1


def width(s):
    return sum(cw(c) for c in s)


def put(x, y, s):
    cx = x
    for ch in s:
        w = cw(ch)
        if 0 <= cx < W and 0 <= y < H:
            CANVAS[y][cx] = ch
            if w == 2:                       # 宽字符吃掉两列，后一列置空占位
                for k in range(1, w):
                    if cx + k < W:
                        CANVAS[y][cx + k] = ""
        cx += w


def box(x, y, w, h, title="", right=""):
    put(x, y, "┌" + "─" * (w - 2) + "┐")
    for i in range(1, h - 1):
        put(x, y + i, "│")
        put(x + w - 1, y + i, "│")
    put(x, y + h - 1, "└" + "─" * (w - 2) + "┘")
    if title:
        put(x + 1, y, title)
    if right:
        put(x + w - 2 - width(right), y, right)


def line(x, y, inner, s):
    put(x + 1, y, s + " " * max(0, inner - width(s)))


def ctr(x, y, inner, s):
    put(x + 1 + max(0, (inner - width(s)) // 2), y, s)


def kv(x, y, inner, left, right):
    """左标签 + 右数值，中间补空"""
    pad = max(1, inner - width(left) - width(right))
    line(x, y, inner, left + " " * pad + right)


def art_lines():
    """从 mockup 里的像素逻辑抽帧，2x2 降采样成 11x15 字符画"""
    grid = pixel_grid("idle")

    PRI = {
        "#12305c": ("●", 0), "#ffffff": ("●", 0), "#8a4a52": ("▄", 1), "#8fd8ff": ("~", 1),
        "#f19a9a": ("·", 1), "#f6cfb5": ("░", 2), "#e3b096": ("░", 2),
        "#eef4ff": ("█", 3), "#e8eff8": ("▒", 3), "#3a6bd0": ("▒", 4), "#1e3a6e": ("█", 4),
        "#6a9cf0": ("▒", 5), "#7aa6ff": ("▓", 6), "#3f6fd8": ("▓", 6), "#2a4e9e": ("▓", 6),
        "#ffe08a": ("*", 7), "#93bcff": ("*", 7), "#0b1a26": (" ", 9),
    }
    out = []
    for by in range(0, 30, 2):          # 每个字符行吃 2 个像素行（终端字符 1:2）
        row = ""
        for bx in range(22):            # 水平不降采样，保持真实宽高比
            a, b = grid[by][bx], grid[by + 1][bx]
            if a == b:
                ch = PRI.get(a, ("?", 8))[0]
            else:
                ca, pa = PRI.get(a, ("?", 8))
                cb, pb = PRI.get(b, ("?", 8))
                ch = ca if pa <= pb else cb
            row += ch
        out.append(row)
    return out


def pixel_grid(state):
    """mockup 里的像素逻辑是 JS，用 node 跑一遍拿 JSON"""
    import json
    import subprocess
    here = os.path.dirname(os.path.abspath(__file__))
    html = open(os.path.join(here, "..", "mockup", "index.html"), encoding="utf-8").read()
    js = html.split("/*PIXEL-BEGIN*/")[1].split("/*PIXEL-END*/")[0]
    tmp = os.path.join(here, "_pixel_tmp.js")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(js + "\nconsole.log(JSON.stringify(build('%s')));\n" % state)
    out = subprocess.check_output(["node", tmp], encoding="utf-8")
    return json.loads(out)


def main():
    # 顶栏
    put(0, 0, "▚ PONKO HUD   [AGENT] SHELL FILES MOOD")
    meta = "● local · qwen3-8b   ds-whale @ win32   20:46:57"
    put(W - width(meta), 0, meta)
    put(0, 1, "─" * W)

    # ── 左列上：SYS（压成一小格：4 根条 + 网络）
    box(LX, TOP_Y, LW, 7, "SYS", "live")
    iw = LW - 2
    for i, (name, val, ratio) in enumerate(
            [("CPU", "47%", .47), ("MEM", "39%", .39), ("GPU", "61%", .61), ("DISK", "78%", .78)]):
        head = "%s %s" % (name, val)
        nbar = iw - width(head) - 2
        f = int(nbar * ratio)
        line(LX, TOP_Y + 1 + i, iw, head + " " + "█" * f + "░" * (nbar - f))
    kv(LX, TOP_Y + 5, iw, "NET ↑ 1.2 MB/s", "↓ 8.4 MB/s")

    # ── 左列下：GLOBE（球面反投影 + 半块字符，真海陆数据）
    gy = TOP_Y + 7
    gh = (BOT_Y + BOT_H - 1) - gy + 1         # 底边与中/右列对齐
    box(LX, gy, LW, gh, "GLOBE", "自转 45s/圈")
    gcols, grows = iw - 2, gh - 5
    gtop, gbot, gplain = globe.render(gcols, grows, 116.0, 18.0)
    for i, ln in enumerate(globe.to_plain(gplain).split("\n")):
        put(LX + 2, gy + 2 + i, ln)
    kv(LX, gy + gh - 2, iw, "NETLINK", "5 arcs · 8 nodes")

    # ── 中列上：SHELL
    box(CX, TOP_Y, CW, TOP_H, "SHELL", "pwsh · C:\\NetGateBuild")
    ciw = CW - 2
    for i, s in enumerate([
        "PS> cd C:\\NetGateBuild",
        "PS> .\\gradlew assembleDebug",
        "",
        "> Task :app:assembleDebug FAILED",
        "BUILD FAILED in 1m 12s · 14 tasks",
        "",
        "╌" * ciw,
        "PS C:\\NetGateBuild> ▏",
    ]):
        line(CX, TOP_Y + 1 + i, ciw, s)

    # ── 中列下：AGENT（贴地）
    box(CX, BOT_Y, CW, BOT_H, "AGENT", "ctx 12%")
    for i, s in enumerate([
        "● agent online · 工具5个 · 记忆库已挂载",
        "› 帮我看下今天的 Gradle 构建为什么失败",
        "◐ thinking... 33s · 已读 build.log",
        "⚙ tool_call → read_file(\"build.log\")",
        "✓ 412 行 · :app:assembleDebug FAILED",
        "问题出在路径非 ASCII 上。AGP path check",
        "在解析中文路径时直接抛错，和依赖无关。",
        "方案1 复制到 C:\\NetGateBuild 再构建",
        "方案2 加 overridePathCheck=true",
        "",
        "╌" * ciw,
        "状态：待机   tokens 1,204   ¥0.00",
    ]):
        line(CX, BOT_Y + 1 + i, ciw, s)

    # ── 右列：MOOD（角色 + 心情）
    box(RX, TOP_Y, RW, 28, "DS·MOOD", "方块字符")
    miw = RW - 2
    for i, row in enumerate(art_lines()):
        put(RX + 1 + (miw - 22) // 2, TOP_Y + 1 + i, row)
    y = TOP_Y + 16
    ctr(RX, y, miw, "平静 · 待机")
    ctr(RX, y + 1, miw, "mood 62 / 100")
    ctr(RX, y + 3, miw, "情绪历史")
    ctr(RX, y + 4, miw, "▁▂▂▃▂▂▃▃▂▃")
    ctr(RX, y + 6, miw, "待机 思考 输出 瞌睡 出错")
    ctr(RX, y + 8, miw, "已 8 分钟空闲")
    ctr(RX, y + 9, miw, "素材库 ds-whale")

    # 底栏
    put(0, H - 2, "─" * W)
    put(0, H - 1, "▚ SHELL=命令输入 · AGENT=对话输入 · GLOBE 可拖拽旋转")
    foot = "[TAB]切换 [^P]命令 [ESC]中断 [^M]心情 拖│调列宽"
    put(W - width(foot), H - 1, foot)

    text = "\n".join("".join(r).rstrip() for r in CANVAS)
    for i, l in enumerate(text.split("\n")):
        if width(l) > W:
            print("WARN line %d 超宽 %d" % (i, width(l)), file=sys.stderr)
    open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "layout.txt"),
         "w", encoding="utf-8").write(text)
    print("layout.txt 已更新（%dx%d）" % (W, H))


if __name__ == "__main__":
    main()
