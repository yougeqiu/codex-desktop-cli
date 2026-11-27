# codex-desktop-cli

[English](README.md) | [简体中文](README.zh-CN.md)

**零依赖、不劫持全局命令的 Codex 桌面端 CLI（`codexctl`）与 Agent Skill —— 通过共享 `app-server` 让终端 / AI Agent 与 Windows Codex 桌面端实时同步会话。**

平时照常从桌面图标打开 Codex 桌面端即可。当你或 AI Agent 调用 `codexctl send` 派活时，若检测到桌面端处于私有模式会自动重拉挂载**一次**；挂载成功后后续发任务、追问、验收**全程不关闭或打断窗口**，新会话直接携带匹配的 `projectId` 出现在桌面端侧栏，全程实时看进度。

---

## 项目定位：为什么做这个项目？

| 工具 | 适用场景 | 侵入性与体积 | 桌面端实时同屏 |
|---|---|---|---|
| 官方 `codex` CLI | 终端独立跑任务 | 轻量，纯终端 | 与桌面端隔离，除非手动配 `--remote` |
| [LazyGon/codex-desktop-control](https://github.com/LazyGon/codex-desktop-control) | 长期挂机的完整桌面 + Discord 控制面板 | ~110+ 文件、WinForms GUI、装用户 `PATH` shim 劫持 `codex`、改写 `config.toml` | 是 |
| **`codex-desktop-cli`（本项目）** | **AI Agent 派活 / 开发者脚本联动桌面端** | **零 npm 依赖、不改 `PATH`、不改 `config.toml`、仅 6 个核心脚本** | **是（按需自动挂载 + 即时项目绑定）** |

### 核心特性
- **不劫持系统命令**：保持原版 `codex` CLI 与 `~/.codex/config.toml` 原样不动，只有显式执行 `codexctl` 时才接入共享 `ws://127.0.0.1:8798` 后端。
- **不打断已开启窗口**：`restart-desktop.ps1` 与 `codexctl send` 会结合 TCP 连接状态与 `tasklist /V` 真实窗口标题判定。只要桌面端已经连在共享端口且窗口在线，就**直接放行不重启**。
- **脱离父进程树常驻（修复“界面消失 / 后台掉线”）**：通过 Windows WMI `Win32_Process.Create` 拉起 `codex.exe app-server` 与 `ChatGPT.exe`，彻底脱离终端/Agent Runner 的 Job Object 与管道限制；重拉前自动等待旧窗口、残留无界面 `ChatGPT.exe` 及新版附带子进程完全退出。
- **侧栏实时同步（修复“新会话重开客户端才可见”）**：新建会话前先调 `project/list` 解析 `roots[].path`，把匹配到的 `projectId` 直接带入 `thread/start`，前端侧栏即时挂出。
- **面向 Agent 的派活参数**：支持 `--model`、`--effort`、`--tier`（如 `priority` 即 fast 档）、`--wait` 阻塞等待 `turn/completed`、`steer` 自动获取 `expectedTurnId`、`read --all` 全量拉取验收，并内置完整 `SKILL.md`。

---

## 环境要求

- **Windows 10 / 11**，已通过 Microsoft Store 安装并登录 **Codex Desktop**（`OpenAI.Codex`）。
- **Node.js >= 22.0.0**（原生使用全局 `WebSocket`、`fetch` 与 `node:test`，**无需安装任何第三方包**）。
- **PowerShell 5.1+**。

---

## 快速上手

### 1. 安装（CLI 或 Agent Skill 两种用法）

```bash
git clone https://github.com/yougeqiu/codex-desktop-cli.git
cd codex-desktop-cli

# 方式 A：全局链接 `codexctl` 命令
npm link

# 方式 B：直接运行
node scripts/codexctl.mjs --help
```

如作为 Agent Skill 使用（Antigravity / Claude Code 等），直接将本仓库放进 `~/.agents/skills/codex-desktop` 即可，根目录已包含规范的 `SKILL.md` 与 `references/`。

### 2. 日常使用示例

平时用桌面图标打开 Codex 后，随时可以直接派发任务：

```bash
# 新建会话并实时显示在桌面端对应项目下（如首次未挂载会自动重拉挂载一次）
codexctl send --new --cwd D:\your-project --text "检查项目结构" --model gpt-6.2-sol --effort high --tier priority --wait
```

之后的每一次 `send`、`steer`、`read` 都不会再重启你的桌面窗口。

---

## 命令速查

```text
codexctl status                                  检查服务端、账号与桌面端挂载状态
codexctl list [--limit N] [--search S]           列出最近会话
codexctl models [--hidden]                       列出本机可用模型与推理档位
codexctl send --text T|--file F [--thread ID | --new [--cwd DIR]]
              [--model M] [--effort E] [--tier T] [--name N]
              [--approval A] [--attach|--no-attach] [--wait] [--timeout S]
codexctl steer --thread ID --text T [--turn ID]  向进行中的 turn 插话（自动获取 turnId）
codexctl interrupt --thread ID                   打断进行中的 turn
codexctl read --thread ID [--all]                查看对话记录（--all 不截断输出）
codexctl name --thread ID --name N               重命名会话
```

---

## 自检测试

```bash
npm run check
npm test
```

## 致谢与协议

- 共享 `app-server` 思路参考自 [LazyGon/codex-desktop-control](https://github.com/LazyGon/codex-desktop-control)。
- [`references/cure-gpt-behavior.md`](references/cure-gpt-behavior.md) 行为矫正提示词源自 `@_kaichen` 的 [Gist](https://gist.github.com/kaichen/64d5fdce7eaefa1d377a874d79ee26d9)。
- 基于 [MIT License](LICENSE) 开源。
