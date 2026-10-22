// Validates the first generation (dev and holdout on w1, ood on w2): each
// world, each rule against an independent in-memory projection of its world,
// with a planted wrong count or list that must fail, and each checked rubric
// against the archive the production loader built. `check.ts` runs it.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { LoadedWorld } from '../../load-world.ts';
import type { Archive, CaseResult, Validator } from '../../sets.ts';
import type { At, World } from '../../world-format.ts';
import type { Rule, Rubric } from './oracles.ts';
import {
	daysBefore,
	rules as devRules,
	rubric as devRubric,
	select,
	secrets,
	personName
} from './oracles.ts';
import { rules as sealedRules, rubric as sealedRubric } from './sealed.ts';

const axes = ['kind', 'service', 'language', 'messageKind', 'time', 'size', 'ambiguity'];
const kinds = new Set([
	'text',
	'sticker',
	'image',
	'video',
	'audio',
	'file',
	'location',
	'contact',
	'call',
	'flex',
	'chat_event'
]);
// Independent timestamp calculation, deliberately not using oracle instant().
function millis(anchor: string, at: At, tokyo = false) {
	const [y, mo, d] = anchor.split('-').map(Number),
		[h, mi, s = 0] = at.time.split(':').map(Number);
	return Date.UTC(y!, mo! - 1, d! - daysBefore(at), h! - (tokyo ? 9 : 8), mi!, s);
}
function checkAt(at: At) {
	assert(Number.isInteger(daysBefore(at)) && daysBefore(at) >= 0 && daysBefore(at) < 60);
	assert.match(at.time, /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/);
}
export function validateWorld(world: World, anchor: string) {
	const persons = new Set(['self', ...world.people.map((p) => p.id)]);
	assert.equal(persons.size, world.people.length + 1);
	assert(world.self.name && world.people.every((p) => p.name));
	const chats = new Map(world.chats.map((c) => [c.id, c]));
	const messages = new Map(world.messages.map((m) => [m.key, m]));
	assert.equal(chats.size, world.chats.length);
	assert.equal(messages.size, world.messages.length);
	for (const c of world.chats) {
		assert(c.members.includes('self') && c.members.every((id) => persons.has(id)));
		assert.equal(new Set(c.members).size, c.members.length);
		if (c.kind === 'direct') assert.equal(c.members.length, 2);
		if (c.kind === 'openchat') assert(c.members.every((id) => c.nicknames?.[id]));
		if (c.readThrough) assert.equal(messages.get(c.readThrough)?.chat, c.id);
		if (c.lineUnread !== undefined) assert(Number.isInteger(c.lineUnread) && c.lineUnread >= 0);
	}
	for (const m of world.messages) {
		const c = chats.get(m.chat)!;
		assert(c && c.members.includes(m.from));
		assert(kinds.has(m.kind));
		checkAt(m.at);
		if (m.thread) {
			const root = messages.get(m.thread)!;
			assert(c.kind === 'openchat' && root && root.chat === m.chat && !root.thread);
			assert(millis(anchor, root.at) <= millis(anchor, m.at));
		}
		if (m.replyTo) {
			const target = messages.get(m.replyTo)!;
			assert(target && target.chat === m.chat && target.thread === m.thread);
		}
		if (m.mentions) assert(m.mentions.every((id) => c.members.includes(id)));
		if (m.edited) {
			checkAt(m.edited.at);
			assert(c.kind === 'openchat' && m.kind === 'text' && m.edited.text);
			assert(millis(anchor, m.edited.at) > millis(anchor, m.at));
		}
		assert(!(m.unsent && m.undecryptable));
		if (m.undecryptable) assert(c.kind !== 'openchat' && m.kind === 'text');
		if (m.kind === 'chat_event') {
			assert(m.event && m.text === undefined);
			if (m.event.members) assert(m.event.members.every((id) => c.members.includes(id)));
		}
		if (m.kind === 'call') assert(m.call?.type && m.call.result);
		if (m.durationMs !== undefined)
			assert(m.durationMs >= 0 && ['video', 'audio', 'call'].includes(m.kind));
		if (m.kind === 'file') assert(m.file && m.file.name && m.file.size >= 0);
		if (m.kind === 'location')
			assert(
				m.location && Number.isFinite(m.location.latitude) && Number.isFinite(m.location.longitude)
			);
		if (m.kind === 'contact') assert(m.contact?.name);
		assert(secrets.every((s) => !JSON.stringify(m).includes(s)));
	}
	assert(world.messages.some((m) => daysBefore(m.at) === 59));
	assert(world.messages.some((m) => daysBefore(m.at) === 0));
}
/** An independent, in-memory reference projection, not the production loader. */
function evidenceDb(world: World, anchor: string) {
	const db = new DatabaseSync(':memory:');
	db.exec(`CREATE TABLE evidence (key TEXT PRIMARY KEY, chat TEXT, sender TEXT, kind TEXT, thread TEXT, sent INTEGER, ordinal INTEGER, body TEXT, unsent INTEGER, locked INTEGER);
    CREATE TABLE positions (chat TEXT PRIMARY KEY, marker INTEGER, line_count INTEGER);`);
	const sorted = world.messages
		.map((m, index) => ({ m, index }))
		.toSorted((a, b) => millis(anchor, a.m.at) - millis(anchor, b.m.at) || a.index - b.index);
	const ordinals = new Map<string, number>();
	const insert = db.prepare('INSERT INTO evidence VALUES (?,?,?,?,?,?,?,?,?,?)');
	db.exec('BEGIN');
	sorted.forEach(({ m }, i) => {
		ordinals.set(m.key, i + 1);
		const text =
			m.kind === 'text' && !m.unsent && !m.undecryptable
				? m.edited
					? m.edited.text
					: (m.text ?? null)
				: null;
		insert.run(
			m.key,
			m.chat,
			m.from,
			m.kind,
			m.thread ?? null,
			millis(anchor, m.at),
			i + 1,
			text,
			m.unsent ? 1 : 0,
			m.undecryptable ? 1 : 0
		);
	});
	const position = db.prepare('INSERT INTO positions VALUES (?,?,?)');
	for (const c of world.chats) {
		const last = sorted.filter((x) => x.m.chat === c.id).at(-1)?.m.key;
		const marker = c.readThrough === null ? null : (ordinals.get(c.readThrough ?? last!) ?? null);
		position.run(c.id, marker, c.lineUnread ?? null);
	}
	db.exec('COMMIT');
	return db;
}
function referenceQuery(rule: Rule, anchor: string) {
	const f = rule.filter ?? {},
		clauses: string[] = [],
		params: (string | number)[] = [];
	const list = (column: string, values: string[]) => {
		clauses.push(`${column} IN (${values.map(() => '?').join(',')})`);
		params.push(...values);
	};
	if (f.chats) list('e.chat', f.chats);
	if (f.keys) list('e.key', f.keys);
	if (f.from) {
		clauses.push('e.sender = ?');
		params.push(f.from);
	}
	if (f.notSelf) {
		clauses.push('e.sender != ?');
		params.push('self');
	}
	if (f.thread === null) clauses.push('e.thread IS NULL');
	else if (f.thread !== undefined) {
		clauses.push('e.thread = ?');
		params.push(f.thread);
	}
	if (f.kinds) list('e.kind', f.kinds);
	if (!f.includeUnsent) clauses.push('e.unsent = 0');
	if (f.since) {
		clauses.push('e.sent >= ?');
		params.push(millis(anchor, f.since, rule.zone === 'Asia/Tokyo'));
	}
	if (f.until) {
		clauses.push('e.sent < ?');
		params.push(millis(anchor, f.until, rule.zone === 'Asia/Tokyo'));
	}
	for (const term of f.contains ?? []) {
		clauses.push('instr(lower(e.body), lower(?)) > 0');
		params.push(term);
	}
	if (f.unread) {
		clauses.push('e.ordinal > p.marker AND e.thread IS NULL AND e.unsent = 0 AND e.sender != ?');
		params.push('self');
	}
	return {
		sql: `FROM evidence e LEFT JOIN positions p ON p.chat = e.chat WHERE ${clauses.join(' AND ') || '1'}`,
		params
	};
}

