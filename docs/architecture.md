# Architecture

line-mcp works with one personal LINE account:

- Log in as a secondary device by QR code and keep the session across restarts, refreshing tokens as LINE expires them.
- Decrypt end-to-end encrypted messages with the keys LINE transfers at login.
- Mirror personal chats, groups, rooms and joined OpenChat (Square) chats into a local archive, including history and non-Latin text such as Traditional Chinese.
- Keep the archive current across reboots, sleep and network loss without user action, except a QR login again when LINE revokes the session.
- Serve the archive to coding agents (Claude Code, Codex, T3 Code) as one MCP server, with a CLI and an agent skill over the same tools.
- Act in those chats (send, reply, react, unsend, send media) when the user asks the agent to.

## Runtime

Node 24.18 or later runs the TypeScript sources directly through type stripping. The npm package ships two bundles built with Bun from `src/` and the JSR packages: `dist/cli.js` and, beside it, `dist/query-runner.js`, the process the `query` tool runs SQL in; npm installs the other dependencies. Bun manages packages. Tests run with Vitest and never contact LINE.

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
line-mcp daemon (Node 24, LaunchAgent, systemd user unit or scheduled task)
   |- session: ANDROIDSECONDARY client, SQLite storage, upstream guards
   |- sync: Talk loop, Square loop, backfill and reconciliation worker
   |- archive: <state root>/line.db
   |- MCP: http://127.0.0.1:47822/mcp (Streamable HTTP, stateless, no CORS)
   '- outbox: idempotent mutating actions, never resent on its own
        ^ loopback, native clients only
