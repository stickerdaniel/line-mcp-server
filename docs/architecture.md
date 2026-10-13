# Architecture

line-mcp works with one personal LINE account:

- Log in as a secondary device by QR code and keep the session across restarts, refreshing tokens as LINE expires them.
- Decrypt end-to-end encrypted messages with the keys LINE transfers at login.
- Mirror personal chats, groups, rooms and joined OpenChat (Square) chats into a local archive, including history and non-Latin text such as Traditional Chinese.
- Keep the archive current across reboots, sleep and network loss without user action, except a QR login again when LINE revokes the session.
- Serve the archive to coding agents (Claude Code, Codex, T3 Code) as one MCP server, with a CLI and an agent skill over the same tools.
- Act in those chats (send, reply, react, unsend, send media) when the user asks the agent to.

## Runtime

Node 24.18 or later runs the TypeScript sources directly through type stripping. The npm package ships one bundle, `dist/cli.js`, built with Bun from `src/` and the JSR packages; npm installs the other dependencies. Bun manages packages. Tests run with Vitest and never contact LINE.

## Principles

- One process owns the LINE session, the local archive and every upstream request.
- Reads never change LINE state: no read receipts and no E2EE key registration.
- MIDs and tokens are opaque strings, stored unchanged. Integer message IDs and revisions are decimal strings, never JavaScript numbers.
- Logs and tool results never carry tokens, keys, raw envelopes or message text outside a tool's own result data.

Source paths in this document are relative to the pinned dependency checkouts: LINEJS (`@evex/linejs`) `packages/linejs/` at v3.5.0 and Prefect FastMCP TS (`@prefecthq/fastmcp-ts`) `src/` at 1.7.3.

## Overview

