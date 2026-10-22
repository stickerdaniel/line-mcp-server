# line-mcp

<p align="left">
  <a href="https://www.npmjs.com/package/line-mcp-server"><img src="https://img.shields.io/npm/v/line-mcp-server?color=blue" alt="npm"></a>
  <a href="https://github.com/stickerdaniel/line-mcp-server/actions/workflows/ci.yml"><img src="https://github.com/stickerdaniel/line-mcp-server/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/stickerdaniel/line-mcp-server/actions/workflows/release.yml"><img src="https://github.com/stickerdaniel/line-mcp-server/actions/workflows/release.yml/badge.svg?branch=main" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-%233fb950?labelColor=32383f" alt="License"></a>
</p>

Give your coding agents your LINE chats. line-mcp keeps a local SQLite copy of one personal LINE account and serves it over MCP, so Claude Code, Codex and T3 Code can read, search and answer your messages.

> [!WARNING]
> line-mcp is an unofficial client, not affiliated with or endorsed by LINE. It speaks LINE's private protocol through [LINEJS](https://github.com/evex-dev/linejs). Using it may break LINE's terms of use, and LINE may restrict or ban an account that uses it. Use it at your own risk.

## Quick start

You need [Node](https://nodejs.org) 24.18 or later on macOS, Linux with systemd or Windows, and the LINE app on your phone, logged in to the account.

```bash
npm i -g line-mcp-server
line-mcp login     # scan the QR code with LINE on your phone, then enter the PIN
line-mcp install   # start the background daemon
line-mcp doctor    # check the setup without contacting LINE
```

line-mcp joins the account as a secondary device; the phone stays the primary one. From then on the daemon syncs every chat, starts again after a reboot, and serves MCP at `http://127.0.0.1:47822/mcp`. If LINE ends the session, it keeps serving the local archive, shows a desktop notification and waits for another `login`.

Linux and Windows have a few extra requirements: see [Platforms](#platforms).

## Connect your agent

**Claude Code**

```bash
claude plugin marketplace add stickerdaniel/line-mcp-server
claude plugin install line-mcp-server@line-mcp-server
```

**Codex**

```bash
codex plugin marketplace add stickerdaniel/line-mcp-server
codex plugin add line-mcp-server@line-mcp-server
```

The plugin connects the agent to the running daemon and adds the line-mcp skill. **T3 Code** runs Claude Code and Codex, so it needs nothing else.

<details>
<summary>Without the plugin, or with another port</summary>

The plugins expect the default port. Otherwise add the server by hand.

Claude Code:

```bash
claude mcp add --transport http --scope user line http://127.0.0.1:47822/mcp
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.line]
url = "http://127.0.0.1:47822/mcp"
# Attachment downloads can take longer than the 60 s default.
tool_timeout_sec = 180
```

For the skill, link or copy `plugins/line-mcp-server/skills/line-mcp/` into the agent's skills directory. It runs `line-mcp` from `PATH`, where the npm install puts it.

</details>

## Tools

| Tool                | What it does                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `query`             | Read-only SQL over the local archive: chats, names, messages, read state, full-text search.  |
| `status`            | Session health, last sync times, coverage gaps, backfill progress and the archive time zone. |
| `get_attachment`    | Metadata of an image, video, audio or file message, or the file saved to a private cache.    |
| `get_announcements` | Pinned announcements of a group, room or OpenChat.                                           |
| `get_profile`       | Your own profile, another LINE user's, or an OpenChat member's.                              |
| `send_message`      | Sends text, an image or a file, optionally as a reply.                                       |
| `react`             | Reacts to a message.                                                                         |
| `unsend`            | Unsends one of your messages for everyone.                                                   |

Reads never mark anything as read. Every send, reaction and unsend needs an `idempotency_key`: a retry with the same key and arguments never acts twice.

<details>
<summary>Details</summary>

- The endpoint is stateless Streamable HTTP and serves for as long as the daemon runs.
- `query` runs one `SELECT`. Its description lists the readable tables and columns and what they mean. A result holds at most 200 rows and 64 KiB.
- Every result reports `stale` and the last sync times.
- The archive stores times as UTC milliseconds. `local_time(ms)` in a query, and every time the other tools return, is ISO 8601 with the offset of the daemon's system time zone, which `status` reports as `time_zone`.
- A result with state `unknown` means LINE may have acted; line-mcp never resends it on its own.

</details>

## CLI

Every tool is also a `line-mcp` command that calls the running daemon:

```bash
line-mcp query --sql "
  SELECT local_time(sent_at), text FROM message
  WHERE instr(text, '晚餐') ORDER BY sent_at DESC LIMIT 5"
```

<details>
<summary>Commands and output</summary>

- Commands and flags are the tool and field names in kebab case. The `status` tool is `sync-status`, since `line-mcp status` reports the local setup without the daemon.
- `line-mcp help` lists the commands, `line-mcp <command> --help` a command's flags.
- A result is JSON on stdout. An error is JSON on stderr with exit code 1, or 2 for a usage error.
- The skill in `plugins/line-mcp-server/skills/line-mcp/SKILL.md` teaches agents these commands.

</details>

## Security

> [!IMPORTANT]
> Every local process that can reach `127.0.0.1:47822` can call every tool, including sending, reacting to and unsending messages. `send_message` with `file_path` sends any file the daemon's user can read. There is no token, no per-user isolation and no confirmation step.

<details>
<summary>What the listener refuses</summary>

The listener binds `127.0.0.1` only. It refuses any request with an `Origin` header, which every browser request carries, and any `Host` other than `127.0.0.1:<port>` or `localhost:<port>`, and it sends no CORS headers. Web pages cannot reach it.

</details>

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Platforms

The daemon runs as a per-user service: a LaunchAgent on macOS, a systemd user unit on Linux, a scheduled task on Windows. `install` writes it, and running `install` again after an upgrade rewrites it.

<details>
<summary><b>macOS</b></summary>

| What        | Where                                                           |
| ----------- | --------------------------------------------------------------- |
| Archive     | `~/Library/Application Support/line-mcp/line.db` (`0600`)       |
| Attachments | `~/Library/Application Support/line-mcp/attachments`            |
| Logs        | `~/Library/Logs/line-mcp/daemon.log`, without message content   |
| LaunchAgent | `~/Library/LaunchAgents/io.github.stickerdaniel.line-mcp.plist` |

</details>

<details>
<summary><b>Linux</b></summary>

The daemon runs as the systemd user unit `line-mcp.service` (line-mcp-server 0.3.0 or later). Linux also needs:

- systemd 240 or later with a user manager, so `systemctl --user status` answers.
- Lingering, for the daemon to keep running after you log out: `loginctl enable-linger "$(id -un)"`. line-mcp never turns it on; `doctor` reports it.
- An npm prefix you own, so `npm i -g` needs no sudo, with its `bin` on `PATH`. With a distribution Node, `npm config set prefix ~/.local` and `~/.local/bin` on `PATH` do that.
- The state directory on a local disk. SQLite's WAL mode needs shared memory, which network file systems do not provide.

| What        | Where                                                                      |
| ----------- | -------------------------------------------------------------------------- |
| Archive     | `~/.local/share/line-mcp/line.db` (`0600`), under `$XDG_DATA_HOME` if set  |
| Attachments | `~/.local/share/line-mcp/attachments`                                      |
| Logs        | `~/.local/state/line-mcp/daemon.log`, under `$XDG_STATE_HOME` if set       |
| Unit        | `~/.config/systemd/user/line-mcp.service`, under `$XDG_CONFIG_HOME` if set |

- `install` writes the state directory into the unit, so the daemon opens the same archive whatever environment the user manager has. The unit must go where the user manager looks: with an `XDG_CONFIG_HOME` set only in your shell, `install` fails with `unit_not_found` and removes the unit again.
- Notifications go through `notify-send` when it is installed.
- A Node from nvm, fnm, Volta, asdf or snap lives in a directory that goes away with its version, and the daemon with it; `install` and `doctor` warn about that. Pass `--node` with a Node that stays, such as the distribution's `/usr/bin/node`, or run `line-mcp install` again after switching versions.
- Without systemd, for example in a container, run `line-mcp daemon` in the foreground.
- WSL 2 with systemd enabled works like Linux. Keep the state directory in the Linux file system, not under `/mnt/c`. A systemd service does not keep WSL running, so the daemon stops when WSL shuts down after its last terminal closes.

</details>

<details>
<summary><b>Windows</b></summary>

The daemon runs as the scheduled task `line-mcp-<your user SID>` (line-mcp-server 0.3.0 or later), which starts it when you log on and runs it while you stay logged on. When PowerShell's execution policy blocks the scripts npm installs, run `npm.cmd` and `line-mcp.cmd` instead of `npm` and `line-mcp`.

| What        | Where                                                                |
| ----------- | -------------------------------------------------------------------- |
| Archive     | `%LOCALAPPDATA%\line-mcp\line.db`                                    |
| Attachments | `%LOCALAPPDATA%\line-mcp\attachments`                                |
| Logs        | `%LOCALAPPDATA%\line-mcp\logs\daemon.log`, also with `LINE_MCP_HOME` |
| Task files  | `%LOCALAPPDATA%\line-mcp\service`, also with `LINE_MCP_HOME`         |

- The state must stay inside your user profile, readable by you, SYSTEM and Administrators only. line-mcp refuses state that others can read and never changes access lists itself; `doctor` prints the fix.
- Paths with a `"` or a `%` cannot run as a scheduled task, so `install` refuses them.
- Logging off ends the daemon without a shutdown. SQLite recovers the archive when the task starts again at your next logon, and the sync catches up from there.
- A Node from nvm-windows lives in a directory that goes away with its version, and the daemon with it; `install` and `doctor` warn about that. Pass `--node` with a Node that stays, such as `C:\Program Files\nodejs\node.exe`, or run `line-mcp install` again after switching versions.

</details>

<details>
<summary><b>Environment variables</b></summary>

Set them before `install`, which passes them on to the service.

| Variable             | Default         | What it does                                        |
| -------------------- | --------------- | --------------------------------------------------- |
| `LINE_MCP_HOME`      | the paths above | Moves the state directory.                          |
| `LINE_MCP_PORT`      | `47822`         | The MCP port. It must differ from the lock port.    |
| `LINE_MCP_LOCK_PORT` | `47821`         | The lock port: one process at a time talks to LINE. |

</details>

## Upgrade and uninstall

```bash
npm i -g line-mcp-server@latest
line-mcp install              # restarts the daemon; the archive and session stay
```

```bash
line-mcp uninstall            # stops the daemon, keeps the archive
line-mcp uninstall --purge    # also deletes the state directory
npm rm -g line-mcp-server
```

To revoke the session itself, log the device out in LINE's device list on your phone.

## Development

```bash
bun install
bun run verify
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [architecture](docs/architecture.md). The agent eval of the tools lives in [evals/](https://github.com/stickerdaniel/line-mcp-server/blob/main/evals/README.md).

## License

[Apache-2.0](LICENSE)
