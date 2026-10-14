import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { join, win32 } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { system32 } from '../acl.ts';
import type { Check } from '../doctor.ts';
import { type ErrorCode, LineMcpError, mapError } from '../errors.ts';
import { lockHeld, lockPort, requestStop } from '../lock.ts';
import { serviceTemplate, stateRoot, windowsAppDir } from '../paths.ts';
import { statePrivacy } from '../privacy.ts';
import type { DryRun, Restore, Service, ServiceDeps } from './index.ts';
import { defaultToolTimeoutMs, toolRunner } from './runner.ts';

/** Ports the daemon needs to see as `install` did; `LINE_MCP_HOME` is always set. */
const forwarded = ['LINE_MCP_LOCK_PORT', 'LINE_MCP_PORT'];

/** Between two looks at the task while it stops or starts. */
const pollMs = 250;
/** At most one stop request a second, each waiting at most this long for the port. */
const requestMs = 5000;
/**
 * A look at the task gets at least this long, even past its deadline, so the
 * last look before a deadline still reads the state instead of timing out.
 */
const lookMs = 5000;
/** What returning the task to its prior state may take after the stop's own deadline. */
const rollbackMs = 15_000;

/**
 * The task as `service/task-state.js` reports it through Schedule.Service:
 * `state` is 1 disabled, 2 queued, 3 ready, 4 running (0 unknown), and
 * `command` and `arguments` are its first action.
 */
const answer = z.union([
	z.strictObject({ exists: z.literal(false) }),
	z.strictObject({ error: z.number().int().nonnegative() }),
	z.strictObject({
		exists: z.literal(true),
		state: z.number().int().min(0).max(4),
		enabled: z.boolean(),
		instances: z.number().int().nonnegative(),
		lastResult: z.number().int().nonnegative(),
		command: z.string(),
		arguments: z.string()
	})
]);
type Task = Exclude<z.infer<typeof answer>, { error: number }>;
type Registered = Extract<Task, { exists: true }>;

/** Whether the task was enabled and had a running instance before `stop()`. */
interface Prior {
	enabled: boolean;
	running: boolean;
}

const hex = (value: number) => `0x${value.toString(16).toUpperCase().padStart(8, '0')}`;

/** Task Scheduler's answer from cscript's output, when it is exactly one well-formed line. */
function parseAnswer(stdout: string): z.infer<typeof answer> | undefined {
	const lines = stdout.split(/\r?\n/);
	if (lines.length !== 2 || lines[1] !== '') return undefined;
	try {
		return answer.parse(JSON.parse(lines[0]!));
	} catch {
		return undefined;
	}
}

/** Why `error` failed, for a message: line-mcp's own text, or a file system code. */
function reason(error: unknown, operation: string): string {
	const { code } = error as NodeJS.ErrnoException;
	return error instanceof LineMcpError || typeof code !== 'string'
		? mapError(error, operation).message
		: code;
}

