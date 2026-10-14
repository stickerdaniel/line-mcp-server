# Contributing

Thanks for helping improve line-mcp. It holds a live LINE session and private chats, so a few rules are stricter than usual.

## Development

```bash
bun install
bun run verify
```

`verify` runs formatting, lint, the type check and the tests, the same steps as CI. It needs Node 24.18 or later and Bun. The tests never contact LINE: each one runs against a fake upstream and its own temporary state root.

`bun run build` writes the npm package's `dist/cli.js`. `bun run smoke-pack` packs the package, installs it into a temporary prefix and runs `test/cli.test.ts` and `test/cli-tools.test.ts` against the installed `line-mcp`, like the `package` CI job.

The skill runs `line-mcp` from PATH. To put this checkout's build there:

```bash
bun run build
npm link
```

The link runs `dist/cli.js`, so run `bun run build` again after a change.

## Test data

Use synthetic fixtures only: made-up MIDs, IDs, names and message text. Never commit anything taken from a real account, including tokens, keys, envelopes, archive rows, logs or screenshots.

## CLI and skill

The `line-mcp` tool commands and their flags come from the MCP tool schemas at runtime, so a tool change needs no CLI change. `plugins/line-mcp-server/skills/line-mcp/SKILL.md` is written by hand: when you add, rename or remove a tool, update its command list.

## Live checks

A change to session, sync or tool code may need a check against a real account. Run it only when the user asks for it, and only in the connected account's own chat, unless the user names another recipient and action.

## Releasing

Maintainers release from `main`:

```bash
bun run release:bump minor   # or major, patch, x.y.z
```

This sets the version in `package.json` and both plugin manifests. Open it as `chore(release): Release vX.Y.Z` and merge it. The Release workflow then verifies and packs the commit, tests the package on macOS, publishes it to npm, tags the commit and creates the GitHub Release with generated notes. Wait for that run to go green before merging another bump. "Re-run all jobs" finishes a failed run, since every step skips what is already done; a failure that needs a code change ships with the next bump.

npm trusts `release.yml` in the GitHub environment `npm` as a trusted publisher, so the repository holds no npm token.

## Pull requests

Keep PRs small and single-purpose, with a conventional title such as `fix(sync): Keep empty pages out of the page hash`. Describe the problem, the change, and how you verified it. A behaviour change needs a test that fails without it. The template's last line is the model attribution this repository requires of its own pull requests.
