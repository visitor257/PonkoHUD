#!/usr/bin/env python3
"""PTY bridge —— 给 Node 后端开一个真正的终端（Windows ConPTY）。

为什么需要它：Node 标准库没有 PTY，而"交互式程序会卡死"的根因就是——
持久 PowerShell 的 stdin 是管道不是终端，python / ssh / mysql 这类程序
要么缓冲输出、要么死等终端输入。ConPTY 能给出真正的终端，程序才会正常干活。

协议（stdio 上的 JSON lines，字节一律 base64，避免任何编码歧义）：

    Node → bridge
      {"op":"start","shell":"pwsh"|"cmd","cwd":"...","cols":80,"rows":24}
      {"op":"write","d":"<base64 utf-8>"}
      {"op":"resize","cols":80,"rows":24}
      {"op":"stop"}
      {"op":"quit"}

    bridge → Node
      {"t":"ready","pid":123,"shell":"pwsh"}
      {"t":"out","d":"<base64 utf-8>"}     可能很频繁
      {"t":"exit","code":0,"reason":"..."}
      {"t":"error","msg":"..."}

用法：python ptybridge.py   （由 server/pty.js 以子进程方式拉起）
"""
import base64
import io
import json
import os
import shutil
import sys
import threading
import time

LOG = None  # 需要排障时指向一个文件路径


def log(msg):
    if not LOG:
        return
    try:
        with open(LOG, "a", encoding="utf-8", errors="replace") as f:
            f.write(time.strftime("%H:%M:%S ") + str(msg) + "\n")
    except OSError:
        pass


def b64e(s):
    return base64.b64encode(s.encode("utf-8", "replace")).decode("ascii")


def b64d(s):
    return base64.b64decode(s or "").decode("utf-8", "replace")


_lock = threading.Lock()


def emit(obj):
    with _lock:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def which(exe):
    found = shutil.which(exe)
    if found:
        return found
    for p in (r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
              r"C:\Windows\System32\cmd.exe",
              r"C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe"):
        if os.path.basename(p).lower().startswith(exe.lower().split(".")[0]) and os.path.isfile(p):
            return p
    return None


