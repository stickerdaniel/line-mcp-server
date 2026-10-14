import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { posix } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { LineMcpError, mapError } from '../errors.ts';
import { serviceTemplate } from '../paths.ts';
import type { DryRun, Service, ServiceDeps } from './index.ts';

export const label = 'io.github.stickerdaniel.line-mcp';

const launchctl = '/bin/launchctl';

// launchd paths are POSIX paths on every OS the tests run this backend on.
const { dirname, join } = posix;

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
export function launchd({ home, runner, stopTimeoutMs = 30_000 }: ServiceDeps): Service {
	const logDir = join(home, 'Library', 'Logs', 'line-mcp');
	const paths = {
		definition: join(home, 'Library', 'LaunchAgents', `${label}.plist`),
		logDir,
		log: join(logDir, 'daemon.log')
	};
	const domain = `gui/${userInfo().uid}`;
	const target = `${domain}/${label}`;

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

	/**
	 * Boots the agent out and waits until launchd has let it go; one that is
	 * not loaded is already where it should be. `bootout` returns while the
	 * daemon is still shutting down, and until it is gone a `bootstrap` fails
	 * (5) and a login finds the lock held. A bootout that failed or timed out
	 * may still take effect, so launchd's view decides then too: it fails only
	 * while the agent stays loaded, and with `service_state_unknown` when
	 * `print` fails.
	 */
	async function bootout({ dryRun }: DryRun = {}): Promise<void> {
		const args = ['bootout', target];
		if (dryRun) {
			console.log(`would run: ${runner.describe(launchctl, args)}`);
			return;
		}
		let failure: unknown;
		try {
			if ((await run(args)) === 'not_loaded') return;
		} catch (error) {
			failure = error;
		}
		const loaded = () =>
			run(['print', target]).then(
				(state) => state === 'done',
				(error: unknown) => {
					const after =
						failure === undefined ? '' : `${mapError(failure, 'service').message}, and `;
					throw new LineMcpError(
						'service_state_unknown',
						`${after}${mapError(error, 'service').message}, so it is unknown whether launchd ` +
							`still has ${label} loaded. Run line-mcp doctor`,
						{ cause: error }
					);
				}
			);
		const deadline = Date.now() + stopTimeoutMs;
		while (await loaded()) {
			if (Date.now() >= deadline) {
				const after = failure === undefined ? 'bootout' : mapError(failure, 'service').message;
				throw new LineMcpError(
					'launchctl_failed',
					`launchd still had ${label} loaded ${stopTimeoutMs / 1000} s after ${after}`,
					{ cause: failure }
				);
			}
			await sleep(100);
		}
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
		async stop() {
			try {
				await bootout();
			} catch (error) {
				if (!(error instanceof LineMcpError) || error.code !== 'service_state_unknown') throw error;
				// launchd may have let the agent go without saying so. Loading it
				// again puts it back; while it is still loaded that fails, and the
				// state stays unknown.
				try {
					await bootstrap();
				} catch {
					throw error;
				}
				throw new LineMcpError(
					'launchctl_failed',
					`launchd could not confirm that ${label} stopped, so line-mcp loaded it again; the service is unchanged`,
					{ cause: error }
				);
			}
			// Today's handoff: bootstrap again whenever the plist is there.
			return async () => {
				if (existsSync(paths.definition)) await bootstrap();
			};
		},
		start: () => bootstrap(),
		installed: () => existsSync(paths.definition),
		async diagnose() {
			const name = 'launch_agent_loaded';
			try {
				const loaded = (await run(['print', target])) === 'done';
				return [
					{
						name,
						ok: loaded,
						detail: loaded ? `${label} is loaded` : `${label} is not loaded; run line-mcp install`
					}
				];
			} catch (error) {
				return [{ name, ok: false, detail: mapError(error, 'doctor').message }];
			}
		}
	};
}