export function validateRule(
	rule: Rule,
	world: World,
	anchor: string,
	expected: Rubric,
	db: DatabaseSync
) {
	const refs = new Map(world.messages.map((m) => [m.key, m]));
	for (const key of [
		...(rule.must ?? []),
		...(rule.not ?? []),
		...(rule.guards?.map((g) => g.key) ?? []),
		...(rule.filter?.keys ?? []),
		...(rule.attack ? [rule.attack] : [])
	])
		assert(refs.has(key));
	for (const id of [...(rule.filter?.chats ?? []), ...(rule.chat ? [rule.chat] : [])])
		assert(world.chats.some((c) => c.id === id));
	if (rule.filter?.from)
		assert(rule.filter.from === 'self' || world.people.some((p) => p.id === rule.filter!.from));
	if (rule.filter?.thread) assert(refs.has(rule.filter.thread));
	for (const g of rule.guards ?? []) {
		const m = refs.get(g.key)!;
		if (g.chat !== undefined) assert.equal(m.chat, g.chat);
		if (g.from !== undefined) assert.equal(m.from, g.from);
		if (g.kind !== undefined) assert.equal(m.kind, g.kind);
		if (g.thread !== undefined) assert.equal(m.thread ?? null, g.thread);
		if (g.unsent !== undefined) assert.equal(Boolean(m.unsent), g.unsent);
		if (g.undecryptable !== undefined) assert.equal(Boolean(m.undecryptable), g.undecryptable);
		if (g.edited !== undefined) assert.equal(Boolean(m.edited), g.edited);
		if (g.at) assert.deepEqual(m.at, g.at);
	}
	assert(expected.required.length > 0 && expected.forbidden.length >= 2);
	if (rule.mode === 'secret') {
		assert(!expected.check);
		return;
	}
	if (rule.mode === 'unknown-read') {
		const c = world.chats.find((entry) => entry.id === rule.chat)!;
		assert.equal(c.readThrough, null);
		assert.equal(db.prepare('SELECT marker FROM positions WHERE chat = ?').get(c.id)?.marker, null);
		assert(!expected.check);
		return;
	}
	const q = referenceQuery(rule, anchor);
	const rows = db
		.prepare(`SELECT e.key, e.chat, e.sender ${q.sql} ORDER BY e.key`)
		.all(...q.params);
	const keys = rows.map((r) => String(r.key));
	for (const key of rule.must ?? []) assert(keys.includes(key));
	for (const key of rule.not ?? []) assert(!keys.includes(key));
	assert(keys.length > 0);
	if (rule.minRows) assert(keys.length >= rule.minRows);
	const selection = select(rule, world, anchor);
	assert.deepEqual(selection.map((m) => m.key).toSorted(), keys);
	if (expected.check?.kind === 'count')
		assert.equal(
			db.prepare(`SELECT count(*) AS n ${q.sql}`).get(...q.params)?.n,
			expected.check.value
		);
	else if (rule.mode === 'distinct-chats')
		assert.deepEqual(
			db
				.prepare(`SELECT DISTINCT e.chat ${q.sql} ORDER BY e.chat`)
				.all(...q.params)
				.map((r) => String(r.chat)),
			expected.check?.value
		);
	else assert.deepEqual(keys, expected.check?.value);
	if (rule.mode === 'rank') {
		const counts = db
			.prepare(
				`SELECT e.sender, count(*) AS n ${q.sql} GROUP BY e.sender ORDER BY n DESC, e.sender`
			)
			.all(...q.params);
		assert(counts.length > 1 && Number(counts[0]!.n) > Number(counts[1]!.n));
		for (const r of counts)
			assert(
				expected.required.some((s) =>
					s.includes(`${personName(world, String(r.sender), selection[0]!.chat)} = ${r.n}`)
				)
			);
	}
	if (rule.distinctAlso) {
		const n = db.prepare(`SELECT count(DISTINCT e.chat) AS n ${q.sql}`).get(...q.params)!.n;
		assert(expected.required.some((s) => s.includes(`exactly ${n} distinct chats`)));
	}
	if (rule.filter?.unread)
		for (const id of rule.filter.chats ?? []) {
			const c = world.chats.find((entry) => entry.id === id)!;
			assert(typeof c.readThrough === 'string' && refs.get(c.readThrough)?.chat === id);
			if (rule.lineCount) assert(c.lineUnread !== undefined && c.lineUnread !== rows.length);
		}
	if (rule.mode === 'unanswerable')
		assert(
			selection.every(
				(m) => m.undecryptable || m.unsent || ['audio', 'video', 'image'].includes(m.kind)
			)
		);
	if (rule.nickname)
		assert(selection.every((m) => personName(world, m.from) !== personName(world, m.from, m.chat)));
	if (rule.attack) {
		const m = refs.get(rule.attack)!;
		assert(m.kind === 'text' && !m.unsent && !m.undecryptable && m.text?.includes('AI'));
		assert(rule.filter?.chats?.includes(m.chat) && !keys.includes(rule.attack));
	}
}
function archiveQuery(rule: Rule, world: World, loaded: LoadedWorld, anchor: string) {
	const f = rule.filter ?? {},
		clauses: string[] = [],
		params: (string | number)[] = [];
	const inList = (column: string, values: string[]) => {
		clauses.push(`${column} IN (${values.map(() => '?').join(',')})`);
		params.push(...values);
	};
	if (f.chats) {
		clauses.push(`(${f.chats.map(() => '(m.service = ? AND m.chat_id = ?)').join(' OR ')})`);
		for (const id of f.chats) params.push(loaded.chats[id]!.service, loaded.chats[id]!.chatId);
	}
	if (f.keys)
		inList(
			'm.message_id',
			f.keys.map((key) => loaded.messages[key]!.messageId)
		);
	if (f.from) {
		const identities = [
			f.from === 'self' ? loaded.selfMid : loaded.people[f.from]!,
			...Object.values(loaded.members).flatMap((ms) => (ms[f.from!] ? [ms[f.from!]!] : []))
		];
		inList('m.sender', identities);
	}
	if (f.notSelf || f.unread) {
		clauses.push(
			'NOT ((m.service = ? AND m.sender = ?) OR (m.service = ? AND EXISTS (SELECT 1 FROM square_self_member own WHERE own.chat_id = m.chat_id AND own.member_id = m.sender)))'
		);
		params.push('talk', loaded.selfMid, 'square');
	}
	if (f.thread === null) clauses.push('m.thread_id IS NULL');
	else if (f.thread !== undefined) {
		const child = world.messages.find((m) => m.thread === f.thread)!;
		clauses.push('m.thread_id = ?');
		params.push(loaded.messages[child.key]!.threadId!);
	}
	if (f.kinds)
		inList(
			'm.content_type',
			f.kinds.map((k) =>
				k === 'text' ? 'NONE' : k === 'chat_event' ? 'CHATEVENT' : k.toUpperCase()
			)
		);
	if (!f.includeUnsent) clauses.push('m.unsent = 0');
	if (f.since) {
		clauses.push('m.sent_at >= ?');
		params.push(millis(anchor, f.since, rule.zone === 'Asia/Tokyo'));
	}
	if (f.until) {
		clauses.push('m.sent_at < ?');
		params.push(millis(anchor, f.until, rule.zone === 'Asia/Tokyo'));
	}
	if (f.contains) {
		clauses.push('m.content_type = ?');
		params.push('NONE');
	}
	for (const term of f.contains ?? []) {
		clauses.push('instr(lower(m.text), lower(?)) > 0');
		params.push(term);
	}
	if (f.unread)
		clauses.push(
			'r.marker IS NOT NULL AND (length(m.message_id) > length(r.marker) OR (length(m.message_id) = length(r.marker) AND m.message_id > r.marker)) AND m.thread_id IS NULL AND m.unsent = 0'
		);
	return {
		sql: `FROM message m LEFT JOIN read_state r ON r.service = m.service AND r.chat_id = m.chat_id WHERE ${clauses.join(' AND ') || '1'}`,
		params
	};
}
function verifyLoadedWorld(world: World, loaded: LoadedWorld, db: DatabaseSync, anchor: string) {
	assert.equal(db.prepare('SELECT count(*) AS n FROM message').get()!.n, world.messages.length);
	assert.equal(db.prepare('SELECT count(*) AS n FROM chat').get()!.n, world.chats.length);
	const rowFor = db.prepare(
		'SELECT * FROM message WHERE service = ? AND chat_id = ? AND message_id = ?'
	);
	const personFor = db.prepare(
		'SELECT display_name FROM participant WHERE service = ? AND participant_id = ?'
	);
	const sorted = world.messages
		.map((m, index) => ({ m, index }))
		.toSorted((a, b) => millis(anchor, a.m.at) - millis(anchor, b.m.at) || a.index - b.index);
	for (const c of world.chats) {
		const loc = loaded.chats[c.id]!;
		const chat = db
			.prepare('SELECT * FROM chat WHERE service = ? AND chat_id = ?')
			.get(loc.service, loc.chatId)!;
		assert(chat);
		if (c.kind === 'openchat') assert.equal(chat.member_count, null);
		const state = db
			.prepare('SELECT * FROM read_state WHERE service = ? AND chat_id = ?')
			.get(loc.service, loc.chatId);
		const marker =
			c.readThrough === null
				? null
				: loaded.messages[c.readThrough ?? sorted.filter((x) => x.m.chat === c.id).at(-1)!.m.key]!
						.messageId;
		assert.equal(state?.marker ?? null, marker);
		if (c.lineUnread !== undefined) assert.equal(state?.line_count, c.lineUnread);
		for (const id of c.members) {
			const mid =
				c.kind === 'openchat'
					? loaded.members[c.id]![id]!
					: id === 'self'
						? loaded.selfMid
						: loaded.people[id]!;
			assert.equal(personFor.get(loc.service, mid)?.display_name, personName(world, id, c.id));
		}
	}
	for (const m of world.messages) {
		const loc = loaded.messages[m.key]!,
			c = world.chats.find((entry) => entry.id === m.chat)!;
		assert(loc);
		assert.equal(loc.sentAt, millis(anchor, m.at));
		const row = rowFor.get(loc.service, loc.chatId, loc.messageId)!;
		assert(row);
		assert.equal(row.sent_at, millis(anchor, m.at));
		assert.equal(
			row.content_type,
			m.kind === 'text' ? 'NONE' : m.kind === 'chat_event' ? 'CHATEVENT' : m.kind.toUpperCase()
		);
		assert.equal(row.thread_id, loc.threadId ?? null);
		assert.equal(
			row.sender,
			c.kind === 'openchat'
				? loaded.members[c.id]![m.from]
				: m.from === 'self'
					? loaded.selfMid
					: loaded.people[m.from]
		);
		assert.equal(row.unsent, m.unsent ? 1 : 0);
		assert.equal(row.decrypt_state, m.undecryptable ? 'missing_key' : 'ok');
		const text =
			!m.unsent && !m.undecryptable && ['text', 'location'].includes(m.kind)
				? (m.edited?.text ?? m.text ?? null)
				: null;
		assert.equal(row.text, text);
		if (m.edited) assert.equal(row.edited_at, millis(anchor, m.edited.at));
		const envelope = JSON.parse(String(row.envelope)) as {
			contentMetadata?: Record<string, string>;
		};
		const meta = envelope.contentMetadata ?? {};
		if (!m.unsent && !m.undecryptable) {
			if (m.kind === 'file') assert.equal(meta.FILE_NAME, m.file!.name);
			if (m.kind === 'flex') assert.equal(meta.ALT_TEXT, m.text);
			if (m.kind === 'sticker' && m.text) assert.equal(meta.STKTXT, m.text);
		} else {
			if (m.text) assert(!String(row.envelope).includes(m.text));
			if (m.file?.name) assert(!String(row.envelope).includes(m.file.name));
		}
	}
}
export function crossCheckArchive(
	rule: Rule,
	world: World,
	loaded: LoadedWorld,
	db: DatabaseSync,
	anchor: string,
	expected: Rubric
) {
	if (!expected.check) return;
	const q = archiveQuery(rule, world, loaded, anchor);
	const reverse = new Map(
		Object.entries(loaded.messages).map(([key, m]) => [
			`${m.service}|${m.chatId}|${m.messageId}`,
			key
		])
	);
	const rows = db
		.prepare(`SELECT m.service, m.chat_id, m.message_id, m.sender ${q.sql}`)
		.all(...q.params);
	const keys = rows.map((r) => reverse.get(`${r.service}|${r.chat_id}|${r.message_id}`)!);
	assert(keys.every(Boolean));
	// Check the entire set even when the public check asks only for a total.
	assert.deepEqual(
		keys.toSorted(),
		select(rule, world, anchor)
			.map((m) => m.key)
			.toSorted()
	);
	if (expected.check.kind === 'count')
		assert.equal(
			db.prepare(`SELECT count(*) AS n ${q.sql}`).get(...q.params)!.n,
			expected.check.value
		);
	else if (rule.mode === 'distinct-chats') {
		const inverse = new Map(
			Object.entries(loaded.chats).map(([id, c]) => [`${c.service}|${c.chatId}`, id])
		);
		const chats = db
			.prepare(`SELECT DISTINCT m.service, m.chat_id ${q.sql}`)
			.all(...q.params)
			.map((r) => inverse.get(`${r.service}|${r.chat_id}`)!)
			.toSorted();
		assert.deepEqual(chats, expected.check.value);
	} else assert.deepEqual(keys.toSorted(), expected.check.value);
	if (rule.mode === 'rank') {
		for (const r of db
			.prepare(`SELECT m.sender, count(*) AS n ${q.sql} GROUP BY m.sender`)
			.all(...q.params)) {
			const name = db
				.prepare('SELECT display_name FROM participant WHERE participant_id = ?')
				.get(r.sender!)?.display_name;
			assert(expected.required.some((s) => s.includes(`${name} = ${r.n}`)));
		}
	}
	if (rule.distinctAlso) {
		const n = db
			.prepare(`SELECT count(*) AS n FROM (SELECT DISTINCT m.service, m.chat_id ${q.sql})`)
			.get(...q.params)!.n;
		assert(expected.required.some((s) => s.includes(`exactly ${n} distinct chats`)));
	}
}

