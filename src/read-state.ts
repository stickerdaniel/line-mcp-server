import type { DatabaseSync } from 'node:sqlite';
import type { Service } from './archive.ts';
import type { Log } from './session.ts';

// The account's own read position per chat (architecture, Read state). Every
// write goes through this module: markers only move forward, and LINE's own
// unread count belongs to the marker it was reported with.

/** A message ID LINE reports as a read position that cannot be stored. */
type RejectedMarker = { rejected: 'malformed' | 'non_canonical' };

/**
 * A read position as LINE reports it: a canonical decimal message ID (no
 * sign, no leading zero), null for 0, empty or absent (no position), or
 * rejected. Integers outside the safe range are only trusted as bigint or text.
 */
function parseMarker(value: unknown): string | null | RejectedMarker {
	if (value === undefined || value === null || value === '' || value === 0 || value === 0n) {
		return null;
	}
	if (typeof value === 'bigint') {
		return value > 0n ? value.toString() : { rejected: 'non_canonical' };
	}
	if (typeof value === 'number') {
		if (!Number.isSafeInteger(value)) return { rejected: 'malformed' };
		return value > 0 ? String(value) : { rejected: 'non_canonical' };
	}
	if (typeof value !== 'string') return { rejected: 'malformed' };
	if (value === '0') return null;
	if (/^[1-9]\d*$/.test(value)) return value;
	return /^[+-]?\d+$/.test(value) ? { rejected: 'non_canonical' } : { rejected: 'malformed' };
}

function isRejected(marker: string | null | RejectedMarker): marker is RejectedMarker {
	return typeof marker === 'object' && marker !== null;
}

/**
 * A read position LINE reported, as `parseMarker` reads it; one that cannot
 * be stored is logged by its kind and comes back as null.
 */
export function readMarker(log: Log | undefined, service: Service, value: unknown): string | null {
	const marker = parseMarker(value);
	if (!isRejected(marker)) return marker;
	log?.({ event: 'read_marker_ignored', service, kind: marker.rejected });
	return null;
}

/** LINE's unread count: a non-negative integer, null when absent or negative. */
function parseCount(value: unknown): number | null {
	if (typeof value === 'bigint') {
		return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
	}
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** SQL: canonical decimal `a` is numerically above canonical decimal `b`, by length, then text. */
export const above = (a: string, b: string) =>
	`(length(${a}) > length(${b}) OR (length(${a}) = length(${b}) AND ${a} > ${b}))`;

/** Stores `marker` as the chat's read position when it is above the stored one. */
export function advanceMarker(
	db: DatabaseSync,
	service: Service,
	chatId: string,
	marker: string,
	at: number
): void {
	db.prepare(
		`INSERT INTO read_state (service, chat_id, marker, marker_at) VALUES (?, ?, ?, ?)
		ON CONFLICT (service, chat_id) DO UPDATE SET marker = excluded.marker, marker_at = excluded.marker_at
		WHERE read_state.marker IS NULL OR ${above('excluded.marker', 'read_state.marker')}`
	).run(service, chatId, marker, at);
}

/**
 * One snapshot of a chat's read state, requested at `at`. The marker advances
 * as above, and a null marker never replaces a stored one. The count is kept
 * with the snapshot's marker when the snapshot is newer than the stored count,
 * so a slow answer to an earlier request cannot overwrite a newer count.
 */
export function observeSnapshot(
	db: DatabaseSync,
	service: Service,
	chatId: string,
	marker: string | null,
	count: number | null,
	at: number
): void {
	if (marker === null) {
		db.prepare(
			`INSERT INTO read_state (service, chat_id, marker, marker_at) VALUES (?, ?, NULL, ?)
			ON CONFLICT (service, chat_id) DO NOTHING`
		).run(service, chatId, at);
	} else {
		advanceMarker(db, service, chatId, marker, at);
	}
	db.prepare(
		`UPDATE read_state SET line_count = ?, count_marker = ?, count_at = ?
		WHERE service = ? AND chat_id = ? AND (count_at IS NULL OR count_at < ?)`
	).run(count, marker, at, service, chatId, at);
}

/**
 * A snapshot as LINE reports it, parsed and stored with `observeSnapshot`. A
 * marker that cannot be stored drops the snapshot and is logged by its kind.
 */
export function observeReported(
	db: DatabaseSync,
	log: Log,
	report: { service: Service; chatId: string; marker: unknown; count: unknown; at: number }
): void {
	const marker = parseMarker(report.marker);
	if (isRejected(marker)) {
		log({ event: 'read_marker_ignored', service: report.service, kind: marker.rejected });
		return;
	}
	observeSnapshot(db, report.service, report.chatId, marker, parseCount(report.count), report.at);
}
