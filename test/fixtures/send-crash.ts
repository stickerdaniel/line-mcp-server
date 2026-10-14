// Child process: serves the MCP tools over the state root argv[2] with lock
// port argv[3]. With argv[4] `before`, the E2EE key lookup ahead of a send
// stalls; with `after`, LINE's sendMessage stalls once it was dispatched. Each
// prints a line when it stalls, and stays there until the parent kills it.
import { Buffer } from 'node:buffer';
import { archiveStatus } from '../../src/archive.ts';
import { startMcpServer } from '../../src/mcp/server.ts';
import { attachmentsDir } from '../../src/paths.ts';
import { statePrivacy } from '../../src/privacy.ts';
import { openSession } from '../../src/session.ts';
import { Pool } from '../../src/sync/loop.ts';
import { fakeUpstream, otherMid, selfMid } from '../fake-line.ts';

const [root, lockPort, mode] = process.argv.slice(2) as [string, string, string];
const stall = (line: string) => {
	console.log(line);
	return new Promise<never>(() => {});
};
const upstream = fakeUpstream({
	getProfile: () => ({ mid: selfMid }),
	negotiateE2EEPublicKey: async (_value, base) => {
		if (mode === 'before') return await stall('preparing');
		const keyData = String(await base.storage.get(`e2eePublicKeys:${otherMid}:5`));
		return { specVersion: 2, publicKey: { keyId: 5, keyData: Buffer.from(keyData, 'base64') } };
	},
	sendMessage: () => stall('dispatched')
});
const session = await openSession({
	root,
	lockPort: Number(lockPort),
	createClient: upstream.createClient,
	log: () => {}
});
const server = await startMcpServer(
	{
		db: session.db,
		base: session.base,
		selfMid,
		pool: new Pool(2),
		attachments: attachmentsDir(root),
		privacy: statePrivacy(),
		status: () => archiveStatus(session.db),
		log: () => {}
	},
	{ port: 0 }
);
console.log(`listening ${server.port}`);