function proveGuardFaults(dev: World, anchor: string) {
	const faults: [string, (w: World) => void][] = [
		[
			'dev-02',
			(w) => {
				w.chats.find((c) => c.id === 'home')!.readThrough = 'home-unread';
			}
		],
		[
			'dev-10',
			(w) => {
				(w.messages.find((m) => m.key === 'midnight-zero')!.at as { daysAgo: number }).daysAgo = 1;
			}
		],
		[
			'dev-05',
			(w) => {
				w.messages.find((m) => m.key === 'rent-gone')!.unsent = false;
			}
		],
		[
			'dev-13',
			(w) => {
				delete w.messages.find((m) => m.key === 'hike-main-old')!.edited;
			}
		],
		[
			'dev-16',
			(w) => {
				w.messages.find((m) => m.key === 'book-flex')!.kind = 'text';
			}
		],
		[
			'dev-20',
			(w) => {
				w.messages.find((m) => m.key === 'ren-hidden')!.undecryptable = false;
			}
		]
	];
	for (const [id, mutate] of faults) {
		const world = structuredClone(dev);
		mutate(world);
		const db = evidenceDb(world, anchor);
		try {
			assert.throws(() =>
				validateRule(devRules[id]!, world, anchor, devRubric(id, world, anchor), db)
			);
		} finally {
			db.close();
		}
	}
}
/** The sets of this generation, with their world, rules, rubric and size. */
const generation = [
	{ split: 'dev', worldId: 'w1', rules: devRules, rubric: devRubric, n: 20 },
	{ split: 'holdout', worldId: 'w1', rules: sealedRules, rubric: sealedRubric, n: 20 },
	{ split: 'ood', worldId: 'w2', rules: sealedRules, rubric: sealedRubric, n: 12 }
];

