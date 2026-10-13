# line-mcp

Local MCP server that mirrors a personal LINE account into SQLite, so coding agents (Claude Code, Codex, T3 Code) can read, search and answer messages.

A Node 24 daemon, started by launchd, logs in to LINE as a secondary Android device, keeps a local copy of every chat, and serves MCP tools on `127.0.0.1`. The `line-mcp` CLI runs the same tools from a shell, and an agent skill teaches agents to use it.

Status: in development. See [`docs/architecture.md`](docs/architecture.md) for the architecture.

> [!WARNING]
> line-mcp is an unofficial client, not affiliated with or endorsed by LINE. It speaks LINE's private protocol through [LINEJS](https://github.com/evex-dev/linejs). Using it may break LINE's terms of use, and LINE may restrict or ban an account that uses it. Use it at your own risk.

## Requirements

- macOS. The daemon runs as a per-user LaunchAgent.
- [Node](https://nodejs.org) 24.18 or later
- The LINE app on your phone, logged in to the account

## Install

```bash
npm i -g line-mcp-server
line-mcp login
line-mcp install
line-mcp doctor
```

`login` shows a QR code. Scan it with LINE on your phone and enter the PIN it prints. line-mcp joins the account as a secondary device; the phone stays the primary one. `install` writes the LaunchAgent and starts the daemon, which syncs from then on and starts again after a reboot. `doctor` checks the setup without contacting LINE.

If LINE ends the session, the daemon keeps serving the local archive, shows a macOS notification, and waits for another `login`.

## State

| What        | Where                                                           |
| ----------- | --------------------------------------------------------------- |
| Archive     | `~/Library/Application Support/line-mcp/line.db` (`0600`)       |
| Attachments | `~/Library/Application Support/line-mcp/attachments`            |
| Logs        | `~/Library/Logs/line-mcp/daemon.log`, without message content   |
| LaunchAgent | `~/Library/LaunchAgents/io.github.stickerdaniel.line-mcp.plist` |

`LINE_MCP_HOME` moves the state directory; set it before `install`, which passes it on to the LaunchAgent.

## Upgrade

```bash
npm i -g line-mcp-server@latest
line-mcp install
```

`install` rewrites the LaunchAgent and restarts the daemon. The archive and the session stay.

## Uninstall

```bash
line-mcp uninstall          # stops the daemon, keeps the archive
line-mcp uninstall --purge  # also deletes the state directory
npm rm -g line-mcp-server
```

To revoke the session itself, log the device out in LINE's device list on your phone.

## MCP endpoint

The daemon serves Streamable HTTP at `http://127.0.0.1:47822/mcp`, stateless, for as long as it runs. `LINE_MCP_PORT` changes the port (set it before `install`, which passes it on to the LaunchAgent); it must differ from the lock port 47821 (`LINE_MCP_LOCK_PORT`).

Read tools: `status`, `list_chats`, `read_messages`, `search_messages`, `list_changes`, `get_attachment`, `get_announcements`, `get_profile`. Every result reports `stale` and the last sync times. Each time is an ISO 8601 string with the offset of the daemon's system time zone, which `status` reports as `time_zone`. Message and chat items leave out fields without a value.

Mutating tools: `send_message`, `react`, `unsend`. Each call needs an `idempotency_key`; a retry with the same key and arguments never acts twice. A result with state `unknown` means LINE may have acted, and line-mcp never resends it on its own.

### Codex plugin

The plugin connects Codex to the daemon and adds the line-mcp skill:

```bash
codex plugin marketplace add stickerdaniel/line-mcp-server
codex plugin add line-mcp-server@line-mcp-server
```

Without the plugin, add the server to `~/.codex/config.toml`:

```toml
[mcp_servers.line]
url = "http://127.0.0.1:47822/mcp"
# Attachment downloads can take longer than the 60 s default.
tool_timeout_sec = 180
```

### Claude Code plugin

The same plugin works in Claude Code:

```bash
claude plugin marketplace add stickerdaniel/line-mcp-server
claude plugin install line-mcp-server@line-mcp-server
```

Without the plugin:

```bash
claude mcp add --transport http --scope user line http://127.0.0.1:47822/mcp
```

The plugins only connect to the daemon. Install and log it in first (see Install). With a different `LINE_MCP_PORT`, configure the server by hand instead.

### T3 Code

T3 Code runs Claude Code and Codex, which read the configuration above. Nothing else is needed.

### CLI and skill

Every tool is also a `line-mcp` command that calls the running daemon:

```bash
line-mcp search-messages --query 晚餐
```

Commands and flags are the tool and field names in kebab case; the `status` tool is `sync-status`, since `line-mcp status` reports the local setup without the daemon. `line-mcp help` lists the commands and `line-mcp <command> --help` a command's flags. A result is JSON on stdout. An error is JSON on stderr with exit code 1, or 2 for a usage error.

`plugins/line-mcp-server/skills/line-mcp/SKILL.md` teaches agents these commands. The plugins install it; otherwise link or copy that directory into an agent's skills directory. The skill runs `line-mcp` from PATH, where the npm install puts it.

## Trust boundary

Every local client that can connect to the loopback listener can call every tool, including sending, reacting to and unsending messages. There is no per-user isolation and no confirmation step. `send_message` with `file_path` reads any local file the daemon's user can read and sends it to the chat. The listener binds `127.0.0.1` only, refuses any request with an `Origin` header (every browser request) and any `Host` other than `127.0.0.1:<port>` or `localhost:<port>`, and sends no CORS headers, so web pages cannot reach it. There is no bearer token.

## Development

```bash
bun install
bun run verify
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE)
