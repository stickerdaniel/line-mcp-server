import { homedir } from 'node:os';
import { join, posix } from 'node:path';

/**
 * An XDG base directory from `env`, or `fallback` under `home`. The XDG spec
 * ignores empty and relative values.
 */
export function xdgDir(
	env: NodeJS.ProcessEnv,
	name: 'XDG_CONFIG_HOME' | 'XDG_DATA_HOME' | 'XDG_STATE_HOME',
	home: string,
	fallback: string
): string {
	const value = env[name];
	return value && posix.isAbsolute(value) ? value : posix.join(home, fallback);
}

/**
 * State root; `LINE_MCP_HOME` overrides it so tests never touch the real
 * archive. Linux keeps it under `$XDG_DATA_HOME/line-mcp`; every other OS
 * under `~/Library/Application Support/line-mcp`.
 */
export function stateRoot(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	home: string = homedir()
): string {
	if (env.LINE_MCP_HOME) return env.LINE_MCP_HOME;
	if (platform === 'linux') {
		return posix.join(xdgDir(env, 'XDG_DATA_HOME', home, '.local/share'), 'line-mcp');
	}
	return join(home, 'Library', 'Application Support', 'line-mcp');
}

export function databasePath(root: string): string {
	return join(root, 'line.db');
}

// `../service` from both `src/paths.ts` and the bundled `dist/cli.js`.
export function serviceTemplate(name: string): URL {
	return new URL(`../service/${name}`, import.meta.url);
}
