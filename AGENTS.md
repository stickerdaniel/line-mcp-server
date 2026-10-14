# AGENTS.md

> `CLAUDE.md` is a symlink to this file. Edit `AGENTS.md`.

`line-mcp` mirrors one personal LINE account into local SQLite and serves it to coding agents as an MCP server. A Node 24 daemon, run by launchd on macOS and by a systemd user unit on Linux, owns the only LINE session. Architecture and invariants: [`docs/architecture.md`](docs/architecture.md). Read it before changing session, sync, storage or tool code.

## Stack

Node 24 runs the TypeScript sources directly (type stripping) in development and tests. The npm package ships `dist/cli.js`, which `bun run build` bundles from `src/` and the JSR packages; every package in `dependencies` stays external, so a new runtime dependency of the JSR packages must be added there or the build fails. Bun is the package manager. LINE access goes through `@evex/linejs` from JSR, the MCP server through `@prefecthq/fastmcp-ts`. When a dependency's behaviour matters, read its source at the version pinned in `bun.lock`.

## Invariants

- Tests never contact LINE. Each test gets its own temporary state root; the real state under `~/Library/Application Support/line-mcp` or `~/.local/share/line-mcp` stays untouched.
- Live checks run only when the user asks for them, and only in the connected account's own chat, unless the user names another recipient and action.
- Reads never mutate LINE state: no read receipts and no E2EE key registration.
- Integer LINE IDs and revisions stay decimal strings end to end; MIDs and tokens stay opaque strings.
- Logs and tool results carry no tokens, keys, raw envelopes or message text outside the tool's own result data.

## Checks

`bun run verify` runs format, lint, type check and tests; CI runs the same steps on Linux, macOS and Windows. A test asserts what a caller observes; one that checks POSIX-only behaviour skips on Windows with `it.skipIf(process.platform === 'win32')` and a one-line reason. Before committing, plant the fault the test guards against and watch it fail.

## Commits and pull requests

- Commit and PR title: `<type>(<scope>): <Subject>`, imperative, capitalized, subject under 50 characters. Scope is required unless none fits.
- One focused change per PR, squash-merged. Commits carry no co-author trailers; the Post No Bills check rejects them.
- PR bodies follow `.github/pull_request_template.md` and end with `Generated with <model> for <job> in <tool> via <host>.` Repeat `<model> for <job>` joined by `and`; join jobs with `/`. Humans are `Human`. Ask for unknown values.

## Releasing

`bun run release:bump <major|minor|patch|x.y.z>` sets the version in `package.json` and both plugin manifests; a test keeps the three equal. The bump goes in its own PR, `chore(release): Release vX.Y.Z`. Merging it runs `.github/workflows/release.yml`, which publishes to npm, tags the merge commit and creates the GitHub Release. Merge no further bump until that run is green. "Re-run all jobs" finishes a failed run, since every step skips what is already done; a failure that needs a code change ships with the next bump.
