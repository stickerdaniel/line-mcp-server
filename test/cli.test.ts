import { execFile } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { selectNode } from '../src/launchd.ts';
import { databasePath } from '../src/paths.ts';
import { freePort, seedLive, selfMid, tempRoot } from './fake-line.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

/** A link to the running Node at `<dir>/node`, standing in for a Homebrew layout. */
function nodeAt(dir: string): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, 'node');
	symlinkSync(process.execPath, path);
	return path;
}

interface Run {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * Runs the CLI with a temporary HOME and state root. `launchctl` is a script
 * that only records its arguments, so the test proves dry runs execute nothing.
 * It exits 0, except with the code `exits` names for a subcommand; `print`
 * defaults to 113, launchctl's answer for a service that is not loaded.
 */
async function runCli(
	args: string[],
	home = tempRoot(),
	env: NodeJS.ProcessEnv = {},
	exits: Record<string, number> = {}
) {
	const state = join(home, 'state');
	const calls = join(home, 'launchctl-calls');
	const launchctl = join(home, 'launchctl');
	const lockPort = await freePort();
	const cases = Object.entries({ print: 113, ...exits })
		.map(([command, code]) => `\t${command}) exit ${code} ;;\n`)
		.join('');
	writeFileSync(launchctl, `#!/bin/sh\necho "$@" >> '${calls}'\ncase "$1" in\n${cases}esac\n`);
	chmodSync(launchctl, 0o755);
	const run = await new Promise<Run>((resolve) => {
		execFile(
			process.execPath,
			[cli, ...args],
			{
				env: {
					...process.env,
					HOME: home,
					LINE_MCP_HOME: state,
					LINE_MCP_LOCK_PORT: String(lockPort),
					LINE_MCP_LAUNCHCTL: launchctl,
					...env
				}
			},
			(error, stdout, stderr) =>
				resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr })
		);
	});
	const launched = existsSync(calls)
		? readFileSync(calls, 'utf-8').trimEnd().split('\n')
		: ([] as string[]);
	return { ...run, home, state, launched: launched.length > 0, calls: launched };
}

const agent = `gui/${userInfo().uid}/io.github.stickerdaniel.line-mcp`;

/** `uninstall` over an installed plist, with launchctl's `bootout` exiting `bootout`. */
async function uninstall(bootout: number) {
	const home = tempRoot();
	const plist = join(home, 'Library', 'LaunchAgents', 'io.github.stickerdaniel.line-mcp.plist');
	mkdirSync(dirname(plist), { recursive: true });
	writeFileSync(plist, '');
	const result = await runCli(['uninstall'], home, {}, { bootout });
	return { ...result, plistKept: existsSync(plist) };
}

