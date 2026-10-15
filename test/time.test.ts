import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderTime } from '../src/time.ts';
import { callTool, serve } from './mcp-client.ts';

// Pinned before the imports load, so anything that captured the zone at import
// time would render Tokyo's +09:00 instead of the zone a test switches to.
const pinned = vi.hoisted(() => (process.env.TZ = 'Asia/Tokyo'));

afterEach(() => {
	process.env.TZ = pinned;
});

/** Renders `utc` while the process runs in `zone`. */
function renderIn(zone: string, utc: string) {
	process.env.TZ = zone;
	return renderTime(Date.parse(utc));
}

/** The offset `zone` has at `utc`, as Intl reports it: `+05:45`, `-04:00`. */
function offsetIn(zone: string, utc: string): string {
	const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
		.formatToParts(Date.parse(utc))
		.find((part) => part.type === 'timeZoneName')!.value;
	return name === 'GMT' ? '+00:00' : name.slice(3).replace('−', '-');
}

describe('local time', () => {
	it('names the same instant whatever the local zone', () => {
		const utc = '2026-10-12T04:30:00.123Z';

		for (const zone of ['UTC', 'America/New_York', 'Asia/Kathmandu']) {
			expect(Date.parse(renderIn(zone, utc)!)).toBe(Date.parse(utc));
		}
		expect(renderIn('UTC', utc)).toBe('2026-10-12T04:30:00.123+00:00');
	});

	it('uses the winter and the summer offset of the zone', () => {
		expect(renderIn('Europe/Berlin', '2026-01-15T04:30:00.123Z')).toBe(
			'2026-01-15T05:30:00.123+01:00'
		);
		expect(renderIn('Europe/Berlin', '2026-07-15T04:30:00.123Z')).toBe(
			'2026-07-15T06:30:00.123+02:00'
		);
	});

	it('tells the two 01:30 of a daylight saving end apart', () => {
		const before = renderIn('America/New_York', '2026-11-01T05:30:00.000Z');
		const after = renderIn('America/New_York', '2026-11-01T06:30:00.000Z');

		expect(before).toBe('2026-11-01T01:30:00.000-04:00');
		expect(after).toBe('2026-11-01T01:30:00.000-05:00');
		// Each local time still names its own instant.
		expect([Date.parse(before!), Date.parse(after!)]).toEqual([
			Date.parse('2026-11-01T05:30:00.000Z'),
			Date.parse('2026-11-01T06:30:00.000Z')
		]);
	});

	it('renders an offset that is not a whole hour', () => {
		expect(renderIn('Asia/Kathmandu', '2026-10-12T04:30:00.123Z')).toBe(
			'2026-10-12T10:15:00.123+05:45'
		);
	});

	it('names in status the zone its times use', async () => {
		const { server, session } = await serve();
		const syncedAt = '2026-11-01T06:30:00.000Z';
		session.db
			.prepare(`INSERT INTO sync_state (key, value, updated_at) VALUES ('talk:syncedAt', ?, 0)`)
			.run(String(Date.parse(syncedAt)));

		for (const zone of ['America/New_York', 'Asia/Kathmandu']) {
			process.env.TZ = zone;
			const { data } = await callTool(server.port, 'status', {});
			const local = (data.synced_at as { talk: string }).talk;

			expect(local.slice(-6)).toBe(offsetIn(data.time_zone as string, syncedAt));
			expect(offsetIn(data.time_zone as string, syncedAt)).toBe(offsetIn(zone, syncedAt));
		}
	});
});
