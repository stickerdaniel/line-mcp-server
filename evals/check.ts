// Checks every case's rubric without a model: loads each world through the
// production write paths (`load-world.ts`), runs the validator of the case's
// generation, and recounts every count rubric with SQL of its own on the
// loaded archive.
//
//   node evals/check.ts [--sets dev,holdout,...] [--anchor YYYY-MM-DD]
//
// The anchor is today in each world's zone unless --anchor names one date.
// Prints `<set> <case id> ok|mismatch`, the reason of a mismatch on stderr,
// and exits 1 unless every case is ok.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { databasePath } from '../src/paths.ts';
import { loadWorld, worldZone } from './load-world.ts';
import {
	type Archive,
	type Case,
	type CountFilter,
	type CountRule,
	readCases,
	setOf,
	sets,
	today,
	type Validator,
	worldOf
} from './sets.ts';
import type { At, MessageKind, World } from './world-format.ts';

const { values } = parseArgs({
	options: {
		sets: { type: 'string', default: Object.keys(sets).join(',') },
		anchor: { type: 'string' }
	},
	strict: true
});
const selected = values.sets.split(',');
for (const name of selected) setOf(name);

/** The filter fields the count check knows; a rule with any other is unsupported. */
const known = new Set<string>([
	'chats',
	'keys',
	'from',
	'notSelf',
	'thread',
	'kinds',
	'since',
	'until',
	'contains',
	'includeUnsent',
	'unread',
	'callType',
	'callResult'
] satisfies (keyof CountFilter)[]);

/** Content types the write path stores per world message kind. */
const contentTypes: Record<MessageKind, string> = {
	text: 'NONE',
	sticker: 'STICKER',
	image: 'IMAGE',
	video: 'VIDEO',
	audio: 'AUDIO',
	file: 'FILE',
	location: 'LOCATION',
	contact: 'CONTACT',
	call: 'CALL',
	flex: 'FLEX',
	chat_event: 'CHATEVENT'
};

/**
 * UTC milliseconds of the local time `at` in `zone`, found apart from the
 * loader's conversion: the one instant within 15 hours of the wall time,
 * on the quarter-hour grid every zone offset lies on, that the zone renders
 * as that wall time. `undefined` when none or two do.
 */
function instant(zone: string, anchor: string, at: At): number | undefined {
	const [y, mo, d] = ('date' in at ? at.date : anchor).split('-').map(Number) as [
		number,
		number,
		number
	];
	const [h, mi, s = 0] = at.time.split(':').map(Number) as [number, number, number?];
	const wall = Date.UTC(y, mo - 1, d - ('date' in at ? 0 : at.daysAgo), h, mi, s);
	const format = new Intl.DateTimeFormat('sv-SE', {
		timeZone: zone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	});
	const expected = new Date(wall).toISOString().slice(0, 19).replace('T', ' ');
	const found = [];
	for (let quarter = -60; quarter <= 60; quarter++) {
		const ms = wall - quarter * 15 * 60_000;
		if (format.format(ms) === expected) found.push(ms);
	}
	return found.length === 1 ? found[0] : undefined;
}

/** Each world built once at its anchor. */
const built = new Map<string, { world: World; anchor: string }>();
function worldAt(name: string): { world: World; anchor: string } {
	const cached = built.get(name);
	if (cached) return cached;
	const entry = worldOf(name);
	const anchor = values.anchor ?? today(entry.zone);
	const made = { world: entry.build(anchor), anchor };
	built.set(name, made);
	return made;
}

/** Each world loaded once into its own temporary state root. */
const archives = new Map<string, Promise<Archive & { root: string }>>();
function archive(name: string): Promise<Archive> {
	let pending = archives.get(name);
	if (!pending) {
		pending = (async () => {
			const { world: loadedWorld, anchor } = worldAt(name);
			const root = mkdtempSync(join(tmpdir(), 'line-mcp-check-'));
			try {
				const loaded = await loadWorld(loadedWorld, anchor, root);
				const db = new DatabaseSync(databasePath(root), { readOnly: true });
				// SQLite's lower() folds ASCII only; the oracles fold with JavaScript.
				db.function('js_lower', { deterministic: true }, (text) =>
					typeof text === 'string' ? text.toLowerCase() : null
				);
				return { world: loadedWorld, anchor, loaded, db, root };
			} catch (error) {
				rmSync(root, { recursive: true, force: true });
				throw error;
			}
		})();
		archives.set(name, pending);
	}
	return pending;
}

/**
 * The rule's message count by SQL on the archive; `undefined` for a filter
 * field it does not know or a bound it cannot place.
 */
