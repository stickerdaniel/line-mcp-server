import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { LineMcpError } from '../errors.ts';
import { serviceTemplate } from '../paths.ts';
import type { DryRun, Service, ServiceDeps } from './index.ts';

export const label = 'io.github.stickerdaniel.line-mcp';

const launchctl = '/bin/launchctl';

/** Variables the daemon needs to see the same state root and ports as `install`. */
const forwarded = ['LINE_MCP_HOME', 'LINE_MCP_LOCK_PORT', 'LINE_MCP_PORT'];

function xml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

/**
 * Exit codes launchctl uses for a service that is not loaded: 3 ("No such
 * process") from `bootout`, 113 ("Could not find service") from `print` and
 * from `bootout` on some macOS releases.
 */
const notLoadedCodes = new Set([3, 113]);

/** The per-user LaunchAgent in the GUI domain, logging to `~/Library/Logs/line-mcp`. */
export function launchd({ home, runner }: ServiceDeps): Service {
	const logDir = join(home, 'Library', 'Logs', 'line-mcp');
	const paths = {
		definition: join(home, 'Library', 'LaunchAgents', `${label}.plist`),
		logDir,
		log: join(logDir, 'daemon.log')
	};
	const domain = `gui/${userInfo().uid}`;

	/**
	 * Runs launchctl and tells whether the service was there. Every failure
	 * other than "not loaded" rejects with the subcommand and its exit code.
	 */
	async function run(args: string[]): Promise<'done' | 'not_loaded'> {
		const { exit } = await runner.run(launchctl, args);
		if (exit === 0) return 'done';
		if (typeof exit === 'number' && notLoadedCodes.has(exit)) return 'not_loaded';
		throw new LineMcpError('launchctl_failed', `launchctl ${args[0]} failed (${exit})`);
	}

	/** Boots the agent out; one that is not loaded is already where it should be. */
	async function bootout({ dryRun }: DryRun = {}): Promise<void> {
		const args = ['bootout', `${domain}/${label}`];
		if (dryRun) console.log(`would run: ${runner.describe(launchctl, args)}`);
		else await run(args);
	}

	async function bootstrap({ dryRun }: DryRun = {}): Promise<void> {
		const args = ['bootstrap', domain, paths.definition];
		if (dryRun) console.log(`would run: ${runner.describe(launchctl, args)}`);
		else if ((await run(args)) === 'not_loaded') {
			throw new LineMcpError('launchctl_failed', 'launchctl bootstrap failed (not loaded)');
		}
	}

	return {
		label,
		check: 'launch_agent',
		paths,
		render({ node, cli, env }) {
			const environment = forwarded
				.filter((name) => env[name])
				.map((name) => `\n\t\t<key>${name}</key>\n\t\t<string>${xml(env[name]!)}</string>`)
				.join('');
			return readFileSync(serviceTemplate(`${label}.plist`), 'utf-8')
				.replace(/<!--.*?-->\n/s, '')
				.replaceAll('{{NODE}}', xml(node))
				.replaceAll('{{CLI}}', xml(cli))
				.replaceAll('{{LOG}}', xml(paths.log))
				.replaceAll('{{ENVIRONMENT}}', environment);
		},
		async install(definition, { dryRun } = {}) {
			if (dryRun) {
				console.log(`would write ${paths.definition}:\n${definition}`);
				console.log(`would create ${logDir} (0700)`);
			} else {
				mkdirSync(logDir, { recursive: true, mode: 0o700 });
				chmodSync(logDir, 0o700);
				mkdirSync(dirname(paths.definition), { recursive: true });
				writeFileSync(paths.definition, definition, { mode: 0o644 });
				console.log(`wrote ${paths.definition}`);
			}
			await bootout({ dryRun });
			await bootstrap({ dryRun });
		},
		async uninstall({ dryRun } = {}) {
			await bootout({ dryRun });
			if (dryRun) console.log(`would remove ${paths.definition}`);
			else rmSync(paths.definition, { force: true });
		},
		stop: () => bootout(),
		start: () => bootstrap(),
		installed: () => existsSync(paths.definition),
		loaded: async () => (await run(['print', `${domain}/${label}`])) === 'done'
	};
}
