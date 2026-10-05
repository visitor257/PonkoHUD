"""Capture the Ponko HUD native window to a PNG.

Usage:  python tools/snap_window.py [out.png]
No third-party packages required.
"""
import ctypes
import os
import struct
import sys
import zlib

ctypes.windll.shcore.SetProcessDpiAwareness(2)

TITLE = "Ponko HUD"


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


def png_bytes(w, h, rows_bgrx):
    raw = b"".join(b"\x00" + r for r in rows_bgrx)
    comp = zlib.compress(raw, 9)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", comp) + chunk(b"IEND", b""))


def find_best_hwnd(title=TITLE):
    """Several hidden helper windows share the app title; pick the biggest visible one."""
    u = ctypes.windll.user32
    candidates = []
    keep = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_long)
    def cb(h, _lp):
        buf = ctypes.create_unicode_buffer(256)
        u.GetWindowTextW(h, buf, 256)
        if u.IsWindowVisible(h) and buf.value.strip() == title:
            r = RECT()
            u.GetWindowRect(h, ctypes.byref(r))
            candidates.append(((r.right - r.left) * (r.bottom - r.top), h))
        return True

    keep.append(cb)
    u.EnumWindows(cb, 0)
    if not candidates:
        return None
    candidates.sort(reverse=True)
    return candidates[0][1]


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\Administrator\WorkBuddy\智能Agent\PonkoHUD\tools\snap_native.png"
    u = ctypes.windll.user32
    g = ctypes.windll.gdi32
    hwnd = find_best_hwnd()
    if not hwnd:
        print(f"no visible window titled {TITLE!r}")
        return 1
    # bring it fully into view before capturing
    u.ShowWindow(hwnd, 9)
    import time
    time.sleep(0.8)
    r = RECT()
    u.GetWindowRect(hwnd, ctypes.byref(r))
    w, h = r.right - r.left, r.bottom - r.top
    hdc = u.GetWindowDC(hwnd)
    mem = g.CreateCompatibleDC(hdc)
    bmp = g.CreateCompatibleBitmap(hdc, w, h)
    g.SelectObject(mem, bmp)
    ok = u.PrintWindow(hwnd, mem, 2)  # PW_RENDERFULLCONTENT
    class BIH(ctypes.Structure):
        _fields_ = [("biSize", ctypes.c_uint32), ("biWidth", ctypes.c_int),
                    ("biHeight", ctypes.c_int), ("biPlanes", ctypes.c_uint16),
                    ("biBitCount", ctypes.c_uint16), ("biCompression", ctypes.c_uint32),
                    ("biSizeImage", ctypes.c_uint32), ("biXPelsPerMeter", ctypes.c_int),
                    ("biYPelsPerMeter", ctypes.c_int), ("biClrUsed", ctypes.c_uint32),
                    ("biClrImportant", ctypes.c_uint32)]
    bi = BIH()
    bi.biSize = ctypes.sizeof(BIH)
    bi.biWidth = w
    bi.biHeight = -h          # top-down
    bi.biPlanes = 1
    bi.biBitCount = 32
    bi.biCompression = 0      # BI_RGB
    buf = ctypes.create_string_buffer(w * h * 4)
    got = g.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(bi), 0)
    rows = []
    for y in range(h):
        off = y * w * 4
        row = bytearray(w * 4)
        for x in range(w):
            b, gg, rr, a = buf[off + x * 4: off + x * 4 + 4]
            row[x * 4: x * 4 + 4] = bytes((rr, gg, b, 255))
        rows.append(row)
    g.DeleteObject(bmp)
    g.DeleteDC(mem)
    u.ReleaseDC(hwnd, hdc)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "wb") as f:
        f.write(png_bytes(w, h, rows))
    print(f"PrintWindow={ok} GetDIBits={got} {w}x{h} -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
