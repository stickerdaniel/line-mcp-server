// The Windows Task Scheduler backend through a fake schtasks, cscript and
// whoami, on every OS, with its daemon on a real loopback lock port;
// test/service-e2e.test.ts runs it against the real Task Scheduler.
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { join, parse } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { LineMcpError } from '../src/errors.ts';
import { acquireLock, lockInUse, type OwnershipLock } from '../src/lock.ts';
import type { StatePrivacy } from '../src/privacy.ts';
import { type Service, serviceFor, withServiceStopped } from '../src/service/index.ts';
import type { ToolResult, ToolRunner } from '../src/service/runner.ts';
import { freePort, tempRoot } from './fake-line.ts';

const sid = 'S-1-5-21-1-2-3-1001';
const task = `line-mcp-${sid}`;
const wscript = 'C:\\Windows\\System32\\wscript.exe';

interface Fault {
	exit?: ToolResult['exit'];
	/** Replaces the tool's output. */
	stdout?: string;
	/** Whether a failing schtasks call still took effect. */
	landed?: boolean;
}

type Initial =
	'absent' | 'enabled, running' | 'enabled, idle' | 'disabled, running' | 'disabled, idle';

/** Every tool call of the test, to check that none ends a task. */
let everyCall: string[][] = [];
afterEach(() => {
	// `/End` kills wscript and orphans the daemon (P0); a stop goes through the daemon.
	expect(everyCall.filter((call) => call.includes('/End'))).toEqual([]);
	everyCall = [];
});

/**
 * Task Scheduler with one task, as schtasks, cscript (service/task-state.js)
 * and whoami answer for it. `/Run` starts an instance whose daemon binds the
 * lock port after `bindDelayMs`, retrying while another process holds it,
 * and stops on a stop request over the port, as `LINE_MCP_SERVICE=task`
 * makes the real one do; with `binds: false` it never binds. `fault`
 * replaces the answer of the nth call (from 0) of `cscript` or of a schtasks
 * subcommand such as `schtasks /Create`. `events` records the tool calls and
 * the privacy checks in order.
 */
