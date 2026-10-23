# Security policy

line-mcp holds a live LINE session, its E2EE keys and a local copy of every chat, and serves them to local MCP clients. Treat every report that lets someone outside the local machine reach that data, or makes LINE act without a tool call asking for it, as security-relevant.

## Trust model

The daemon serves MCP on `127.0.0.1:47822`, or the port in `LINE_MCP_PORT`, without a token. Every local process that can reach that port can call every tool, including sending, reacting to and unsending messages, and `send_message` with `file_path` sends any file the daemon's user can read. There is no per-user isolation and no confirmation step.

The listener binds `127.0.0.1` only. It refuses any request with an `Origin` header, which every browser request carries, and any `Host` other than `127.0.0.1:<port>` or `localhost:<port>`, and it sends no CORS headers, so web pages cannot reach it.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](../../security/advisories/new) for this repository. Do not open a public issue for exploitable problems.

You can expect an initial response within 7 days. Please include the commit you run, your OS version (on Linux, also the distribution and systemd version), your Node version, and the steps that reproduce it.

Never post QR codes, login PINs, tokens, keys, archives, logs with message content, or chat transcripts, not even in a private report. Describe the data instead, or replace it with made-up values.

## Scope

In scope:

- Anything that lets a caller outside the machine, or a web page in a local browser, reach the MCP tools
- Tokens, E2EE keys or archive contents leaking into logs, tool results of other chats, files readable by other users, or the network
- A read path that changes LINE state, such as a read receipt or an E2EE key registration
- A mutating tool that acts twice for one idempotency key

Out of scope:

- Local clients that can connect to the loopback listener. The design trusts them: they can call every tool, and there is no per-user isolation (see the trust model above)
- Vulnerabilities in LINE, Node, SQLite, macOS, Linux, systemd, Windows or a dependency (report to their maintainers)
- Account restrictions LINE applies to unofficial clients

## Supported versions

Only the latest commit on `main` receives security fixes.
