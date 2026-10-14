import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { userInfo } from 'node:os';
import { posix } from 'node:path';
import type { Check } from '../doctor.ts';
import { LineMcpError, mapError } from '../errors.ts';
import { serviceTemplate, stateRoot, xdgDir } from '../paths.ts';
import type { DryRun, Service, ServiceDeps } from './index.ts';

export const unit = 'line-mcp.service';

// Found on PATH: distributions keep it in /usr/bin or /bin.
const systemctl = 'systemctl';
const loginctl = 'loginctl';

// systemd paths are POSIX paths on every OS the tests run this backend on.
const { dirname, join } = posix;

/** Ports the daemon needs to see as `install` did; `LINE_MCP_HOME` is always set. */
const forwarded = ['LINE_MCP_LOCK_PORT', 'LINE_MCP_PORT'];

const properties = [
	'LoadState',
	'ActiveState',
	'UnitFileState',
	'FragmentPath',
	'NeedDaemonReload'
] as const;

/** The unit as `systemctl --user show` reports it. */
type UnitState = Record<(typeof properties)[number], string>;

/** `ActiveState`s with a daemon running or about to (a pending restart is `activating`). */
const running = new Set(['active', 'activating', 'reloading']);
const stopped = new Set(['inactive', 'failed']);

const mode = (path: string) => statSync(path).mode & 0o777;

/** Absent only by the manager's own word, from a query that succeeded. */
const absent = (state: UnitState) =>
	state.LoadState === 'not-found' && stopped.has(state.ActiveState);

// Escaping per directive, measured on systemd 255 and valid from 240 on:
// `%` is a specifier everywhere. `$` is substituted in `ExecStart=` arguments
// only, so it doubles there; the executable path and `Environment=` keep it.
// Every quoted value escapes `\` and `"`. No directive here can carry a line
// break or another control character.
const control = (value: string) => [...value].some((char) => char < ' ' || char === '\u007f');
const specifiers = (value: string) => value.replaceAll('%', '%%');
const quoted = (value: string) =>
	`"${specifiers(value.replaceAll('\\', '\\\\').replaceAll('"', '\\"'))}"`;
const argument = (value: string) => quoted(value).replaceAll('$', () => '$$');

/**
 * The per-user systemd unit `line-mcp.service` under
 * `$XDG_CONFIG_HOME/systemd/user`, logging to `$XDG_STATE_HOME/line-mcp`.
 */