async function fakeScheduler({
	initial = 'absent',
	bindDelayMs = 0,
	binds = true,
	fault = () => undefined
}: {
	initial?: Initial;
	bindDelayMs?: number;
	binds?: boolean;
	fault?: (call: string, n: number) => Fault | undefined;
} = {}) {
	const port = await freePort();
	const state = {
		exists: false,
		enabled: false,
		instances: 0,
		lastResult: 0x41303,
		command: '',
		arguments: ''
	};
	const events: string[] = [];
	const counts = new Map<string, number>();
	const timers = new Set<NodeJS.Timeout>();
	/** The XML of each `/Create`, decoded. */
	const registered: string[] = [];
	let lock: OwnershipLock | undefined;
	let launched = 0;
	let closed = false;
	const later = (ms: number, run: () => void) => {
		const timer = setTimeout(() => {
			timers.delete(timer);
			if (!closed) run();
		}, ms);
		timers.add(timer);
	};

	function launch() {
		state.instances = 1;
		launched++;
		const bind = () =>
			void acquireLock(port, () => {
				void lock?.release().then(() => {
					lock = undefined;
					state.instances = 0;
					state.lastResult = 0;
				});
			}).then(
				(taken) => {
					if (closed) void taken.release();
					else lock = taken;
				},
				() => later(50, bind)
			);
		if (binds) later(bindDelayMs, bind);
	}

	const query = () => {
		if (!state.exists) return '{"exists":false}';
		const code = state.instances > 0 ? 4 : state.enabled ? 3 : 1;
		const { enabled, instances, lastResult, command, arguments: args } = state;
		return JSON.stringify({
			exists: true,
			state: code,
			enabled,
			instances,
			lastResult,
			command,
			arguments: args
		});
	};

	const schtasks: Record<string, (args: string[]) => number> = {
		'/Create': (args) => {
			const bytes = readFileSync(args[args.indexOf('/XML') + 1]!);
			// schtasks takes the XML only as UTF-16 with a byte order mark (P0).
			if (bytes[0] !== 0xff || bytes[1] !== 0xfe) return 1;
			const text = bytes.subarray(2).toString('utf16le');
			registered.push(text);
			const settings = /<Settings>([\s\S]*?)<\/Settings>/.exec(text)?.[1] ?? '';
			Object.assign(state, {
				exists: true,
				enabled: /<Enabled>true<\/Enabled>/.test(settings),
				command: /<Command>(.*)<\/Command>/.exec(text)?.[1],
				arguments: /<Arguments>(.*)<\/Arguments>/.exec(text)?.[1]?.replaceAll('&quot;', '"')
			});
			return 0;
		},
		'/Change': (args) => {
			if (!state.exists) return 1;
			state.enabled = args.includes('/Enable');
			return 0;
		},
		'/Run': () => {
			// A disabled task does not run; a running one keeps its instance (IgnoreNew).
			if (!state.exists || !state.enabled) return 1;
			if (state.instances === 0) launch();
			return 0;
		},
		'/Delete': () => {
			if (!state.exists) return 1;
			state.exists = false;
			return 0;
		}
	};

	const runner: ToolRunner = {
		run: async (tool, args) => {
			const name = parse(tool.replaceAll('\\', '/')).name.toLowerCase();
			everyCall.push([name, ...args]);
			const call = name === 'schtasks' ? `${name} ${args[0]}` : name;
			events.push(name === 'schtasks' ? `${call} ${args.slice(3).join(' ')}`.trim() : call);
			const n = counts.get(call) ?? 0;
			counts.set(call, n + 1);
			const failed = fault(call, n);
			if (name === 'whoami') return { exit: 0, stdout: `"host\\me","${sid}"\r\n` };
			if (name === 'cscript') {
				expect(args.slice(0, 2)).toEqual(['//Nologo', '//E:JScript']);
				expect(args.at(-1)).toBe(task);
				return { exit: failed?.exit ?? 0, stdout: failed?.stdout ?? `${query()}\r\n` };
			}
			expect(args.slice(1, 3)).toEqual(['/TN', task]);
			const effect = schtasks[args[0]!]!;
			if (!failed) return { exit: effect(args), stdout: '' };
			if (failed.landed) effect(args);
			return { exit: failed.exit ?? 1, stdout: failed.stdout ?? '' };
		},
		describe: (tool, args) => [parse(tool.replaceAll('\\', '/')).name, ...args].join(' ')
	};

	const fake = {
		port,
		state,
		events,
		registered,
		runner,
		/** How many instances `/Run` started. */
		launched: () => launched,
		/** The schtasks calls without the task name, as `/Change /Enable`. */
		schtasks: () =>
			events.filter((event) => event.startsWith('schtasks ')).map((event) => event.slice(9)),
		/** Whether the task's daemon holds the lock port. */
		bound: () => lock !== undefined,
		launch,
		close: async () => {
			closed = true;
			for (const timer of timers) clearTimeout(timer);
			await lock?.release();
		}
	};
	onTestFinished(fake.close);

	if (initial !== 'absent') {
		Object.assign(state, { exists: true, enabled: initial.startsWith('enabled') });
		if (initial.endsWith('running')) {
			launch();
			if (binds) await vi.waitFor(() => expect(fake.bound()).toBe(true));
		}
	}
	return fake;
}

type Fake = Awaited<ReturnType<typeof fakeScheduler>>;

/** A privacy guard that records its checks in `events` and refuses the paths `refuse` names. */
function fakePrivacy(events: string[], refuse: (path: string) => boolean): StatePrivacy {
	const check = async (kind: string, path: string) => {
		events.push(`privacy ${kind} ${path}`);
		if (refuse(path)) throw new LineMcpError('insecure_directory', `${path} is not private`);
	};
	return {
		database: async () => {},
		directory: async (dir) => {
			await check('directory', dir);
			mkdirSync(dir, { recursive: true });
		},
		file: (path) => check('file', path),
		diagnose: async () => ({ checks: [], readable: true }),
		diagnoseDirectory: async (name, dir) => [{ name, ok: true, detail: `${dir} is private` }]
	};
}

