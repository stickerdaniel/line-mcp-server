// One world of the eval as an MCP server: the world loaded into its own state
// root, a session whose client never reaches LINE, and the production tool
// set exactly as the daemon serves it. `serve.ts` runs it from the command
// line.
import { archiveStatus } from '../src/archive.ts';
import { startMcpServer } from '../src/mcp/server.ts';
import { attachmentsDir } from '../src/paths.ts';
import { statePrivacy } from '../src/privacy.ts';
import { type Log, openSession } from '../src/session.ts';
import { Pool } from '../src/sync/loop.ts';
import { type LoadedWorld, loadWorld, offlineClient } from './load-world.ts';
import type { World } from './world-format.ts';

/** One line of the events file: a query the guard refused. */
export interface EvalEvent {
	time: string;
	event: 'query_denied';
	action: string;
	object: string;
}

export interface EvalServerOptions {
	world: World;
	/** The batch anchor date, YYYY-MM-DD in the world's zone. */
	anchor: string;
	/** A new, empty state root for the world. */
	root: string;
	/** 0 for any free port. */
	port: number;
	record: (event: EvalEvent) => void;
	/** Everything the session and the tools log. */
	log: Log;
}

export interface EvalServer {
	url: string;
	port: number;
	loaded: LoadedWorld;
	close(): Promise<void>;
}

/**
 * Loads the world and serves it with every read and mutating tool. A
 * mutating call goes through the outbox to the offline client, which
 * refuses it as it refuses every other LINE request.
 */
export async function startEvalServer(options: EvalServerOptions): Promise<EvalServer> {
	const loaded = await loadWorld(options.world, options.anchor, options.root);
	const log: Log = (entry) => {
		if (entry.event === 'query_denied') {
			options.record({
				time: new Date().toISOString(),
				event: 'query_denied',
				action: String(entry.action),
				object: String(entry.object)
			});
		}
		options.log(entry);
	};
	const privacy = statePrivacy();
	// The session restores as the daemon does; its client answers the profile
	// check locally and refuses everything else. Lock port 0 never meets the
	// daemon's lock.
	const session = await openSession({
		root: options.root,
		lockPort: 0,
		createClient: (storage) =>
			offlineClient(storage, {
				getProfile: () => ({ mid: loaded.selfMid, displayName: options.world.self.name })
			}),
		log,
		privacy
	});
	const server = await startMcpServer(
		{
			db: session.db,
			root: options.root,
			base: session.base,
			selfMid: loaded.selfMid,
			pool: new Pool(2),
			attachments: attachmentsDir(options.root),
			privacy,
			status: () => archiveStatus(session.db),
			log
		},
		{ port: options.port }
	).catch(async (error: unknown) => {
		await session.close();
		throw error;
	});
	return {
		url: server.url,
		port: server.port,
		loaded,
		close: async () => {
			await server.close();
			await session.close();
		}
	};
}