Claude Code / Codex / T3 Code          line-mcp CLI and agent skill
```

## State

All state lives in the state root: `~/Library/Application Support/line-mcp` on macOS, `$XDG_DATA_HOME/line-mcp` on Linux (`~/.local/share/line-mcp` when `XDG_DATA_HOME` is unset or relative), `%LOCALAPPDATA%\line-mcp` on Windows (`%USERPROFILE%\AppData\Local\line-mcp` when `LOCALAPPDATA` is not a full path). `LINE_MCP_HOME` overrides it; `install` refuses a relative one, since the service runs in another directory. It holds one SQLite database, `line.db`, in WAL mode with `synchronous = FULL`. On macOS and Linux the directory is `0700` and the database files are `0600`; Windows uses access lists instead (Private state on Windows).

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
| `read_state`     | the account's read position per chat, and LINE's unread count with the position it was reported for      |

## Private state on Windows

Windows has no mode bits, so line-mcp checks owners and access lists (`src/acl.ts`, `src/privacy.ts`). It refuses state that is not private and never repairs it.

**Confinement.** The state root must lie inside `%USERPROFILE%`. Walking up from the root, the first existing entry whose real path is the profile's is the anchor; real paths make short names, case and `\\?\` forms compare equal. No existing entry below the anchor may be a link or junction, so containment by text is containment on disk. Otherwise the command fails with `insecure_directory`.

**The check.** One Windows PowerShell call (no profile, no inherited module path, 30 s timeout) reads the owner and access list of the anchor, each entry down to the root and the files it guards. An object is private when its owner is the user, SYSTEM or Administrators, it has an access list, every entry allows or denies, and allow entries name only the user, SYSTEM, Administrators or CREATOR OWNER; inherit-only entries count. A reparse point fails. A timeout, a failed PowerShell, Constrained Language Mode or any unexpected answer fails closed.

**When it runs.** Before every SQLite open (daemon, login, probe, `status`, `doctor`), on the chain and on `line.db` with its `-wal`, `-shm` and `-journal` files. On the attachment cache before its first use in a process, and on each file `get_attachment` returns, cached or just downloaded. Writers (daemon, login, probe) create a missing part of the chain top down with a protected access list for the user, SYSTEM and Administrators (`icacls /inheritance:r /grant:r`), then check the new directories; readers create nothing. SQLite keeps temporary storage in memory (`temp_store = MEMORY`) so nothing lands outside the root. `doctor` checks the chain even before the first login, whose refusal points to it, and names each object that is not private with its fix: `icacls /setowner` for a foreign owner, `icacls /remove:g` for an explicit entry, and for an inherited one protecting the parent, then `icacls /reset`. The fixes are printed for PowerShell, with every argument but a switch in single quotes.

**Above the anchor.** `C:\Users` and the drive root stay unchecked. line-mcp relies on the Windows default that a standard user cannot rename or replace another user's profile. CI checks that the default chain passes for an administrator and for a standard user.

**The profile's traverse entry.** Windows Server 2025 (build 26100) gives every profile directory one more allow entry: `0x100020` (`FILE_TRAVERSE | SYNCHRONIZE`), without inheritance, for the capability SID of the Win32 app isolation capability `isolatedWin32-userProfileMinimal` (`C:\Users` has a similar one for `isolatedWin32-profilesRootMinimal`). The anchor alone accepts such an entry: a capability SID (`S-1-15-3-`), no inheritance flag and no right beyond `0x100020`. Traverse lets a holder pass to a child only when that child's own access list allows it; it grants no listing, reading, writing, deleting, renaming, or change of owner or access list. Every entry below the anchor is checked strictly, and a root that is the profile itself gets no exception.

**The scheduled task's files.** The task (Daemon and service) keeps its launcher and XML in `%LOCALAPPDATA%\line-mcp\service` and its log in `%LOCALAPPDATA%\line-mcp\logs`, whatever `LINE_MCP_HOME` says. `install` creates and checks both directories like a writer, and checks the launcher, XML and log already there, before it stops, writes, opens, registers or runs anything; it checks each file again after writing it, and when that check fails, the task stays disabled; `doctor` reads the launcher and `uninstall` removes a file only after checking it. `doctor` checks both directories and the files in them. `uninstall --purge` checks the state root right before deleting it, so a root that is not private (a link, say) stays.

## Process and lock ownership

One process at a time may talk to LINE for the account. Ownership is an exclusive bind of a fixed loopback lock port, `127.0.0.1:47821` (`LINE_MCP_LOCK_PORT`), with `exclusive: true` and `reusePort: false`. The kernel frees the port when the process dies, so there is no lock file, no stale lock and no PID reuse case. Any bind failure, including an unrelated process on the port, fails closed before LINE work starts; there is no fallback port. Commands that take the lock close the listener, destroy any connection still open and await the close on success and on error.

**Stop request.** A daemon that the Windows scheduled task started (its launcher sets `LINE_MCP_SERVICE=task`) also stops on a request over the lock port, since a scheduled task gets no signal. A connection whose bytes from the first are exactly `line-mcp stop\n` stops it like SIGTERM. The daemon reads at most 64 bytes within 1 s of accepting; anything else, including a silent connection, is destroyed. `login`, `probe` and a daemon run by hand read nothing and destroy every connection at once, so they ignore the request (stopping the service never ends a daemon run by hand), and the stopper (`requestStop`) fails with `stop_timeout` once its deadline passes without the port coming free. It never kills anything, and only a refused connection counts as "nothing listens" or "stopped"; any other connection error fails with `lock_failed`. There is no token: whoever can connect here can also reach the unauthenticated MCP port, which already sends messages (MCP transport and trust boundary), and a browser cannot open a connection with that first line.

A session opens in a fixed order: take the lock, open and migrate the database, check the device and account binding, install the upstream guards, register the token handler, then restore the session. A stop during startup (a signal or the stop request) closes the guards, closes the database and releases the lock in that order, without waiting for a pending upstream call such as the profile check; its late answer meets closed guards and writes nothing. The daemon then exits 0.

## Session and login

The client logs in as `ANDROIDSECONDARY` through the V3 secure QR path (`base/core/utils/devices.ts:18`). `IOS` or `ANDROID` would move the account off the phone, and desktop device types could compete with a desktop LINE app.

**Token persistence.** `SqliteStorage` implements LINEJS's `BaseStorage` with synchronous `node:sqlite` writes. LINEJS emits a new access token from a response header without assigning it and without awaiting the handler (`base/request/mod.ts:170-173`), so the handler writes it synchronously and sets it on the client. A failed write puts the session in `storage_error`, which blocks every further upstream request.

**Token refresh.** One refresh runs at a time and later callers await it. LINEJS's own refresh lets concurrent callers spend the same refresh token and writes the access token, rotated refresh token and expiry separately (`base/service/auth/mod.ts:21-37`); here the three commit in one transaction before the new access token is used.

**Auth loss.** Terminal auth errors (a refused refresh, `NOT_AUTHORIZED_DEVICE`, a revoked token, or a Square `AUTHENTICATION_FAILURE` after one refresh and retry) are read from the thrown error data, since LINEJS throws before its own `end` event (`base/request/mod.ts:244-262`). The session then enters `needs_login`, stops every upstream request and keeps the local data readable.

**Login handoff.** `line-mcp login` takes the lock, copies the live `line_kv` into staging storage and runs the QR login there. LINEJS writes transferred keys before it learns the account MID (`base/login/mod.ts:288-307`, :117-122), so nothing reaches the live store until the MID matches the bound account, or binds it on the first login. One transaction then replaces the token and certificate rows and adds any new key generations. Existing key generations and contact or group key caches are never deleted or overwritten. A wrong account is refused, and a login killed or cancelled midway leaves the live store unchanged.

## E2EE key boundaries

**No implicit key registration.** Guards on the client block `registerE2EEPublicKey`, `registerE2EEPublicKeyV2` and `registerE2EEGroupKey`. LINEJS would otherwise register a group key after a `NOT_FOUND` lookup (`base/e2ee/mod.ts:240`) and a fresh key pair when QR login decodes no key (`base/login/mod.ts:303-305`). A login whose key transfer yields no key fails with `key_transfer_empty`. Reads never register a key: a message whose group key is missing stays `missing_key`.

**Group-key registration on send.** There is one exception. LINE drops a group's shared key on every membership change, and the next sender creates a new one. So `send_message` to a Talk group or room without a current key registers a new group key (`registerE2EEGroupKey`, as LINEJS does in `base/e2ee/mod.ts:356-409`) while it prepares the message, inside a scoped allowance that opens nothing else. A refused registration gets one more key lookup, since another member may have registered a key meanwhile; otherwise the send fails, and it never falls back to plain text. `registerE2EEPublicKey`, `registerE2EEPublicKeyV2` and `registerE2EEKeyPair` stay blocked everywhere.

**Read receipts.** The guards also block `sendChatChecked`, `markAsRead`, `markChatsAsRead` and `markThreadsAsRead`, so nothing line-mcp does marks a message as read, and no tool offers to.

**Exact key generations.** Before decrypting, the adapter checks that the exact key generations an envelope names (self key, peer key or group key) are available locally or from LINE. Older peer generations come from `getE2EEPublicKey`, since LINEJS asks `negotiateE2EEPublicKey`, which knows only the current key. LINEJS silently substitutes another self key for a missing DM key (`base/e2ee/mod.ts:903-906`) and the latest group key for a missing group generation (`base/e2ee/mod.ts:209-226`), which then fails as a generic authentication error. So a message whose keys are missing is `missing_key` without a decryption attempt, and `invalid` is kept for messages whose keys were verified present.

## Errors

One allowlisted mapper sits between upstream failures and both logs and results: an error code, the operation name and a fixed message. Upstream text is never copied, because LINEJS parse errors embed response headers, including the next access token, and body bytes (`base/request/mod.ts:183-190`). Only codes from the published LINE enums pass through.

## OpenChat adapter

`fetchSquareChatEvents` goes through the generated Thrift request, because the handwritten wrapper drops `continuationToken`, `subscriptionId`, `inclusive` and `fetchType` (`base/service/square/mod.ts:127-144`). LINE answers `getJoinedSquareChats` with `NOT_IMPLEMENTED` for this device type, so joined chats come from the account's own `fetchMyEvents` membership history, and `getSquareChat` confirms each one. A joined square without a confirmed chat is reported as uncovered rather than dropped.

The account has a separate member MID in each square. Discovery records every own member `getSquareChat` reports for a confirmed chat (`squareChatMember.squareMemberMid`) in `square_self_member`, and keeps earlier ones, since LINE may hand out a new member on rejoin. An OpenChat message is `from_self` when its sender is one of the chat's own members. While the chat has none, `from_self` is left out as unknown, never borrowed from another square. A message without a sender, in Talk too, has no `from_self` either.

## Daemon and service

`install`, `uninstall`, the login handoff and `doctor` reach the service manager only through the `Service` interface in `src/service/`, with one backend per OS: launchd on macOS, systemd on Linux, the Task Scheduler on Windows, and launchd elsewhere. The service runs an absolute Node path: an override from `--node` or `LINE_MCP_NODE`, which must be an executable Node 24.18 or later, otherwise Homebrew's stable `opt/node@24` link rather than a versioned Cellar path that the next `brew upgrade` removes, otherwise the running Node. `install` and `doctor` warn when the Node or the CLI lies in a versioned directory (Homebrew Cellar, nvm, nvm-windows, fnm, Volta, asdf, snap), and `install` refuses to run from the npx cache. A dry run writes no file and changes no service; it may still query the Node version. Every service manager call has a 15 s timeout, and a call that timed out counts as failed, never as stopped or absent. In tests, `LINE_MCP_SERVICE_RUNNER=<file>` runs every service tool call as `node <file> <tool> ...args` (`test/fixtures/service-runner.ts`) instead of the real tool; it never reaches the rendered definition.

**macOS.** `line-mcp install` writes the per-user LaunchAgent `io.github.stickerdaniel.line-mcp` to `~/Library/LaunchAgents` from `service/io.github.stickerdaniel.line-mcp.plist` and bootstraps it: `RunAtLoad`, `KeepAlive`, `ThrottleInterval` 30, `Umask` 63, logs in `~/Library/Logs/line-mcp` (`0700`). `LINE_MCP_HOME`, `LINE_MCP_LOCK_PORT` and `LINE_MCP_PORT` pass on to the agent when set. `uninstall` boots the agent out and removes the plist. `bootout` counts an agent that is not loaded as done. It returns while the daemon is still shutting down, so every bootout then waits up to 30 s (`stopTimeoutMs`) until `launchctl print` no longer finds the agent; a `bootstrap` or a login right away would fail. A bootout that failed or timed out may still take effect, so it waits the same way and fails only while the agent stays loaded. When `print` fails, the state is `service_state_unknown`; the login's stop then bootstraps the agent again, which puts it back or fails because it is still loaded.

**Linux.** `line-mcp install` writes the systemd user unit `line-mcp.service` to `$XDG_CONFIG_HOME/systemd/user` from `service/line-mcp.service`: `Type=exec`, `Restart=always`, `RestartSec=30s`, `UMask=0077`, output appended to `$XDG_STATE_HOME/line-mcp/daemon.log` (directory `0700`, file `0600`), `WantedBy=default.target`. XDG values count only when absolute. The unit always sets `LINE_MCP_HOME` to the resolved state root, so a user manager with other XDG values opens the same archive; the ports pass on when set.

- Escaping follows systemd 255's reading of each directive. `%` doubles everywhere. `$` doubles only in `ExecStart=` arguments; the executable path and `Environment=` take it literally. Quoted values escape `\` and `"`. A Node path with a double or single quote, backslash or control character (systemd's `string_is_safe`), or a line break in any value, fails with `unsupported_path` before anything is written.
- `install` queries the unit first: a missing `systemctl` is `systemd_unavailable`, an unreachable user manager `systemd_unreachable`, both before any write. It then stops an existing unit, writes the files, runs `daemon-reload` and checks that the manager loads the unit from the written path; otherwise it removes the written unit and fails with `unit_not_found`. Then it runs `enable` and `start`. Rerunning it converges; it is not transactional.
- `uninstall` runs `stop` and `disable`, removes the unit and runs `daemon-reload`.
- A unit is absent only when a successful query reports `LoadState=not-found` with nothing running. When a mutating call fails or times out, the unit's state decides: if it reached the target state the step counts as done; otherwise it fails with its remedy, and if the query fails too, with `service_state_unknown`. A failed `stop` may leave its job queued or running, so a unit that ran is started again before the stop's failure is reported; if that start fails too, the failure is `service_state_unknown`.
- The daemon shows notifications through `notify-send` with a 3 s timeout, and none without it, a session bus or a notification server. The unit carries no display variables.
- Without lingering, the user manager stops at logout and the daemon with it. line-mcp never enables lingering; `doctor` reports it.

