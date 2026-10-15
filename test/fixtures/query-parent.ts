// Child process: owns a query runner over the state root argv[2] and starts a
// runaway query in it, with a time limit far past any test. Prints
// `runner <pid>` once the query was sent, then waits until the parent kills it.
import { QueryRunner } from '../../src/mcp/tools/query.ts';
import { statePrivacy } from '../../src/privacy.ts';

const root = process.argv[2]!;
// Long enough that only the parent's death can end the runner during a test,
// short enough that a failed test leaves no runner behind for long.
const runner = new QueryRunner({ root, privacy: statePrivacy('linux'), timeoutMs: 30_000 });
const signal = new AbortController().signal;

await runner.query('SELECT 1', signal);
void runner.query(
	'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c',
	signal
);
// The query goes out on the next IPC write; the worker is busy right after.
setTimeout(() => console.log(`runner ${runner.pid}`), 200);
