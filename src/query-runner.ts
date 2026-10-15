// The process the `query` tool runs SQL in (src/mcp/tools/query.ts starts
// it), and, in a worker thread, the same file again. node:sqlite cannot
// interrupt a statement, and a worker busy in SQLite does not terminate, so
// the main thread owns the time limit and ends the whole process at it. It
// also ends the process when its IPC channel closes: a runaway statement
// never outlives the daemon or holds a WAL snapshot for nobody.
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { Guard, type QueryOutcome } from './query/guard.ts';

/** What the daemon sends: first `init`, then one `query` at a time. */
export type RunnerRequest =
	{ type: 'init'; root: string; timeoutMs: number } | { type: 'query'; id: number; sql: string };

/** What the runner answers; `init_failed` carries no message, which could name a path. */
export type RunnerReply =
	| { type: 'ready' }
	| { type: 'init_failed' }
	| { type: 'result'; id: number; outcome: QueryOutcome };

interface WorkerInit {
	root: string;
	heapLimitBytes: number;
}

/**
 * SQLite's hard heap limit for this process: a query that needs more fails
 * with an out-of-memory error, and the next one runs.
 */
const heapLimitBytes = 128 * 1024 * 1024;

/** Ends this process at once, the worker in the middle of a statement included. */
const die = () => process.kill(process.pid, 'SIGKILL');

if (isMainThread) {
	process.on('disconnect', die);
	let thread: Worker | undefined;
	let timeoutMs = 5000;
	let limit: NodeJS.Timeout | undefined;
	process.on('message', (request: RunnerRequest) => {
		if (request.type === 'init') {
			timeoutMs = request.timeoutMs;
			thread = new Worker(new URL(import.meta.url), {
				workerData: { root: request.root, heapLimitBytes } satisfies WorkerInit
			});
			thread.on('message', (reply: RunnerReply) => {
				if (reply.type === 'result') clearTimeout(limit);
				process.send?.(reply);
			});
			thread.on('error', die);
			thread.on('exit', die);
			return;
		}
		if (!thread) return die();
		limit = setTimeout(die, timeoutMs);
		// Nothing to transfer; a Worker takes no target origin, which oxlint asks for otherwise.
		thread.postMessage(request, []);
	});
} else {
	const port = parentPort!;
	const { root, heapLimitBytes: heapLimit } = workerData as WorkerInit;
	let guard: Guard | undefined;
	try {
		guard = new Guard(root, { heapLimitBytes: heapLimit });
		port.postMessage({ type: 'ready' } satisfies RunnerReply);
	} catch {
		port.postMessage({ type: 'init_failed' } satisfies RunnerReply);
	}
	port.on('message', (request: Extract<RunnerRequest, { type: 'query' }>) => {
		if (!guard) return;
		port.postMessage({
			type: 'result',
			id: request.id,
			outcome: guard.run(request.sql)
		} satisfies RunnerReply);
	});
}