/** The backend under a fresh home, with its paths. */
function scheduler(
	fake: Fake,
	{
		refuse = () => false,
		stopTimeoutMs = 3000
	}: { refuse?: (path: string) => boolean; stopTimeoutMs?: number } = {}
) {
	const home = tempRoot();
	const local = join(home, 'AppData', 'Local');
	const service = serviceFor('win32', {
		home,
		env: { LOCALAPPDATA: local, LINE_MCP_LOCK_PORT: String(fake.port) },
		runner: fake.runner,
		stopTimeoutMs,
		startTimeoutMs: 1500,
		privacy: fakePrivacy(fake.events, refuse)
	});
	const dir = join(local, 'line-mcp', 'service');
	const logDir = join(local, 'line-mcp', 'logs');
	return {
		home,
		service,
		dir,
		launcher: join(dir, 'line-mcp.js'),
		xml: join(dir, 'line-mcp.xml'),
		logDir,
		log: join(logDir, 'daemon.log')
	};
}

const node = 'C:\\Program Files\\nodejs\\node.exe';
const cli = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\line-mcp-server\\dist\\cli.js';
const render = (service: Service) => service.render({ node, cli, env: {} });

/** The task as the restore table names it: `enabled, running` and so on, or `absent`. */
const taskState = ({ state }: Fake) =>
	state.exists
		? `${state.enabled ? 'enabled' : 'disabled'}, ${state.instances > 0 ? 'running' : 'idle'}`
		: 'absent';

