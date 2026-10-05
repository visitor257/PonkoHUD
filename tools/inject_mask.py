# -*- coding: utf-8 -*-
"""inject_mask.py —— 把 landmask.b64 塞进 mockup 的 __MASK_B64__ 占位符"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
b64 = open(os.path.join(HERE, "_world", "landmask.b64"), encoding="utf-8").read().strip()
p = os.path.join(HERE, "..", "mockup", "index.html")
html = open(p, encoding="utf-8").read()
if "__MASK_B64__" not in html:
    print("占位符不存在（可能已注入过），长度检查：", len(b64))
else:
    html = html.replace("__MASK_B64__", b64)
    open(p, "w", encoding="utf-8").write(html)
    print(f"已注入 {len(b64)} 字符 base64 -> mockup/index.html")
