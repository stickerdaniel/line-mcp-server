// Windows only: stands in for `line-mcp daemon` under the real scheduled task
// (test/service-e2e.test.ts), started by the launcher as `node task-daemon.ts
// daemon`. It waits 3 s before it binds the lock port, as a daemon still
// starting does, then holds the port until a stop request, which it accepts
// only when the task started it (LINE_MCP_SERVICE=task), as the daemon does.
// While another process (a login) holds the port, it retries every 250 ms.
// Prints `bound` and `stopped` to the task's log.
import { setTimeout as sleep } from 'node:timers/promises';
import { LineMcpError } from '../../src/errors.ts';
import { acquireLock, type OwnershipLock } from '../../src/lock.ts';

await sleep(3000);
const stop = Promise.withResolvers<void>();
const onStop = process.env.LINE_MCP_SERVICE === 'task' ? () => stop.resolve() : undefined;
let lock: OwnershipLock;
for (;;) {
	try {
		lock = await acquireLock(undefined, onStop);
		break;
	} catch (error) {
		if (!(error instanceof LineMcpError && error.code === 'lock_held')) throw error;
		await sleep(250);
	}
}
console.log('bound');
await stop.promise;
await lock.release();
console.log('stopped');
