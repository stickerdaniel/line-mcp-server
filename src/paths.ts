import { homedir } from 'node:os';
import { isAbsolute, join, posix, sep } from 'node:path';

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
 * archive. Linux keeps it under `$XDG_DATA_HOME/line-mcp`; Windows under
 * `%LOCALAPPDATA%\line-mcp`, or `<home>\AppData\Local\line-mcp` when that is
 * not an absolute path; every other OS under
 * `~/Library/Application Support/line-mcp`.
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
	if (platform === 'win32') return windowsAppDir(env, home);
	return join(home, 'Library', 'Application Support', 'line-mcp');
}

/**
 * `%LOCALAPPDATA%\line-mcp`, or `<home>\AppData\Local\line-mcp` when that is
 * not an absolute path: the default state root on Windows, which also keeps
 * the service's files and logs whatever `LINE_MCP_HOME` says. Joined with
 * this OS's separator, so tests of the Windows backend elsewhere get paths
 * they can write.
 */
export function windowsAppDir(env: NodeJS.ProcessEnv, home: string): string {
	const local = env.LOCALAPPDATA;
	// A drive and its root, or a UNC path: `\dir` and `C:dir` depend on the current directory.
	const absolute =
		local !== undefined &&
		(sep === '\\' ? /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(local) : isAbsolute(local));
	return join(absolute ? local : join(home, 'AppData', 'Local'), 'line-mcp');
}

export function databasePath(root: string): string {
	return join(root, 'line.db');
}

/** The database and every file SQLite keeps beside it. */
export function databaseFiles(root: string): string[] {
	const path = databasePath(root);
	return [path, `${path}-wal`, `${path}-shm`, `${path}-journal`];
}

/** The private cache `get_attachment` downloads into. */
export function attachmentsDir(root: string): string {
	return join(root, 'attachments');
}

// `../service` from both `src/paths.ts` and the bundled `dist/cli.js`.
export function serviceTemplate(name: string): URL {
	return new URL(`../service/${name}`, import.meta.url);
}