**Windows.** `line-mcp install` registers the scheduled task `line-mcp-<user SID>` from `service/line-mcp.xml` with `schtasks /Create /XML`, the XML in UTF-16LE with a byte order mark: a logon trigger and a trigger repeating every minute, both for the user; `InteractiveToken` with least privilege, so it runs only while the user is logged on and stores no password; `IgnoreNew`, so an instance never runs twice; no time limit; runs on battery. Its action is `wscript.exe //B //Nologo //E:JScript "<launcher>"`, the launcher rendered from `service/line-mcp.js` to `%LOCALAPPDATA%\line-mcp\service\line-mcp.js` beside the XML (Private state on Windows). The launcher sets `LINE_MCP_SERVICE=task`, `LINE_MCP_HOME` to the resolved state root and the ports when set, and runs `cmd.exe /d /v:off /s /c ""<node>" "<cli>" daemon >> "<log>" 2>&1"` without a window, appending to `%LOCALAPPDATA%\line-mcp\logs\daemon.log`. Its string literals carry every non-ASCII character as `\uXXXX`. cmd.exe and Windows Script Host expand `%` and a `"` ends a path, so a Node, CLI, log or environment value with a `"`, a `%` or a control character fails with `unsupported_path` before anything is written. The minute trigger starts a daemon that exited again; Task Scheduler's restart on failure does not restart a task that exited with an error. Logging off ends the task's processes without a shutdown: that is the crash path (SQLite recovers the WAL), and the next logon starts the task.