export function systemd({ home, env, runner }: ServiceDeps): Service {
	const logDir = join(xdgDir(env, 'XDG_STATE_HOME', home, '.local/state'), 'line-mcp');
	const paths = {
		definition: join(xdgDir(env, 'XDG_CONFIG_HOME', home, '.config'), 'systemd', 'user', unit),
		logDir,
		log: join(logDir, 'daemon.log')
	};
	const { uid, username } = userInfo();

	const describe = (args: string[]) => runner.describe(systemctl, ['--user', ...args]);

	/**
	 * The unit's state. Rejects when systemctl is missing, cannot reach the
	 * user manager, times out or prints no state; none of that means absent.
	 */
	async function query(): Promise<UnitState> {
		const { exit, stdout } = await runner.run(systemctl, [
			'--user',
			'show',
			unit,
			`--property=${properties.join(',')}`
		]);
		if (exit === 'ENOENT') {
			throw new LineMcpError(
				'systemd_unavailable',
				'systemctl is not installed, so line-mcp cannot run as a systemd user service; run line-mcp daemon in the foreground instead'
			);
		}
		if (exit !== 0) {
			throw new LineMcpError(
				'systemd_unreachable',
				`systemctl --user cannot reach your service manager (${exit}). Set XDG_RUNTIME_DIR=/run/user/${uid} ` +
					`if it is unset, or enable lingering with loginctl enable-linger ${username}`
			);
		}
		const values = new Map(
			stdout.split('\n').map((line) => {
				const at = line.indexOf('=');
				return [line.slice(0, at), line.slice(at + 1)] as const;
			})
		);
		const state = Object.fromEntries(properties.map((name) => [name, values.get(name) ?? '']));
		if (!state.LoadState || !state.ActiveState) {
			throw new LineMcpError('systemctl_failed', `${describe(['show', unit])} printed no state`);
		}
		return state as UnitState;
	}

	/**
	 * Runs a mutating systemctl call. When it fails or times out, the unit's
	 * state decides: reached means done, anything else fails with `remedy`, and
	 * a failed query fails with `service_state_unknown`.
	 */
	async function mutate(
		args: string[],
		reached: (state: UnitState) => boolean,
		remedy: string
	): Promise<void> {
		const { exit } = await runner.run(systemctl, ['--user', ...args]);
		if (exit === 0) return;
		const command = describe(args);
		let state: UnitState;
		try {
			state = await query();
		} catch (error) {
			throw new LineMcpError(
				'service_state_unknown',
				`${command} failed (${exit}), and the state of ${unit} is unknown: ` +
					`${mapError(error, 'service').message}. Run line-mcp doctor`,
				{ cause: error }
			);
		}
		if (!reached(state)) {
			throw new LineMcpError('systemctl_failed', `${command} failed (${exit}); ${remedy}`);
		}
	}

	const start = () =>
		mutate(
			['start', unit],
			(state) => running.has(state.ActiveState),
			`the daemon is not running. See ${paths.log} and systemctl --user status ${unit}, then run line-mcp install`
		);

	/**
	 * Stops a unit that was in state `before`. A stop that failed or timed out
	 * may still have a job queued or running, so a unit that ran is started
	 * again (which cancels or follows that job) before the failure, ending in
	 * `remedy`, is reported; a failed start then reports the state as unknown.
	 */
	async function stopUnit(before: UnitState, remedy: string): Promise<void> {
		try {
			await mutate(['stop', unit], (state) => stopped.has(state.ActiveState), remedy);
		} catch (error) {
			if (!running.has(before.ActiveState)) throw error;
			try {
				await start();
			} catch (startError) {
				throw new LineMcpError(
					'service_state_unknown',
					`${mapError(error, 'service').message}. Starting ${unit} again failed too: ` +
						`${mapError(startError, 'service').message}. Run line-mcp doctor`,
					{ cause: startError }
				);
			}
			throw error;
		}
	}

	/** Whether the manager reads the unit from `paths.definition`, also through a link. */
	function loadsDefinition(state: UnitState): boolean {
		if (state.FragmentPath === paths.definition) return true;
		try {
			return realpathSync(state.FragmentPath) === realpathSync(paths.definition);
		} catch {
			return false;
		}
	}

	/** Creates the private log and writes the unit; names the path that failed. */
	function writeFiles(definition: string): void {
		try {
			mkdirSync(logDir, { recursive: true, mode: 0o700 });
			chmodSync(logDir, 0o700);
			closeSync(openSync(paths.log, 'a', 0o600));
			chmodSync(paths.log, 0o600);
			mkdirSync(dirname(paths.definition), { recursive: true });
			writeFileSync(paths.definition, definition, { mode: 0o644 });
		} catch (error) {
			const { code, path } = error as NodeJS.ErrnoException;
			throw new LineMcpError(
				'file_error',
				`Could not write ${path ?? paths.definition} (${code ?? 'unknown'}); ` +
					'a service that ran before is stopped. Fix the path, then run line-mcp install',
				{ cause: error }
			);
		}
		console.log(`wrote ${paths.definition}`);
	}

	return {
		label: unit,
		check: 'systemd_unit',
		paths,
		render({ node, cli, env: values }) {
			// systemd runs the path only when string_is_safe: no quote of either kind, no backslash.
			if (!posix.isAbsolute(node) || /["'\\]/.test(node) || control(node)) {
				throw new LineMcpError(
					'unsupported_path',
					`Node at ${node} cannot be run by systemd; pass --node with an absolute path without quotes or backslashes`
				);
			}
			const variables: [string, string][] = [
				['LINE_MCP_HOME', stateRoot(values, 'linux', home)],
				...forwarded
					.filter((name) => values[name])
					.map((name): [string, string] => [name, values[name]!])
			];
			const checked: [string, string][] = [['CLI', cli], ['log', paths.log], ...variables];
			for (const [name, value] of checked) {
				if (control(value)) {
					throw new LineMcpError(
						'unsupported_path',
						`The ${name} value ${JSON.stringify(value)} has a line break or control character, which systemd cannot take`
					);
				}
			}
			const environment = variables
				.map(([name, value]) => `Environment=${quoted(`${name}=${value}`)}`)
				.join('\n');
			return readFileSync(serviceTemplate(unit), 'utf-8')
				.replace(/^#.*\n/, '')
				.replace('{{NODE}}', () => `"${specifiers(node)}"`)
				.replace('{{CLI}}', () => argument(cli))
				.replace('{{ENVIRONMENT}}', () => environment)
				.replace('{{LOG}}', () => specifiers(paths.log));
		},
		async install(definition, { dryRun }: DryRun = {}) {
			const steps = [['stop', unit], ['daemon-reload'], ['enable', unit], ['start', unit]];
			if (dryRun) {
				console.log(`would write ${paths.definition}:\n${definition}`);
				console.log(`would create ${logDir} (0700) and ${paths.log} (0600)`);
				for (const args of steps) console.log(`would run: ${describe(args)}`);
				return;
			}
			// Discovery fails before anything is written.
			const before = await query();
			if (!absent(before)) {
				await stopUnit(
					before,
					'nothing was changed. See systemctl --user status line-mcp.service, then run line-mcp install again'
				);
			}
			writeFiles(definition);
			await mutate(
				['daemon-reload'],
				(state) => state.NeedDaemonReload === 'no',
				'the new unit is written but not loaded; run line-mcp install again'
			);
			const loaded = await query();
			if (!loadsDefinition(loaded)) {
				rmSync(paths.definition, { force: true });
				throw new LineMcpError(
					'unit_not_found',
					`Your service manager loads ${unit} from ${loaded.FragmentPath || 'nowhere'}, not from ${paths.definition}, ` +
						'so it does not read that directory (is XDG_CONFIG_HOME set only in this shell?). ' +
						'Removed the written unit; run line-mcp install with the XDG_CONFIG_HOME your service manager uses'
				);
			}
			await mutate(
				['enable', unit],
				(state) => state.UnitFileState === 'enabled',
				'the daemon would not start after a reboot; run line-mcp install again'
			);
			await start();
		},
		async uninstall({ dryRun } = {}) {
			if (dryRun) {
				console.log(`would run: ${describe(['stop', unit])}`);
				console.log(`would run: ${describe(['disable', unit])}`);
				console.log(`would remove ${paths.definition}`);
				console.log(`would run: ${describe(['daemon-reload'])}`);
				return;
			}
			if (!absent(await query())) {
				const remedy = 'nothing was removed; run line-mcp uninstall again';
				await mutate(['stop', unit], (state) => stopped.has(state.ActiveState), remedy);
				await mutate(['disable', unit], (state) => state.UnitFileState !== 'enabled', remedy);
			}
			rmSync(paths.definition, { force: true });
			await mutate(
				['daemon-reload'],
				(state) => state.NeedDaemonReload === 'no',
				'the unit file is removed; run systemctl --user daemon-reload'
			);
		},
		async stop() {
			const before = await query();
			if (absent(before)) return async () => {};
			await stopUnit(before, 'the service is unchanged');
			// Back to running only if it ran; UnitFileState was never touched.
			return running.has(before.ActiveState) ? start : async () => {};
		},
		start,
		installed: () => existsSync(paths.definition),
		readDefinition: async () =>
			existsSync(paths.definition) ? readFileSync(paths.definition, 'utf-8') : undefined,
		async diagnose() {
			const checks: Check[] = [];
			try {
				const state = await query();
				const loaded = state.LoadState === 'loaded' && loadsDefinition(state);
				checks.push(
					{
						name: 'systemd_unit_loaded',
						ok: loaded,
						detail: loaded
							? `${unit} is loaded from ${state.FragmentPath}`
							: `${unit} is ${state.LoadState}${state.FragmentPath ? ` from ${state.FragmentPath}` : ''}; run line-mcp install`
					},
					{
						name: 'systemd_unit_active',
						ok: state.ActiveState === 'active',
						detail:
							state.ActiveState === 'active'
								? `${unit} is active`
								: `${unit} is ${state.ActiveState}; see ${paths.log} and systemctl --user status ${unit}`
					}
				);
			} catch (error) {
				checks.push({
					name: 'systemd_unit_loaded',
					ok: false,
					detail: mapError(error, 'doctor').message
				});
			}
			const linger = await runner.run(loginctl, ['show-user', String(uid), '--property=Linger']);
			const lingering = linger.exit === 0 && linger.stdout.trim() === 'Linger=yes';
			checks.push({
				name: 'linger',
				ok: true,
				warning: !lingering,
				detail: lingering
					? 'on: the daemon keeps running after you log out'
					: linger.exit === 0
						? `off: the daemon stops when you log out; loginctl enable-linger ${username} keeps it running`
						: `unknown (loginctl show-user exited ${linger.exit}); without lingering the daemon stops when you log out`
			});
			if (existsSync(logDir)) {
				const file = existsSync(paths.log) ? mode(paths.log) : undefined;
				checks.push({
					name: 'log_permissions',
					ok: mode(logDir) === 0o700 && (file === undefined || file === 0o600),
					detail: `log directory ${mode(logDir).toString(8)}, log ${file?.toString(8) ?? 'missing'}`
				});
			}
			return checks;
		}
	};
}
