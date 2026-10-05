#!/usr/bin/env python3
"""Ponko HUD desktop host -- a real application window instead of a browser window.

Why this exists
---------------
The old launcher shelled out to ``msedge --app=...``. That works, but the window
still *is* Edge: it shares the user's default profile, shows up as Edge in the
taskbar / Alt+Tab / Task Manager, keeps browser context menus and shortcuts, and
requires Edge itself to be installed and healthy.

This host renders the very same UI inside a Win32 form hosting WebView2 (the
Chromium runtime Windows ships on its own), and adds the things a real app needs:

  * own icon + AppUserModelID -> own taskbar entry, own Alt+Tab entry
  * no address bar, no tabs, no extensions, no browser context menu
  * single instance (a second launch just raises the running window)
  * starts the Node backend itself and always tears it down on exit
  * dark immersive title bar tinted to the HUD palette

Usage
-----
    pythonw native_host.py            # normal
    python  native_host.py --frameless --devtools
    pythonw native_host.py --always-on-top
"""

import argparse
import atexit
import ctypes
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from ctypes import wintypes

APP_ID = "PonkoHUD.Desktop"
APP_TITLE = "Ponko HUD"
ROOT = os.path.dirname(os.path.abspath(__file__))
ICON = os.path.join(ROOT, "tools", "assets", "PonkoHUD.ico")
RUN_DIR = os.path.join(ROOT, "run")

# HUD palette as COLORREF (0x00bbggrr)
CAPTION_COLOR = 0x100C07   # #070C10
TEXT_COLOR = 0xFFF97D      # #7DF9FF
BORDER_COLOR = 0x1C1A0E    # #0E1A1C

DWMWA_USE_IMMERSIVE_DARK_MODE = 20
DWMWA_BORDER_COLOR = 34
DWMWA_CAPTION_COLOR = 35
DWMWA_TEXT_COLOR = 36

CREATE_NO_WINDOW = 0x08000000
ERROR_ALREADY_EXISTS = 183

_backend_proc = None
_backend_owned = False


def _log(*args_, **kwargs):
    """Write to run/host.log (pythonw launches have no console to print to)."""
    msg = kwargs.get("sep", " ").join(str(a) for a in args_)
    try:
        os.makedirs(RUN_DIR, exist_ok=True)
        with open(os.path.join(RUN_DIR, "host.log"), "a", encoding="utf-8",
                  errors="replace") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# backend (node server.js)
# --------------------------------------------------------------------------- #
def port_listening(port: int) -> bool:
    s = socket.socket()
    s.settimeout(0.35)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def find_node() -> str | None:
    exe = shutil.which("node") or shutil.which("node.exe")
    if exe:
        return exe
    for cand in (
        r"C:\Program Files\nodejs\node.exe",
        os.path.join(os.environ.get("ProgramW6432", ""), "nodejs", "node.exe"),
    ):
        if cand and os.path.isfile(cand):
            return cand
    return None


def ensure_backend(port: int) -> None:
    """Start server.js unless something already listens on the port."""
    global _backend_proc, _backend_owned
    if port_listening(port):
        _log(f"[host] backend already listening on {port}, reusing it")
        return

    node = find_node()
    if not node:
        _log("[host] FATAL: node.exe not found in PATH", file=sys.stderr)
        sys.exit(1)

    server = os.path.join(ROOT, "server", "server.js")
    _backend_proc = subprocess.Popen(
        [node, server],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=CREATE_NO_WINDOW,
    )
    _backend_owned = True
    write_pid("backend.pid", _backend_proc.pid)
    _log(f"[host] backend started (pid {_backend_proc.pid})")

    deadline = time.time() + 20
    url = f"http://127.0.0.1:{port}/index.html"
    while time.time() < deadline:
        if _backend_proc.poll() is not None:
            _log("[host] FATAL: backend exited immediately", file=sys.stderr)
            sys.exit(1)
        if port_listening(port):
            try:
                with urllib.request.urlopen(url, timeout=2) as r:
                    if r.status == 200:
                        _log("[host] backend ready")
                        return
            except Exception:  # noqa: BLE001 - keep polling
                pass
        time.sleep(0.25)
    _log("[host] WARNING: backend did not answer in 20s, opening anyway")


