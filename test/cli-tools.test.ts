import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { transaction } from '../src/db.ts';
import { Pool } from '../src/sync/loop.ts';
import { applyChanges, type MessageRow } from '../src/sync/normalize.ts';
import { freePort, otherMid, tempRoot } from './fake-line.ts';
import {
	callTool,
	cliEntry,
	listTools,
	runCli,
	serve,
	type Served,
	startCli
} from './mcp-client.ts';

/** Messages from the peer with `texts`, one minute apart. */
function store(served: Served, ...texts: string[]): void {
	const { db } = served.session;
	const rows = texts.map((text, index): MessageRow => ({
		service: 'talk',
		chatId: otherMid,
		chatType: 'user',
		messageId: String(index + 1),
		threadId: null,
		sender: otherMid,
		sentAt: Date.UTC(2026, 9, 12, 4, 30 + index),
		editedAt: null,
		contentType: 'NONE',
		text,
		replyTo: null,
		mentions: null,
		envelope: JSON.stringify({ id: String(index + 1) }),
		decryptState: 'ok',
		missingKey: null
	}));
	transaction(db, () =>
		applyChanges(
			db,
			rows.map((row) => ({ kind: 'message' as const, row }))
		)
	);
}

/** A listener on a free port that answers nothing useful and counts what reaches it. */
async function counter() {
	const seen = { port: 0, requests: 0 };
	const server = createServer((_req, res) => {
		seen.requests += 1;
		res.writeHead(500).end();
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
	seen.port = (server.address() as AddressInfo).port;
	return seen;
}

/** A pool that counts the calls waiting for a slot. */
class CountingPool extends Pool {
	waiting = 0;

	override async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		this.waiting += 1;
		let started = false;
		try {
			return await super.run(() => {
				started = true;
				this.waiting -= 1;
				return task();
			}, signal);
		} finally {
			if (!started) this.waiting -= 1;
		}
	}
}

/** The published command name of a tool. */
const commandOf = (tool: string) => (tool === 'status' ? 'sync-status' : tool.replaceAll('_', '-'));

// Each case starts the CLI, which loads the whole server on a cold start.
describe('tool commands', { timeout: 30_000 }, () => {
	it('prints the result the MCP tool returns', async () => {
		const served = await serve();
		store(served, '今晚晚餐吃什麼', '晚餐好了', '明天見', '晚餐在哪');
		const { port } = served.server;

		const run = await runCli(port, ['search-messages', '--query', '晚餐', '--limit', '2']);

		const expected = await callTool(port, 'search_messages', { query: '晚餐', limit: 2 });
		expect(run).toMatchObject({ code: 0, stderr: '' });
		expect(JSON.parse(run.stdout)).toEqual(expected.data);
		expect(expected.data.messages).toHaveLength(2);
	});

	it('exits quietly when the reader closes the pipe before the command ends', async () => {
		const { port } = (await serve()).server;

		// A shell pipe: `head` exits after one byte, while the command still closes its MCP session.
		const shell = spawn(
			'bash',
			[
				'-c',
				'"$0" "$1" sync-status | head -c 1 >/dev/null; echo "code=${PIPESTATUS[0]}"',
				process.execPath,
				cliEntry
			],
			{ env: { ...process.env, LINE_MCP_HOME: tempRoot(), LINE_MCP_PORT: String(port) } }
		);
		let stdout = '';
		let stderr = '';
		shell.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
		shell.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
		await once(shell, 'close');

		expect(stderr).toBe('');
		expect(stdout).toBe('code=0\n');
	});

	it('offers every served tool as a command, with its input fields as flags', async () => {
		const { port } = (await serve()).server;
		const tools = await listTools(port);
		const commands = tools.map((tool) => commandOf(tool.name));

		const help = await runCli(port, ['help']);
		const runs = await Promise.all(commands.map((command) => runCli(port, [command, '--help'])));

		for (const command of commands) expect(help.stdout).toMatch(new RegExp(`^  ${command} `, 'm'));
		const flags = runs.map((run) =>
			run.stdout
				.split('\n')
				.filter((line) => line.startsWith('  --'))
				.map((line) => [/^ {2}--([a-z-]+)/.exec(line)![1], line.endsWith(' (required)')])
		);
		expect(flags).toEqual(
			tools.map((tool) =>
				Object.keys(tool.inputSchema.properties ?? {}).map((field) => [
					field.replaceAll('_', '-'),
					tool.inputSchema.required?.includes(field) ?? false
				])
			)
		);
	});

	it.each([
		['an unknown flag', ['search-messages', '--query', '晚餐', '--sort', 'new'], "'--sort'"],
		['a missing required flag', ['search-messages', '--limit', '2'], '--query is required'],
		['a value outside the enum', ['list-chats', '--service', 'line'], '--service:'],
		['a non-integer', ['list-chats', '--limit', 'ten'], '--limit:'],
		['an integer out of range', ['list-chats', '--limit', '500'], '--limit:'],
		[
			'a time without an offset',
			['search-messages', '--query', '晚餐', '--since', '2026-10-12T06:30:00'],
			'--since:'
		],
		['a positional argument', ['list-chats', 'extra'], "'extra'"]
	])('refuses %s with exit 2 before any request', async (_case, args, names) => {
		const listener = await counter();

		const run = await runCli(listener.port, args);

		expect(run.code).toBe(2);
		expect(run.stdout).toBe('');
		expect(JSON.parse(run.stderr)).toMatchObject({
			error: { code: 'invalid_argument', message: expect.stringContaining(names) }
		});
		expect(listener.requests).toBe(0);
	});

	it('names the daemon setup commands when no daemon answers', async () => {
		const run = await runCli(await freePort(), ['sync-status']);

		expect(run.code).toBe(1);
		expect(run.stdout).toBe('');
		expect(JSON.parse(run.stderr)).toMatchObject({
			error: {
				code: 'daemon_unreachable',
				message: expect.stringMatching(/line-mcp doctor.*line-mcp install/)
			}
		});
	});

	it('prints a tool error whole, with its outbox state, on stderr and exits 1', async () => {
		// The fake LINE answers no E2EE key lookup, so the send fails before any message goes out.
		const served = await serve();

		const run = await runCli(served.server.port, [
			'send-message',
			'--service',
			'talk',
			'--chat-id',
			otherMid,
			'--idempotency-key',
			'failed-0001',
			'--text',
			'你好'
		]);

		expect(run.code).toBe(1);
		expect(run.stdout).toBe('');
		expect(JSON.parse(run.stderr)).toEqual({
			error: {
				code: 'internal_error',
				operation: 'send_message',
				message: 'Unexpected failure during send_message'
			},
			idempotency_key: 'failed-0001',
			state: 'failed',
			replayed: false
		});
		expect(served.upstream.calls).not.toContain('sendMessage');
	});

	it('cancels a queued call on Ctrl-C and exits 130', async () => {
		const { promise: gate, resolve: open } = Promise.withResolvers<void>();
		onTestFinished(() => open());
		const pool = new CountingPool(1);
		// The only slot stays busy, so the CLI's call waits in the queue.
		const held = pool.run(() => gate);
		const served = await serve({}, undefined, { pool });

		const cli = startCli(served.server.port, ['get-profile']);
		await vi.waitFor(() => expect(pool.waiting).toBe(1), { timeout: 10_000, interval: 10 });
		cli.child.kill('SIGINT');
		const run = await cli.done;

		expect(run).toMatchObject({ code: 130, stdout: '', stderr: '' });
		await vi.waitFor(() => expect(pool.waiting).toBe(0), { timeout: 5000, interval: 10 });
		expect(served.logs).toContainEqual(
			expect.objectContaining({ event: 'tool_failed', code: 'cancelled' })
		);
		open();
		await held;
		expect(served.upstream.calls).toEqual([]);
	});
});
