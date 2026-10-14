import { type ChildProcess, fork } from 'node:child_process';
import { z } from 'zod';
import { LineMcpError } from '../../errors.ts';
import { untilAborted } from '../../outbox.ts';
import { queryRunnerPath } from '../../paths.ts';
import type { StatePrivacy } from '../../privacy.ts';
import { maxSqlBytes, type QueryOutcome } from '../../query/guard.ts';
import { description, knownNames } from '../../query/surface.ts';
import type { RunnerReply, RunnerRequest } from '../../query-runner.ts';
import { defineTool } from '../tool.ts';

// The `query` tool: one read-only SQL statement over the archive, run by the
// guard (`src/query/guard.ts`) in a runner process (`src/query-runner.ts`)
// that this module starts, keeps and kills.

const defaultTimeoutMs = 5000;
/** How long a runner may take from its start to its ready connection. */
const defaultStartTimeoutMs = 15_000;
/** How long after the time limit the daemon kills a runner that did not end itself. */
const backstopMs = 1000;
/** Queries that wait while one runs; the next one is refused with `query_busy`. */
const maxWaiting = 4;

export interface QueryRunnerOptions {
	/** The state root whose archive the runner opens read-only. */
	root: string;
	/** Checked before every runner start, so the runner opens a private archive. */
	privacy: StatePrivacy;
	timeoutMs?: number;
	startTimeoutMs?: number;
}

interface Runner {
	child: ChildProcess;
	/** `TZ` as the runner got it; `local_time` renders in that zone. */
	zone: string | undefined;
}

const timedOut = (timeoutMs: number) =>
	new LineMcpError('query_timeout', `The query ran longer than ${timeoutMs} ms and was stopped`);

/**
 * The runner process of one MCP server, started on the first query and kept,
 * since a fresh one would pay the Windows privacy check on every query. One
 * query runs at a time and at most `maxWaiting` wait. A query past the time
 * limit, or one whose caller went away, ends the runner (node:sqlite cannot
 * interrupt a statement); the next query starts a fresh one. So does a
 * changed `TZ`, which keeps `local_time` in the daemon's zone.
 */
export class QueryRunner {
	readonly #root: string;
	readonly #privacy: StatePrivacy;
	readonly #timeoutMs: number;
	readonly #startTimeoutMs: number;
	readonly #children = new Set<ChildProcess>();
	#runner: Runner | undefined;
	#starting: Promise<Runner> | undefined;
	/** Settles when the last query that took a turn has finished. */
	#tail: Promise<void> = Promise.resolve();
	#pending = 0;
	#nextId = 0;
	#closed = false;

	constructor(options: QueryRunnerOptions) {
		this.#root = options.root;
		this.#privacy = options.privacy;
		this.#timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
		this.#startTimeoutMs = options.startTimeoutMs ?? defaultStartTimeoutMs;
	}

	/** The process ID of the ready runner, if there is one. */
	get pid(): number | undefined {
		return this.#runner?.child.pid;
	}

