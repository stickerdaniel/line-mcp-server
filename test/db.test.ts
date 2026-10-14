import { statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.ts';
import { databasePath } from '../src/paths.ts';
import { SqliteStorage } from '../src/storage.ts';
import { tempRoot } from './fake-line.ts';

const mode = (path: string) => statSync(path).mode & 0o777;

describe('archive files', () => {
	// Windows has no POSIX modes; its private directories are ACL checks of their own.
	it.skipIf(process.platform === 'win32')(
		'keeps the state directory and every database file private',
		() => {
			const root = join(tempRoot(), 'line-mcp');
			const db = openDatabase(root);
			new SqliteStorage(db).setSync('authToken', 'token');

			const path = databasePath(root);
			expect([mode(root), mode(path), mode(`${path}-wal`), mode(`${path}-shm`)]).toEqual([
				0o700, 0o600, 0o600, 0o600
			]);
			db.close();
		}
	);
});
