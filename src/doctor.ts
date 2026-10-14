import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { archiveStatus } from './archive.ts';
import { readAccount, schemaVersion } from './db.ts';
import { mapError } from './errors.ts';
import { lockInUse } from './lock.ts';
import { databasePath } from './paths.ts';
import type { Service } from './service/index.ts';
import { isCellarPath, nodeVersion, selectNode, supportedNode } from './service/node.ts';
import { device } from './session.ts';

export interface Check {
	name: string;
	ok: boolean;
	/** Works now, but likely to break later; does not fail `doctor`. */
	warning?: boolean;
	detail: string;
}

const mode = (path: string) => statSync(path).mode & 0o777;

/** Local checks only: nothing here calls LINE or changes the service. */
export async function doctor(input: {
	root: string;
	service: Service;
	env: NodeJS.ProcessEnv;
	/** The CLI entry `install` writes into the service definition. */
	cli: string;
	/** The Node `install` would write; selected like `install` when absent. */
	node?: string;
	nodeVersion?: string;
}): Promise<Check[]> {
	const checks: Check[] = [];
	let node: string;
	try {
		node = input.node ?? selectNode({ override: input.env.LINE_MCP_NODE }).path;
	} catch (error) {
		node = process.execPath;
		checks.push({ name: 'node_override', ok: false, detail: mapError(error, 'doctor').message });
	}
	const runs = input.nodeVersion ?? nodeVersion(node);
	checks.push(
		{
			name: 'node',
			ok: isAbsolute(node) && existsSync(node) && supportedNode(runs),
			detail: `${node} (v${runs ?? 'unknown'}, needs >= 24.18)`
		},
		isCellarPath(node)
			? {
					name: 'node_path',
					ok: true,
					warning: true,
					detail: `${node} is a versioned Cellar path that brew upgrade removes; set LINE_MCP_NODE or install the node@24 opt link`
				}
			: { name: 'node_path', ok: true, detail: 'stable across Homebrew upgrades' }
	);

	try {
		const sqlite = new DatabaseSync(':memory:');
		sqlite.exec(`CREATE VIRTUAL TABLE probe USING fts5 (text, tokenize = 'trigram')`);
		sqlite.close();
		checks.push({ name: 'fts5_trigram', ok: true, detail: 'available' });
	} catch {
		checks.push({ name: 'fts5_trigram', ok: false, detail: 'SQLite lacks FTS5 trigram' });
	}

	const path = databasePath(input.root);
	if (!existsSync(path)) {
		checks.push({
			name: 'archive',
			ok: false,
			detail: `${path} does not exist; run line-mcp login`
		});
	} else {
		checks.push({
			name: 'permissions',
			ok: mode(input.root) === 0o700 && mode(path) === 0o600,
			detail: `state root ${mode(input.root).toString(8)}, database ${mode(path).toString(8)}`
		});
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
				user_version: number;
			};
			checks.push({
				name: 'schema',
				ok: version === schemaVersion,
				detail: `version ${version} of ${schemaVersion}${version < schemaVersion ? ' (the daemon migrates on start)' : ''}`
			});
			const account = readAccount(db);
			checks.push({
				name: 'account',
				ok: account?.device === device && account.authState === 'active',
				detail: account
					? `${account.mid} on ${account.device}, ${account.authState}`
					: 'no account bound; run line-mcp login'
			});
			if (version >= 2) {
				const status = archiveStatus(db);
				checks.push({
					name: 'sync',
					ok: status.health === 'online' || status.health === 'catching_up',
					detail:
						`health ${status.health}, talk synced ${time(status.talkSyncedAt)}, ` +
						`square synced ${time(status.squareSyncedAt)}, ` +
						`${status.unreconciledGaps} unreconciled gap(s)`
				});
			}
		} finally {
			db.close();
		}
	}

	const { service } = input;
	const { definition } = service.paths;
	const expected = service.render({ node, cli: input.cli, env: input.env });
	const installed = existsSync(definition) ? readFileSync(definition, 'utf-8') : undefined;
	checks.push({
		name: service.check,
		ok: installed === expected,
		detail:
			installed === undefined
				? `${definition} missing; run line-mcp install`
				: installed === expected
					? `${definition} matches this installation`
					: `${definition} differs from this installation; run line-mcp install`
	});
	try {
		const loaded = await service.loaded();
		checks.push({
			name: `${service.check}_loaded`,
			ok: loaded,
			detail: loaded
				? `${service.label} is loaded`
				: `${service.label} is not loaded; run line-mcp install`
		});
	} catch (error) {
		checks.push({
			name: `${service.check}_loaded`,
			ok: false,
			detail: mapError(error, 'doctor').message
		});
	}
	const held = await lockInUse();
	checks.push({
		name: 'daemon',
		ok: held,
		detail: held
			? 'the lock port is held (daemon or login running)'
			: 'no process holds the lock port'
	});
	return checks;
}

function time(value: number | null): string {
	return value === null ? 'never' : new Date(value).toISOString();
}
