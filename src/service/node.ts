import { execFileSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { LineMcpError } from '../errors.ts';

/**
 * Homebrew's version-independent link to Node 24. A Cellar path such as
 * `/opt/homebrew/Cellar/node@24/24.18.0/bin/node` (what `process.execPath`
 * reports) disappears with the next `brew upgrade`, and launchd then fails.
 */
export const stableNode = '/opt/homebrew/opt/node@24/bin/node';

export interface NodeSelection {
	path: string;
	source: 'override' | 'stable' | 'running';
}

function executable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** `24.18.0` for the Node at `path`, or undefined when it does not run. */
export function nodeVersion(path: string): string | undefined {
	try {
		return execFileSync(path, ['--version'], { encoding: 'utf-8', timeout: 10_000 })
			.trim()
			.replace(/^v/, '');
	} catch {
		return undefined;
	}
}

/** Node 24.18 or later: `node:sqlite` with FTS5 trigram and type stripping. */
export function supportedNode(version: string | undefined): boolean {
	const [major = 0, minor = 0] = (version ?? '').split('.').map(Number);
	return major > 24 || (major === 24 && minor >= 18);
}

export function isCellarPath(path: string): boolean {
	return path.includes('/Cellar/');
}

/**
 * The Node binary the service runs: an explicit override (`--node` or
 * `LINE_MCP_NODE`), which must be an absolute path to an executable Node
 * 24.18 or later; otherwise Homebrew's stable `opt` link, also derived from a
 * Cellar `execPath` under another prefix; otherwise the running Node.
 */
export function selectNode(
	input: { override?: string; execPath?: string; stable?: string } = {}
): NodeSelection {
	if (input.override) {
		const { override } = input;
		if (!isAbsolute(override) || !executable(override) || !supportedNode(nodeVersion(override))) {
			throw new LineMcpError(
				'invalid_node',
				'The Node override (--node or LINE_MCP_NODE) must be an absolute path to an executable Node 24.18 or later'
			);
		}
		return { path: override, source: 'override' };
	}
	const stable = input.stable ?? stableNode;
	if (executable(stable)) return { path: stable, source: 'stable' };
	const execPath = input.execPath ?? process.execPath;
	const cellar = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(execPath);
	if (cellar) {
		const linked = `${cellar[1]}/opt/${cellar[2]}/bin/node`;
		if (executable(linked)) return { path: linked, source: 'stable' };
	}
	return { path: execPath, source: 'running' };
}