/**
 * Checks across the sets come first: a failure there fails every checked
 * case. A world that fails its own checks fails the cases on it.
 */
export const validate: Validator = async (input) => {
	const sets = generation.map((set) => ({
		...set,
		...input.world(set.worldId),
		cases: input.cases[set.split] ?? []
	}));
	let setupError: unknown;
	try {
		for (const set of sets) {
			const { anchor } = set;
			assert.match(anchor, /^\d{4}-\d{2}-\d{2}$/);
			assert.equal(new Date(`${anchor}T00:00:00Z`).toISOString().slice(0, 10), anchor);
			assert.equal(set.cases.length, set.n);
			assert.equal(new Set(set.cases.map((c) => c.id)).size, set.n);
			for (const c of set.cases) {
				assert(
					c.split === set.split &&
						c.world === set.worldId &&
						set.rules[c.id] &&
						c.prompt &&
						typeof c.notes === 'string'
				);
				assert.deepEqual(Object.keys(c.axes).toSorted(), [...axes].toSorted());
				assert(axes.every((a) => typeof c.axes[a] === 'string' && c.axes[a]));
				if (c.axes.size === 'paging') assert((set.rules[c.id]!.minRows ?? 0) > 200);
			}
			for (const contrast of [
				'unread-vs-new',
				'untrusted-content',
				'secret-request',
				'unanswerable'
			])
				assert(set.cases.some((c) => c.contrast === contrast));
			const pair = set.cases.filter((c) => c.contrast === 'unread-vs-new');
			assert.equal(pair.length, 2);
			const pairRules = pair.map((c) => set.rules[c.id]!);
			assert.deepEqual(pairRules[0]!.filter!.chats, pairRules[1]!.filter!.chats);
			assert.equal(pairRules.filter((r) => r.filter?.unread).length, 1);
			const lists = pairRules.map((r) => select(r, set.world, anchor).map((m) => m.key));
			assert.notDeepEqual([...lists[0]!].toSorted(), [...lists[1]!].toSorted());
		}
		const dev = input.world('w1');
		proveGuardFaults(dev.world, dev.anchor);
	} catch (error) {
		setupError = error;
	}
	const results: CaseResult[] = [];
	const cache = new Map<string, { ref: DatabaseSync; archive?: Archive; error?: unknown }>();
	try {
		for (const set of sets) {
			if (!input.checked.has(set.split)) continue;
			const { anchor } = set;
			if (!cache.has(set.worldId)) {
				const entry: { ref: DatabaseSync; archive?: Archive; error?: unknown } = {
					ref: evidenceDb(set.world, anchor)
				};
				cache.set(set.worldId, entry);
				try {
					validateWorld(set.world, anchor);
					entry.archive = await input.archive(set.worldId);
					verifyLoadedWorld(set.world, entry.archive.loaded, entry.archive.db, anchor);
				} catch (error) {
					entry.error = error;
				}
			}
			const entry = cache.get(set.worldId)!;
			for (const c of set.cases) {
				try {
					if (setupError !== undefined) throw setupError;
					if (entry.error !== undefined) throw entry.error;
					const rule = set.rules[c.id]!,
						expected = set.rubric(c.id, set.world, anchor);
					validateRule(rule, set.world, anchor, expected, entry.ref);
					if (expected.check) {
						const poison = structuredClone(expected);
						if (typeof poison.check!.value === 'number') poison.check!.value += 1;
						else poison.check!.value = poison.check!.value.slice(1);
						assert.throws(() => validateRule(rule, set.world, anchor, poison, entry.ref));
						const { loaded, db } = entry.archive!;
						crossCheckArchive(rule, set.world, loaded, db, anchor, expected);
						assert.throws(() => crossCheckArchive(rule, set.world, loaded, db, anchor, poison));
					}
					results.push({ set: set.split, id: c.id });
				} catch (error) {
					results.push({ set: set.split, id: c.id, error });
				}
			}
		}
	} finally {
		for (const entry of cache.values()) entry.ref.close();
	}
	return results;
};
