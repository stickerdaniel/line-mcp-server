// Windows only: `node console-interrupt.ts <out file>`, started in a console
// of its own, as line-mcp runs in a terminal. Runs Node, waiting 10 s, once
// as a tool through the tool runner and once as a plain child on this
// console, then sends Ctrl-C to every process on the console, as the key
// does. Writes `{ interrupted, plain, tool }` as JSON to the out file: whether
// this process got SIGINT within 5 s, how the plain child exited, and the
// tool's result.
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { toolRunner } from '../../src/service/runner.ts';

const out = process.argv[2]!;
const interrupt = Promise.withResolvers<boolean>();
process.on('SIGINT', () => interrupt.resolve(true));

// Without the test seam: the runner starts this very command line itself.
const wait = ['-e', 'setTimeout(() => {}, 10_000)'];
const tool = toolRunner({}).run(process.execPath, wait, { timeoutMs: 30_000 });
const plain = spawn(process.execPath, wait, { stdio: 'ignore' });
const plainExit = once(plain, 'exit');
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

const interrupted = await Promise.race([interrupt.promise, sleep(5000, false)]);
const [code, signal] = (await plainExit) as [number | null, string | null];
writeFileSync(out, JSON.stringify({ interrupted, plain: code ?? signal, tool: await tool }));
process.exit(0);
