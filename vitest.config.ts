import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		// Tests never reach LINE; each test gets its own temporary state root.
		environment: 'node',
		pool: 'forks'
	}
});