- `service/task-state.js`, run in place with `cscript`, reads the task through `Schedule.Service` and prints one JSON line: whether it exists, its state (1 disabled, 3 ready, 4 running), whether it is enabled, its running instances, its last result and its first action. Anything but one well-formed line, a COM error or a timeout fails with `task_scheduler_failed`, whatever cscript's exit code. The task is absent only when that line says so, which only `0x80070002` (not found) gives.
- The task is always registered disabled. Whatever enables or runs it (`start()`, a restore, a rollback) checks the launcher, the XML and the log first, so a failed check leaves it disabled. `start()` then checks the lock port (`lock_held` with nothing changed when another process holds it), enables and runs the task, then waits up to 15 s for a running instance whose daemon holds the lock port; otherwise it fails with `start_failed` and the task's last result.
- `stop()` records whether the task was enabled and running, disables it so no trigger starts it again, and polls every 250 ms, for up to 45 s, until the task reports state 1 with no instance. While an instance runs and the lock port is held, it sends the stop request at most once a second; with no instance a held port belongs to someone else and is left alone. It never runs `schtasks /End`, which would end the daemon mid-write. Every failure after the disable rolls back: the task is enabled again if it was, and started again if it ran and its daemon is gone. A rollback that fails too is `service_state_unknown`.
- When a `schtasks` call fails or times out, the task's state decides, as on Linux.
- The daemon shows notifications as a toast through Windows PowerShell 5.1 under its app ID, with a 10 s timeout, and none without a desktop. The text reaches the encoded script in an environment variable.
- `install` checks the service and log directories and the files already in them, stops a running task, writes the launcher and the XML, creates the log, checks the three files, registers the task and starts it. A failed step after the stop puts the task back as it was, except a failed check of the files: then the task stays disabled until `doctor`'s fix and another `install`. `uninstall` stops the task, deletes it and removes the launcher and the XML; the log stays. Rerunning either converges; neither is transactional, and a failure names the step, the state it left and the command to run again.

