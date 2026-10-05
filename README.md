# Ponko HUD

全屏无边框的 eDEX-UI 风格 HUD 桌面应用（Windows）。自己动手画的字符网格，没有 Electron 那套重壳。

## 特性

- **自绘字符网格**：Canvas 2D 逐字符渲染整个界面，不是 DOM 拼出来的
- **真终端**：ConPTY 驱动的 PTY，按键裸直通（参照 eDEX-UI / xterm.js 模型），支持 vim / python / htop 等全交互程序，中文 IME 正常
- **Agent 对话**：接 OpenAI 兼容接口，流式输出；未配置时界面内直接弹配置框
- **实时地理地球**：真实 IP / DNS 地理位置，字符点阵球面投影 + 自动跑马灯
- **心情角色**：方块字符动画角色，心情由 Agent 正文标记 `[[mood:STATE|face:...]]` 自主控制
- **原生窗口**：pywebview + WebView2，独立任务栏身份、自有图标、单实例
- **零依赖后端**：纯 Node 标准库，无任何第三方包

## 运行

```bat
start-native.bat        :: 原生窗口（推荐）
```

或直接双击 `PonkoHUD.pyw`。后端监听 `127.0.0.1:8787`。

## 结构

```
app/src/        前端：grid 字符网格、vt 终端仿真、panels 各面板
server/         后端：server.js HTTP 服务、pty.js PTY 管理、ptybridge.py Windows ConPTY 桥
characters/     角色动画资源（.ans / .json）
native_host.py  pywebview 原生窗口宿主
```

## 说明

界面语言与代码注释为中文。项目硬编码了本机路径，克隆后请按需修改 `native_host.py`
与 `app/src/main.js` 中的目录。
