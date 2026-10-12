import { homedir } from 'node:os';
import { join } from 'node:path';

/** State root; `LINE_MCP_HOME` overrides it so tests never touch the real archive. */
export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
	return env.LINE_MCP_HOME || join(homedir(), 'Library', 'Application Support', 'line-mcp');
}

export function databasePath(root: string): string {
	return join(root, 'line.db');
}