**Login handoff.** `line-mcp login` stops an installed service before it takes the lock. `stop()` either leaves the service stopped or fails having changed nothing, and resolves to a `restore` that returns the service to its prior state once the login has released the lock: launchd bootstraps the agent again whenever the plist is there; systemd starts the unit again only if it was `active`, `activating` or `reloading`, and never changes whether it is enabled; the scheduled task follows this table:

| Before the stop   | Restore                                               |
| ----------------- | ----------------------------------------------------- |
| absent            | nothing                                               |
| enabled, running  | `start()`                                             |
| enabled, idle     | `schtasks /Change /Enable` only; a trigger starts it  |
| disabled, running | nothing, with a warning that names `line-mcp install` |
| disabled, idle    | nothing                                               |

A failed stop ends the login before it starts. A failed restore exits 1 with `service_restore_failed` after the login's own result and names `line-mcp install`.

**Login cancellation.** From before the stop until the restore has finished, SIGINT (Ctrl-C, which Node also raises on Windows) and SIGTERM cancel the login instead of ending the process. The login client refuses further upstream calls at once, the commit transaction checks the cancel, so the live store stays unchanged, and the stores close and the lock is released without waiting for a pending call. A stop in progress finishes, or rolls back on its own failure, and the login is skipped; a restore in progress finishes too. Service tools run in a session of their own on POSIX, and with a hidden console of their own on Windows, so a Ctrl-C in the terminal does not reach them, and a tool that times out is killed with its process group. Once the service is back, `login` exits 130 with `login_cancelled`, and a further signal changes nothing. Its message is "The login was cancelled" when the signal came during the stop or the login, followed by the failure of a stop that rolled back. A signal during the restore cancels nothing, so the message keeps the login's own result: "Interrupted after the login finished", or the login's failure with its code. A stop that leaves the state unknown still exits 1 with `service_state_unknown`, and a failed restore exits 1 with `service_restore_failed`, naming the cancel or the login's own failure.

`uninstall` keeps the archive unless `--purge` is given, which deletes the state root once it can take the lock; on Windows only after checking it, retrying files that antivirus or indexing still holds a moment. `line-mcp doctor` checks the local setup without contacting LINE: Node, the Node and CLI paths, FTS5, permissions (on Windows, privacy, also before the archive exists; a failure skips the archive checks), schema, account, sync health, whether the installed definition matches this installation, the service manager's view (launchd: loaded; systemd: loaded from the written unit, active, lingering, log permissions; Task Scheduler: registered, enabled, running this launcher, running, and the service and log directories private), and whether a process holds the lock port.

The daemon reports one health state: `online`, `catching_up`, `offline`, `needs_login` or `storage_error`. When the session leaves `online` for `needs_login` or `storage_error`, every loop stops calling LINE while the archive stays readable, and the daemon shows one desktop notification for the transition, with fixed text and no message content. A failed archive write puts the daemon in `storage_error`.

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

