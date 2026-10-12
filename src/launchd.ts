import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LineMcpError } from './errors.ts';

export const label = 'io.github.stickerdaniel.line-mcp';

const template = new URL(`../launchd/${label}.plist`, import.meta.url);
export const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));

/** Variables the daemon needs to see the same state root and lock port as `install`. */
const forwarded = ['LINE_MCP_HOME', 'LINE_MCP_LOCK_PORT'];

export interface AgentPaths {
	plist: string;
	logDir: string;
	log: string;
}

export function agentPaths(home = homedir()): AgentPaths {
	const logDir = join(home, 'Library', 'Logs', 'line-mcp');
	return {
		plist: join(home, 'Library', 'LaunchAgents', `${label}.plist`),
		logDir,
		log: join(logDir, 'daemon.log')
	};
}

function xml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

/** The LaunchAgent for this checkout: absolute Node path, this CLI, private logs. */
export function renderPlist(input: {
	node: string;
	cli: string;
	log: string;
	env: NodeJS.ProcessEnv;
}): string {
	const environment = forwarded
		.filter((name) => input.env[name])
		.map((name) => `\n\t\t<key>${name}</key>\n\t\t<string>${xml(input.env[name]!)}</string>`)
		.join('');
	return readFileSync(template, 'utf-8')
		.replace(/<!--.*?-->\n/s, '')
		.replaceAll('{{NODE}}', xml(input.node))
		.replaceAll('{{CLI}}', xml(input.cli))
		.replaceAll('{{LOG}}', xml(input.log))
		.replaceAll('{{ENVIRONMENT}}', environment);
}

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
 * The Node binary the LaunchAgent runs: an explicit override (`--node` or
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

export function launchctlPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.LINE_MCP_LAUNCHCTL || '/bin/launchctl';
}

export function domain(): string {
	return `gui/${userInfo().uid}`;
}

export interface Command {
	args: string[];
	/** True for `bootout`: an agent that is not loaded is already where it should be. */
	absentOk: boolean;
}

export function bootoutCommand(): Command {
	return { args: ['bootout', `${domain()}/${label}`], absentOk: true };
}

export function bootstrapCommand(plist: string): Command {
	return { args: ['bootstrap', domain(), plist], absentOk: false };
}

export function describe(command: Command, env: NodeJS.ProcessEnv = process.env): string {
	return [launchctlPath(env), ...command.args].join(' ');
}

/**
 * Exit codes launchctl uses for a service that is not loaded: 3 ("No such
 * process") from `bootout`, 113 ("Could not find service") from `print` and
 * from `bootout` on some macOS releases.
 */
const notLoadedCodes = new Set([3, 113]);

/**
 * Runs launchctl and tells whether the service was there. Every failure other
 * than "not loaded" rejects with the command and its exit code.
 */
function launchctl(args: string[], env: NodeJS.ProcessEnv): Promise<'done' | 'not_loaded'> {
	return new Promise((resolve, reject) => {
		execFile(launchctlPath(env), args, (error) => {
			if (!error) resolve('done');
			else if (notLoadedCodes.has(Number(error.code))) resolve('not_loaded');
			else {
				const reason = error.code ?? error.signal ?? 'unknown';
				reject(new LineMcpError('launchctl_failed', `launchctl ${args[0]} failed (${reason})`));
			}
		});
	});
}

export async function runLaunchctl(
	command: Command,
	env: NodeJS.ProcessEnv = process.env
): Promise<void> {
	if ((await launchctl(command.args, env)) === 'not_loaded' && !command.absentOk) {
		throw new LineMcpError('launchctl_failed', `launchctl ${command.args[0]} failed (not loaded)`);
	}
}

/** Whether launchd has the agent loaded in this user's GUI domain. Read-only. */
export async function agentLoaded(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
	return (await launchctl(['print', `${domain()}/${label}`], env)) === 'done';
}
