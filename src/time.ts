// Times as tools show them (architecture, Time). Kept apart from the read
// helpers so the query runner, which registers `renderTime` as SQL
// `local_time`, loads nothing else.

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/**
 * UTC milliseconds as ISO 8601 at millisecond precision in the daemon's system
 * time zone with its numeric offset, for example `2026-10-12T10:15:00.000+05:45`,
 * so the string names one instant. The zone is read on every call, so a changed
 * `TZ` applies without a restart.
 */
export function renderTime(ms: number | null | undefined): string | null {
	if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return null;
	const date = new Date(ms);
	const offset = -date.getTimezoneOffset();
	const sign = offset < 0 ? '-' : '+';
	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
		`T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
		`.${pad(date.getMilliseconds(), 3)}` +
		`${sign}${pad(Math.trunc(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
	);
}

/** The IANA time zone that times are rendered in right now. */
export function timeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