def stop_backend() -> None:
    global _backend_proc, _backend_owned
    if _backend_proc and _backend_owned:
        try:
            subprocess.run(
                ["taskkill", "/pid", str(_backend_proc.pid), "/t", "/f"],
                capture_output=True,
                timeout=10,
            )
            _log("[host] backend stopped")
        except Exception as e:  # noqa: BLE001
            _log(f"[host] backend kill failed: {e!r}")
        _backend_proc = None
        _backend_owned = False
    remove_pid("backend.pid")


# --------------------------------------------------------------------------- #
# pid files (so stop.bat can be precise)
# --------------------------------------------------------------------------- #
def write_pid(name: str, pid: int) -> None:
    try:
        os.makedirs(RUN_DIR, exist_ok=True)
        with open(os.path.join(RUN_DIR, name), "w", encoding="utf-8") as f:
            f.write(str(pid))
    except OSError:
        pass


def remove_pid(name: str) -> None:
    try:
        os.remove(os.path.join(RUN_DIR, name))
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# win32 helpers
# --------------------------------------------------------------------------- #
_u = ctypes.windll.user32
_k = ctypes.windll.kernel32
_dwmapi = ctypes.windll.dwmapi

_u.LoadImageW.restype = ctypes.c_void_p
_u.EnumWindows.restype = ctypes.c_bool
_u.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
_u.FindWindowW.restype = wintypes.HWND
_k.CreateMutexW.restype = ctypes.c_void_p


def list_windows(title_prefix: str, pid: int | None = None) -> list[int]:
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_long)
    def cb(hwnd, _lparam):
        if _u.IsWindowVisible(hwnd):
            buf = ctypes.create_unicode_buffer(256)
            _u.GetWindowTextW(hwnd, buf, 256)
            if buf.value.startswith(title_prefix):
                proc = ctypes.c_ulong()
                _u.GetWindowThreadProcessId(hwnd, ctypes.byref(proc))
                if pid is None or proc.value == pid:
                    found.append(hwnd)
        return True

    _u.EnumWindows(cb, 0)
    cb_keepalive.append(cb)
    return found


cb_keepalive = []


def acquire_single_instance() -> bool:
    """True if this process owns the app; False if another instance is running."""
    handle = _k.CreateMutexW(None, True, f"Local\\{APP_ID}.Mutex")
    if not handle:
        return True
    owned = _k.GetLastError() != ERROR_ALREADY_EXISTS
    # keep the handle alive for the lifetime of the process
    globals()["_mutex_handle"] = handle
    if not owned:
        return False
    return True


def focus_existing() -> bool:
    hwnds = list_windows(APP_TITLE)
    if not hwnds:
        # try again briefly: window may still be coming up
        time.sleep(1.2)
        hwnds = list_windows(APP_TITLE)
    if not hwnds:
        return False
    hwnd = hwnds[0]
    if _u.IsIconic(hwnd):
        _u.ShowWindow(hwnd, 9)      # SW_RESTORE
    _u.SetForegroundWindow(hwnd)
    _u.FlashWindow(hwnd, True)
    return True


