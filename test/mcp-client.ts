// A minimal Streamable HTTP client for tests: raw node:http requests, so a
// test controls every header (Host, Origin) a real client would send.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import { archiveStatus } from '../src/archive.ts';
import { startMcpServer, type McpServer } from '../src/mcp/server.ts';
import { openSession, type LogEntry, type Session } from '../src/session.ts';
import { Pool } from '../src/sync/loop.ts';
import {
	type FakeUpstream,
	fakeUpstream,
	freePort,
	type Handler,
	seedLive,
	selfMid,
	tempRoot
} from './fake-line.ts';

const open: { server: McpServer; session: Session }[] = [];
afterEach(async () => {
	for (const { server, session } of open.splice(0)) {
		await server.close();
		await session.close();
	}
});

export interface Served {
	root: string;
	session: Session;
	server: McpServer;
	upstream: FakeUpstream;
	logs: LogEntry[];
}

export interface ServeOptions {
	maxAttachmentBytes?: number;
	/** An existing state root, as left by an earlier server; a fresh one by default. */
	root?: string;
	/** Answers instead of `handlers` and `fetch`, for example at the HTTP layer. */
	upstream?: FakeUpstream;
	/** The server's upstream pool; two slots by default. */
	pool?: Pool;
}

/** The MCP server on a free port over a real session on a temporary state root. */
export async function serve(
	handlers: Record<string, Handler> = {},
	fetch?: (request: Request) => Promise<Response>,
	options: ServeOptions = {}
): Promise<Served> {
	const root = options.root ?? tempRoot();
	if (!options.root) seedLive(root, selfMid, { authToken: 'token' });
	const upstream =
		options.upstream ?? fakeUpstream({ getProfile: () => ({ mid: selfMid }), ...handlers }, fetch);
	const session = await openSession({
		root,
		lockPort: await freePort(),
		createClient: upstream.createClient,
		log: () => {}
	});
	const logs: LogEntry[] = [];
	const server = await startMcpServer(
		{
			db: session.db,
			base: session.base,
			selfMid,
			pool: options.pool ?? new Pool(2),
			attachments: join(root, 'attachments'),
			...(options.maxAttachmentBytes ? { maxAttachmentBytes: options.maxAttachmentBytes } : {}),
			status: () => archiveStatus(session.db),
			log: (entry) => void logs.push(entry)
		},
		{ port: 0 }
	);
	open.push({ server, session });
	// Setup calls are not what a test asserts on.
	upstream.calls.length = 0;
	return { root, session, server, upstream, logs };
}

export interface HttpResult {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

export function post(
	port: number,
	body: unknown,
	headers: Record<string, string> = {},
	method = 'POST'
): Promise<HttpResult> {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: '127.0.0.1',
				port,
				path: '/mcp',
				// A fresh connection each time, so a closed listener shows as refused.
				agent: false,
				method,
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream',
					...headers
				}
			},
			(res) => {
				let text = '';
				res.setEncoding('utf-8');
				res.on('data', (chunk: string) => (text += chunk));
				res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
			}
		);
		req.on('error', reject);
		req.end(method === 'POST' ? JSON.stringify(body) : undefined);
	});
}

/** The JSON-RPC message of a response, sent as JSON or as one SSE event. */
export function message(result: HttpResult): Record<string, unknown> {
	const data = result.body
		.split('\n')
		.filter((line) => line.startsWith('data: '))
		.map((line) => line.slice(6))
		.filter(Boolean)
		.at(-1);
	return JSON.parse(data ?? result.body) as Record<string, unknown>;
}

export interface ToolCall {
	isError: boolean;
	/** The structured result, or the parsed error text. */
	data: Record<string, unknown>;
	text: string;
}

let nextId = 1;

export async function callTool(
	port: number,
	name: string,
	args: Record<string, unknown> = {}
): Promise<ToolCall> {
	const response = message(
		await post(port, {
			jsonrpc: '2.0',
			id: nextId++,
			method: 'tools/call',
			params: { name, arguments: args }
		})
	);
	if (response.error) throw new Error(`tools/call ${name}: ${JSON.stringify(response.error)}`);
	const result = response.result as {
		isError?: boolean;
		structuredContent?: Record<string, unknown>;
		content: { type: string; text: string }[];
	};
	const text = result.content.map((block) => block.text).join('');
	return {
		isError: result.isError === true,
		data: result.structuredContent ?? (JSON.parse(text) as Record<string, unknown>),
		text
	};
}

export async function listTools(port: number) {
	const response = message(
		await post(port, { jsonrpc: '2.0', id: nextId++, method: 'tools/list' })
	);
	return (response.result as { tools: Tool[] }).tools;
}

export interface Tool {
	name: string;
	inputSchema: {
		type: 'object';
		properties?: Record<string, { type?: string; anyOf?: unknown[] }>;
		required?: string[];
	};
	annotations?: Record<string, unknown>;
}

/**
 * The CLI under test: the sources, or an installed `line-mcp` bin named by
 * `LINE_MCP_TEST_CLI` (scripts/smoke-pack.sh).
 */
export const cliEntry =
	process.env.LINE_MCP_TEST_CLI || fileURLToPath(new URL('../src/cli.ts', import.meta.url));

export interface CliRun {
	code: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Starts a `line-mcp` command against the MCP server on `port`, with a
 * temporary state root; `done` resolves once it exited and closed its output.
 */
export function startCli(port: number, args: string[], cwd?: string) {
	const child = spawn(process.execPath, [cliEntry, ...args], {
		cwd,
		env: { ...process.env, LINE_MCP_HOME: tempRoot(), LINE_MCP_PORT: String(port) },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf-8').on('data', (chunk: string) => (stdout += chunk));
	child.stderr.setEncoding('utf-8').on('data', (chunk: string) => (stderr += chunk));
	const done = once(child, 'close').then(([code]): CliRun => ({
		code: code as number | null,
		stdout,
		stderr
	}));
	return { child, done };
}

/** Runs a `line-mcp` command against the MCP server on `port` to its end. */
export const runCli = (port: number, args: string[], cwd?: string) =>
	startCli(port, args, cwd).done;
