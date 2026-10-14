# Security policy

line-mcp holds a live LINE session, its E2EE keys and a local copy of every chat, and serves them to local MCP clients. Treat every report that lets someone outside the local machine reach that data, or makes LINE act without a tool call asking for it, as security-relevant.

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

- Local clients that can connect to the loopback listener. The design trusts them: they can call every tool, and there is no per-user isolation (see the README)
- Vulnerabilities in LINE, Node, SQLite, macOS, Linux, systemd or a dependency (report to their maintainers)
- Account restrictions LINE applies to unofficial clients

## Supported versions

Only the latest commit on `main` receives security fixes.