Sender and chat names come from the `participant` table. They are current labels: a rename takes no `seq`, so reading changes by `seq` does not see it. Each Talk discovery pass (at startup, every 6 hours, and at most every 10 minutes after Talk reports a chat change) looks up one-to-one peers, the group members `getChats` lists and archived senders still unnamed, which covers rooms and members who left, through `getContactsV2` in batches of 100. A contact's `displayNameOverridden` or `displayName` replaces the stored name.

OpenChat names come from each message event's `senderDisplayName`. After each discovery pass, archived OpenChat senders still unnamed are looked up with `getSquareMembers` in batches of 50, and such a name is written only while the member is still unnamed at commit, so an event name that arrived meanwhile wins. A refused, partial or empty answer never erases a name; a refusal is logged by its code.

## Retained envelopes

Every message row keeps a lossless envelope (`contentMetadata`, `chunks` as base64, `contentType`), because encrypted media download needs the original `chunks` (`base/obs/mod.ts:459-468`). `decrypt_state` is `ok`, `missing_key` or `invalid`, as described under E2EE key boundaries. `missing_key` rows are tried again when new key generations arrive, and a retry never brings back unsent content.

## Tombstones and changes

An unsend clears the message text, its search entry, the fields of a non-text message and any plaintext in the retained envelope (text, location, non-E2EE `contentMetadata` values). Only tombstone metadata remains: IDs, sender, times and content type. A tombstone beats any later history or decryption result for the same message, and a newer `edited_at` beats older content.

Every insert or change of a message (new, edited, unsent, decrypted later) takes a fresh `seq` from one counter inside its transaction, so a changed row moves above every `seq` taken before. `message.seq` is a change feed of latest states: a reader that keeps the highest `seq` it saw and later reads the rows above it gets every message changed since, once, in its current state. Names and read positions take no `seq`.

## Search

`message_fts` is an FTS5 `trigram` index over message text, which triggers on `message` keep current, with `message_fts.rowid` = `message.id`. A query finds a term of three or more characters with `message_fts MATCH` and the term in double quotes, so `OR`, `NEAR` and `*` stay plain text; the index handles Chinese text and folds case. A trigram index cannot match a shorter term, so such a term filters with `instr(text, ...)`, which matches as written; `lower` on both sides folds ASCII letters only. Beyond case, text matches as written, so Traditional and Simplified Chinese are separate queries. An unsend removes the text from the index; FTS5 keeps trigrams of it in its shadow tables, which agent SQL never reads (SQL query tool).

## MCP transport and trust boundary

The daemon serves the tools with Prefect FastMCP TS over Streamable HTTP on `127.0.0.1:47822/mcp` (`LINE_MCP_PORT`), in stateless mode, so no legacy session is retained without bound. The daemon owns the `node:http` listener and serves Prefect's always-stateless `fetch()` entry (`src/server/FastMCP.ts:1913-1924`) behind its own checks, which run before any body is read: a request with an `Origin` header (every browser request; native clients send none) or a `Host` other than this exact `127.0.0.1:<port>` or `localhost:<port>` is refused, and no CORS headers are sent. Prefect's own `run()` would answer CORS preflights and custom routes before any guard and accepts localhost origins on any port (`src/server/FastMCP.ts:2272-2300`).

There is no bearer token. Every local client that can connect to the loopback listener can call every tool, including the mutating ones, and there is no per-user isolation and no confirmation step. `send_message` with `file_path` reads any local file the daemon's user can read and sends it. Mutating tools carry the MCP `destructiveHint` annotation, so a host can still be configured to ask first. The README states this boundary.

Prefect does not end a running handler when a Streamable HTTP client goes away, so the listener gives each request its own abort signal. A client that disconnects cancels its tool call, and queued upstream work leaves the pool instead of running for nobody. Every failure goes through the error mapper, because Prefect would otherwise return `err.message` as the tool output (`src/server/FastMCP.ts:800-805`).

## Freshness

Every tool result is an object envelope that reports `health`, `stale` and the last Talk and Square sync times; a service that never synced has no time. `stale` is true unless the daemon is `online` or `catching_up`. When the session is lost, `status` and `query` keep answering from the local copy.

`query` returns the rows its SQL selects, NULLs included, with integers beyond JavaScript's safe range as decimal strings. The message `get_attachment` shows leaves out a field without a value: `decrypt_state` appears only when not `ok`, `from_self` only when known and `mentions` only when there are some.

## Non-text messages

The archive stores LINE's content type names (`NONE` for text, `IMAGE`, `STICKER`, `CHATEVENT`, ...). A non-text message is described by columns of `message` derived from the plaintext `contentMetadata` of its envelope when the message is written, each NULL when LINE gave no valid value:

