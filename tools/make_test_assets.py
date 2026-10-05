# -*- coding: utf-8 -*-
"""生成 DS娘 测试立绘（5 种表情），用于验证 charpack 素材管线。

素材规范（用户自制素材需满足）：
  - PNG，RGBA，透明背景
  - 建议 512x640 以上，纯色扁平上色风格转色块效果最好
  - 一张图 = 一个表情标签；同名加序号 = 该标签的逐帧动画（idle_0.png / idle_1.png）

用法：python make_test_assets.py
"""
import os
from PIL import Image, ImageDraw, ImageFilter

W, H = 480, 640
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "characters", "ds-whale", "src")

HAIR_A, HAIR_B = (42, 92, 200), (126, 170, 255)
HAIR_DARK = (28, 62, 150)
SKIN = (250, 214, 190)
SKIN_SH = (228, 174, 152)
EYE = (18, 48, 92)
APRON = (240, 246, 255)
DRESS = (58, 107, 208)
FIN = (106, 156, 240)
BLUSH = (241, 154, 154)


def vgrad(w, h, c1, c2):
    img = Image.new("RGBA", (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        c = tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3)) + (255,)
        d.line([(0, y), (w, y)], fill=c)
    return img


def grad_shape(size, c1, c2, draw_fn):
    """在透明画布上按 draw_fn 生成一个带竖直渐变的形状"""
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    mask = Image.new("L", size, 0)
    draw_fn(ImageDraw.Draw(mask))
    canvas.paste(vgrad(size[0], size[1], c1, c2), (0, 0), mask)
    return canvas


def base_body(d):
    # 裙子
    d.polygon([(150, 330), (330, 330), (394, 566), (86, 566)], fill=DRESS)
    # 围裙
    d.polygon([(196, 342), (284, 342), (302, 522), (178, 522)], fill=APRON)
    # 领结
    d.polygon([(198, 330), (282, 330), (240, 372)], fill=APRON)
    # 手臂
    d.ellipse([100, 344, 158, 470], fill=DRESS)
    d.ellipse([322, 344, 380, 470], fill=DRESS)
    d.ellipse([97, 430, 155, 482], fill=SKIN)
    d.ellipse([325, 430, 383, 482], fill=SKIN)
    # 腿 / 鞋
    d.rounded_rectangle([198, 556, 230, 612], 12, fill=(232, 240, 250))
    d.rounded_rectangle([250, 556, 282, 612], 12, fill=(232, 240, 250))
    d.ellipse([186, 604, 244, 630], fill=(30, 58, 110))
    d.ellipse([236, 604, 294, 630], fill=(30, 58, 110))


def draw_face(d, mood):
    # 眼睛
    eyeL, eyeR = (200, 226), (280, 226)
    if mood == "sleepy":
        for cx in (eyeL[0], eyeR[0]):
            d.arc([cx - 28, 208, cx + 28, 248], 200, 340, fill=EYE, width=7)
    elif mood == "thinking":
        d.ellipse([eyeL[0] - 26, eyeL[1] - 32, eyeL[0] + 26, eyeL[1] + 32], fill=EYE)
        d.ellipse([eyeL[0] - 12, eyeL[1] - 22, eyeL[0] - 2, eyeL[1] - 10], fill=(255, 255, 255))
        d.arc([eyeR[0] - 28, 212, eyeR[0] + 28, 248], 200, 340, fill=EYE, width=7)
    elif mood == "error":
        for cx in (eyeL[0], eyeR[0]):
            d.polygon([(cx - 24, 250), (cx, 208), (cx + 24, 250)], fill=EYE)
            d.ellipse([cx - 26, 244, cx + 26, 268], fill=EYE)
        # 泪
        d.polygon([(300, 252), (312, 300), (288, 300)], fill=(143, 216, 255))
        d.ellipse([288, 292, 312, 314], fill=(143, 216, 255))
    else:
        r = (34, 40) if mood == "streaming" else (27, 33)
        for cx in (eyeL[0], eyeR[0]):
            d.ellipse([cx - r[0], eyeL[1] - r[1], cx + r[0], eyeL[1] + r[1]], fill=EYE)
            d.ellipse([cx - r[0] + 8, eyeL[1] - r[1] + 6, cx - r[0] + 22, eyeL[1] - r[1] + 22], fill=(255, 255, 255))

    # 眉毛（出错时是倒八字）
    if mood == "error":
        d.line([(172, 182), (222, 198)], fill=HAIR_DARK, width=8)
        d.line([(258, 198), (308, 182)], fill=HAIR_DARK, width=8)

    # 腮红
    if mood in ("idle", "streaming", "thinking"):
        d.ellipse([152, 250, 196, 274], fill=BLUSH)
        d.ellipse([284, 250, 328, 274], fill=BLUSH)

    # 嘴
    if mood == "streaming":
        d.ellipse([222, 274, 258, 302], fill=(138, 74, 82))
    elif mood == "error":
        d.arc([214, 292, 266, 322], 200, 340, fill=(138, 74, 82), width=7)
    elif mood == "sleepy":
        d.ellipse([230, 282, 250, 296], fill=(138, 74, 82))
    else:
        d.arc([216, 268, 264, 300], 20, 160, fill=(138, 74, 82), width=7)