describe('Task Scheduler (Windows)', { timeout: 15_000 }, () => {
	it('renders the launcher with every value as an ASCII JScript literal', async () => {
		const fake = await fakeScheduler();
		const { service, log } = scheduler(fake);
		const state = join(tempRoot(), 'a & (b) ! ü 日本');

		const launcher = service.render({
			node,
			cli,
			env: {
				LINE_MCP_HOME: state,
				LINE_MCP_PORT: '47900',
				LINE_MCP_NODE: 'C:\\elsewhere\\node.exe',
				PATH: 'C:\\Windows'
			}
		});

		expect(launcher).toMatch(/^[\x20-\x7e\n]*$/);
		expect(launcher).not.toContain('{{');
		const escaped = JSON.stringify(state).replace('ü', '\\u00fc').replace('日本', '\\u65e5\\u672c');
		expect(launcher).toContain(
			[
				"var shell = new ActiveXObject('WScript.Shell');",
				"var env = shell.Environment('Process');",
				'env("LINE_MCP_SERVICE") = "task";',
				`env("LINE_MCP_HOME") = ${escaped};`,
				'env("LINE_MCP_PORT") = "47900";',
				`WScript.Quit(shell.Run(${JSON.stringify(
					`"C:\\Windows\\System32\\cmd.exe" /d /v:off /s /c ""${node}" "${cli}" daemon >> "${log}" 2>&1"`
				)}, 0, true));`,
				''
			].join('\n')
		);
	});

	it.each([
		['a Node path with a quote', { node: 'C:\\a"b\\node.exe' }],
		['a CLI path with a %', { cli: 'C:\\%USERNAME%\\cli.js' }],
		['a state root with a line break', { env: { LINE_MCP_HOME: 'C:\\state\nx' } }]
	])('refuses to render %s', async (_kind, input) => {
		const { service } = scheduler(await fakeScheduler());

		expect(() => service.render({ node, cli, env: {}, ...input })).toThrow(
			expect.objectContaining({ code: 'unsupported_path' })
		);
	});

	it('installs: checks its directories, registers the task disabled, then runs it', async () => {
		const fake = await fakeScheduler();
		const paths = scheduler(fake);

		await paths.service.install(render(paths.service));

		expect(fake.events.filter((event) => event !== 'cscript')).toEqual([
			`privacy directory ${paths.dir}`,
			`privacy directory ${paths.logDir}`,
			// Before anything is stopped, written or opened; missing files pass.
			`privacy file ${paths.launcher}`,
			`privacy file ${paths.xml}`,
			`privacy file ${paths.log}`,
			'whoami',
			`privacy file ${paths.launcher}`,
			`privacy file ${paths.xml}`,
			`privacy file ${paths.log}`,
			`schtasks /Create /XML ${paths.xml} /F`,
			'schtasks /Change /Enable',
			'schtasks /Run'
		]);
		const [xml = ''] = fake.registered;
		for (const setting of [
			`<UserId>${sid}</UserId>`,
			'<LogonType>InteractiveToken</LogonType>',
			'<RunLevel>LeastPrivilege</RunLevel>',
			'<Interval>PT1M</Interval>',
			'<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
			'<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
			`<Command>${wscript}</Command>`,
			`<Arguments>//B //Nologo //E:JScript &quot;${paths.launcher}&quot;</Arguments>`
		]) {
			expect(xml).toContain(setting);
		}
		// Registered disabled: only the start enables it.
		expect(/<Settings>[\s\S]*<Enabled>false<\/Enabled>[\s\S]*<\/Settings>/.test(xml)).toBe(true);
		expect(readFileSync(paths.launcher, 'utf-8')).toBe(render(paths.service));
		expect(existsSync(paths.log)).toBe(true);
		expect([taskState(fake), fake.bound()]).toEqual(['enabled, running', true]);
	});

	it('reinstalls a running task: stops its daemon first, then starts a new one', async () => {
		const fake = await fakeScheduler({ initial: 'enabled, running' });
		const { service } = scheduler(fake);

		await service.install(render(service));

		expect(fake.schtasks()).toEqual([
			'/Change /Disable',
			expect.stringMatching(/^\/Create /),
			'/Change /Enable',
			'/Run'
		]);
		expect([fake.launched(), taskState(fake), fake.bound()]).toEqual([2, 'enabled, running', true]);
	});

	it('stops, writes and registers nothing when a directory is not private', async () => {
		const fake = await fakeScheduler({ initial: 'enabled, running' });
		const paths = scheduler(fake, { refuse: (path) => path === paths.logDir });

		await expect(paths.service.install(render(paths.service))).rejects.toMatchObject({
			code: 'insecure_directory'
		});
		expect(fake.schtasks()).toEqual([]);
		expect(readdirSync(paths.dir)).toEqual([]);
		expect([taskState(fake), fake.bound()]).toEqual(['enabled, running', true]);
	});

	it('stops and writes nothing when a file already there is not private', async () => {
		const fake = await fakeScheduler({ initial: 'enabled, running' });
		const paths = scheduler(fake, { refuse: (path) => path === paths.log });

		await expect(paths.service.install(render(paths.service))).rejects.toMatchObject({
			code: 'insecure_directory',
			message: expect.stringContaining('Nothing was stopped or written')
		});
		expect(fake.schtasks()).toEqual([]);
		expect(readdirSync(paths.dir)).toEqual([]);
		expect([taskState(fake), fake.bound()]).toEqual(['enabled, running', true]);
	});

	it('opens no log that failed its check, so a link creates nothing', async () => {
		const fake = await fakeScheduler();
		const paths = scheduler(fake, { refuse: (path) => path === paths.log });
		const outside = join(tempRoot(), 'outside.log');
		mkdirSync(paths.logDir, { recursive: true });
		symlinkSync(outside, paths.log, 'file');

		await expect(paths.service.install(render(paths.service))).rejects.toMatchObject({
			code: 'insecure_directory'
		});
		expect(existsSync(outside)).toBe(false);
	});

	it('keeps the stopped task disabled when a written file fails its check', async () => {
		const fake = await fakeScheduler({ initial: 'enabled, running' });
		// The log passes before the stop and fails once written.
		let logChecks = 0;
		const paths = scheduler(fake, { refuse: (path) => path === paths.log && ++logChecks > 1 });

		await expect(paths.service.install(render(paths.service))).rejects.toMatchObject({
			code: 'install_failed',
			message: expect.stringMatching(
				/^Checking the written files failed: .*; the scheduled task stays disabled\. Run line-mcp doctor, then line-mcp install$/
			)
		});
		expect(fake.schtasks()).toEqual(['/Change /Disable']);
		expect([taskState(fake), fake.launched()]).toEqual(['disabled, idle', 1]);
	});

	it('leaves everything as it was when the stop of an install fails', async () => {
		// An instance whose daemon cannot bind, beside a login that holds the port.
		const fake = await fakeScheduler({ initial: 'enabled, running', binds: false });
		const login = await acquireLock(fake.port);
		onTestFinished(() => login.release());
		const paths = scheduler(fake, { stopTimeoutMs: 1000 });

		await expect(paths.service.install(render(paths.service))).rejects.toMatchObject({
			code: 'stop_timeout',
			message: expect.stringContaining('the scheduled task is unchanged. Nothing was installed')
		});
		expect(existsSync(paths.launcher)).toBe(false);
		expect(fake.schtasks()).toEqual(['/Change /Disable', '/Change /Enable']);
		expect(taskState(fake)).toBe('enabled, running');
	});

	it('puts the previous task back when the registration fails', async () => {
		const fake = await fakeScheduler({
			initial: 'enabled, running',
			fault: (call) => (call === 'schtasks /Create' ? { exit: 1 } : undefined)
		});
		const { service } = scheduler(fake);

		await expect(service.install(render(service))).rejects.toMatchObject({
			code: 'install_failed',
			message: expect.stringMatching(
				/^Registering the scheduled task failed: .*; the scheduled task as it was before is back\. Run line-mcp install again$/
			)
		});
		expect([taskState(fake), fake.bound()]).toEqual(['enabled, running', true]);
	});

	it('keeps the new task registered and enabled when its daemon does not start', async () => {
		const fake = await fakeScheduler({ binds: false });
		const { service } = scheduler(fake);

		await expect(service.install(render(service))).rejects.toMatchObject({
			code: 'start_failed',
			message: expect.stringMatching(
				/^The daemon did not start within 1\.5 s \(last result 0x00041303\)\. See .*, then rerun line-mcp install or run line-mcp doctor$/
			)
		});
		expect(taskState(fake)).toBe('enabled, running');
	});

	it('never runs the task while another process holds the lock port', async () => {
		const fake = await fakeScheduler();
		const login = await acquireLock(fake.port);
		onTestFinished(() => login.release());
		const { service } = scheduler(fake);

		await expect(service.install(render(service))).rejects.toMatchObject({ code: 'lock_held' });
		expect(fake.schtasks()).toEqual([expect.stringMatching(/^\/Create /)]);
		expect(taskState(fake)).toBe('disabled, idle');
	});

	describe('stop for login and restore', () => {
		// The Windows column of the restore table.
		it.each([
			['enabled, running', ['/Change /Disable', '/Change /Enable', '/Run'], 'enabled, running'],
			['enabled, idle', ['/Change /Disable', '/Change /Enable'], 'enabled, idle'],
			['disabled, running', [], 'disabled, idle'],
			['disabled, idle', [], 'disabled, idle'],
			['absent', [], 'absent']
		] as const)('returns a task that was %s to its state', async (initial, calls, after) => {
			const fake = await fakeScheduler({ initial });
			const { service } = scheduler(fake);
			const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
			onTestFinished(() => warn.mockRestore());

			const restore = await service.stop();
			const during = [taskState(fake), await lockInUse(fake.port)];
			await restore();

			expect(during).toEqual([initial === 'absent' ? 'absent' : 'disabled, idle', false]);
			expect(fake.schtasks()).toEqual(calls);
			expect(taskState(fake)).toBe(after);
			expect(fake.bound()).toBe(after === 'enabled, running');
			// The one row that does not go back: a disabled task does not run again.
			expect(warn).toHaveBeenCalledTimes(initial === 'disabled, running' ? 1 : 0);
		});

		it('waits for a daemon that has not bound the lock port yet', async () => {
			const fake = await fakeScheduler({ initial: 'enabled, idle', bindDelayMs: 700 });
			const { service } = scheduler(fake);
			fake.launch();

			await service.stop();

			expect([taskState(fake), fake.launched(), await lockInUse(fake.port)]).toEqual([
				'disabled, idle',
				1,
				false
			]);
		});

		it('counts the task as stopped only once it reports state 1', async () => {
			// Disabled with no instance, but still reported as ready: not stopped yet.
			const ready = JSON.stringify({
				exists: true,
				state: 3,
				enabled: false,
				instances: 0,
				lastResult: 0,
				command: wscript,
				arguments: ''
			});
			const fake = await fakeScheduler({
				initial: 'enabled, idle',
				fault: (call, n) => (call === 'cscript' && n > 0 ? { stdout: `${ready}\r\n` } : undefined)
			});
			const { service } = scheduler(fake, { stopTimeoutMs: 1000 });

			await expect(service.stop()).rejects.toMatchObject({ code: 'stop_timeout' });
			expect(fake.schtasks()).toEqual(['/Change /Disable', '/Change /Enable']);
		});

		it('times out against a lock another process holds and enables the task again', async () => {
			const fake = await fakeScheduler({ initial: 'enabled, running', binds: false });
			const login = await acquireLock(fake.port);
			onTestFinished(() => login.release());
			const { service } = scheduler(fake, { stopTimeoutMs: 1000 });

			await expect(service.stop()).rejects.toMatchObject({
				code: 'stop_timeout',
				message: expect.stringContaining('the scheduled task is unchanged')
			});
			// The login keeps its lock; only the task's daemon is ever asked to stop.
			expect([taskState(fake), await lockInUse(fake.port)]).toEqual(['enabled, running', true]);
		});

		it('runs the login with the daemon stopped and starts it again', async () => {
			const fake = await fakeScheduler({ initial: 'enabled, running' });
			const paths = scheduler(fake);
			mkdirSync(paths.dir, { recursive: true });
			writeFileSync(paths.launcher, '');
			let during: unknown;

			await withServiceStopped(paths.service, async () => {
				during = [taskState(fake), await lockInUse(fake.port)];
			});

			expect(during).toEqual(['disabled, idle', false]);
			expect([taskState(fake), fake.bound()]).toEqual(['enabled, running', true]);
		});
	});

	describe('the state query', () => {
		const answer =
			'{"exists":true,"state":3,"enabled":true,"instances":0,"lastResult":0,"command":"","arguments":""}';
		// cscript exits 0 even after a script error, so only one well-formed line counts.
		it.each([
			['times out after a valid answer', { exit: 'timeout', stdout: `${answer}\r\n` }],
			['does not start', { exit: 'ENOENT', stdout: '' }],
			['prints nothing', { stdout: '' }],
			['prints two lines', { stdout: `${answer}\r\n${answer}\r\n` }],
			['prints a field more', { stdout: `${answer.slice(0, -1)},"x":1}\r\n` }],
			['reports a COM error', { stdout: '{"error":2147942405}\r\n' }]
		])('never takes an answer that %s as absent or stopped', async (_kind, reply: Fault) => {
			const fake = await fakeScheduler({
				initial: 'enabled, running',
				fault: (call) => (call === 'cscript' ? reply : undefined)
			});
			const { service } = scheduler(fake);

			await expect(service.stop()).rejects.toMatchObject({ code: 'task_scheduler_failed' });
			expect(fake.schtasks()).toEqual([]);
			expect(taskState(fake)).toBe('enabled, running');
		});

		it('takes only a not-found answer as absent', async () => {
			const fake = await fakeScheduler();
			const { service } = scheduler(fake);

			await (
				await service.stop()
			)();

			expect(fake.events).toEqual(['whoami', 'cscript']);
		});
	});

	describe('after a change fails or times out', () => {
		it('continues when the task reached the target state', async () => {
			const fake = await fakeScheduler({
				initial: 'enabled, running',
				fault: (call) =>
					call === 'schtasks /Change' ? { exit: 'timeout', landed: true } : undefined
			});
			const { service } = scheduler(fake);

			await service.stop();

			expect(taskState(fake)).toBe('disabled, idle');
		});

		it('fails and leaves the task as it was when it did not', async () => {
			const fake = await fakeScheduler({
				initial: 'enabled, running',
				fault: (call, n) => (call === 'schtasks /Change' && n === 0 ? { exit: 1 } : undefined)
			});
			const { service } = scheduler(fake);

			await expect(service.stop()).rejects.toMatchObject({
				code: 'task_scheduler_failed',
				message: expect.stringMatching(/\/Disable failed \(1\).*the scheduled task is unchanged/)
			});
			expect([taskState(fake), fake.bound()]).toEqual(['enabled, running', true]);
		});

		it('enables the task again when the query fails after the disable', async () => {
			const fake = await fakeScheduler({
				initial: 'enabled, running',
				fault: (call, n) => (call === 'cscript' && n === 1 ? { stdout: '' } : undefined)
			});
			const { service } = scheduler(fake);

			await expect(service.stop()).rejects.toMatchObject({ code: 'task_scheduler_failed' });
			expect(taskState(fake)).toBe('enabled, running');
		});

		it('fails as unknown when the rollback cannot read the task either', async () => {
			const fake = await fakeScheduler({
				initial: 'enabled, running',
				fault: (call, n) => (call === 'cscript' && n > 0 ? { stdout: '' } : undefined)
			});
			const { service } = scheduler(fake);

			await expect(service.stop()).rejects.toMatchObject({
				code: 'service_state_unknown',
				message: expect.stringContaining('Run line-mcp doctor')
			});
		});
	});

	describe('uninstall', () => {
		it('stops the daemon, deletes the task and removes its files', async () => {
			const fake = await fakeScheduler();
			const paths = scheduler(fake);
			await paths.service.install(render(paths.service));

			await paths.service.uninstall();

			expect(fake.schtasks().slice(3)).toEqual(['/Change /Disable', '/Delete /F']);
			expect([taskState(fake), await lockInUse(fake.port)]).toEqual(['absent', false]);
			expect(readdirSync(paths.dir)).toEqual([]);
		});

		it('puts the task back and removes nothing when the delete fails', async () => {
			const fake = await fakeScheduler({
				fault: (call) => (call === 'schtasks /Delete' ? { exit: 1 } : undefined)
			});
			const paths = scheduler(fake);
			await paths.service.install(render(paths.service));

			await expect(paths.service.uninstall()).rejects.toMatchObject({
				message: expect.stringContaining('as it was before is back. Nothing was removed')
			});
			expect([taskState(fake), fake.bound()]).toEqual(['enabled, running', true]);
			expect(existsSync(paths.launcher)).toBe(true);
		});
	});

	it('prints every step of a dry run and changes nothing', async () => {
		const fake = await fakeScheduler({ initial: 'enabled, running' });
		const paths = scheduler(fake);
		const lines: string[] = [];
		const log = vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line));
		onTestFinished(() => log.mockRestore());

		await paths.service.install(render(paths.service), { dryRun: true });
		await paths.service.uninstall({ dryRun: true });

		// Reading the user SID is all it does.
		expect(fake.events).toEqual(['whoami']);
		expect(readdirSync(paths.home)).toEqual([]);
		const printed = lines.join('\n');
		expect(printed).toContain(`would write ${paths.launcher}:\n${render(paths.service)}`);
		expect(printed).toContain('<Enabled>false</Enabled>');
		expect(lines.filter((line) => line.startsWith('would run: '))).toEqual([
			`would run: schtasks /Create /TN ${task} /XML ${paths.xml} /F`,
			`would run: schtasks /Change /TN ${task} /Enable`,
			`would run: schtasks /Run /TN ${task}`,
			`would run: schtasks /Delete /TN ${task} /F`
		]);
	});

	describe('doctor', () => {
		it('reports a task that is not registered, and the privacy of its files', async () => {
			const fake = await fakeScheduler();
			const paths = scheduler(fake);

			expect(await paths.service.diagnose()).toEqual([
				{
					name: 'scheduled_task',
					ok: false,
					detail: `${task} is not registered; run line-mcp install`
				},
				{ name: 'service_privacy', ok: true, detail: `${paths.dir} is private` },
				{ name: 'log_privacy', ok: true, detail: `${paths.logDir} is private` }
			]);
		});

		it('reports whether the task is enabled, runs this launcher and is running', async () => {
			const fake = await fakeScheduler();
			const paths = scheduler(fake);
			await paths.service.install(render(paths.service));
			fake.state.arguments = '//B //Nologo //E:JScript "C:\\old\\line-mcp.js"';

			const checks = await paths.service.diagnose();

			expect(checks.slice(0, 3)).toEqual([
				{ name: 'scheduled_task', ok: true, detail: `${task} is enabled` },
				{
					name: 'scheduled_task_action',
					ok: false,
					detail: expect.stringContaining(`not ${paths.launcher}; run line-mcp install`)
				},
				{ name: 'scheduled_task_running', ok: true, detail: `${task} is running` }
			]);
		});

		it('reads no launcher that is not private', async () => {
			const fake = await fakeScheduler();
			const paths = scheduler(fake, { refuse: (path) => path.endsWith('line-mcp.js') });
			mkdirSync(paths.dir, { recursive: true });
			writeFileSync(paths.launcher, 'launcher');

			await expect(paths.service.readDefinition()).rejects.toMatchObject({
				code: 'insecure_directory'
			});
		});
	});
});
