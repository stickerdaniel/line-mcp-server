// Windows only: `node console-interrupt.ts <out file>`, started in a console
// of its own, as line-mcp runs in a terminal. Runs Node, waiting 60 s, once
// as a tool through the tool runner and once as a plain child on this
// console, then sends Ctrl-C to every process on the console, as the key
// does. Writes `{ interrupted, plain, tool }` as JSON to the out file: whether
// this process got SIGINT, how the plain child exited, and how the tool did,
// each `running` when it was still running a while after the Ctrl-C. The
// children end with this process (libuv's job object).
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { toolRunner } from '../../src/service/runner.ts';

const out = process.argv[2]!;
const interrupt = Promise.withResolvers<boolean>();
process.on('SIGINT', () => interrupt.resolve(true));

// Without the test seam: the runner starts this very command line itself.
const wait = ['-e', 'setTimeout(() => {}, 60_000)'];
const tool = toolRunner({})
	.run(process.execPath, wait, { timeoutMs: 120_000 })
	.then(({ exit }) => exit);
const plain = spawn(process.execPath, wait, { stdio: 'ignore' });
const plainExit = once(plain, 'exit').then(([code, signal]) => (code ?? signal) as number | string);
await sleep(1000);

const { PSModulePath: _modules, ...env } = process.env;
spawnSync(
	'powershell.exe',
	[
		'-NoProfile',
		'-NonInteractive',
		'-Command',
		'Add-Type -Namespace LineMcp -Name Console -MemberDefinition \'[DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint group);\'; [void][LineMcp.Console]::GenerateConsoleCtrlEvent(0, 0)'
	],
	{ env, stdio: 'ignore' }
);

// The Ctrl-C went out before spawnSync returned; the children got it then too.
const interrupted = await Promise.race([interrupt.promise, sleep(15_000, false)]);
const settled = (exit: Promise<number | string>) => Promise.race([exit, sleep(3000, 'running')]);
const result = { interrupted, plain: await settled(plainExit), tool: await settled(tool) };
writeFileSync(out, JSON.stringify(result));
process.exit(0);