| Columns                                            | Content types            | Source                                                                                    |
| -------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| `alt_text`                                         | `FLEX`, `STICKER`        | `ALT_TEXT`, `STKTXT`                                                                      |
| `file_name`                                        | `FILE`                   | `FILE_NAME`, sent in plaintext only for files without E2EE; `get_attachment` has the rest |
| `duration_ms`                                      | `VIDEO`, `AUDIO`, `CALL` | `DURATION`, a non-negative integer in milliseconds                                        |
| `image_index`, `image_total`                       | `IMAGE`                  | `GSEQ` (1-based) and `GTOTAL` of an image sent with others                                |
| `call_type`, `call_result`                         | `CALL`                   | `TYPE` (`A` audio, `V` video) and `RESULT` in lower case                                  |
| `event`, `event_by`, `event_members`, `event_name` | `CHATEVENT`              | `LOC_KEY` and `LOC_ARGS`: args split at U+001E, MID lists in an arg at U+001F             |

`event` covers only the codes whose arguments LINE's own web client confirms: `C_MJ` joined, `C_ML` left, `C_GI` and `C_MI` invited, `C_IC` invitation_canceled, `C_MR` removed, `C_PN` renamed (with the new `event_name`), `C_PI` picture_changed, `C_SN` link_join_allowed and `C_SP` link_join_disabled. `event_by` holds a MID and `event_members` MIDs separated by `,`; a query joins `participant` for their display names, so the names follow renames. Any other code, an argument count the code does not take, or a malformed MID gives no `event`. A canceled call from someone else is a missed call, as LINE's web client shows it.

`query` reads these columns; `get_attachment` shows a media message's `file_name`, `duration_ms` and image set. Nothing else leaves the envelope: no chunks, URLs, `OID`, `SID`, `FLEX_JSON`, `MEDIA_CONTENT_INFO` or `REPLACE`. Every write of an envelope writes these columns from it, so no read parses an envelope to describe a message, and a text message's envelope is never parsed. An archive from before the columns derives them from its retained envelopes when it migrates. An unsent message has none of these fields. The fields follow the envelope, which every content change (edit, decryption, unsend) replaces; LINE resending only metadata for an unchanged message keeps the archived envelope, and with it the archived fields. Search covers message text only, not these fields.

## Time

The archive stores times as UTC milliseconds. Every time a tool shows, and `local_time(ms)` in a query, is one ISO 8601 string at millisecond precision with the numeric offset of the daemon's system time zone at that instant, for example `2026-10-12T10:15:00.000+05:45`. The offset makes it one exact instant, so both sides of a daylight saving change stay distinct, and `unixepoch()` reads it back as the same instant. The zone is read on every call, and the query runner starts again when `TZ` changed, so a changed `TZ` applies without a restart. `status` reports the zone as `time_zone`.

## Read tools

`status` and `query` read only the local copy. `get_attachment`, `get_announcements` and `get_profile` ask LINE through the shared pool. `get_attachment` decrypts only messages whose exact key generations were verified, refuses unsent messages, and streams a download of at most 100 MiB into a private cache (`0700`) under the state directory. An E2EE file keeps its name inside the encrypted payload, so `get_attachment` decrypts the payload in the pool to report it, with or without a download; that costs at most the read-only key lookups, and a failed lookup leaves the name out.

## SQL query tool

`query` runs one read-only SQL statement over the archive (`src/query/`). `src/query/surface.ts` declares the readable relations and columns, the notes on what they mean and the caps; the guard's allowlist and the tool description both come from it, so a column is readable exactly when the description lists it.

**Guard.** One read-only connection with SQLite limits (SQL 20,000 bytes, values 1 MiB) and an authorizer. It allows SELECT, recursive CTEs, built-in functions except `load_extension`, `local_time` (which is `renderTime`) and `PRAGMA data_version`. A listed column reads; an unlisted column of a listed table reads as NULL; any other table, the schema tables, `dbstat` and table-valued pragmas are denied, and so are writes, ATTACH, TEMP objects, transactions and other pragmas. FTS5's shadow tables keep trigrams of unsent text, so agent SQL never reads them. They are readable only while a statement steps, when the authorizer sees FTS5's own statements, and during a fixed zero-row warm-up before every agent statement, which reconnects `message_fts` after another connection changed the schema. A FROM item whose columns go unused (`count(*)`) may be a CTE, which SQLite names before it looks into it; it passes unless the name is a stored table or a virtual table module.

**Runner.** node:sqlite cannot interrupt a statement, so SQL runs in a separate process, started on the first query and kept. Its main thread owns the 5 s limit and kills its own process at the limit or when its IPC channel closes, so a runaway statement never outlives the daemon; a worker thread holds the guard. The daemon runs one query at a time with at most 4 waiting (`query_busy` beyond), checks privacy before every start, starts a new runner when `TZ` changed, and kills the runner when a caller goes away. `McpServer.close()` ends it.

