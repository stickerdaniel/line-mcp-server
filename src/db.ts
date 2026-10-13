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
	) STRICT;`,
	// Archive. Integer LINE IDs and revisions are TEXT (decimal strings); times
	// are UTC milliseconds. `seq` comes from the single `change_counter` row.
	`CREATE TABLE sync_state (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	) STRICT;
	CREATE TABLE change_counter (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		value INTEGER NOT NULL
	) STRICT;
	INSERT INTO change_counter (id, value) VALUES (1, 0);
	CREATE TABLE chat (
		service TEXT NOT NULL CHECK (service IN ('talk', 'square')),
		chat_id TEXT NOT NULL,
		type TEXT NOT NULL,
		name TEXT,
		member_count INTEGER,
		last_activity_at INTEGER,
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (service, chat_id)
	) STRICT;
	CREATE TABLE participant (
		service TEXT NOT NULL CHECK (service IN ('talk', 'square')),
		participant_id TEXT NOT NULL,
		display_name TEXT,
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (service, participant_id)
	) STRICT;
	CREATE TABLE message (
		id INTEGER PRIMARY KEY,
		service TEXT NOT NULL CHECK (service IN ('talk', 'square')),
		chat_id TEXT NOT NULL,
		message_id TEXT NOT NULL,
		thread_id TEXT,
		sender TEXT,
		sent_at INTEGER,
		edited_at INTEGER,
		content_type TEXT,
		text TEXT,
		reply_to TEXT,
		mentions TEXT,
		envelope TEXT NOT NULL,
		decrypt_state TEXT NOT NULL CHECK (decrypt_state IN ('ok', 'missing_key', 'invalid')),
		missing_key TEXT,
		unsent INTEGER NOT NULL DEFAULT 0 CHECK (unsent IN (0, 1)),
		seq INTEGER NOT NULL UNIQUE,
		UNIQUE (service, chat_id, message_id)
	) STRICT;
	CREATE INDEX message_by_id ON message (service, message_id);
	CREATE INDEX message_by_time ON message (service, chat_id, sent_at, message_id);
	CREATE INDEX message_recent ON message (sent_at, id);
	CREATE INDEX message_missing_key ON message (decrypt_state) WHERE decrypt_state = 'missing_key';
	CREATE VIRTUAL TABLE message_fts USING fts5 (
		text, content = 'message', content_rowid = 'id', tokenize = 'trigram'
	);
	CREATE TRIGGER message_fts_insert AFTER INSERT ON message WHEN new.text IS NOT NULL BEGIN
		INSERT INTO message_fts (rowid, text) VALUES (new.id, new.text);
	END;
	CREATE TRIGGER message_fts_delete AFTER DELETE ON message WHEN old.text IS NOT NULL BEGIN
		INSERT INTO message_fts (message_fts, rowid, text) VALUES ('delete', old.id, old.text);
	END;
	CREATE TRIGGER message_fts_update AFTER UPDATE OF text ON message BEGIN
		INSERT INTO message_fts (message_fts, rowid, text)
			SELECT 'delete', old.id, old.text WHERE old.text IS NOT NULL;
		INSERT INTO message_fts (rowid, text) SELECT new.id, new.text WHERE new.text IS NOT NULL;
	END;
	CREATE TABLE coverage_gap (
		id INTEGER PRIMARY KEY,
		service TEXT NOT NULL CHECK (service IN ('talk', 'square')),
		scope TEXT NOT NULL,
		reason TEXT NOT NULL,
		detail TEXT NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('open', 'reconciled', 'incomplete')),
		opened_at INTEGER NOT NULL,
		closed_at INTEGER
	) STRICT;`,
	// Read order of one chat: send time (a tombstone without one sorts as 0),
	// then row id, so keyset pages never skip or repeat a row.
	`CREATE INDEX message_chat_order ON message (service, chat_id, coalesce(sent_at, 0), id);`,
	// Mutating actions by caller idempotency key (architecture, Outbox). The frozen
	// payload keeps message text only as its SHA-256, so no plaintext outlives
	// an unsend here (architecture, Tombstones); `payload_hash` covers the text.
	`CREATE TABLE outbox (
		idempotency_key TEXT PRIMARY KEY,
		operation TEXT NOT NULL CHECK (operation IN ('send_message', 'react', 'unsend')),
		service TEXT NOT NULL CHECK (service IN ('talk', 'square')),
		chat_id TEXT NOT NULL,
		thread_id TEXT,
		target_id TEXT,
		payload TEXT NOT NULL,
		payload_hash TEXT NOT NULL,
		state TEXT NOT NULL CHECK (state IN ('in_flight', 'sent', 'failed', 'unknown')),
		request_seq TEXT,
		message_id TEXT,
		correlation TEXT NOT NULL DEFAULT '{}',
		error TEXT,
		reconciled_by TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	) STRICT;
	CREATE INDEX outbox_message ON outbox (service, chat_id, message_id) WHERE message_id IS NOT NULL;
	CREATE INDEX outbox_in_flight ON outbox (state) WHERE state = 'in_flight';`,
	// Discovery looks up every archived sender still unnamed (architecture, Names).
	`CREATE INDEX message_sender ON message (service, sender);`,
	// Every own member MID discovery confirmed in a Square chat (architecture,
	// OpenChat adapter).
	`CREATE TABLE square_self_member (
		chat_id TEXT NOT NULL,
		member_id TEXT NOT NULL,
		confirmed_at INTEGER NOT NULL,
		PRIMARY KEY (chat_id, member_id)
	) STRICT;`
];

export const schemaVersion = migrations.length;

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
