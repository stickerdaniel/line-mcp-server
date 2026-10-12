# line-mcp

Local MCP server that mirrors a personal LINE account into SQLite, so coding agents (Claude Code, Codex, T3 Code) can read, search and answer messages.

A Node 24 daemon, started by launchd, logs in to LINE as a secondary Android device, keeps a local copy of every chat, and serves MCP tools on `127.0.0.1`. A CLI and an agent skill are generated from the same tools.

Status: in development. See [`docs/architecture.md`](docs/architecture.md) for the architecture.

## Trust boundary

Every local client that can connect to the loopback listener can call every tool, including sending messages. There is no per-user isolation and no confirmation step.

## Development

```bash
bun install
bun run verify
```
