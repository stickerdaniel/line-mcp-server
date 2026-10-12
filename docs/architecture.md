# Architecture

This document describes the runtime of line-mcp and the principles every part of it follows.

## Runtime

Node 24.18 or later runs the TypeScript sources directly through type stripping; there is no build step. Bun manages packages. Tests run with Vitest and never contact LINE.

## Principles

- One process owns the LINE session, the local archive and every upstream request.
- Reads never change LINE state: no read receipts and no E2EE key registration.
- MIDs and tokens are opaque strings, stored unchanged. Integer message IDs and revisions are decimal strings, never JavaScript numbers.
- Logs and tool results never carry tokens, keys, raw envelopes or message text outside a tool's own result data.

## Out of scope

LINE calls, LINE Pay and shopping, account settings changes, joining or leaving groups, contact management, multiple accounts, hosts other than one macOS user account, embeddings, OCR and speech, and MCP resources or prompts beyond the framework defaults.