describe('install and uninstall', () => {
	it('prints the LaunchAgent and launchctl commands on a dry run and changes nothing', async () => {
		const result = await runCli(['install', '--dry-run']);

		expect(result.code).toBe(0);
		expect(result.launched).toBe(false);
		expect(readdirSync(result.home).toSorted()).toEqual(['launchctl']);
		const plist = result.stdout;
		for (const setting of [
			'<string>io.github.stickerdaniel.line-mcp</string>',
			`<string>${cli}</string>`,
			'<string>daemon</string>',
			'<key>RunAtLoad</key>\n\t<true/>',
			'<key>KeepAlive</key>\n\t<true/>',
			'<key>ThrottleInterval</key>\n\t<integer>30</integer>',
			'<key>Umask</key>\n\t<integer>63</integer>',
			`<key>LINE_MCP_HOME</key>\n\t\t<string>${result.state}</string>`,
			join(result.home, 'Library', 'Logs', 'line-mcp', 'daemon.log')
		]) {
			expect(plist).toContain(setting);
		}
		expect(plist).not.toContain('{{');
		// The Node path must survive `brew upgrade`: never a versioned Cellar directory.
		expect(plist).not.toMatch(/<string>[^<]*\/Cellar\/[^<]*<\/string>/);
		expect(plist).toMatch(/would run: \S+ bootout gui\/\d+\/io\.github\.stickerdaniel\.line-mcp/);
		expect(plist).toMatch(
			/would run: \S+ bootstrap gui\/\d+ \S+\/Library\/LaunchAgents\/io\.github\.stickerdaniel\.line-mcp\.plist/
		);
	});

	it('writes a validated Node override from --node or LINE_MCP_NODE into the LaunchAgent', async () => {
		const node = nodeAt(join(tempRoot(), 'bin'));

		const flag = await runCli(['install', '--dry-run', '--node', node]);
		const env = await runCli(['install', '--dry-run'], tempRoot(), { LINE_MCP_NODE: node });

		for (const result of [flag, env]) {
			expect(result.code).toBe(0);
			expect(result.stdout).toContain(
				`<key>ProgramArguments</key>\n\t<array>\n\t\t<string>${node}</string>`
			);
		}
	});

	it('refuses a Node override that is relative or not executable', async () => {
		const notExecutable = join(tempRoot(), 'node');
		writeFileSync(notExecutable, '');
		// A working Node, but relative: launchd would resolve it against another directory.
		const relativeNode = relative(process.cwd(), nodeAt(join(tempRoot(), 'bin')));

		for (const override of [relativeNode, notExecutable]) {
			const result = await runCli(['install', '--dry-run', '--node', override]);

			expect(result.code).toBe(1);
			expect(result.stderr).toContain('invalid_node');
			expect(result.stdout).not.toContain('would write');
			expect(result.launched).toBe(false);
		}
	});

	it('uses the Homebrew opt link for a Node running from a versioned Cellar path', () => {
		const prefix = tempRoot();
		const cellar = nodeAt(join(prefix, 'Cellar', 'node@24', '24.18.0', 'bin'));
		const opt = nodeAt(join(prefix, 'opt', 'node@24', 'bin'));

		expect(selectNode({ execPath: cellar, stable: join(prefix, 'missing') })).toEqual({
			path: opt,
			source: 'stable'
		});
	});

	it('keeps the archive on uninstall and only names it with --purge on a dry run', async () => {
		const home = tempRoot();
		seedLive(join(home, 'state'), selfMid, { authToken: 'token' });

		const keep = await runCli(['uninstall', '--dry-run'], home);
		const purge = await runCli(['uninstall', '--dry-run', '--purge'], home);

		expect([keep.code, purge.code]).toEqual([0, 0]);
		expect(keep.stdout).toContain(`kept the archive in ${keep.state}`);
		expect(purge.stdout).toContain(`would delete ${purge.state}`);
		expect(keep.launched || purge.launched).toBe(false);
		expect(existsSync(databasePath(keep.state))).toBe(true);
	});

	it('runs doctor offline and reports the missing LaunchAgent', async () => {
		const home = tempRoot();
		seedLive(join(home, 'state'), selfMid, { authToken: 'token' });

		const result = await runCli(['doctor'], home);

		expect(result.code).toBe(1);
		expect(result.stdout).toContain(`ok   account: ${selfMid} on ANDROIDSECONDARY, active`);
		expect(result.stdout).toContain('FAIL launch_agent');
		// Only the read-only `print`: doctor never boots the agent in or out.
		expect(result.calls).toEqual([`print ${agent}`]);
	});

	// One CLI process per case keeps each test well inside the default timeout.
	it.each([
		[0, 'ok   launch_agent_loaded: io.github.stickerdaniel.line-mcp is loaded'],
		[113, 'FAIL launch_agent_loaded: io.github.stickerdaniel.line-mcp is not loaded'],
		[5, 'FAIL launch_agent_loaded: launchctl print failed (5)']
	])(
		'reports in doctor whether launchd has the agent loaded (print exits %i)',
		async (print, line) => {
			const home = tempRoot();
			seedLive(join(home, 'state'), selfMid, { authToken: 'token' });

			const result = await runCli(['doctor'], home, {}, { print });

			expect(result.stdout).toContain(line);
		}
	);

	it.each([3, 113])(
		'treats a not-loaded agent as booted out (bootout exits %i)',
		async (bootout) => {
			const result = await uninstall(bootout);

			expect([result.code, result.plistKept]).toEqual([0, false]);
			expect(result.calls).toEqual([`bootout ${agent}`]);
		}
	);

	it('surfaces other launchctl errors on uninstall and keeps the plist', async () => {
		const failed = await uninstall(5);

		expect(failed.code).toBe(1);
		expect(failed.stderr).toContain('launchctl bootout failed (5)');
		// A failed bootout may leave the agent running: its plist stays for a retry.
		expect(failed.plistKept).toBe(true);
	});

	it('warns in doctor when the selected Node is a versioned Cellar path', async () => {
		const home = tempRoot();
		seedLive(join(home, 'state'), selfMid, { authToken: 'token' });
		const node = nodeAt(join(tempRoot(), 'Cellar', 'node@24', '24.18.0', 'bin'));

		const result = await runCli(['doctor'], home, { LINE_MCP_NODE: node });

		expect(result.stdout).toContain(`ok   node: ${node}`);
		expect(result.stdout).toContain(`warn node_path: ${node} is a versioned Cellar path`);
	});
});
