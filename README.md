# codex-desktop-cli

[English](README.md) | [简体中文](README.zh-CN.md)

**A zero-hijack, zero-dependency Windows CLI (`codexctl`) and Agent Skill to dispatch, steer, and inspect live Codex Desktop sessions via its shared `app-server`.**

Keep opening Codex Desktop from your normal Windows shortcut. Whenever you or an AI agent run `codexctl send`, it attaches once (only if Desktop is running detached), binds the new thread directly to your sidebar project, and streams live progress inside the Desktop UI without closing your window on subsequent runs.

---

## Positioning: Why `codex-desktop-cli`?

| Tool | Best For | Footprint & Intrusion | Live Desktop UI Sync |
|---|---|---|---|
| Official `codex` CLI | Standalone terminal sessions | Minimal, terminal-only | Separate unless manually wired with `--remote` |
| [LazyGon/codex-desktop-control](https://github.com/LazyGon/codex-desktop-control) | Full persistent desktop + Discord + TUI shim setup | ~110+ files, WinForms GUI, User `PATH` shim (`codex.cmd`), edits `config.toml`, caches binaries | Yes (full control plane) |
| **`codex-desktop-cli` (This Repo)** | **AI Agents & devs dispatching tasks straight into Codex Desktop** | **Zero external deps, no `PATH` hijack, no `config.toml` edits, 6 scripts** | **Yes — one-time auto-attach + live `projectId` binding** |

### Core Design Choices
- **No Global `PATH` Hijack**: Your native `codex` CLI stays untouched. Only explicit `codexctl` commands talk to the shared `ws://127.0.0.1:<port>` backend.
- **No Unnecessary Restarts**: `restart-desktop.ps1` and `codexctl send` check active TCP sockets (`netstat` / `Get-NetTCPConnection`) + real window titles (`tasklist /V`). If Desktop is already visible and attached, they **leave your window untouched** so you can watch progress continuously.
- **Detached Survival (`Win32_Process.Create`)**: Launches `codex.exe app-server` and `ChatGPT.exe` via WMI out of the caller's Windows Job Object and stdio pipes—preventing the "UI disappears / server dies as soon as the agent shell exits" bug.
- **Instant Sidebar Visibility**: Queries `project/list` (`roots[].path`) and passes the matched `projectId` directly into `thread/start`, so new CLI threads appear under the right Desktop sidebar project immediately without restarting the app.
- **Agent-First Ergonomics**: Native `--model`, `--effort`, `--tier` (e.g., `priority` fast tier), `--wait` completion blocking, automatic `expectedTurnId` lookup in `steer`, default `approvalPolicy: "never"`, and a drop-in `SKILL.md`.

---

## Requirements

- **Windows 10/11** with the **Codex Desktop** Microsoft Store app (`OpenAI.Codex`) installed and signed in.
- **Node.js >= 22.0.0** (uses built-in `WebSocket`, `fetch`, and `node:test`; **zero npm dependencies**).
- **PowerShell 5.1+** (built into Windows).

---

## Quick Start

### 1. Install as CLI or Agent Skill

```bash
git clone https://github.com/yougeqiu/codex-desktop-cli.git
cd codex-desktop-cli

# Option A: Link globally as `codexctl`
npm link

# Option B: Run directly
node scripts/codexctl.mjs --help
```

Or drop this repository directly into your Agent Skills directory (e.g., `~/.agents/skills/codex-desktop`) — `SKILL.md` and `references/` are already wired at the root.

### 2. Probe & Dispatch Your First Task

Open Codex Desktop normally from its Windows icon, then run:

```bash
# Dispatch a new task into an existing Desktop project folder
codexctl send --new --cwd D:\your-project --text "Inspect the repo structure" --model gpt-6.2-sol --effort high --wait
```

What happens automatically:
1. If Codex Desktop was opened in native private mode, `codexctl` starts `codex.exe app-server` on `ws://127.0.0.1:8798` and cleanly relaunches `ChatGPT.exe` **once** onto that WebSocket endpoint.
2. `codexctl` matches `D:\your-project` against `project/list`, passes `projectId` into `thread/start`, and sends the turn—so the thread appears live in your Desktop sidebar immediately.
3. On your next `codexctl send` / `steer` / `read`, Desktop is already attached and **never restarted**.

---

## CLI Reference

```text
codexctl status                                  Probe server, account, and Desktop UI attachment
codexctl list [--limit N] [--search S]           List recent threads
codexctl models [--hidden]                       List available models & supported reasoning efforts
codexctl send --text T|--file F [--thread ID | --new [--cwd DIR]]
              [--model M] [--effort E] [--tier T] [--name N]
              [--approval A] [--attach|--no-attach] [--wait] [--timeout S]
codexctl steer --thread ID --text T [--turn ID]  Steer an active turn (auto-resolves turnId)
codexctl interrupt --thread ID                   Interrupt an active turn
codexctl read --thread ID [--all]                Read transcript (--all disables 2000-char truncation)
codexctl name --thread ID --name N               Rename a thread
```

### Additional Scripts

- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-server.ps1 [-Port 8798]` — Start/adopt the detached shared `app-server` (`~/.codex-desktop/state.json`).
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restart-desktop.ps1 [-Port 8798] [-Force]` — Attach Codex Desktop to the shared server (skips if already attached unless `-Force` is set).
- `node scripts/codex-call.mjs <method> [paramsJson]` — Raw JSON-RPC helper for any un-wrapped `app-server` method.
- `node scripts/codex-autoapprove.mjs` — Background auto-approval listener for legacy threads without `approvalPolicy: "never"`.
- `node scripts/codex-steer.mjs <threadId> <expectedTurnId> <textFile>` — File-based steer compatibility helper.

---

## Troubleshooting & Notes

- **Why did my `--cwd` log a warning about `project/list`?**  
  Codex Desktop only displays project groups for directories registered in the app. Add the root folder once in Codex Desktop (or pass a `--cwd` under an existing project root) and `codexctl` will link future threads automatically.
- **Loopback Security**: `codex app-server` listens only on `127.0.0.1` without authentication by default. On shared machines, configure `--ws-auth capability-token` manually.
- **Returning to Native Mode**: Simply quit Codex Desktop from its tray/window and reopen it normally without running `restart-desktop.ps1`.

---

## Development & Release Checks

```bash
npm run check
npm test
```

## Acknowledgments

- Shared `app-server` WebSocket architecture inspired by [LazyGon/codex-desktop-control](https://github.com/LazyGon/codex-desktop-control).
- Behavioral prompt reference in [`references/cure-gpt-behavior.md`](references/cure-gpt-behavior.md) adapted from `@_kaichen`'s [cure-gpt-behavior gist](https://gist.github.com/kaichen/64d5fdce7eaefa1d377a874d79ee26d9).

## License

[MIT](LICENSE)
