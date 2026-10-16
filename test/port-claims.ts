// Vitest global setup: a directory that every test worker of a run shares,
// where `freePort` (test/fake-line.ts) claims each port it hands out.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
	export interface ProvidedContext {
		portClaims: string;
	}
}

export default function claimPorts(project: TestProject): () => void {
	const dir = mkdtempSync(join(tmpdir(), 'line-mcp-ports-'));
	const remove = () => rmSync(dir, { recursive: true, force: true });
	project.provide('portClaims', dir);
	// Watch mode keeps this setup across reruns; each rerun is a new run.
	project.onTestsRerun(() => {
		remove();
		mkdirSync(dir);
	});
	// Vitest skips the teardown when a signal ends the run.
	process.once('exit', remove);
	return () => {
		process.off('exit', remove);
		remove();
	};
}
