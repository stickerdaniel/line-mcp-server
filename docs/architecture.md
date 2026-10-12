# Architecture

line-mcp works with one personal LINE account:

- Log in as a secondary device by QR code and keep the session across restarts, refreshing tokens as LINE expires them.
- Decrypt end-to-end encrypted messages with the keys LINE transfers at login.
- Mirror personal chats, groups, rooms and joined OpenChat (Square) chats into a local archive, including history and non-Latin text such as Traditional Chinese.
- Keep the archive current across reboots, sleep and network loss without user action, except a QR login again when LINE revokes the session.

## Runtime

Node 24.18 or later runs the TypeScript sources directly through type stripping; there is no build step. Bun manages packages. Tests run with Vitest and never contact LINE.

## Principles

- One process owns the LINE session, the local archive and every upstream request.
- Reads never change LINE state: no read receipts and no E2EE key registration.
- MIDs and tokens are opaque strings, stored unchanged. Integer message IDs and revisions are decimal strings, never JavaScript numbers.
- Logs and tool results never carry tokens, keys, raw envelopes or message text outside a tool's own result data.

Source paths in this document are relative to the pinned dependency checkouts: LINEJS (`@evex/linejs`) `packages/linejs/` at v3.5.0.

## Overview

```text
LINE servers
   |  talk.sync / Square events / history (one session)
line-mcp daemon (Node 24, LaunchAgent io.github.stickerdaniel.line-mcp)
   |- session: ANDROIDSECONDARY client, SQLite storage, upstream guards
   |- sync: Talk loop, Square loop, backfill and reconciliation worker
   '- archive: ~/Library/Application Support/line-mcp/line.db
```

## State

All state lives under `~/Library/Application Support/line-mcp` (`LINE_MCP_HOME` overrides it): one SQLite database, `line.db`, in WAL mode with `synchronous = FULL`. The directory is `0700` and the database files are `0600`.

| Table            | Purpose                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| `line_kv`        | LINEJS key/value storage: tokens, certificates, E2EE keys; never shown                                   |
| `account`        | the bound account MID, device type, LINEJS version and auth state                                        |
| `sync_state`     | Talk revisions, Square paging state, backfill cursors and stop reasons, health                           |
| `change_counter` | the single source of `seq`                                                                               |
| `chat`           | service, opaque ID, type, name, member count, last activity                                              |
| `participant`    | service-scoped ID and display name                                                                       |
| `message`        | one row per (service, chat, message ID): thread, sender, times, text, envelope, decrypt state, tombstone |
| `message_fts`    | FTS5 `trigram` index over message text                                                                   |
| `coverage_gap`   | scope, reason and reconciliation status of every known gap                                               |

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

## Daemon and LaunchAgent

`line-mcp install` writes the per-user LaunchAgent `io.github.stickerdaniel.line-mcp` to `~/Library/LaunchAgents` from `launchd/io.github.stickerdaniel.line-mcp.plist` and bootstraps it: `RunAtLoad`, `KeepAlive`, `ThrottleInterval` 30, `Umask` 63, logs in `~/Library/Logs/line-mcp` (`0700`). `LINE_MCP_HOME` and `LINE_MCP_LOCK_PORT` pass on to the agent. The agent runs an absolute Node path: an override from `--node` or `LINE_MCP_NODE`, which must be an executable Node 24.18 or later, otherwise Homebrew's stable `opt/node@24` link rather than a versioned Cellar path that the next `brew upgrade` removes, otherwise the running Node.

`line-mcp uninstall` boots the agent out and removes the plist; the archive stays unless `--purge` is given, which deletes the state root once it can take the lock. `bootout` counts an agent that is not loaded as done and fails on every other launchctl error. `line-mcp login` boots the agent out before it takes the lock and bootstraps it again afterwards. `line-mcp doctor` checks the local setup without contacting LINE: Node, FTS5, permissions, schema, account, sync health, whether the installed plist matches this checkout, whether launchd has the agent loaded, and whether a process holds the lock port.

The daemon reports one health state: `online`, `catching_up`, `offline`, `needs_login` or `storage_error`. When the session leaves `online` for `needs_login` or `storage_error`, every loop stops calling LINE while the archive stays readable, and the daemon shows one macOS notification for the transition, with fixed text and no message content. A failed archive write puts the daemon in `storage_error`.

## Upstream concurrency

The Talk and Square sync loops run independently. History requests (backfill and reconciliation) share a bounded pool of 2, and token refresh is serialized. Transient failures back off exponentially with jitter, from 1 s to 5 min. An empty or immediately returning call waits at least 1 s before the next one, and history requests for one chat, like backfill rounds, are at least 3 s apart.

