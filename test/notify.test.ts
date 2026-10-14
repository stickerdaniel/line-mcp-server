import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { notifyLinux } from '../src/daemon.ts';
import { tempRoot, within } from './fake-line.ts';

const path = process.env.PATH;
afterEach(() => {
	process.env.PATH = path;
});

/** Puts a `notify-send` running `body` alone on PATH; returns the file its argv goes to. */
function notifySend(body: string): string {
	const dir = tempRoot();
	const argv = join(dir, 'argv');
	writeFileSync(join(dir, 'notify-send'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argv}'\n${body}\n`);
	chmodSync(join(dir, 'notify-send'), 0o755);
	process.env.PATH = dir;
	return argv;
}

// notify-send is a shell script here; Windows has neither.
describe.skipIf(process.platform === 'win32')('Linux notifications', () => {
	it('shows the fixed text under the line-mcp name', async () => {
		const argv = notifySend('exit 0');

		await notifyLinux('LINE ended the session.');

		expect(readFileSync(argv, 'utf-8')).toBe(
			'--app-name=line-mcp\nline-mcp\nLINE ended the session.\n'
		);
	});

	it.each([
		['fails', 'exit 1'],
		// A hung notification server must not hold the daemon's health update.
		['hangs', 'exec /bin/sleep 30']
	])('carries on when notify-send %s', async (_kind, body) => {
		notifySend(body);

		await within(6000, notifyLinux('text'), 'the notification');
	});

	it('carries on without notify-send', async () => {
		process.env.PATH = tempRoot();

		await expect(notifyLinux('text')).resolves.toBeUndefined();
	});
});
