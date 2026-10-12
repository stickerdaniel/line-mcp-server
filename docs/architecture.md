# Architecture

line-mcp works with one personal LINE account:

- Log in as a secondary device by QR code and keep the session across restarts, refreshing tokens as LINE expires them.
- Decrypt end-to-end encrypted messages with the keys LINE transfers at login.

## Runtime

Node 24.18 or later runs the TypeScript sources directly through type stripping; there is no build step. Bun manages packages. Tests run with Vitest and never contact LINE.

## Principles

- One process owns the LINE session, the local archive and every upstream request.
- Reads never change LINE state: no read receipts and no E2EE key registration.
- MIDs and tokens are opaque strings, stored unchanged. Integer message IDs and revisions are decimal strings, never JavaScript numbers.
- Logs and tool results never carry tokens, keys, raw envelopes or message text outside a tool's own result data.

Source paths in this document are relative to the pinned dependency checkouts: LINEJS (`@evex/linejs`) `packages/linejs/` at v3.5.0.

## State

All state lives under `~/Library/Application Support/line-mcp` (`LINE_MCP_HOME` overrides it): one SQLite database, `line.db`, in WAL mode with `synchronous = FULL`. The directory is `0700` and the database files are `0600`.

| Table     | Purpose                                                                |
| --------- | ---------------------------------------------------------------------- |
| `line_kv` | LINEJS key/value storage: tokens, certificates, E2EE keys; never shown |
| `account` | the bound account MID, device type, LINEJS version and auth state      |

## Process and lock ownership

One process at a time may talk to LINE for the account. Ownership is an exclusive bind of a fixed loopback lock port, `127.0.0.1:47821` (`LINE_MCP_LOCK_PORT`), with `exclusive: true` and `reusePort: false`. Nothing is ever exchanged on it: every accepted connection is destroyed at once. The kernel frees the port when the process dies, so there is no lock file, no stale lock and no PID reuse case. Any bind failure, including an unrelated process on the port, fails closed before LINE work starts; there is no fallback port. Commands that take the lock close the listener and await the close on success and on error.

A session opens in a fixed order: take the lock, open and migrate the database, check the device and account binding, install the upstream guards, register the token handler, then restore the session.

## Session and login

The client logs in as `ANDROIDSECONDARY` through the V3 secure QR path (`base/core/utils/devices.ts:18`). `IOS` or `ANDROID` would move the account off the phone, and desktop device types could compete with a desktop LINE app.

**Token persistence.** `SqliteStorage` implements LINEJS's `BaseStorage` with synchronous `node:sqlite` writes. LINEJS emits a new access token from a response header without assigning it and without awaiting the handler (`base/request/mod.ts:170-173`), so the handler writes it synchronously and sets it on the client. A failed write puts the session in `storage_error`, which blocks every further upstream request.

**Token refresh.** One refresh runs at a time and later callers await it. LINEJS's own refresh lets concurrent callers spend the same refresh token and writes the access token, rotated refresh token and expiry separately (`base/service/auth/mod.ts:21-37`); here the three commit in one transaction before the new access token is used.

**Auth loss.** Terminal auth errors (a refused refresh, `NOT_AUTHORIZED_DEVICE`, a revoked token, or a Square `AUTHENTICATION_FAILURE` after one refresh and retry) are read from the thrown error data, since LINEJS throws before its own `end` event (`base/request/mod.ts:244-262`). The session then enters `needs_login`, stops every upstream request and keeps the local data readable.

**Login handoff.** `line-mcp login` takes the lock, copies the live `line_kv` into staging storage and runs the QR login there. LINEJS writes transferred keys before it learns the account MID (`base/login/mod.ts:288-307`, :117-122), so nothing reaches the live store until the MID matches the bound account, or binds it on the first login. One transaction then replaces the token and certificate rows and adds any new key generations. Existing key generations and contact or group key caches are never deleted or overwritten. A wrong account is refused, and a login killed midway leaves the live store unchanged.

## E2EE key boundaries

**No implicit key registration.** Guards on the client block `registerE2EEPublicKey`, `registerE2EEPublicKeyV2` and `registerE2EEGroupKey`. LINEJS would otherwise register a group key after a `NOT_FOUND` lookup (`base/e2ee/mod.ts:240`) and a fresh key pair when QR login decodes no key (`base/login/mod.ts:303-305`). A login whose key transfer yields no key fails with `key_transfer_empty`.

**Read state.** The guards also block `sendChatChecked`, `markAsRead` and `markThreadsAsRead`, so nothing line-mcp does marks a message as read.

**Exact key generations.** Before decrypting, the adapter checks that the exact key generations an envelope names (self key, peer key or group key) are available locally or from LINE. Older peer generations come from `getE2EEPublicKey`, since LINEJS asks `negotiateE2EEPublicKey`, which knows only the current key. LINEJS silently substitutes another self key for a missing DM key (`base/e2ee/mod.ts:903-906`) and the latest group key for a missing group generation (`base/e2ee/mod.ts:209-226`), which then fails as a generic authentication error. So a message whose keys are missing is `missing_key` without a decryption attempt, and `invalid` is kept for messages whose keys were verified present.

## Errors

One allowlisted mapper sits between upstream failures and both logs and results: an error code, the operation name and a fixed message. Upstream text is never copied, because LINEJS parse errors embed response headers, including the next access token, and body bytes (`base/request/mod.ts:183-190`). Only codes from the published LINE enums pass through.

## OpenChat adapter

`fetchSquareChatEvents` goes through the generated Thrift request, because the handwritten wrapper drops `continuationToken`, `subscriptionId`, `inclusive` and `fetchType` (`base/service/square/mod.ts:127-144`). LINE answers `getJoinedSquareChats` with `NOT_IMPLEMENTED` for this device type, so joined chats come from the account's own `fetchMyEvents` membership history, and `getSquareChat` confirms each one. A joined square without a confirmed chat is reported as uncovered rather than dropped.

## Out of scope

LINE calls, LINE Pay and shopping, account settings changes, joining or leaving groups, contact management, multiple accounts, hosts other than one macOS user account, embeddings, OCR and speech, and MCP resources or prompts beyond the framework defaults.
