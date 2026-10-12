// Serves the MCP tools from a throwaway archive for CLI generation. It never
// opens the real state root and never reaches LINE: the client refuses every
// request. Prints the MCP URL once listening; stops on SIGTERM or SIGINT.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseClient } from '@evex/linejs/base';
import { archiveStatus, upsertChat, upsertParticipant } from '../src/archive.ts';
import { openDatabase, transaction } from '../src/db.ts';
import { startMcpServer } from '../src/mcp/server.ts';
import { SqliteStorage } from '../src/storage.ts';
import { Pool } from '../src/sync/loop.ts';
import { applyChanges, encodeEnvelope } from '../src/sync/normalize.ts';

const selfMid = `u${'0'.repeat(32)}`;
const peerMid = `u${'1'.repeat(32)}`;

const root = mkdtempSync(join(tmpdir(), 'line-mcp-cli-'));
const db = openDatabase(root);
if (process.argv.includes('--seed')) {
	transaction(db, () => {
		upsertChat(db, { service: 'talk', chatId: peerMid, type: 'user' });
		upsertParticipant(db, 'talk', peerMid, '王小明');
		const sentAt = Date.UTC(2026, 9, 12, 4, 30);
		applyChanges(db, [
			{
				kind: 'message',
				row: {
					service: 'talk',
					chatId: peerMid,
					chatType: 'user',
					messageId: '100000000000000001',
					threadId: null,
					sender: peerMid,
					sentAt,
					editedAt: null,
					contentType: 'NONE',
					text: '今天晚上吃什麼？',
					replyTo: null,
					mentions: null,
					envelope: encodeEnvelope({ id: '100000000000000001' } as never),
					decryptState: 'ok',
					missingKey: null
				}
			}
		]);
	});
}
const base = new BaseClient({
	device: 'ANDROIDSECONDARY',
	storage: new SqliteStorage(db),
	fetch: async () => {
		throw new Error('the CLI fixture never reaches LINE');
	}
});
const portArg = process.argv.find((arg) => /^--port=\d+$/.test(arg));
const server = await startMcpServer(
	{
		db,
		base,
		selfMid,
		pool: new Pool(2),
		attachments: join(root, 'attachments'),
		status: () => archiveStatus(db),
		log: (entry) => process.stderr.write(`${JSON.stringify(entry)}\n`)
	},
	{ port: portArg ? Number(portArg.slice(7)) : 0 }
);
console.log(server.url);

await new Promise<void>((resolve) => {
	process.once('SIGTERM', resolve);
	process.once('SIGINT', resolve);
});
await server.close();
db.close();
rmSync(root, { recursive: true, force: true });