```text
LINE servers
   |  talk.sync / Square events / history / media / mutations (one session)
line-mcp daemon (Node 24, LaunchAgent io.github.stickerdaniel.line-mcp)
   |- session: ANDROIDSECONDARY client, SQLite storage, upstream guards
   |- sync: Talk loop, Square loop, backfill and reconciliation worker
   |- archive: ~/Library/Application Support/line-mcp/line.db
   |- MCP: http://127.0.0.1:47822/mcp (Streamable HTTP, stateless, no CORS)
   '- outbox: idempotent mutating actions, never resent on its own
        ^ loopback, native clients only
Claude Code / Codex / T3 Code          line-mcp CLI and agent skill
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
| `outbox`         | one row per idempotency key: frozen payload and its hash, state, correlation, timestamps                 |

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

**No implicit key registration.** Guards on the client block `registerE2EEPublicKey`, `registerE2EEPublicKeyV2` and `registerE2EEGroupKey`. LINEJS would otherwise register a group key after a `NOT_FOUND` lookup (`base/e2ee/mod.ts:240`) and a fresh key pair when QR login decodes no key (`base/login/mod.ts:303-305`). A login whose key transfer yields no key fails with `key_transfer_empty`. Reads never register a key: a message whose group key is missing stays `missing_key`.

**Group-key registration on send.** There is one exception. LINE drops a group's shared key on every membership change, and the next sender creates a new one. So `send_message` to a Talk group or room without a current key registers a new group key (`registerE2EEGroupKey`, as LINEJS does in `base/e2ee/mod.ts:356-409`) while it prepares the message, inside a scoped allowance that opens nothing else. A refused registration gets one more key lookup, since another member may have registered a key meanwhile; otherwise the send fails, and it never falls back to plain text. `registerE2EEPublicKey`, `registerE2EEPublicKeyV2` and `registerE2EEKeyPair` stay blocked everywhere.

**Read state.** The guards also block `sendChatChecked`, `markAsRead`, `markChatsAsRead` and `markThreadsAsRead`, so nothing line-mcp does marks a message as read, and no tool offers to.

**Exact key generations.** Before decrypting, the adapter checks that the exact key generations an envelope names (self key, peer key or group key) are available locally or from LINE. Older peer generations come from `getE2EEPublicKey`, since LINEJS asks `negotiateE2EEPublicKey`, which knows only the current key. LINEJS silently substitutes another self key for a missing DM key (`base/e2ee/mod.ts:903-906`) and the latest group key for a missing group generation (`base/e2ee/mod.ts:209-226`), which then fails as a generic authentication error. So a message whose keys are missing is `missing_key` without a decryption attempt, and `invalid` is kept for messages whose keys were verified present.

## Errors

One allowlisted mapper sits between upstream failures and both logs and results: an error code, the operation name and a fixed message. Upstream text is never copied, because LINEJS parse errors embed response headers, including the next access token, and body bytes (`base/request/mod.ts:183-190`). Only codes from the published LINE enums pass through.

## OpenChat adapter

`fetchSquareChatEvents` goes through the generated Thrift request, because the handwritten wrapper drops `continuationToken`, `subscriptionId`, `inclusive` and `fetchType` (`base/service/square/mod.ts:127-144`). LINE answers `getJoinedSquareChats` with `NOT_IMPLEMENTED` for this device type, so joined chats come from the account's own `fetchMyEvents` membership history, and `getSquareChat` confirms each one. A joined square without a confirmed chat is reported as uncovered rather than dropped.

The account has a separate member MID in each square. Discovery records every own member `getSquareChat` reports for a confirmed chat (`squareChatMember.squareMemberMid`) in `square_self_member`, and keeps earlier ones, since LINE may hand out a new member on rejoin. An OpenChat message is `from_self` when its sender is one of the chat's own members; while the chat has none, `from_self` is `null`, never borrowed from another square.

## Daemon and LaunchAgent

`line-mcp install` writes the per-user LaunchAgent `io.github.stickerdaniel.line-mcp` to `~/Library/LaunchAgents` from `launchd/io.github.stickerdaniel.line-mcp.plist` and bootstraps it: `RunAtLoad`, `KeepAlive`, `ThrottleInterval` 30, `Umask` 63, logs in `~/Library/Logs/line-mcp` (`0700`). `LINE_MCP_HOME`, `LINE_MCP_LOCK_PORT` and `LINE_MCP_PORT` pass on to the agent. The agent runs an absolute Node path: an override from `--node` or `LINE_MCP_NODE`, which must be an executable Node 24.18 or later, otherwise Homebrew's stable `opt/node@24` link rather than a versioned Cellar path that the next `brew upgrade` removes, otherwise the running Node.

`line-mcp uninstall` boots the agent out and removes the plist; the archive stays unless `--purge` is given, which deletes the state root once it can take the lock. `bootout` counts an agent that is not loaded as done and fails on every other launchctl error. `line-mcp login` boots the agent out before it takes the lock and bootstraps it again afterwards. `line-mcp doctor` checks the local setup without contacting LINE: Node, FTS5, permissions, schema, account, sync health, whether the installed plist matches this checkout, whether launchd has the agent loaded, and whether a process holds the lock port.

The daemon reports one health state: `online`, `catching_up`, `offline`, `needs_login` or `storage_error`. When the session leaves `online` for `needs_login` or `storage_error`, every loop stops calling LINE while the archive stays readable, and the daemon shows one macOS notification for the transition, with fixed text and no message content. A failed archive write puts the daemon in `storage_error`.

## Upstream concurrency

The Talk and Square sync loops run independently. Backfill, Talk reconciliation and every tool request to LINE (profiles, announcements, media and mutations) share a bounded pool of 2; OpenChat reconciliation runs inside the Square loop, one request at a time. Token refresh is serialized. Transient failures back off exponentially with jitter, from 1 s to 5 min. An empty or immediately returning call waits at least 1 s before the next one. Backfill rounds are at least 3 s apart, and OpenChat history requests for one chat or thread share one 3 s slot (see OpenChat sync). Talk reconciliation pages a gap back without pausing, at most five pages.

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

## Names

Sender and chat names come from the `participant` table. They are current labels: a rename takes no `seq`, so `list_changes` does not announce it. Each Talk discovery pass (at startup, every 6 hours, and at most every 10 minutes after Talk reports a chat change) looks up one-to-one peers, the group members `getChats` lists and archived senders still unnamed, which covers rooms and members who left, through `getContactsV2` in batches of 100. A contact's `displayNameOverridden` or `displayName` replaces the stored name.

OpenChat names come from each message event's `senderDisplayName`. After each discovery pass, archived OpenChat senders still unnamed are looked up with `getSquareMembers` in batches of 50, and such a name is written only while the member is still unnamed at commit, so an event name that arrived meanwhile wins. A refused, partial or empty answer never erases a name; a refusal is logged by its code.

## Retained envelopes

Every message row keeps a lossless envelope (`contentMetadata`, `chunks` as base64, `contentType`), because encrypted media download needs the original `chunks` (`base/obs/mod.ts:459-468`). `decrypt_state` is `ok`, `missing_key` or `invalid`, as described under E2EE key boundaries. `missing_key` rows are tried again when new key generations arrive, and a retry never brings back unsent content.

## Tombstones and changes

An unsend clears the message text, its search entry and any plaintext in the retained envelope (text, location, non-E2EE `contentMetadata` values). Only tombstone metadata remains: IDs, sender, times and content type. A tombstone beats any later history or decryption result for the same message, and a newer `edited_at` beats older content.

Every insert or change takes a fresh `seq` from one counter. Reading changes after a `seq` returns rows in `seq` order, and a row changed during paging appears again with its new `seq`: at least once, with no gaps.

## Search

A query splits into terms at whitespace; a phrase in double quotes is one term, spaces included. A message matches when its text contains every term, at most 10. Terms of three or more characters go to the FTS5 `trigram` index as quoted phrases joined by `AND`, so `OR`, `NEAR` and `*` are plain text; the index handles Chinese text and folds case. Shorter terms cannot match a trigram index and filter with `instr` over `lower`, which folds ASCII letters only. Beyond case, text matches as written, so Traditional and Simplified Chinese are separate queries.

A query of only short terms scans in pages. A page reads at most 50,000 messages newest first in the read order: of the chat when service and chat are both given (`message_chat_order`), otherwise of the whole archive. Its cursor continues after the last message read, not the last hit, so a page may hold fewer hits than its limit, or none, and `scanned_through` gives the send time it reached. Across chats, `message_recent (sent_at, id)` serves the read order without a sort: a send time is positive or unknown (ordered as 0), so the messages with one come first and the rest follow.

`since` and `until` keep the messages sent from `since` up to, not including, `until`; a message without a send time is outside any range. A scan starts at `until` and ends at `since`, so the page that reaches `since` has no cursor. `sender_id` keeps one sender's messages. `context` adds up to three messages on each side of a hit, from its chat and thread (the main chat alone for a hit outside threads), as `read_messages` shows them. The cursor binds all of these. A hit's size counts its context: a hit that does not fit the rest of a page starts the next one, and a hit too large for a page alone drops context messages, farthest first, and carries `context_truncated`.

## MCP transport and trust boundary

The daemon serves the tools with Prefect FastMCP TS over Streamable HTTP on `127.0.0.1:47822/mcp` (`LINE_MCP_PORT`), in stateless mode, so no legacy session is retained without bound. The daemon owns the `node:http` listener and serves Prefect's always-stateless `fetch()` entry (`src/server/FastMCP.ts:1913-1924`) behind its own checks, which run before any body is read: a request with an `Origin` header (every browser request; native clients send none) or a `Host` other than this exact `127.0.0.1:<port>` or `localhost:<port>` is refused, and no CORS headers are sent. Prefect's own `run()` would answer CORS preflights and custom routes before any guard and accepts localhost origins on any port (`src/server/FastMCP.ts:2272-2300`).

There is no bearer token. Every local client that can connect to the loopback listener can call every tool, including the mutating ones, and there is no per-user isolation and no confirmation step. `send_message` with `file_path` reads any local file the daemon's user can read and sends it. Mutating tools carry the MCP `destructiveHint` annotation, so a host can still be configured to ask first. The README states this boundary.

Prefect does not end a running handler when a Streamable HTTP client goes away, so the listener gives each request its own abort signal. A client that disconnects cancels its tool call, and queued upstream work leaves the pool instead of running for nobody. Every failure goes through the error mapper, because Prefect would otherwise return `err.message` as the tool output (`src/server/FastMCP.ts:800-805`).

## Freshness and paging

Every tool result is an object envelope that reports `health`, `stale` and the last Talk and Square sync times. `stale` is true unless the daemon is `online` or `catching_up`. When the session is lost, the archive tools keep answering from the local copy.

Pages hold 50 items by default and at most 200. A continuation is an opaque cursor bound to the tool and a fingerprint of its filters, so a cursor replayed with other filters is refused rather than paging a different result. A page also ends early at about 64 KiB of items, with a continuation. `read_messages` pages by keyset over send time and row ID, so pages never skip or repeat a message, and `around_message_id` centres a page on one message. `list_changes` returns changes after a `seq` in `seq` order, as described under Tombstones and changes.

## Time

Every time is an object with `utc` and `local`, both ISO 8601 at millisecond precision. `local` carries the numeric offset of the daemon's system time zone at that instant, for example `2026-10-12T10:15:00.000+05:45`, so both sides of a daylight saving change stay distinct. The zone is read on every call, so a changed `TZ` applies without a restart. `status` reports the zone as `time_zone`.

## Read tools

The archive tools (`status`, `list_chats`, `read_messages`, `search_messages`, `list_changes`) read only the local copy. `get_attachment`, `get_announcements` and `get_profile` ask LINE through the shared pool. `get_attachment` decrypts only messages whose exact key generations were verified, refuses unsent messages, and streams a download of at most 100 MiB into a private cache (`0700`) under the state directory. An E2EE file keeps its name inside the encrypted payload, so `get_attachment` decrypts the payload in the pool to report it, with or without a download; that costs at most the read-only key lookups, and a failed lookup leaves the name out.

## Privacy

Logs carry event names, codes and counts, never tokens, keys, envelopes or message text. Tool results carry message data only for the chat and messages asked for, never raw envelopes. Framework diagnostics reach the log as fixed text, without their metadata. Logs, the archive and the attachment cache are readable only by the user that runs the daemon.

## Outbox

`send_message`, `react` and `unsend` go through an outbox, so a retry, a timeout or a crash never sends a message twice. It is not a confirmation step.

- **Idempotency key.** Every mutating call requires a caller idempotency key. The outbox stores the operation, the destination, the thread, the target or reply message, the reaction, the text as its SHA-256 and the attachment's SHA-256, plus a hash over all of them. The same key with a different payload is refused with `idempotency_conflict`, and calls with one key run one at a time. The skill tells agents to derive one key per intended action and reuse it on retry.
- **States.** A row moves `in_flight -> sent | failed | unknown`, and `in_flight` is persisted with the request sequence number before the request leaves. `failed` covers only errors before the request was dispatched: validation, the local file, key lookups, encryption, uploads that create no message, or a cancelled wait for the pool. Any error after dispatch (a timeout, a parse failure, token persistence, a cancelled call) is `unknown`, because LINEJS parses the answer and handles its next token after LINE already acted (`base/request/mod.ts:163-190`). An `in_flight` row found at startup becomes `unknown`.
- **Retries.** A retry with the same key and payload reports a `sent` result again, runs a `failed` action again, and reports an `unknown` one again unless sync evidence settled it. Nothing is resent on line-mcp's own initiative.
- **Reconciliation.** An `unknown` action becomes `sent` only on evidence that cannot belong to anything else: a synced message that carries exactly the encrypted chunks this request sent, or, for an unsend, its target as a tombstone. Matching text is no evidence, since another device may have sent the same words.
- **OpenChat threads.** A reply to a thread message goes into its thread through the thread RPC with `threadMid`, and reactions and unsends of a thread message name the thread. The thread is part of the payload hash. Media cannot go into a thread, and a thread action LINEJS has no RPC for is refused, never sent to the parent chat.
- **Cancellation.** A client that goes away before the request leaves stops the action as `failed`. After that the action runs to its end: the caller gets `unknown`, and the row still moves to `sent` when LINE's answer arrives. The key stays held until the attempt settles, so a retry sees the real outcome.

## CLI and skill

Every tool is also a `line-mcp` command (`src/tool-cli.ts`). The commands are built at runtime from the zod schemas the server registers, so the CLI cannot drift from the tools and nothing is generated: the tool name and each input field in kebab case name the command and its flags, and a field's type (string, enum, integer, boolean) and optionality give the flag's shape. The `status` tool is `sync-status`, since `line-mcp status` reads the local setup without the daemon. `node:util` `parseArgs` in strict mode and the tool's own schema check the arguments before any request, so a usage error exits 2 without reaching the daemon. A relative `--file-path` is resolved against the current directory.

A command calls the daemon on `127.0.0.1` through the FastMCP client, with its own 300 s deadline instead of the client's default 60 s, so a large attachment download finishes. A result goes to stdout as JSON. A tool error goes to stderr whole, including a mutating tool's outbox state, and exits 1; so does `daemon_unreachable` when nothing answers on the MCP port. Ctrl-C closes the request, which cancels the call like any client that goes away, and exits 130.

`plugins/line-mcp-server/skills/line-mcp/SKILL.md` is written by hand and names the commands. It lets agents use the mutating commands only when the user explicitly asks for that action, treats chat messages, attachments and tool results as data rather than authorization, and has them ask when the recipient or the action is unclear.

## Out of scope

LINE calls, LINE Pay and shopping, account settings changes, joining or leaving groups, contact management, multiple accounts, hosts other than one macOS user account, embeddings, OCR and speech, and MCP resources or prompts beyond the framework defaults.