/** A path or value line-mcp writes into the launcher and the task. */
const refused = /["%\p{Cc}]/u;

/** A JScript string literal with every character outside printable ASCII as `\uXXXX`. */
const jscript = (value: string) =>
	JSON.stringify(value).replace(
		/[^\x20-\x7e]/g,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
	);

function xml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

/** The time left until `deadline`, at least 1 ms, so a call still gets an answer or a timeout. */
const left = (deadline: number) => Math.max(1, deadline - Date.now());
/** A tool call's timeout, cut to the time left until `deadline`. */
const clipped = (deadline: number) => ({
	timeoutMs: Math.min(defaultToolTimeoutMs, left(deadline))
});

const enabled = (task: Task) => task.exists && task.enabled;

/** Writes `content` beside `path` under a new name, then renames it into place. */
function replace(path: string, content: string | Buffer): void {
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, content, { flag: 'wx' });
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

/**
 * A per-user Task Scheduler task named with the user's SID, which runs a
 * Windows Script Host launcher in `%LOCALAPPDATA%\line-mcp\service` at logon
 * and every minute; logs go to `%LOCALAPPDATA%\line-mcp\logs`. The task is
 * registered disabled and only `start()` enables it. A task is absent only
 * when Task Scheduler says so; every other failure rejects.
 */
export function taskScheduler({
	home,
	env,
	runner,
	stopTimeoutMs = 45_000,
	startTimeoutMs = 15_000,
	privacy = statePrivacy('win32', { home, env, runner: toolRunner({}) })
}: ServiceDeps): Service {
	const appDir = windowsAppDir(env, home);
	const serviceDir = join(appDir, 'service');
	const logDir = join(appDir, 'logs');
	const launcher = join(serviceDir, 'line-mcp.js');
	const definitionXml = join(serviceDir, 'line-mcp.xml');
	const paths = { definition: launcher, logDir, log: join(logDir, 'daemon.log') };
	const tools = system32(env);
	const schtasks = win32.join(tools, 'schtasks.exe');
	const cscript = win32.join(tools, 'cscript.exe');
	const wscript = win32.join(tools, 'wscript.exe');
	const action = `//B //Nologo //E:JScript "${launcher}"`;
	// Read when used, so a bad LINE_MCP_LOCK_PORT fails the command that needs it.
	const port = () => lockPort(env);
	const query = fileURLToPath(serviceTemplate('task-state.js'));

	let sid: string | undefined;
	/** The user's SID, which the task runs as and is named with. */
	async function userSid(): Promise<string> {
		if (!sid) {
			const { exit, stdout } = await runner.run(win32.join(tools, 'whoami.exe'), [
				'/user',
				'/fo',
				'csv',
				'/nh'
			]);
			const found = /,"(S-1-\d+(?:-\d+)+)"\s*$/.exec(stdout)?.[1];
			if (exit !== 0 || !found) {
				throw new LineMcpError(
					'task_scheduler_failed',
					`whoami failed (${exit}), so line-mcp does not know your user SID, which names its scheduled task`
				);
			}
			sid = found;
		}
		return sid;
	}
	/** `line-mcp-<user SID>`: task names are machine-wide. */
	const taskName = async () => `line-mcp-${await userSid()}`;

	const describe = async (args: string[]) =>
		runner.describe(schtasks, [args[0]!, '/TN', await taskName(), ...args.slice(1)]);

	/**
	 * The task's state. Rejects when the answer is not exactly one well-formed
	 * line, whatever cscript's exit code (it exits 0 after a script error too),
	 * or when the call timed out; none of that means absent. The call gets at
	 * least `lookMs`, even past `deadline`.
	 */
	async function inspect(deadline = Date.now() + defaultToolTimeoutMs): Promise<Task> {
		const name = await taskName();
		const { exit, stdout } = await runner.run(
			cscript,
			['//Nologo', '//E:JScript', query, name],
			clipped(Math.max(deadline, Date.now() + lookMs))
		);
		const failed = (why: string) =>
			new LineMcpError(
				'task_scheduler_failed',
				`line-mcp could not read the state of the scheduled task ${name}: ${why}`
			);
		if (typeof exit === 'string') throw failed(`cscript failed (${exit})`);
		const parsed = parseAnswer(stdout);
		if (!parsed) throw failed('Task Scheduler gave an unexpected answer');
		if ('error' in parsed) throw failed(`Task Scheduler failed (${hex(parsed.error)})`);
		return parsed;
	}

	/**
	 * Runs `schtasks <args[0]> /TN <task> ...args`. When it fails or times out,
	 * the task's state decides: reached means done, anything else fails with
	 * `code` and `remedy`, and a failed query fails with `service_state_unknown`.
	 */
	async function change(
		args: string[],
		reached: (task: Task) => boolean,
		deadline: number,
		{ code = 'task_scheduler_failed', remedy }: { code?: ErrorCode; remedy: string }
	): Promise<void> {
		const name = await taskName();
		const { exit } = await runner.run(
			schtasks,
			[args[0]!, '/TN', name, ...args.slice(1)],
			clipped(deadline)
		);
		if (exit === 0) return;
		const command = await describe(args);
		let task: Task;
		try {
			task = await inspect(deadline);
		} catch (error) {
			throw new LineMcpError(
				'service_state_unknown',
				`${command} failed (${exit}), and the state of ${name} is unknown: ` +
					`${mapError(error, 'service').message}. Run line-mcp doctor`,
				{ cause: error }
			);
		}
		if (!reached(task)) throw new LineMcpError(code, `${command} failed (${exit}); ${remedy}`);
	}

	const startFailed = (why: string, task: Task) =>
		new LineMcpError(
			'start_failed',
			`${why}${task.exists ? ` (last result ${hex(task.lastResult)})` : ''}. See ${paths.log}, ` +
				'then rerun line-mcp install or run line-mcp doctor'
		);

	/**
	 * Enables and runs the task, then waits until an instance runs and its
	 * daemon holds the lock port. Never runs it while another process holds
	 * the port: then `lock_held`, with nothing changed. A slow start is
	 * reported with `start_failed`, not stopped.
	 */
	async function start(deadline = Date.now() + startTimeoutMs): Promise<void> {
		if (await lockHeld(port(), { timeoutMs: Math.min(requestMs, left(deadline)) })) {
			throw new LineMcpError(
				'lock_held',
				`Another process holds the line-mcp lock port ${port()}, so the scheduled task was not started. ` +
					'Stop it (a login, or line-mcp daemon in a terminal), then run line-mcp install'
			);
		}
		const remedy = `the daemon is not running. See ${paths.log}, then rerun line-mcp install or run line-mcp doctor`;
		await change(['/Change', '/Enable'], enabled, deadline, { code: 'start_failed', remedy });
		await change(['/Run'], (task) => task.exists && task.instances > 0, deadline, {
			code: 'start_failed',
			remedy
		});
		let ran = false;
		for (;;) {
			const task = await inspect(deadline);
			if (task.exists && task.instances > 0) {
				ran = true;
				// The port was free before the run, so its holder is this instance's daemon.
				// A port that does not answer in time counts as not held yet.
				const held = await lockHeld(port(), { timeoutMs: requestMs }).catch(() => false);
				if (held) return;
			} else if (ran) throw startFailed('The daemon exited right after it started', task);
			if (Date.now() >= deadline) {
				throw startFailed(`The daemon did not start within ${startTimeoutMs / 1000} s`, task);
			}
			await sleep(Math.min(pollMs, left(deadline)));
		}
	}

	/**
	 * Waits until the disabled task reports state 1 with no instance, asking a
	 * running instance's daemon to stop over the lock port. With no instance a
	 * held port belongs to someone else (a login, a daemon run by hand) and is
	 * left alone; the task's daemon is the only one that accepts the request.
	 */
	async function drain(deadline: number): Promise<void> {
		let asked = 0;
		for (;;) {
			const task = await inspect(deadline);
			const name = await taskName();
			if (!task.exists) {
				throw new LineMcpError(
					'task_scheduler_failed',
					`The scheduled task ${name} disappeared while line-mcp stopped it`
				);
			}
			// Task Scheduler never reports state 1 while an instance runs.
			if (task.state === 1 && task.instances === 0) return;
			if (task.instances > 0 && Date.now() - asked >= 1000) {
				asked = Date.now();
				try {
					// Connects first, and sends nothing to a port nobody holds.
					await requestStop(port(), { deadlineMs: Math.min(requestMs, left(deadline)) });
				} catch (error) {
					if (!(error instanceof LineMcpError && error.code === 'stop_timeout')) throw error;
				}
			}
			if (Date.now() >= deadline) {
				throw new LineMcpError(
					'stop_timeout',
					`The scheduled task ${name} still ran ${stopTimeoutMs / 1000} s after line-mcp disabled it ` +
						`(state ${task.state}, ${task.instances} instance(s))`
				);
			}
			await sleep(Math.min(pollMs, left(deadline)));
		}
	}

	/**
	 * Returns the task to `prior` (the restore table in docs/architecture.md):
	 * enabled and running gets `start()`; enabled and idle is enabled, so the
	 * next logon or the minute trigger starts it; a disabled task stays
	 * disabled, with a warning when its daemon ran.
	 */
	async function restore(prior: Prior | undefined): Promise<void> {
		if (!prior?.enabled) {
			if (prior?.running) {
				console.error(
					`warning: the scheduled task ${await taskName()} is disabled; run line-mcp install to start it`
				);
			}
			return;
		}
		if (prior.running) return await start();
		await change(['/Change', '/Enable'], enabled, Date.now() + defaultToolTimeoutMs, {
			remedy: 'the scheduled task stays disabled; run line-mcp install'
		});
	}

	/**
	 * Puts the task back after a stop that failed past its disable: enabled
	 * again if it was, and its daemon started again if it was running and is
	 * gone now. A still running daemon is left alone.
	 */
	async function rollback(prior: Prior, deadline: number): Promise<void> {
		const task = await inspect(deadline);
		if (!task.exists) {
			throw new LineMcpError('task_scheduler_failed', `${await taskName()} is gone`);
		}
		if (prior.enabled && !task.enabled) {
			await change(['/Change', '/Enable'], enabled, deadline, {
				remedy: 'the scheduled task stays disabled'
			});
		}
		if (prior.enabled && prior.running && task.instances === 0) await start(deadline);
	}

	/**
	 * Stops the task's daemon: records the prior state, disables the task so
	 * no trigger starts it again, and waits for it to stop (`drain`). Every
	 * failure after the first query rolls back; a rollback that fails too
	 * leaves the state unknown. Resolves to the prior state, or undefined when
	 * the task is absent.
	 */
	async function quiesce(): Promise<Prior | undefined> {
		const deadline = Date.now() + stopTimeoutMs;
		const before = await inspect(deadline);
		if (!before.exists) return undefined;
		const prior = { enabled: before.enabled, running: before.instances > 0 };
		try {
			if (prior.enabled) {
				await change(['/Change', '/Disable'], (task) => task.exists && !task.enabled, deadline, {
					remedy: 'its daemon may still run'
				});
			}
			await drain(deadline);
		} catch (error) {
			const message = mapError(error, 'service').message;
			try {
				await rollback(prior, Math.max(deadline, Date.now()) + rollbackMs);
			} catch (rollbackError) {
				throw new LineMcpError(
					'service_state_unknown',
					`${message}, and returning the scheduled task to its state before failed too: ` +
						`${mapError(rollbackError, 'service').message}. Run line-mcp doctor`,
					{ cause: rollbackError }
				);
			}
			if (!(error instanceof LineMcpError)) throw error;
			throw new LineMcpError(error.code, `${message}; the scheduled task is unchanged`, {
				cause: error
			});
		}
		return prior;
	}

	/** The task definition for the user `user`, as UTF-16LE with a byte order mark. */
	function taskXml(user: string): Buffer {
		const text = readFileSync(serviceTemplate('line-mcp.xml'), 'utf-8')
			.replace(/<!--.*?-->\n/s, '')
			.replaceAll('{{USER}}', () => xml(user))
			.replaceAll('{{WSCRIPT}}', () => xml(wscript))
			.replaceAll('{{ARGUMENTS}}', () => xml(action))
			.replaceAll('\n', '\r\n');
		return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
	}

	/** Install's failure in `step`, after the prior state was restored where it could be. */
	async function installFailed(step: string, error: unknown, prior: Prior | undefined) {
		let restored = prior
			? 'the scheduled task as it was before is back'
			: 'no scheduled task was registered before';
		try {
			await restore(prior);
		} catch (restoreError) {
			restored = `restoring the scheduled task failed: ${reason(restoreError, 'install')}`;
		}
		return new LineMcpError(
			'install_failed',
			`${step} failed: ${reason(error, 'install')}; ${restored}. Run line-mcp install again`,
			{ cause: error }
		);
	}

	return {
		supported: true,
		label: 'the scheduled task',
		check: 'service_launcher',
		paths,
		render({ node, cli, env: values }) {
			const variables: [string, string][] = [
				['LINE_MCP_SERVICE', 'task'],
				['LINE_MCP_HOME', stateRoot(values, 'win32', home)],
				...forwarded
					.filter((name) => values[name])
					.map((name): [string, string] => [name, values[name]!])
			];
			const cmd = win32.join(tools, 'cmd.exe');
			const checked: [string, string][] = [
				['Node', node],
				['CLI', cli],
				['log', paths.log],
				['launcher', launcher],
				['cmd.exe', cmd],
				...variables
			];
			for (const [name, value] of checked) {
				// cmd.exe and Windows Script Host expand `%`; a quote would end the path.
				if (refused.test(value)) {
					throw new LineMcpError(
						'unsupported_path',
						`The ${name} path ${JSON.stringify(value)} has a quote, a % or a control character, ` +
							'which the scheduled task cannot run; use a path without them'
					);
				}
			}
			const command = `"${cmd}" /d /v:off /s /c ""${node}" "${cli}" daemon >> "${paths.log}" 2>&1"`;
			return readFileSync(serviceTemplate('line-mcp.js'), 'utf-8')
				.replace(/^\/\/ Template.*\n/, '')
				.replace('{{ENVIRONMENT}}', () =>
					variables.map(([name, value]) => `env(${jscript(name)}) = ${jscript(value)};`).join('\n')
				)
				.replace('{{COMMAND}}', () => jscript(command));
		},
		async install(definition, { dryRun }: DryRun = {}) {
			const create = ['/Create', '/XML', definitionXml, '/F'];
			if (dryRun) {
				console.log(`would create ${serviceDir} and ${logDir} private where missing`);
				console.log(`would write ${launcher}:\n${definition}`);
				console.log(
					`would write ${definitionXml} (UTF-16LE):\n${taskXml(await userSid())
						.subarray(2)
						.toString('utf16le')}`
				);
				console.log(`would create ${paths.log}`);
				console.log(
					`would stop the scheduled task if it runs: ${await describe(['/Change', '/Disable'])}, then a stop request on lock port ${port()}`
				);
				for (const args of [create, ['/Change', '/Enable'], ['/Run']]) {
					console.log(`would run: ${await describe(args)}`);
				}
				return;
			}
			// 1. Nothing is stopped, written or registered before the directories are private.
			await privacy.directory(serviceDir);
			await privacy.directory(logDir);
			// 2. A failed stop has put the task back and changed nothing here.
			let prior: Prior | undefined;
			try {
				prior = await quiesce();
			} catch (error) {
				if (!(error instanceof LineMcpError)) throw error;
				throw new LineMcpError(
					error.code,
					`Stopping the running scheduled task failed: ${error.message}. Nothing was installed; run line-mcp install again`,
					{ cause: error }
				);
			}
			// 3. and 4. Written into the checked directories, checked again, then registered disabled.
			let step = `Writing ${launcher}`;
			try {
				replace(launcher, definition);
				step = `Writing ${definitionXml}`;
				replace(definitionXml, taskXml(await userSid()));
				step = `Creating ${paths.log}`;
				closeSync(openSync(paths.log, 'a'));
				step = 'Checking the written files';
				for (const file of [launcher, definitionXml, paths.log]) await privacy.file(file);
				step = 'Registering the scheduled task';
				await change(
					create,
					(task) => task.exists && task.arguments === action && !task.enabled,
					Date.now() + defaultToolTimeoutMs,
					{ remedy: 'the scheduled task is not registered' }
				);
			} catch (error) {
				throw await installFailed(step, error, prior);
			}
			console.log(`registered the scheduled task ${await taskName()} to run ${launcher}`);
			// 5. A failed start leaves the new task registered, as a failed bootstrap on macOS does.
			await start();
		},
		async uninstall({ dryRun } = {}) {
			const remove = ['/Delete', '/F'];
			if (dryRun) {
				console.log(
					`would stop the scheduled task if it runs: ${await describe(['/Change', '/Disable'])}, then a stop request on lock port ${port()}`
				);
				console.log(`would run: ${await describe(remove)}`);
				console.log(`would remove ${launcher} and ${definitionXml}`);
				return;
			}
			let prior: Prior | undefined;
			try {
				prior = await quiesce();
			} catch (error) {
				if (!(error instanceof LineMcpError)) throw error;
				throw new LineMcpError(
					error.code,
					`Stopping the scheduled task failed: ${error.message}. Nothing was removed; run line-mcp uninstall again`,
					{ cause: error }
				);
			}
			if (prior) {
				try {
					await change(remove, (task) => !task.exists, Date.now() + defaultToolTimeoutMs, {
						remedy: 'the scheduled task is still registered'
					});
				} catch (error) {
					let restored = 'the scheduled task as it was before is back';
					try {
						await restore(prior);
					} catch (restoreError) {
						restored = `restoring it failed: ${mapError(restoreError, 'uninstall').message}`;
					}
					throw new LineMcpError(
						error instanceof LineMcpError ? error.code : 'task_scheduler_failed',
						`${mapError(error, 'uninstall').message}; ${restored}. Nothing was removed; run line-mcp uninstall again`,
						{ cause: error }
					);
				}
			}
			// Removed only from a private directory, so nothing outside it is touched.
			for (const file of [launcher, definitionXml]) {
				await privacy.file(file);
				rmSync(file, { force: true });
			}
		},
		async stop(): Promise<Restore> {
			const prior = await quiesce();
			return () => restore(prior);
		},
		start: () => start(),
		installed: () => existsSync(launcher),
		async readDefinition() {
			await privacy.file(launcher);
			return existsSync(launcher) ? readFileSync(launcher, 'utf-8') : undefined;
		},
		async diagnose() {
			const checks: Check[] = [];
			try {
				const task = await inspect();
				const name = await taskName();
				if (!task.exists) {
					checks.push({
						name: 'scheduled_task',
						ok: false,
						detail: `${name} is not registered; run line-mcp install`
					});
				} else checks.push(...taskChecks(name, task));
			} catch (error) {
				checks.push({
					name: 'scheduled_task',
					ok: false,
					detail: mapError(error, 'doctor').message
				});
			}
			checks.push(
				...(await privacy.diagnoseDirectory('service_privacy', serviceDir, [
					launcher,
					definitionXml
				])),
				...(await privacy.diagnoseDirectory('log_privacy', logDir, [paths.log]))
			);
			return checks;
		}
	};

	/** Doctor's view of the registered task: enabled, running this launcher, running at all. */
	function taskChecks(name: string, task: Registered): Check[] {
		// Windows paths compare without case.
		const runsLauncher =
			task.command.toLowerCase() === wscript.toLowerCase() && task.arguments === action;
		return [
			{
				name: 'scheduled_task',
				ok: task.enabled,
				detail: task.enabled ? `${name} is enabled` : `${name} is disabled; run line-mcp install`
			},
			{
				name: 'scheduled_task_action',
				ok: runsLauncher,
				detail: runsLauncher
					? `${name} runs ${launcher}`
					: `${name} runs ${task.command} ${task.arguments}, not ${launcher}; run line-mcp install`
			},
			{
				name: 'scheduled_task_running',
				ok: task.instances > 0,
				detail:
					task.instances > 0
						? `${name} is running`
						: `${name} is not running (last result ${hex(task.lastResult)}); see ${paths.log}`
			}
		];
	}
}
