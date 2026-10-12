import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { databasePath } from './paths.ts';

const migrations = [
	`CREATE TABLE line_kv (
		key TEXT PRIMARY KEY,
		kind TEXT NOT NULL,
		value TEXT NOT NULL
	) STRICT;
	CREATE TABLE account (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		mid TEXT NOT NULL,
		device TEXT NOT NULL,
		linejs_version TEXT NOT NULL,
		auth_state TEXT NOT NULL CHECK (auth_state IN ('active', 'needs_login')),
		auth_changed_at TEXT NOT NULL,
		bound_at TEXT NOT NULL
	) STRICT;`
];

/** Opens the archive with a private directory (0700) and private files (0600). */
export function openDatabase(root: string): DatabaseSync {
	mkdirSync(root, { recursive: true, mode: 0o700 });
	chmodSync(root, 0o700);
	const path = databasePath(root);
	// SQLite gives the -wal and -shm files the mode of the main file.
	closeSync(openSync(path, 'a', 0o600));
	chmodSync(path, 0o600);
	const db = new DatabaseSync(path);
	try {
		db.exec('PRAGMA journal_mode = WAL');
		// FULL makes a committed token write survive power loss, not only a crash.
		db.exec('PRAGMA synchronous = FULL');
		db.exec('PRAGMA busy_timeout = 5000');
		migrate(db);
	} catch (error) {
		db.close();
		throw error;
	}
	return db;
}

export function migrate(db: DatabaseSync): void {
	const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
		user_version: number;
	};
	if (version > migrations.length) {
		throw new Error(`Database schema ${version} is newer than this line-mcp`);
	}
	for (let next = version; next < migrations.length; next++) {
		transaction(db, () => {
			db.exec(migrations[next]!);
			db.exec(`PRAGMA user_version = ${next + 1}`);
		});
	}
}

/** Runs `body` atomically; inside an open transaction it joins that one. */
export function transaction<T>(db: DatabaseSync, body: () => T): T {
	if (db.isTransaction) return body();
	db.exec('BEGIN IMMEDIATE');
	try {
		const result = body();
		db.exec('COMMIT');
		return result;
	} catch (error) {
		if (db.isTransaction) db.exec('ROLLBACK');
		throw error;
	}
}

export type AuthState = 'active' | 'needs_login';

export interface Account {
	mid: string;
	device: string;
	linejsVersion: string;
	authState: AuthState;
	authChangedAt: string;
	boundAt: string;
}

export function readAccount(db: DatabaseSync): Account | undefined {
	const row = db
		.prepare(
			`SELECT mid, device, linejs_version, auth_state, auth_changed_at, bound_at
			FROM account WHERE id = 1`
		)
		.get() as Record<string, string> | undefined;
	if (!row) return undefined;
	return {
		mid: row.mid!,
		device: row.device!,
		linejsVersion: row.linejs_version!,
		authState: row.auth_state as AuthState,
		authChangedAt: row.auth_changed_at!,
		boundAt: row.bound_at!
	};
}

/** Binds the account on first login, otherwise records a fresh login. */
export function bindAccount(
	db: DatabaseSync,
	account: { mid: string; device: string; linejsVersion: string },
	now = new Date().toISOString()
): void {
	db.prepare(
		`INSERT INTO account (id, mid, device, linejs_version, auth_state, auth_changed_at, bound_at)
		VALUES (1, ?, ?, ?, 'active', ?, ?)
		ON CONFLICT (id) DO UPDATE SET
			device = excluded.device,
			linejs_version = excluded.linejs_version,
			auth_state = 'active',
			auth_changed_at = excluded.auth_changed_at`
	).run(account.mid, account.device, account.linejsVersion, now, now);
}

export function setAuthState(
	db: DatabaseSync,
	state: AuthState,
	now = new Date().toISOString()
): void {
	db.prepare('UPDATE account SET auth_state = ?, auth_changed_at = ? WHERE id = 1').run(state, now);
}
