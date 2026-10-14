import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		// Tests never reach LINE; each test gets its own temporary state root.
		environment: 'node',
		pool: 'forks',
		// On Windows every session open starts PowerShell for the privacy check,
		// which pushed tests that serve a session past 5 s on a CI runner.
		testTimeout: process.platform === 'win32' ? 15_000 : 5000
	}
});
