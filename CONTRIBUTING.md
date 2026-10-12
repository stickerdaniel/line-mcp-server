# Contributing

Thanks for helping improve line-mcp. It holds a live LINE session and private chats, so a few rules are stricter than usual.

## Development

```bash
bun install
bun run verify
```

`verify` runs formatting, lint, the type check and the tests, the same steps as CI. It needs Node 24.18 or later and Bun. The tests never contact LINE: each one runs against a fake upstream and its own temporary state root.

`bun run build` writes the npm package's `dist/cli.js`. `scripts/smoke-pack.sh` packs the package, installs it into a temporary prefix and runs `test/cli.test.ts` against the installed `line-mcp`, like the `package` CI job.

## Test data

Use synthetic fixtures only: made-up MIDs, IDs, names and message text. Never commit anything taken from a real account, including tokens, keys, envelopes, archive rows, logs or screenshots.

## Generated CLI and skill

`plugins/line-mcp-server/skills/line-mcp/SKILL.md` and `plugins/line-mcp-server/skills/line-mcp/scripts/line_cli.py` are generated from the MCP tool schemas. Do not edit them by hand. After changing a tool, its description, or the skill text in `scripts/gen-cli.sh`, run:

```bash
scripts/gen-cli.sh
```

It needs `uvx` and serves the tools from a throwaway archive, never the real one. `bun run verify` fails when the CLI and the tool schemas disagree.

## Live checks

A change to session, sync or tool code may need a check against a real account. Run it only when the user asks for it, and only in the connected account's own chat, unless the user names another recipient and action.

## Pull requests

Keep PRs small and single-purpose, with a conventional title such as `fix(sync): Keep empty pages out of the page hash`. Describe the problem, the change, and how you verified it. A behaviour change needs a test that fails without it. The template's last line is the model attribution this repository requires of its own pull requests.
