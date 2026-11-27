---
name: codex-desktop
description: >
  通过共享 app-server 直接控制本机 Codex 桌面端（OpenAI.Codex / ChatGPT.exe）：发任务、追话、打断、
  列会话、读聊天记录验收、指定模型/推理档与 fast 档（如 gpt-6.2-sol high priority）。命令行入口 scripts/codexctl.mjs。
  当用户说"给 codex 桌面端发个任务/让 codex 跑个东西/看 codex 聊天记录/codex 里发一条/
  codex 桌面端自动化/codex 指定模型跑/steer/interrupt codex 会话"时使用。
  不负责：codex CLI 自身的普通用法、云端 Codex 任务、改 codex 配置。
---

# codex-desktop

用命令行直接操控本机 Codex 桌面端，同时保留你从 Windows 图标正常打开的习惯。原理：把安装包内嵌的
`app\resources\codex.exe` 以 `app-server --listen ws://127.0.0.1:<port>` 单独拉起成共享后端，再带
`CODEX_APP_SERVER_WS_URL` 通过 WMI（`Win32_Process.Create`）脱离父进程树启动 `ChatGPT.exe`——此后桌面端 UI 与
CLI 共享同一总机和 `~\.codex` 会话状态，建新会话时直接匹配 `project/list` 传入 `projectId`，侧栏实时可见。

## 启用与无感挂载

```powershell
# 1. 仅拉起共享总机（通常不必单独跑，codexctl send 与 restart-desktop 会自动拉起）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-server.ps1 -Port 8798

# 2. 挂载桌面端并验证握手（会自动确保总机已启动；若已挂载且窗口正常则跳过，加 -Force 才强行重启）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restart-desktop.ps1 -Port 8798
```

- 平时用户直接从图标打开桌面端时，首次 `codexctl send` 会检测到桌面端处于脱钩私有模式，自动调用 `restart-desktop.ps1` **仅重拉一次**完成挂载；之后窗口保持常驻打开、全程实时看进度，不会再打断。
- 若之前旧进程残留无窗口，脚本会清净整棵 `ChatGPT` 与附属 `codex` 树后再拉起，并用 `tasklist /V` 校验真实窗口标题出现、校验 UTC/本地目录的 `codex-desktop-*-t0-*.log` 确认 `transportKind=websocket` + `next=connected`。

## 用法（node scripts/codexctl.mjs）

```bash
node scripts/codexctl.mjs status                          # 探活：server + 账号 + 桌面端挂载状态
node scripts/codexctl.mjs list --limit 20                 # 列会话
node scripts/codexctl.mjs models                          # 本机可选模型与 effort 档
node scripts/codexctl.mjs send --new --cwd D:\proj --text "任务" --model gpt-6.2-sol --effort high --tier priority --wait
node scripts/codexctl.mjs send --thread <id> --text "追加上下文继续" --wait
node scripts/codexctl.mjs steer --thread <id> --text "进行中插话"
node scripts/codexctl.mjs interrupt --thread <id>         # 打断当前 turn
node scripts/codexctl.mjs read --thread <id> --all        # 拉回完整聊天记录验收（不加 --all 默认每条截取 2000 字符）
node scripts/codexctl.mjs name --thread <id> --name "标题"
```

- `--wait` 阻塞到 `turn/completed` 并打印模型回复；`--timeout <秒>`（默认 600）。
- `--attach` 强制确保桌面窗口拉起并挂载；`--no-attach` 跳过自动拉起/挂载。
- `steer` 会自动查询进行中的 `expectedTurnId`（也可用 `--turn <id>` 显式指定）；空闲会话请用 `send`。
- 端点解析顺序：`--url` > `CODEX_APP_SERVER_WS_URL` > `~/.codex-desktop/state.json` > `ws://127.0.0.1:8798`。

## 派活与验收规范

- **验收规则**：tool 返回 success 不代表完成。派活时加 `--wait` 等到 `turn/completed`（`status=completed`），再用 `read --all` 核对真实聊天记录与产物，不直接复述模型自称"已改好"。
- **侧栏项目匹配**：`send --new` 会先调 `project/list` 解析 `roots[].path`（精确匹配优先、其次最长父目录匹配），把 `projectId` 直接带入 `thread/start`。若 `--cwd` 不在桌面端已添加的项目列表里，侧栏可能暂时看不到（控制台会提示 WARN）。

## 模型与推理档（常见参考）

```bash
node scripts/codexctl.mjs send --thread <id> --text "..." --model gpt-6.2-sol --effort high --tier priority
```

设置通过 `thread/settings/update` 写入会话（一次设置后续 turn 均生效），默认附带 `approvalPolicy=never` 与 `dangerFullAccess`：
- 运行 `node scripts/codexctl.mjs models` 获取当前桌面端完整可用模型与支持的 `efforts`（如 `low` / `medium` / `high` / `xhigh` / `max` / `ultra`）。
- 加速档传 `--tier priority`（对应界面 `fast` 模式）。
- 针对复杂编码/多轮排查，可将行为矫正提示词（[references/cure-gpt-behavior.md](references/cure-gpt-behavior.md)，源自 `kaichen/cure-gpt-behavior` Gist）放入目标项目的 `AGENTS.md`。

## 辅助脚本

- `node scripts/codex-call.mjs <method> [paramsJson]`：通用 JSON-RPC 调用口，直调未封装协议（如 `project/list`、`thread/metadata/update`）。
- `node scripts/codex-steer.mjs <threadId> <expectedTurnId> <textFile>`：从文件读取文本进行 `turn/steer` 的兼容入口。
- `node scripts/codex-autoapprove.mjs`：常驻后台监听服务端审批请求并自动放行（用于无法切 `approvalPolicy=never` 的旧会话兜底）。

## 边界与恢复

- WebSocket 仅监听 `127.0.0.1`、默认无鉴权：本机进程均可连入，共享机器请按需给 `app-server` 加 `--ws-auth capability-token`。
- 协议属 experimental：桌面端大版本更新后先跑 `status` 与一次 `send --wait` 冒烟确认。
- 恢复原生模式：不带 `CODEX_APP_SERVER_WS_URL` 从桌面图标正常关闭重开即可；如需停掉后台总机，结束 `~/.codex-desktop/state.json` 中记录的 `serverProcessId`。
- 设计致谢：共享 `app-server` 架构灵感来自 [LazyGon/codex-desktop-control](https://github.com/LazyGon/codex-desktop-control)。