function count(rule: CountRule, { world, anchor, loaded, db }: Archive): number | undefined {
	const filter = rule.filter ?? {};
	if (Object.keys(filter).some((field) => !known.has(field))) return undefined;
	const where: string[] = [];
	const params: SQLInputValue[] = [];
	const list = (items: readonly SQLInputValue[]) => {
		params.push(...items);
		return `(${items.map(() => '?').join(', ') || 'NULL'})`;
	};
	const selfIds = [loaded.selfMid, ...Object.values(loaded.members).flatMap((m) => m.self ?? [])];
	const idsOf = (person: string) =>
		[
			person === 'self' ? loaded.selfMid : loaded.people[person],
			...Object.values(loaded.members).map((members) => members[person])
		].filter((id): id is string => id !== undefined);
	const zone = rule.zone ?? worldZone(world);
	const bound = (at: At) => instant(zone, anchor, at);
	if (
		(filter.since && bound(filter.since) === undefined) ||
		(filter.until && bound(filter.until) === undefined)
	) {
		return undefined;
	}

	if (filter.chats) {
		where.push(
			`m.chat_id IN ${list(filter.chats.map((chat) => loaded.chats[chat]?.chatId ?? '-'))}`
		);
	}
	if (filter.keys) {
		where.push(
			`m.message_id IN ${list(filter.keys.map((key) => loaded.messages[key]?.messageId ?? '-'))}`
		);
	}
	if (filter.from !== undefined) where.push(`m.sender IN ${list(idsOf(filter.from))}`);
	if (filter.notSelf) where.push(`coalesce(m.sender, '') NOT IN ${list(selfIds)}`);
	if (filter.thread === null) where.push('m.thread_id IS NULL');
	else if (filter.thread !== undefined) {
		const member = world.messages.find((message) => message.thread === filter.thread);
		const thread = member ? loaded.messages[member.key]?.threadId : undefined;
		where.push(`m.thread_id = ?`);
		params.push(thread ?? '-');
	}
	if (filter.kinds)
		where.push(`m.content_type IN ${list(filter.kinds.map((kind) => contentTypes[kind]))}`);
	if (!filter.includeUnsent) where.push('m.unsent = 0');
	if (filter.callType) {
		where.push('lower(m.call_type) = ?');
		params.push(filter.callType.toLowerCase());
	}
	if (filter.callResult) {
		where.push('lower(m.call_result) = ?');
		params.push(filter.callResult.toLowerCase());
	}
	if (filter.contains !== undefined) {
		where.push(`m.content_type = 'NONE'`);
		for (const term of [filter.contains].flat()) {
			where.push('instr(js_lower(m.text), ?) > 0');
			params.push(term.toLowerCase());
		}
	}
	if (filter.since) {
		where.push('m.sent_at >= ?');
		params.push(bound(filter.since)!);
	}
	if (filter.until) {
		where.push('m.sent_at < ?');
		params.push(bound(filter.until)!);
	}
	if (filter.unread) {
		// After the read position by numeric message ID, from someone else, in
		// the main chat and not a tombstone; no unread at an unknown position.
		where.push(
			`EXISTS (SELECT 1 FROM read_state r WHERE r.service = m.service AND r.chat_id = m.chat_id
				AND r.marker IS NOT NULL
				AND (length(m.message_id) > length(r.marker)
					OR (length(m.message_id) = length(r.marker) AND m.message_id > r.marker)))`,
			`coalesce(m.sender, '') NOT IN ${list(selfIds)}`,
			'm.thread_id IS NULL',
			'm.unsent = 0'
		);
	}
	const sql = `SELECT count(*) AS n FROM message m${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
	return Number(db.prepare(sql).get(...params)!.n);
}

/** Why a case failed, in one line: the message and the first frame in the eval code. */
function reason(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const frame = error.stack
		?.split('\n')
		.find((line) => line.includes('/evals/') && !line.includes('/evals/check.ts'));
	return `${error.message.split('\n')[0]}${frame ? ` (${frame.trim()})` : ''}`;
}

let failed = 0;
try {
	// A generation's validator sees all its sets, for its checks across them,
	// and checks the cases of the selected ones.
	const generations = new Map<Validator, string[]>();
	for (const [name, entry] of Object.entries(sets)) {
		generations.set(entry.validate, [...(generations.get(entry.validate) ?? []), name]);
	}
	const errors = new Map<string, unknown>();
	for (const [validate, names] of generations) {
		if (!names.some((name) => selected.includes(name))) continue;
		const cases: Record<string, Case[]> = Object.fromEntries(
			names.map((name) => [name, readCases(setOf(name).file)])
		);
		const results = await validate({ cases, checked: new Set(selected), world: worldAt, archive });
		for (const result of results) {
			if (result.error !== undefined) errors.set(`${result.set}/${result.id}`, result.error);
		}
	}
	for (const name of selected) {
		const entry = setOf(name);
		for (const c of readCases(entry.file)) {
			let error = errors.get(`${name}/${c.id}`);
			if (error === undefined) {
				try {
					const loaded = await archive(c.world);
					const check = entry.rubric(c.id, loaded.world, loaded.anchor).check;
					if (check?.kind === 'count') {
						const rule = entry.rules[c.id];
						const counted = rule ? count(rule, loaded) : undefined;
						if (counted === undefined) error = 'the count check does not support this rule';
						else if (counted !== check.value) {
							error = `the archive counts ${counted}, the rubric ${String(check.value)}`;
						}
					}
				} catch (thrown) {
					error = thrown;
				}
			}
			if (error === undefined) {
				process.stdout.write(`${name} ${c.id} ok\n`);
			} else {
				failed++;
				process.stdout.write(`${name} ${c.id} mismatch\n`);
				process.stderr.write(`  ${name} ${c.id}: ${reason(error)}\n`);
			}
		}
	}
} finally {
	for (const pending of archives.values()) {
		const opened = await pending.catch(() => undefined);
		if (!opened) continue;
		opened.db.close();
		rmSync(opened.root, { recursive: true, force: true });
	}
}
process.exitCode = failed ? 1 : 0;