def draw_decoration(img, mood):
    d = ImageDraw.Draw(img)
    if mood == "thinking":
        for x, y, r in ((398, 176, 13), (430, 146, 17), (466, 110, 22)):
            d.ellipse([x - r, y - r, x + r, y + r], fill=(210, 232, 255))
    elif mood == "streaming":
        for x, y, s in ((92, 150, 16), (388, 196, 13), (66, 262, 11)):
            d.polygon([(x, y - s), (x + s * 0.32, y - s * 0.32), (x + s, y),
                       (x + s * 0.32, y + s * 0.32), (x, y + s),
                       (x - s * 0.32, y + s * 0.32), (x - s, y), (x - s * 0.32, y - s * 0.32)],
                      fill=(255, 224, 138))
    elif mood == "sleepy":
        for x, y, s in ((392, 132, 34), (348, 180, 24), (318, 216, 16)):
            w = max(4, s // 5)
            d.line([(x - s, y - s), (x + s, y - s)], fill=(147, 188, 255), width=w)
            d.line([(x + s, y - s), (x - s, y + s)], fill=(147, 188, 255), width=w)
            d.line([(x - s, y + s), (x + s, y + s)], fill=(147, 188, 255), width=w)


def make(mood):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 后发
    d.ellipse([100, 62, 380, 372], fill=HAIR_DARK)
    # 双马尾
    for cx in (86, 394):
        t = grad_shape((W, H), HAIR_A, HAIR_B, lambda dd, cx=cx: dd.ellipse([cx - 48, 150, cx + 48, 452]))
        img.alpha_composite(t)
    # 头鳍
    d.polygon([(298, 118), (392, 54), (436, 108), (372, 140)], fill=FIN)
    # 呆毛
    d.polygon([(238, 66), (248, 16), (268, 52), (252, 66)], fill=HAIR_B)

    base_body(d)
    d = ImageDraw.Draw(img)

    # 头发主体
    head = grad_shape((W, H), HAIR_A, HAIR_B, lambda dd: dd.ellipse([112, 68, 368, 312]))
    img.alpha_composite(head)
    d = ImageDraw.Draw(img)
    # 脸
    d.ellipse([145, 128, 335, 306], fill=SKIN)
    d.ellipse([163, 236, 317, 302], fill=SKIN_SH)
    d.ellipse([149, 132, 331, 288], fill=SKIN)
    # 刘海
    d.chord([112, 68, 368, 300], 180, 360, fill=HAIR_A)
    d.chord([124, 74, 356, 264], 180, 360, fill=HAIR_B)

    draw_face(d, mood)
    draw_decoration(img, mood)

    return img.filter(ImageFilter.SMOOTH)


def main():
    os.makedirs(OUT, exist_ok=True)
    for mood in ("idle", "thinking", "streaming", "sleepy", "error"):
        p = os.path.join(OUT, mood + ".png")
        make(mood).save(p)
        print("wrote", os.path.normpath(p))


if __name__ == "__main__":
    main()
