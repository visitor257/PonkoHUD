#!/usr/bin/env python3
"""回归：宿主暴露给页面的 JS API 只能是"公共方法"。

背景（2026-10-08 实测踩坑）
---------------------------
pywebview 造 ``window.pywebview.api`` 时，会遍历 js_api 对象：公共属性里凡不是 callable
的，都会被**递归**扫下去。当时把窗口存成 ``UIApi.window``，于是它顺着
Window -> .native（WinForms 窗体）走进整个 .NET 对象图：几百个跨线程 COM getter、
``maximum recursion depth exceeded``，最后注入脚本根本没执行 —— 页面上压根没有
``window.pywebview.api``，右上角「退出」按钮点什么都没反应（宿主日志里连一行 quit 都没有），
用户看到的就是"点了退出程序卡死"。

这个测试不需要开窗口：把 pywebview 那段扫描逻辑照搬过来跑，断言它只看到 quit()。
（扫描逻辑抄自 pywebview ``util.py`` 的 ``generate_js_object.get_functions``，
  版本 6.x — 那边是嵌套函数，没法 import，所以这里复刻一份。）

用法：
    python tools/test_host_jsapi.py
"""
import importlib.util
import inspect
import os
import sys
import traceback

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

_argvsave = list(sys.argv)
sys.argv = ["native_host.py", "--no-backend"]     # native_host 只在 main() 里解析参数
try:
    import native_host as nh
finally:
    sys.argv = _argvsave

n_ok = 0
n_bad = 0


def chk(name, cond, detail=""):
    global n_ok, n_bad
    if cond:
        n_ok += 1
        print(f"  ok   {name}")
    else:
        n_bad += 1
        print(f"  FAIL {name}   {detail}")


def get_functions(obj, base_name="", functions=None, exposed=None):
    """pywebview util.py 里 get_functions 的复刻（跳过下划线开头、递归非 callable 属性）。"""
    if exposed is None:
        exposed = []
    if id(obj) in exposed:
        return functions
    exposed.append(id(obj))
    if functions is None:
        functions = {}

    for name in dir(obj):
        try:
            full_name = f"{base_name}.{name}" if base_name else name
            if name.startswith("_"):
                continue
            attr = getattr(obj, name)
            if not getattr(attr, "_serializable", True):
                continue
            if inspect.ismethod(attr) or inspect.isfunction(attr):
                functions[full_name] = True
            elif inspect.isclass(attr) or (
                isinstance(attr, object) and not callable(attr) and hasattr(attr, "__module__")
            ):
                get_functions(attr, full_name, functions, exposed)
        except Exception:  # noqa: BLE001
            continue
    return functions


def main():
    print("[1] UIApi 的公共成员必须全是 callable")
    api = nh.UIApi()
    bad = [n for n in dir(api) if not n.startswith("_") and not callable(getattr(api, n))]
    chk("没有非 callable 的公共属性", not bad, f"会被 pywebview 递归扫: {bad}")

    print("[2] 按 pywebview 的扫描逻辑，页面能拿到的 API 只有 quit")
    fns = get_functions(api)
    chk("扫描结果 == {'quit'}", set(fns) == {"quit"}, f"实际: {sorted(fns)}")

    print("[3] 绑上真实窗口对象后，依然只有 quit（关键：窗口必须叫 _window）")
    class RealWindow:                     # 冒充 pywebview.Window，带 native 之类的深属性
        js_api = None
        native = None
        events = None

        def destroy(self):
            pass

    api._window = RealWindow()
    fns2 = get_functions(api)
    chk("仍然只有 quit", set(fns2) == {"quit"}, f"实际: {sorted(fns2)}")

    print("[4] 自检：这个扫描器确实能发现老写法（public window 属性）")
    class OldStyle:
        def __init__(self):
            self.window = RealWindow()

        def quit(self):
            return True

    old_fns = get_functions(OldStyle())
    leaked = [k for k in old_fns if k.startswith("window")]
    chk("老写法会被递归扫进 window.*", bool(leaked), f"实际: {sorted(old_fns)}")

    print("[5] 本机 pywebview 存在时，顺带确认版本能整包 import")
    spec = importlib.util.find_spec("webview")
    if spec is None:
        print("  skip 本机没有 pywebview（跑不了窗口，无妨）")
    else:
        import webview
        ver = getattr(webview, "__version__", None) or _version_of(webview)
        chk("pywebview 可导入", True)
        print(f"       pywebview 版本: {ver}")

    print(f"\n{'-' * 46}\n通过 {n_ok} / {n_ok + n_bad}")
    return 1 if n_bad else 0


def _version_of(webview):
    try:
        from webview import _version
        return _version.__version__
    except Exception:  # noqa: BLE001
        return "?"


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        sys.exit(2)