def apply_window_style(hwnd: int) -> None:
    """Icon + dark immersive title bar tinted to the HUD palette."""
    if os.path.isfile(ICON):
        h_big = _u.LoadImageW(0, ICON, 1, 0, 0, 0x0010)    # IMAGE_ICON, LR_LOADFROMFILE
        h_small = _u.LoadImageW(0, ICON, 1, 16, 16, 0x0010)
        if h_big:
            _u.SendMessageW(hwnd, 0x0080, 1, h_big)        # WM_SETICON / ICON_BIG
        if h_small:
            _u.SendMessageW(hwnd, 0x0080, 0, h_small)      # WM_SETICON / ICON_SMALL

    def set_attr(attr, value):
        try:
            _dwmapi.DwmSetWindowAttribute(
                hwnd, attr, ctypes.byref(ctypes.c_int(value)), 4
            )
        except Exception:  # noqa: BLE001 - old Windows builds lack these attrs
            pass

    set_attr(DWMWA_USE_IMMERSIVE_DARK_MODE, 1)
    set_attr(DWMWA_CAPTION_COLOR, ctypes.c_int(CAPTION_COLOR).value)
    set_attr(DWMWA_TEXT_COLOR, ctypes.c_int(TEXT_COLOR).value)
    set_attr(DWMWA_BORDER_COLOR, ctypes.c_int(BORDER_COLOR).value)


def window_decorator() -> None:
    for _ in range(80):
        hwnds = list_windows(APP_TITLE, pid=os.getpid())
        if hwnds:
            try:
                apply_window_style(hwnds[0])
                _log(f"[host] window styled (hwnd {hwnds[0]})")
            except Exception as e:  # noqa: BLE001
                _log(f"[host] styling failed: {e!r}")
            return
        time.sleep(0.15)


def screen_size() -> tuple[int, int]:
    return _u.GetSystemMetrics(0), _u.GetSystemMetrics(1)


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def main() -> None:
    ap = argparse.ArgumentParser(description="Ponko HUD native window host")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--windowed", action="store_true",
                    help="windowed mode instead of fullscreen (default is fullscreen borderless)")
    ap.add_argument("--frameless", action="store_true",
                    help="(windowed mode) drop the native title bar")
    ap.add_argument("--always-on-top", action="store_true")
    ap.add_argument("--devtools", action="store_true", help="enable WebView2 dev tools")
    ap.add_argument("--no-backend", action="store_true", help="assume server already runs")
    ap.add_argument("--query", default="", help="extra url query, e.g. \"?demo=1\" or \"?mood=error\"")
    args = ap.parse_args()

    atexit.register(stop_backend)

    if not acquire_single_instance():
        if focus_existing():
            _log("[host] already running, raised existing window")
            sys.exit(0)

    if not args.no_backend:
        ensure_backend(args.port)

    # own taskbar identity (must happen before any window is created)
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_ID)
    except Exception:  # noqa: BLE001
        pass

    import webview  # imported late: single-instance exit should stay cheap

    if os.path.isfile(ICON):
        try:
            webview._state["icon"] = ICON
        except Exception:  # noqa: BLE001
            pass

    sw, sh = screen_size()

    url = f"http://127.0.0.1:{args.port}/index.html{args.query}"

    if args.windowed:
        # old windowed behaviour: a resizable box centred on the screen
        width = max(1000, min(1680, sw - 120))
        height = max(640, min(940, sh - 120))
        _log(f"[host] opening {url} windowed at {width}x{height}")
        window = webview.create_window(
            APP_TITLE,
            url=url,
            width=width,
            height=height,
            min_size=(900, 560),
            resizable=True,
            frameless=args.frameless,
            easy_drag=args.frameless,
            on_top=args.always_on_top,
            background_color="#070C10",
            text_select=True,
        )
    else:
        # default: fullscreen, borderless, covering the whole primary display
        # (pywebview's fullscreen is itself borderless; do not also set
        #  frameless, which interferes with the maximise that hides the taskbar)
        _log(f"[host] opening {url} fullscreen borderless ({sw}x{sh})")
        window = webview.create_window(
            APP_TITLE,
            url=url,
            width=sw,
            height=sh,
            fullscreen=True,
            on_top=False,
            background_color="#070C10",
            text_select=True,
        )

    threading.Thread(target=window_decorator, daemon=True).start()

    write_pid("host.pid", os.getpid())
    try:
        webview.start(
            debug=args.devtools,
            private_mode=False,
            storage_path=os.path.join(ROOT, "run", "webview-profile"),
        )
    finally:
        remove_pid("host.pid")
        stop_backend()


if __name__ == "__main__":
    main()
