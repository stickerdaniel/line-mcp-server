#!/usr/bin/env bash
# Regenerates skills/line-mcp/SKILL.md and skills/line-mcp/scripts/line_cli.py
# from the MCP tool schemas. The tools are served from a throwaway archive
# (scripts/cli-fixture.ts) that never opens the real state root and never
# reaches LINE. The output does not depend on where the checkout lives: the
# skill finds its script relative to SKILL.md.
set -euo pipefail

fastmcp_pin=4.1.0
default_port=47822

repo=$(cd "$(dirname "$0")/.." && pwd)
skill=$repo/skills/line-mcp

if ! command -v uvx >/dev/null; then
	echo 'gen-cli: uvx not found; install uv (https://docs.astral.sh/uv/)' >&2
	exit 1
fi

work=$(mktemp -d)
fixture=
cleanup() {
	if [[ -n $fixture ]]; then
		kill "$fixture" 2>/dev/null || true
		wait "$fixture" 2>/dev/null || true
	fi
	rm -rf "$work"
}
trap cleanup EXIT

node "$repo/scripts/cli-fixture.ts" >"$work/url" 2>"$work/fixture.log" &
fixture=$!
for _ in $(seq 100); do
	[[ -s $work/url ]] && break
	kill -0 "$fixture" 2>/dev/null || {
		cat "$work/fixture.log" >&2
		exit 1
	}
	sleep 0.1
done
url=$(head -n 1 "$work/url")
[[ $url == http://127.0.0.1:*/mcp ]] || {
	echo "gen-cli: the fixture did not start" >&2
	exit 1
}

(cd "$work" && uvx --from "fastmcp==$fastmcp_pin" fastmcp generate-cli "$url" line_cli.py -f)

# The CLI reaches the daemon on its default port unless LINE_MCP_PORT says otherwise.
perl -0pi -e "
	s{^import json\n}{import json\nimport os\n}m;
	s{^CLIENT_SPEC = .*\$}{CLIENT_SPEC = f\"http://127.0.0.1:{os.environ.get('LINE_MCP_PORT', '$default_port')}/mcp\"}m;
	s{generate-cli http://127\.0\.0\.1:\d+/mcp}{generate-cli http://127.0.0.1:$default_port/mcp}g;
	s{CLI for 127\.0\.0\.1 MCP server}{CLI for the line-mcp MCP server}g;
	s{cyclopts\.App\(name=\"127\.0\.0\.1\"}{cyclopts.App(name=\"line-cli\"}g;
" "$work/line_cli.py"

# Commands name the script through <skill-dir>, which the agent replaces with
# the directory that holds SKILL.md, so nothing here names this checkout.
invocation="uvx --from fastmcp==$fastmcp_pin python \"<skill-dir>/scripts/line_cli.py\""
perl -0pi -e "
	s{\A---\n.*?\n---\n\n# [^\n]*\n}{---
name: line-mcp
description: Read and search the chats of the LINE account connected to the local line-mcp daemon (one-to-one, groups, OpenChat). Use to list chats, read or search messages, list changes since a sequence number, fetch attachments, announcements and profiles.
---

# line-mcp CLI

The commands talk to the line-mcp daemon on 127.0.0.1 (port $default_port, or \\\$LINE_MCP_PORT). Every result reports \\\`stale\\\` and the last sync times; check them before treating a result as current. Times come as \\\`utc\\\` and as \\\`local\\\`, in the daemon's time zone, which \\\`status\\\` reports as \\\`time_zone\\\`. Pass a result's cursor back unchanged to continue.

## Running the commands

The CLI is \\\`scripts/line_cli.py\\\` next to this SKILL.md. In every command below, replace \\\`<skill-dir>\\\` with the absolute path of the directory that holds this SKILL.md, and keep the double quotes, since the path may contain spaces. The commands then work from any directory.
}s;
	s{uv run --with fastmcp python line_cli\.py}{$invocation}g;
" "$work/SKILL.md"

mkdir -p "$skill/scripts"
mv "$work/line_cli.py" "$skill/scripts/line_cli.py"
mv "$work/SKILL.md" "$skill/SKILL.md"
(cd "$repo" && node_modules/.bin/prettier --log-level warn --write skills/line-mcp/SKILL.md)
echo "wrote skills/line-mcp/SKILL.md and skills/line-mcp/scripts/line_cli.py"
