#!/usr/bin/env bash
# Installs the npm package as a user would and runs test/cli.test.ts against
# its `line-mcp` bin, including the daemon serving a cache-only archive.
# Usage: scripts/smoke-pack.sh [tarball]; without one it packs this checkout.
# Everything runs under a temporary HOME, npm prefix and state root, with an
# empty npm config (no JSR registry), free ports and a launchctl stub; the real
# LaunchAgent, archive and LINE stay untouched.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [[ $# -gt 0 ]]; then
	tarball=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
else
	# Runs prepack, which builds dist/.
	(cd "$repo" && npm pack --pack-destination "$work" >&2)
	tarball=$(echo "$work"/*.tgz)
fi
echo "smoke-pack: $tarball ($(du -k "$tarball" | cut -f1) KB)" >&2

free_port() {
	node -e 'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });'
}

mkdir "$work/home"
: >"$work/npmrc"
: >"$work/npmrc-global"
printf '#!/bin/sh\nexit 0\n' >"$work/launchctl"
chmod +x "$work/launchctl"
export HOME=$work/home
export npm_config_userconfig=$work/npmrc npm_config_globalconfig=$work/npmrc-global
export LINE_MCP_HOME=$work/state LINE_MCP_LAUNCHCTL=$work/launchctl
LINE_MCP_LOCK_PORT=$(free_port)
LINE_MCP_PORT=$(free_port)
export LINE_MCP_LOCK_PORT LINE_MCP_PORT

npm install --global --prefix "$work/prefix" --no-audit --no-fund "$tarball" >&2
bin=$work/prefix/bin/line-mcp
real=$(realpath "$bin")
if [[ $real != */node_modules/line-mcp-server/dist/cli.js ]]; then
	echo "smoke-pack: $bin resolves to $real, not the package's dist/cli.js" >&2
	exit 1
fi
"$bin" --help >/dev/null

cd "$repo"
LINE_MCP_TEST_CLI=$bin node_modules/.bin/vitest --run test/cli.test.ts
