import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseSync } from 'node:sqlite';
import type { BaseClient } from '@evex/linejs/base';
import { type FastMCP, ToolResult } from '@prefecthq/fastmcp-ts/server';
import { z } from 'zod';
import type { ArchiveStatus } from '../archive.ts';
import { LineMcpError, mapError } from '../errors.ts';
import { freshness, maxLimit } from '../queries.ts';
import type { Log } from '../session.ts';
import type { Pool } from '../sync/loop.ts';

/** What the tools work with: the daemon's archive, session client and upstream pool. */
export interface ToolContext {
	db: DatabaseSync;
	base: BaseClient;
	selfMid: string;
	/** The bounded pool history and media share (architecture, Upstream concurrency). */
	pool: Pool;
	/** Private directory (0700) that downloaded attachments go to. */
	attachments: string;
	/** Largest attachment download in bytes; 100 MiB by default. */
	maxAttachmentBytes?: number;
	/** Current health; cached reads report it in every result. */
	status(): ArchiveStatus;
	log: Log;
}

export const service = z
	.enum(['talk', 'square'])
	.describe('talk: one-to-one chats, groups and rooms; square: OpenChat');
export const chatId = z.string().min(1).max(100).describe('Chat ID from list_chats');
export const messageId = z
	.string()
	.regex(/^\d{1,20}$/)
	.describe('LINE message ID (decimal string)');
export const limit = z
	.number()
	.int()
	.min(1)
	.max(maxLimit)
	.optional()
	.describe(`Items per page, 1 to ${maxLimit}; default 50`);
export const cursor = z
	.string()
	.min(1)
	.max(1024)
	.optional()
	.describe('Continuation from a previous result of this tool with the same filters');

export interface ToolDefinition<S extends z.ZodObject> {
	name: string;
	description: string;
	input: S;
	/** True when the tool asks LINE rather than reading the archive. */
	upstream?: boolean;
	/** `signal` aborts when the client goes away or the server shuts down. */
	run: (args: z.output<S>, context: ToolContext, signal: AbortSignal) => Promise<object> | object;
}

/**
 * The tool calls in progress and their cancellation. The HTTP listener owns
 * each request, so it scopes a signal over the request's handling that aborts
 * when the client closes the connection; `close` aborts every call at once.
 * Prefect does not end a running handler when a Streamable HTTP client goes
 * away (`CancellationMiddleware` in its server.d.ts), hence this own signal.
 */
export class Invocations {
	readonly #scope = new AsyncLocalStorage<AbortSignal>();
	readonly #shutdown = new AbortController();
	readonly #running = new Set<Promise<unknown>>();

	/** Runs the handling of one HTTP request under `signal`. */
	serve<T>(signal: AbortSignal, handle: () => T): T {
		return this.#scope.run(AbortSignal.any([signal, this.#shutdown.signal]), handle);
	}

	/** Runs one tool call and keeps track of it until it settles. */
	async run<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const signal = this.#scope.getStore() ?? this.#shutdown.signal;
		const task = call(signal);
		const settled = task.then(
			() => {},
			() => {}
		);
		this.#running.add(settled);
		void settled.then(() => this.#running.delete(settled));
		return await task;
	}

	/** Aborts every call and resolves once all of them have settled. */
	async close(): Promise<void> {
		this.#shutdown.abort(new LineMcpError('shutting_down', 'The server is shutting down'));
		await Promise.all(this.#running);
	}
}

export function defineTool<S extends z.ZodObject>(
	definition: ToolDefinition<S>
): ToolDefinition<S> {
	return definition;
}

/**
 * Registers a read tool. Every result is an object envelope that reports the
 * archive's freshness. Every failure goes through the allowlisted mapper
 * (architecture, Errors): Prefect would otherwise return `err.message` as the
 * tool output, and LINEJS messages can carry response headers and body bytes.
 */
export function registerTool<S extends z.ZodObject>(
	server: FastMCP,
	context: ToolContext,
	definition: ToolDefinition<S>,
	invocations: Invocations
): void {
	server.tool(
		{
			name: definition.name,
			description: definition.description,
			input: definition.input,
			annotations: { readOnlyHint: true, openWorldHint: definition.upstream === true }
		},
		// Prefect validates the arguments with `input` before calling this.
		(args: Record<string, unknown>) =>
			invocations.run(async (signal) => {
				try {
					const result = await definition.run(args as z.output<S>, context, signal);
					return { ...freshness(context.status()), ...result };
				} catch (error) {
					const mapped = mapError(error, definition.name);
					context.log({ event: 'tool_failed', ...mapped });
					return new ToolResult({
						content: [{ type: 'text', text: JSON.stringify({ error: mapped }) }],
						isError: true
					});
				}
			})
	);
}