class Session:
    def __init__(self):
        self.proc = None
        self.shell = ""
        self.stopped = False

    # ── 启动 ──────────────────────────────────────────────
    def start(self, shell, cwd, cols, rows, env_extra):
        try:
            from winpty import PtyProcess
        except ImportError:
            emit({"t": "error", "msg": "pywinpty 未安装（pip install pywinpty）；PTY 不可用"})
            emit({"t": "exit", "code": 1, "reason": "no-pywinpty"})
            return False

        if shell == "cmd":
            exe = which("cmd") or "cmd.exe"
            argv = [exe]
        else:
            exe = which("powershell") or r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
            argv = [exe, "-NoLogo", "-NoExit"]
            self.shell = "pwsh"

        env = os.environ.copy()
        # 让子进程在终端里也用 UTF-8 说话（否则中文文件名是 GBK，pywinpty 的
        # read() 会在 UTF-8 解码上卡住或吐乱码）
        env.setdefault("PYTHONUTF8", "1")
        env.setdefault("PYTHONIOENCODING", "utf-8")
        env["TERM"] = "xterm-256color"
        # 这两条是 TUI/curses 应用的识别关键（eDEX-UI 也是这么配的）：
        # 没 COLORTERM 的话 htop / ranger / neofetch 之类只用 16 色，版式也会错
        env.setdefault("COLORTERM", "truecolor")
        env.setdefault("TERM_PROGRAM", "Ponko HUD")
        for k, v in (env_extra or {}).items():
            env[k] = v

        try:
            self.proc = PtyProcess.spawn(argv, cwd=cwd or None, env=env,
                                         dimensions=(max(4, rows), max(10, cols)))
        except Exception as e:  # noqa: BLE001
            emit({"t": "error", "msg": "PTY 启动失败：%r" % (e,)})
            emit({"t": "exit", "code": 1, "reason": "spawn-failed"})
            return False

        emit({"t": "ready", "pid": self.proc.pid, "shell": self.shell or shell})
        threading.Thread(target=self._reader, daemon=True).start()
        # 注意：不要在这里自动发初始化命令 —— 时序会跟用户命令抢输入缓冲
        # （实测 Clear-Host 被塞进了刚启动的 python REPL 里）。初始化由 Node 侧
        # 在 ready 事件后统一发送，顺序才可控。
        return True

    # ── 读 ────────────────────────────────────────────────
    def _reader(self):
        proc = self.proc
        try:
            while not self.stopped:
                data = proc.read(8192)
                if not data:
                    break
                emit({"t": "out", "d": b64e(data)})
        except EOFError:
            pass
        except Exception as e:  # noqa: BLE001
            emit({"t": "error", "msg": "读取失败：%r" % (e,)})
        finally:
            if not self.stopped:
                emit({"t": "exit", "code": 0, "reason": "eof"})

    # ── 写 ────────────────────────────────────────────────
    def write_text(self, s):
        if not self.proc:
            return False
        try:
            self.proc.write(s)
            return True
        except Exception as e:  # noqa: BLE001
            log("write failed: %r" % (e,))
            return False

    def resize(self, cols, rows):
        if not self.proc:
            return
        try:
            self.proc.setwinsize(max(4, rows), max(10, cols))
        except Exception as e:  # noqa: BLE001
            log("resize failed: %r" % (e,))

    def stop(self, force=True):
        self.stopped = True
        if not self.proc:
            return
        try:
            self.write_text("exit\r\n" if self.shell == "pwsh" else "exit\r\n")
        except Exception:  # noqa: BLE001
            pass
        deadline = time.time() + 2.0
        try:
            while time.time() < deadline and self.proc.isalive():
                time.sleep(0.1)
        except Exception:  # noqa: BLE001
            pass
        try:
            if self.proc.isalive():
                self.proc.terminate(force=True)
        except Exception:  # noqa: BLE001
            pass
        try:
            self.proc.close(force=force)
        except Exception:  # noqa: BLE001
            pass
        self.proc = None


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        return selftest()
    sess = Session()
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except ValueError:
            continue
        op = req.get("op")
        if op == "start":
            sess.start(req.get("shell") or "pwsh", req.get("cwd"),
                       int(req.get("cols") or 80), int(req.get("rows") or 24),
                       req.get("env"))
        elif op == "write":
            sess.write_text(b64d(req.get("d")))
        elif op == "resize":
            sess.resize(int(req.get("cols") or 80), int(req.get("rows") or 24))
        elif op == "stop":
            sess.stop()
            emit({"t": "exit", "code": 0, "reason": "stopped"})
        elif op == "quit":
            sess.stop()
            break
    sess.stop()


def selftest():
    """不开 Node 也能验证：起一个 PTY，跑 python REPL，看它是否真在交互。"""
    sess = Session()
    got = []
    buf = io.StringIO()
    real_emit = globals()["emit"]

    def capture(obj):
        got.append(obj)
        if obj.get("t") == "out":
            buf.write(b64d(obj["d"]))
        print(json.dumps({k: (v[:60] if k == "d" else v) for k, v in obj.items()},
                         ensure_ascii=False)[:160])

    globals()["emit"] = capture
    ok = sess.start("pwsh", None, 100, 30, {})
    if not ok:
        return 1
    time.sleep(2.0)
    sess.write_text("python -i -u\r\n")
    time.sleep(2.5)
    sess.write_text('print("中文", 2+2)\r\n')
    time.sleep(2.5)
    sess.write_text("exit()\r\n")
    time.sleep(1.5)
    sess.write_text("exit\r\n")
    time.sleep(1.5)
    sess.stop()
    globals()["emit"] = real_emit
    text = buf.getvalue()
    lines = [
        "=== 关键检查 ===",
        "有 python 提示符 >>> : %s" % (">>>" in text),
        "出现计算结果 4      : %s" % (text.count("4") > 0),
        "中文正常            : %s" % ("中文" in text),
        "字节数: %d" % len(text),
        "--- 末尾 800 字 ---",
        text[-800:],
    ]
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools", "_ptytest.txt")
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print("written " + os.path.abspath(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
