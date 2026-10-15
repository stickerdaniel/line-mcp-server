import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { FastMCP, type Logger } from '@prefecthq/fastmcp-ts/server';
import { LineMcpError } from '../errors.ts';
import { lockPort } from '../lock.ts';
import { Outbox } from '../outbox.ts';
import { Invocations, type ToolContext, registerTool } from './tool.ts';
import * as archiveTools from './tools/archive.ts';
import { QueryRunner, query } from './tools/query.ts';
import { react } from './tools/react.ts';
import { sendMessage } from './tools/send.ts';
import { unsend } from './tools/unsend.ts';
import * as upstreamTools from './tools/upstream.ts';

/** Default MCP port; the lock port (47821) is a different one. */
export const defaultMcpPort = 47822;
export const mcpPath = '/mcp';

export function mcpPort(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.LINE_MCP_PORT;
	const port = raw ? Number(raw) : defaultMcpPort;
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error('LINE_MCP_PORT must be a TCP port number');
	}
	if (port === lockPort(env)) {
		throw new Error('LINE_MCP_PORT must differ from the lock port');
	}
	return port;
}

export const readTools = [
	archiveTools.status,
	query,
	upstreamTools.getAttachment,
	upstreamTools.getAnnouncements,
	upstreamTools.getProfile
];

/** Tools that act on LINE, each through the outbox. */
export const mutatingTools = [sendMessage, react, unsend];

export interface McpServer {
	readonly port: number;
	readonly url: string;
	/**
	 * Stops listening, drops open connections, cancels every tool call and
	 * resolves once the port is free, every call has settled and the query
	 * runner has exited.
	 */
	close(): Promise<void>;
}

/** Framework diagnostics reach the daemon log as fixed text only, never with their metadata. */
function frameworkLogger(context: ToolContext): Logger {
	const forward = (level: string) => (message: string) =>
		context.log({ event: 'mcp_framework', level, message: message.slice(0, 200) });
	return { debug: () => {}, info: () => {}, warn: forward('warn'), error: forward('error') };
}

function refuse(res: ServerResponse, status: number, message: string): void {
	res
		.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
		.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/**
 * Serves the tools over Streamable HTTP on `127.0.0.1:<port>/mcp`. Opening the
 * outbox here is the startup step that turns an `in_flight` action left by a
 * stopped daemon into `unknown`.
 *
 * Prefect's own listener (`run()`) answers CORS preflights and attaches
 * `Access-Control-Allow-Origin: *` unless told otherwise, and its DNS-rebinding
 * guard accepts any localhost origin on any port
 * (`src/server/FastMCP.ts:2272-2300`, `docs/servers/running.mdx`). So this
 * listener is our own: it serves Prefect's stateless `fetch()` entry, which
 * keeps no session between requests and adds no CORS headers, behind checks
 * that run before any body is read. A request carrying an `Origin` header
 * (every browser request; native clients send none) or a `Host` other than
 * this exact listener is refused.
 */
export async function startMcpServer(
	context: ToolContext,
	options: { port?: number } = {}
): Promise<McpServer> {
	const mcp = new FastMCP({
		name: 'line-mcp',
		version: '0.0.0',
		http: { cors: false },
		logger: frameworkLogger(context),
		logLevel: 'warn'
	});
	const invocations = new Invocations();
	const served = {
		...context,
		outbox: new Outbox(context.db, { log: context.log }),
		// Started on the first query; `close` ends it.
		queries: new QueryRunner({
			root: context.root,
			privacy: context.privacy,
			...(context.queryTimeoutMs ? { timeoutMs: context.queryTimeoutMs } : {})
		})
	};
	for (const tool of [...readTools, ...mutatingTools]) {
		registerTool(mcp, served, tool, invocations);
	}

	const handler = toNodeHandler(
		{ fetch: (request, init) => mcp.fetch(request, init) },
		{
			maxRequestBodySize: 1024 * 1024,
			onerror: () => context.log({ event: 'mcp_request_failed' })
		}
	);
	let allowedHosts: Set<string> = new Set();
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		if (req.headers.origin !== undefined) return refuse(res, 403, 'Origin not allowed');
		if (!allowedHosts.has(req.headers.host ?? '')) return refuse(res, 403, 'Host not allowed');
		if ((req.url ?? '').split('?')[0] !== mcpPath) return refuse(res, 404, 'Not found');
		// A client that goes away before its answer cancels the tool call: queued
		// upstream work leaves the pool instead of dispatching for nobody.
		const request = new AbortController();
		res.once('close', () => {
			if (!res.writableFinished) {
				request.abort(new LineMcpError('cancelled', 'The client closed the request'));
			}
		});
		void invocations.serve(request.signal, () => handler(req, res));
	});
	// Idle keep-alive sockets go away soon; a dropped client cannot pin one.
	server.keepAliveTimeout = 5000;
	server.headersTimeout = 10_000;
	server.requestTimeout = 5 * 60 * 1000;
	server.on('clientError', (_error, socket) => socket.destroy());

	const port = options.port ?? mcpPort();
	try {
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
				server.off('error', reject);
				resolve();
			});
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
			throw new LineMcpError('mcp_port_in_use', `Another process holds the MCP port ${port}`);
		}
		throw new LineMcpError('mcp_port_failed', `Could not bind the MCP port ${port}`, {
			cause: error
		});
	}
	server.on('error', () => {});
	const bound = (server.address() as AddressInfo).port;
	allowedHosts = new Set([`127.0.0.1:${bound}`, `localhost:${bound}`]);

	let closed: Promise<void> | undefined;
	return {
		port: bound,
		url: `http://127.0.0.1:${bound}${mcpPath}`,
		close: () =>
			(closed ??= (async () => {
				const done = new Promise<void>((resolve) => server.close(() => resolve()));
				server.closeAllConnections();
				const settled = invocations.close();
				await done;
				await settled;
				await served.queries.close();
				await mcp.close();
			})())
	};
}