**Results and logs.** A result has at most 64 columns, 200 rows and 64 KiB for the serialized `{ columns, rows, truncated }`; column names alone over 64 KiB fail. Values count as they are converted, so a wide row stops at the budget instead of being serialized whole. An error result stays under 4 KiB, SQLite's message cut to fit. That message can quote archive data, so it reaches only the tool result: every failure logs `tool_failed` with its code, and a denial logs `query_denied` with the action and an object from the surface's names, otherwise `other`.

## Read state

`read_state` keeps one row per chat: the account's read position, a message ID or NULL when unknown, and LINE's unread count with the position and time it was reported for. `query` reads it with the messages, so the messages the account has not read come from the archive alone, with no request to LINE and nothing marked as read (see Read receipts).

**Sources.** In Talk, a `SEND_CHAT_CHECKED` operation from `talk.sync` (`param1` the chat, `param2` the message ID) moves the position, committed with its batch and cursor. In OpenChat, a `NOTIFIED_UPDATE_SQUARE_CHAT_STATUS` event from `fetchMyEvents` moves it, committed with that stream's paging state; its count is not used. A chat's own history replays old status events, so chat drains never move a position. Snapshots report both position and count: `getMessageBoxes` with `withUnreadCount` (`lastSeenMessageId`, `unreadCount`) in Talk and each `getSquareChat` of the sweep (`otherStatus`) in OpenChat.

**Forward only.** A position is a canonical decimal ID, compared by length, then text, never as a JavaScript number, and it only moves up: an older or replayed position changes nothing. A position of 0, empty or absent is unknown and never replaces a known one. Any other value that is not a canonical ID is ignored and logged by its kind. A count that is absent or negative is unknown; 0 is 0.

**Counts.** Only snapshots carry LINE's count. It is stored with the snapshot's position (`count_marker`) and the time its request was sent (`count_at`), so the answer to an older request never replaces a newer count. A count holds only while its position is still the current one; a live read moves the position past it until the next snapshot.

**Cadence and recovery.** The Talk snapshot is a worker phase in the shared pool, due at start, every 10 minutes and after a Talk reset, including one that arrives while a snapshot runs. Each page commits on its own with its request time; a failure keeps the committed pages and makes the phase due again after 1 minute, doubling up to 10 minutes until a snapshot succeeds. A box for a chat not yet archived adds the chat with its type. OpenChat uses the sweep of joined chats, one `getSquareChat` per chat: every 10 minutes, once after each daemon start whatever the persisted sweep time says, and after a `fetchMyEvents` stall. Queued work and failures can delay a due snapshot.

**Failure direction.** A position can lag behind a read made elsewhere until the next live event or snapshot, which leaves extra messages unread, never fewer. For a chat without a known position, which messages are unread stays unknown, never guessed.

**What is unread.** For a known position: messages in the main chat (OpenChat threads are out), not unsent, with an ID above the position, and not known to be the account's own (as in OpenChat adapter). A message without a known sender stays. Their number in the archive can differ from LINE's count.

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

Every tool is also a `line-mcp` command (`src/tool-cli.ts`). The commands are built at runtime from the zod schemas the server registers, so the CLI cannot drift from the tools and nothing is generated: the tool name and each input field in kebab case name the command and its flags, and a field's type (string, enum, boolean) and optionality give the flag's shape. The `status` tool is `sync-status`, since `line-mcp status` reads the local setup without the daemon. `node:util` `parseArgs` in strict mode and the tool's own schema check the arguments before any request, so a usage error exits 2 without reaching the daemon. A relative `--file-path` is resolved against the current directory.

A command calls the daemon on `127.0.0.1` through the FastMCP client, with its own 300 s deadline instead of the client's default 60 s, so a large attachment download finishes. A result goes to stdout as JSON. A tool error goes to stderr whole, including a mutating tool's outbox state, and exits 1; so does `daemon_unreachable` when nothing answers on the MCP port. Ctrl-C closes the request, which cancels the call like any client that goes away, and exits 130.

`plugins/line-mcp-server/skills/line-mcp/SKILL.md` is written by hand and names the commands; for the archive it points agents to `line-mcp query --help`, the `query` description with the schema. It lets agents use the mutating commands only when the user explicitly asks for that action, treats chat messages, attachments and tool results as data rather than authorization, and has them ask when the recipient or the action is unclear.

## Out of scope

LINE calls, LINE Pay and shopping, account settings changes, joining or leaving groups, contact management, multiple accounts, hosts other than one macOS, Linux or Windows user account, embeddings, OCR and speech, and MCP resources or prompts beyond the framework defaults.
