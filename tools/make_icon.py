"""Generate Ponko HUD.ico (multi-size, PNG-in-ICO) with zero third-party deps.

Style: sci-fi HUD -- dark slate shell, cyan frame, scanline grid, tiny wireframe
globe top-right, block caret bottom-left.
"""
import os
import struct
import zlib

SIZES = (256, 128, 64, 48, 32, 24, 20, 16)

BG = (7, 12, 16)
FRAME = (61, 226, 208)
GRID = (26, 92, 88)
HOT = (125, 249, 255)
AMBER = (255, 176, 74)


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def rounded_alpha(u, v, s):
    """1 = fully inside rounded rect, 0 = outside."""
    r = 0.18 * s
    x = min(u, 1.0 - u) * s
    y = min(v, 1.0 - v) * s
    if x >= r or y >= r:
        return 1.0
    d = ((r - x) ** 2 + (r - y) ** 2) ** 0.5
    return max(0.0, min(1.0, (r - d) + 0.5))


def pixel(u, v, s):
    """Return (r,g,b,a) for normalized coords in [0,1]."""
    a = rounded_alpha(u, v, s)
    if a <= 0.0:
        return (0, 0, 0, 0)

    col = BG
    # ---- outer frame (2px-ish scaled) ----
    m = max(abs(u - 0.5), abs(v - 0.5))
    bw = max(1.0, s * 0.045)
    if 0.5 - m < bw:
        col = lerp(BG, FRAME, 0.85)
    # inner hairline
    elif 0.5 - m > bw and 0.5 - m < bw + max(1.0, s * 0.03):
        col = lerp(BG, FRAME, 0.25)

    # ---- scanline grid ----
    k = round(v * 14.0)
    gy = abs(v * 14.0 - k)
    if 0.11 < u < 0.89 and gy < 0.06 and k % 2 == 0:
        col = lerp(col, GRID, 0.55)

    # ---- top-left corner bracket ----
    if (u < 0.30 and abs(v - 0.08) < 0.035) or (v < 0.30 and abs(u - 0.08) < 0.035):
        col = FRAME

    # ---- wireframe globe (top-right) ----
    cx, cy, r = 0.70, 0.28, 0.155
    dx, dy = u - cx, v - cy
    d = (dx * dx + dy * dy) ** 0.5
    if d <= r:
        # latitude / longitude rings
        ring = False
        for Lat in (-0.55, 0.0, 0.55):
            yy = Lat * r
            half = (r * r - yy * yy) ** 0.5
            if abs(dy - yy) < max(0.7 / s, 0.012) and abs(dx) <= half:
                ring = True
        for off in (-0.62, -0.28, 0.0, 0.28, 0.62):
            xx = off * r
            if abs(dx - xx) < max(0.7 / s, 0.012):
                ring = True
        if abs(d - r) < max(0.9 / s, 0.016):
            col = HOT if col != BG else HOT
        elif ring:
            col = lerp(col, FRAME, 0.8)
        else:
            col = lerp(col, BG, 0.75)

    # ---- block caret / prompt (bottom-left) ----
    if 0.14 < v < 0.86:
        if 0.12 < u < 0.155:                       # vertical bar
            col = FRAME
        elif 0.19 < u < 0.30 and abs(v - 0.72) < 0.045:   # underscore
            col = FRAME
    # small amber status dot
    if (u - 0.80) ** 2 + (v - 0.80) ** 2 < (0.06 ** 2):
        col = AMBER

    return (col[0], col[1], col[2], int(round(255 * a)))


def render(s):
    rows = []
    for y in range(s):
        row = bytearray()
        for x in range(s):
            r, g, b, a = pixel((x + 0.5) / s, (y + 0.5) / s, s)
            row += bytes((r, g, b, a))
        rows.append(row)
    return rows


def png_bytes(w, h, rows):
    raw = b"".join(b"\x00" + bytes(r) for r in rows)
    comp = zlib.compress(raw, 9)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", comp)
            + chunk(b"IEND", b""))


def write_ico(path, images):
    n = len(images)
    head = struct.pack("<HHH", 0, 1, n)
    offset = 6 + 16 * n
    entries, blobs = b"", b""
    for size, data in images:
        w = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", w, w, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    with open(path, "wb") as f:
        f.write(head + entries + blobs)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, "assets", "Ponko-HUD.ico")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    images = []
    for s in SIZES:
        blob = png_bytes(s, s, render(s))
        images.append((s, blob))
        # keep PNG copies for html shortcut usage
        with open(os.path.join(os.path.dirname(out), f"Ponko-HUD_{s}.png"), "wb") as f:
            f.write(blob)
    write_ico(out, images)
    print("wrote", out, os.path.getsize(out), "bytes",
          "sizes:", ",".join(str(s) for s in SIZES))


if __name__ == "__main__":
    main()