## Transactional sync and cursors

The Talk loop calls `base.talk.sync` (`base/service/talk/mod.ts:42`) from the last committed revisions. Each batch is normalized and decrypted, then messages, tombstones, any coverage gap and the new revisions are written in one SQLite transaction. A crash before the commit fetches the batch again; a crash after it loses nothing. The deprecated polling generators of LINEJS are not used (`base/polling/mod.ts:39,87`).

LINE holds an idle `sync` for about 110 s and then ends it with HTTP 410. That is an empty batch: the cursor stays, the sync time is recorded, no error is raised and the loop polls again at once. `sync` runs with LINEJS's 180 s `longTimeout`. A `sync` still held after 5 s counts as caught up for health, since LINE holds only a request with nothing to deliver.

## Coverage gaps

`fullSyncResponse` and `partialFullSyncResponse` (`packages/types/line_types.ts:9807`, :12630) record their reason and scope as a `coverage_gap`, one per full sync and one per partial category, including categories this version does not know. The cursor is checkpointed as the response says, chats are enumerated again, and chats with activity since the last good sync are paged back until they meet archived history or a page bound. A gap is `reconciled` when every chat met its history and `incomplete` otherwise; both stay visible in the status until reconciled. LINEJS's own loop is not copied, since it advances full-sync revisions without reconciliation (`base/polling/mod.ts:104-138`).

A page proves overlap only through a message committed before a request that the gap's starting stream position covers: a complete Talk `sync` response, or the first page of a Square chain that ran to its end. The cursor and each Square paging state persist that row ID boundary, and a position without one trusts no row.

## OpenChat sync

Discovery reads the account's `fetchMyEvents` membership history with its own paging state, separate from the loop's, and keeps each joined square without a confirmed chat as an open `uncovered_square` gap. Paging state is persisted in the same transaction as the events of its page.

Paging follows how LINE answers. A first fetch returns the newest page and a `syncToken`. Forward fetches pass the stored `syncToken` and the last continuation token and end at an empty page. Older history pages only with `direction: BACKWARD` from a `syncToken`: each response's `syncToken` leads to the next older page, and an empty page marks the start of history. Without a direction, a continuation token serves the newest page again under a fresh token, since tokens embed a timestamp. So every Square chain (chat, thread, `fetchMyEvents`, backfill, reconciliation) stops as stalled when its tokens or its page hashes close a cycle, each found by Brent's algorithm in constant memory. Page hashes cover the full events with map keys sorted, so edits and read marks at new positions differ; an empty page that promises more counts only its token. Backfill and reconciliation of one Square chat or thread share one persisted next-request time, 3 s after every attempt, failed ones included.

Threads (`line_types.ts:14535`) are stored as messages with a `thread_id`. `SquareChat.listen()` is never used, since it drops initial pages (`client/features/square/mod.ts:213-226`).

## Backfill

Each chat has a backfill cursor. Talk chats page with `getPreviousMessagesV2WithRequest` (`base/service/talk/mod.ts:1648`), which returns `endMessageId` itself with the older messages, so only messages strictly before the cursor count and a page with nothing older completes the chat. Square chats and threads page backward as above. Talk chats are discovered from every page of `getMessageBoxes` unioned with `getAllChatMids`. Each page commits with its new cursor, and a stop reason is recorded per chat.

## Retained envelopes

Every message row keeps a lossless envelope (`contentMetadata`, `chunks` as base64, `contentType`), because encrypted media download needs the original `chunks` (`base/obs/mod.ts:459-468`). `decrypt_state` is `ok`, `missing_key` or `invalid`, as described under E2EE key boundaries. `missing_key` rows are tried again when new key generations arrive, and a retry never brings back unsent content.

## Tombstones and changes

An unsend clears the message text, its search entry and any plaintext in the retained envelope (text, location, non-E2EE `contentMetadata` values). Only tombstone metadata remains: IDs, sender, times and content type. A tombstone beats any later history or decryption result for the same message, and a newer `edited_at` beats older content.

Every insert or change takes a fresh `seq` from one counter. Reading changes after a `seq` returns rows in `seq` order, and a row changed during paging appears again with its new `seq`: at least once, with no gaps.

## Search

Queries of three or more characters use the FTS5 `trigram` index, which handles Chinese text. Shorter queries cannot match a trigram index, so they scan with `instr`, limited to one chat or to the most recent messages.

## Out of scope

LINE calls, LINE Pay and shopping, account settings changes, joining or leaving groups, contact management, multiple accounts, hosts other than one macOS user account, embeddings, OCR and speech, and MCP resources or prompts beyond the framework defaults.