	/** Runs `sql` once the queries before it are done; `signal` cancels it while it waits, starts or runs. */
	async query(sql: string, signal: AbortSignal): Promise<QueryOutcome> {
		if (this.#closed) throw new LineMcpError('shutting_down', 'The query runner is closed');
		if (this.#pending > maxWaiting) {
			throw new LineMcpError(
				'query_busy',
				`One query runs and ${maxWaiting} wait already; try again when they are done`
			);
		}
		this.#pending++;
		const previous = this.#tail;
		const turn = Promise.withResolvers<void>();
		this.#tail = previous.then(() => turn.promise);
		try {
			await untilAborted(previous, signal);
			return await this.#run(sql, signal);
		} finally {
			turn.resolve();
			this.#pending--;
		}
	}

	/** Ends every runner, also one still starting, and resolves once all have exited. */
	async close(): Promise<void> {
		this.#closed = true;
		const children = [...this.#children];
		for (const child of children) child.kill('SIGKILL');
		await Promise.all(children.map((child) => exited(child)));
	}

	async #run(sql: string, signal: AbortSignal): Promise<QueryOutcome> {
		signal.throwIfAborted();
		const runner = await untilAborted(this.#ready(), signal);
		const { child } = runner;
		const id = ++this.#nextId;
		const sent = performance.now();
		return await new Promise<QueryOutcome>((resolve, reject) => {
			const settle = () => {
				clearTimeout(backstop);
				child.off('message', answered);
				child.off('exit', ended);
				child.off('error', failed);
				signal.removeEventListener('abort', aborted);
			};
			const fail = (error: unknown) => {
				settle();
				this.#discard(runner);
				reject(error);
			};
			const answered = (reply: RunnerReply) => {
				if (reply.type !== 'result' || reply.id !== id) return;
				settle();
				resolve(reply.outcome);
			};
			// The runner ends itself at the limit, which it counts from receiving the query.
			const ended = () =>
				fail(
					performance.now() - sent >= this.#timeoutMs
						? timedOut(this.#timeoutMs)
						: new LineMcpError('query_failed', 'The query runner stopped during the query')
				);
			const failed = () =>
				fail(new LineMcpError('query_failed', 'The query runner stopped during the query'));
			const aborted = () => fail(signal.reason);
			const backstop = setTimeout(
				() => fail(timedOut(this.#timeoutMs)),
				this.#timeoutMs + backstopMs
			);
			child.on('message', answered);
			child.once('exit', ended);
			child.once('error', failed);
			signal.addEventListener('abort', aborted, { once: true });
			child.send({ type: 'query', id, sql } satisfies RunnerRequest, (error) => {
				if (error) failed();
			});
		});
	}

	/** The ready runner, started first when there is none or `TZ` changed since its start. */
	#ready(): Promise<Runner> {
		const current = this.#runner;
		if (current && current.zone === process.env.TZ) return Promise.resolve(current);
		if (current) this.#discard(current);
		if (!this.#starting) {
			const starting = this.#start();
			this.#starting = starting;
			// Handles the rejection too: a start whose callers all went away settles
			// for nobody, and an unhandled rejection would end the daemon.
			const settled = () => {
				if (this.#starting === starting) this.#starting = undefined;
			};
			void starting.then(settled, settled);
		}
		return this.#starting;
	}

	async #start(): Promise<Runner> {
		await this.#privacy.database(this.#root);
		if (this.#closed) throw new LineMcpError('shutting_down', 'The query runner is closed');
		const child = fork(queryRunnerPath(), [], {
			// The runner writes nothing; its stderr could carry SQL in a crash report.
			stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
			execArgv: [],
			windowsHide: true
		});
		this.#children.add(child);
		const runner: Runner = { child, zone: process.env.TZ };
		child.once('exit', () => {
			this.#children.delete(child);
			if (this.#runner === runner) this.#runner = undefined;
		});
		// Without a listener an `error` (a failed spawn, kill or send) would end the daemon.
		child.on('error', () => this.#discard(runner));
		try {
			await new Promise<void>((resolve, reject) => {
				const fail = (message: string) => {
					settle();
					reject(new LineMcpError('query_failed', message));
				};
				const settle = () => {
					clearTimeout(deadline);
					child.off('message', answered);
					child.off('exit', ended);
					child.off('error', errored);
				};
				const answered = (reply: RunnerReply) => {
					if (reply.type === 'ready') {
						settle();
						resolve();
					} else fail('The query runner could not open the archive');
				};
				const ended = () => fail('The query runner exited while starting');
				const errored = () => fail('The query runner could not start');
				const deadline = setTimeout(
					() => fail('The query runner did not start in time'),
					this.#startTimeoutMs
				);
				child.on('message', answered);
				child.once('exit', ended);
				child.once('error', errored);
				child.send(
					{ type: 'init', root: this.#root, timeoutMs: this.#timeoutMs } satisfies RunnerRequest,
					(error) => {
						if (error) errored();
					}
				);
			});
		} catch (error) {
			this.#discard(runner);
			throw error;
		}
		if (this.#closed) {
			this.#discard(runner);
			throw new LineMcpError('shutting_down', 'The query runner is closed');
		}
		this.#runner = runner;
		return runner;
	}

	#discard(runner: Runner): void {
		if (this.#runner === runner) this.#runner = undefined;
		runner.child.kill('SIGKILL');
	}
}

function exited(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => child.once('exit', () => resolve()));
}

const input = z.object({
	sql: z
		.string()
		.min(1)
		.max(maxSqlBytes)
		.describe('One read-only SQLite statement: SELECT, or WITH ... SELECT')
});

export const query = defineTool({
	name: 'query',
	description,
	input,
	quotesArchive: true,
	run: async ({ sql }, context, signal) => {
		const outcome = await context.queries.query(sql, signal);
		if (outcome.ok) {
			return {
				columns: outcome.columns,
				rows: outcome.rows,
				...(outcome.truncated ? { truncated: true } : {})
			};
		}
		if (outcome.code === 'query_denied') {
			// Names outside the schema the guard knows could be anything the SQL said.
			context.log({
				event: 'query_denied',
				action: outcome.action,
				object: knownNames.has(outcome.object) ? outcome.object : 'other'
			});
		}
		throw new LineMcpError(outcome.code, outcome.message);
	}
});
