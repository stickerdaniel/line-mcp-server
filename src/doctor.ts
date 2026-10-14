import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { archiveStatus } from './archive.ts';
import { openReadOnly, readAccount, schemaVersion } from './db.ts';
import { mapError } from './errors.ts';
import { lockInUse } from './lock.ts';
import { databasePath } from './paths.ts';
import type { StatePrivacy } from './privacy.ts';
import type { Service } from './service/index.ts';
import { nodeVersion, selectNode, supportedNode, versionedLayout } from './service/node.ts';
import { device } from './session.ts';

export interface Check {
	name: string;
	ok: boolean;
	/** Works now, but likely to break later; does not fail `doctor`. */
	warning?: boolean;
	detail: string;
}

/** Local checks only: nothing here calls LINE or changes the service. */
export async function doctor(input: {
	root: string;
	service: Service;
	/** Checks the state before the archive is read (file modes, or Windows access lists). */
	privacy: StatePrivacy;
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
		pathCheck('node_path', node, 'set LINE_MCP_NODE to a Node outside it'),
		pathCheck(
			'cli_path',
			input.cli,
			'install line-mcp-server with a Node outside it, then run line-mcp install'
		)
	);

	try {
		const sqlite = new DatabaseSync(':memory:');
		sqlite.exec(`CREATE VIRTUAL TABLE probe USING fts5 (text, tokenize = 'trigram')`);
		sqlite.close();
		checks.push({ name: 'fts5_trigram', ok: true, detail: 'available' });
	} catch {
		checks.push({ name: 'fts5_trigram', ok: false, detail: 'SQLite lacks FTS5 trigram' });
	}

	// Before the archive exists too: a first login on Windows refuses an
	// exposed state root and points here.
	const privacy = await input.privacy.diagnose(input.root);
	checks.push(...privacy.checks);
	const path = databasePath(input.root);
	if (!existsSync(path)) {
		checks.push({
			name: 'archive',
			ok: false,
			detail: `${path} does not exist; run line-mcp login`
		});
	} else if (privacy.readable) {
		// On Windows an archive that is not private is not read.
		checks.push(...archiveChecks(input.root));
	}

	const { service } = input;
	// Without a backend there is no definition to compare; diagnose says so.
	if (service.supported)
		checks.push(definitionCheck(service, { node, cli: input.cli, env: input.env }));
	checks.push(...(await service.diagnose()));
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

/** Whether the service definition on disk is the one `install` would write now. */
function definitionCheck(
	service: Service,
	input: { node: string; cli: string; env: NodeJS.ProcessEnv }
): Check {
	const { definition } = service.paths;
	const installed = existsSync(definition) ? readFileSync(definition, 'utf-8') : undefined;
	try {
		const expected = service.render(input);
		return {
			name: service.check,
			ok: installed === expected,
			detail:
				installed === undefined
					? `${definition} missing; run line-mcp install`
					: installed === expected
						? `${definition} matches this installation`
						: `${definition} differs from this installation; run line-mcp install`
		};
	} catch (error) {
		return { name: service.check, ok: false, detail: mapError(error, 'doctor').message };
	}
}

/** Schema, account and sync health, read from the archive in `root`. */
function archiveChecks(root: string): Check[] {
	const checks: Check[] = [];
	const db = openReadOnly(root);
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
	return checks;
}

/** A warning when `path` lies in a versioned install layout, which `remedy` avoids. */
function pathCheck(name: string, path: string, remedy: string): Check {
	const layout = versionedLayout(path);
	return layout
		? {
				name,
				ok: true,
				warning: true,
				detail: `${path} is in a versioned ${layout} directory that goes away with that version; ${remedy}`
			}
		: { name, ok: true, detail: `${path} is not in a known versioned directory` };
}

function time(value: number | null): string {
	return value === null ? 'never' : new Date(value).toISOString();
}
