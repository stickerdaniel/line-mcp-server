import { describe, expect, it } from 'vitest';
import { Pool } from '../src/sync/loop.ts';

function gate() {
	const { promise: opened, resolve: open } = Promise.withResolvers<void>();
	return { open, opened };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('pool', () => {
	it('runs at most `size` tasks at once', async () => {
		const pool = new Pool(2);
		const held = gate();
		let running = 0;
		let most = 0;
		const task = async () => {
			running += 1;
			most = Math.max(most, running);
			await held.opened;
			running -= 1;
		};
		const all = Promise.all(Array.from({ length: 5 }, () => pool.run(task)));
		await tick();
		expect(running).toBe(2);
		held.open();
		await all;
		expect(most).toBe(2);
	});

	it('drops a waiter whose signal aborts without running it or losing the slot', async () => {
		const pool = new Pool(1);
		const held = gate();
		const first = pool.run(() => held.opened);
		const controller = new AbortController();
		let ran = false;
		const queued = pool.run(async () => {
			ran = true;
		}, controller.signal);
		controller.abort(new Error('client gone'));
		await expect(queued).rejects.toThrow('client gone');

		held.open();
		await first;
		expect(await pool.run(async () => 'next')).toBe('next');
		expect(ran).toBe(false);
		await expect(pool.run(async () => {}, controller.signal)).rejects.toThrow('client gone');
	});

	it('fails every waiter once closed and resolves when the running task ends', async () => {
		const pool = new Pool(1);
		const held = gate();
		let ended = false;
		const first = pool.run(async () => {
			await held.opened;
			ended = true;
		});
		let ran = false;
		const queued = pool.run(async () => {
			ran = true;
		});
		const closed = pool.close(new Error('stopping'));
		await expect(queued).rejects.toThrow('stopping');
		await expect(pool.run(async () => {})).rejects.toThrow('stopping');

		let idle = false;
		void closed.then(() => (idle = true));
		await tick();
		expect(idle).toBe(false);
		held.open();
		await first;
		await closed;
		expect([ended, ran]).toEqual([true, false]);
	});
});
