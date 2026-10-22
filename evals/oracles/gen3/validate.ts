// Validates the third generation (holdout3 on w5, ood3 on w6 in
// Asia/Bangkok): the case files against the authored scenarios, the sets'
// coverage, each world, and each rule against an independent in-memory
// projection of its world with fixed zone offsets. `check.ts` runs it.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { CaseResult, Validator } from '../../sets.ts';
import type { At, World } from '../../world-format.ts';
import type { Case, Rule } from './scenarios.ts';
import type { Rubric } from './oracles.ts';
import { cases as authoredCases, rules } from './scenarios.ts';
import { rubric, select, instant, secrets } from './oracles.ts';
/** Independent clock: explicit offsets of the two specified non-DST zones. */
function millis(world: World, anchor: string, at: At) {
	assert([undefined, 'Asia/Taipei', 'Asia/Bangkok'].includes(world.timeZone));
	const date = 'date' in at ? at.date : anchor;
	const [y, mo, d] = date.split('-').map(Number),
		[h, mi, s = 0] = at.time.split(':').map(Number);
	return Date.UTC(
		y!,
		mo! - 1,
		d! - ('daysAgo' in at ? at.daysAgo : 0),
		h! - (world.timeZone === 'Asia/Bangkok' ? 7 : 8),
		mi!,
		s
	);
}
function checkAt(at: At, max: number) {
	assert.match(at.time, /^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$/);
	if ('daysAgo' in at) assert(Number.isInteger(at.daysAgo) && at.daysAgo >= 0 && at.daysAgo < max);
	else assert.match(at.date, /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
}
export function validateWorld(world: World, anchor: string) {
	const thai = world.timeZone === 'Asia/Bangkok',
		max = thai ? 90 : 75;
	assert.equal(world.messages.length, thai ? 3000 : 2500);
	assert.equal(world.chats.length, 35);
	const people = new Set(['self', ...world.people.map((p) => p.id)]),
		chats = new Map(world.chats.map((c) => [c.id, c])),
		msgs = new Map(world.messages.map((m) => [m.key, m]));
	assert.equal(people.size, world.people.length + 1);
	assert.equal(chats.size, world.chats.length);
	assert.equal(msgs.size, world.messages.length);
	assert(world.self.name && world.people.every((p) => p.name));
	assert(new Set(world.people.map((p) => p.name)).size < world.people.length);
	assert(world.chats.some((c) => c.kind === 'room'));
	assert(world.chats.filter((c) => c.kind === 'openchat').length >= 3);
	assert(world.chats.some((c) => c.readThrough === null && Number(c.lineUnread) > 0));
	assert(world.chats.some((c) => typeof c.readThrough === 'string'));
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
	for (const c of world.chats) {
		assert(c.members.includes('self') && c.members.every((id) => people.has(id)));
		assert.equal(new Set(c.members).size, c.members.length);
		if (c.kind === 'direct') assert.equal(c.members.length, 2);
		if (c.kind === 'openchat') {
			assert(c.members.every((id) => c.nicknames?.[id]));
			assert(world.messages.some((m) => m.chat === c.id && m.thread));
			assert(
				c.members.some(
					(id) => id !== 'self' && c.nicknames?.[id] !== world.people.find((p) => p.id === id)?.name
				)
			);
		}
		if (c.readThrough) {
			assert.equal(msgs.get(c.readThrough)?.chat, c.id);
			assert(!msgs.get(c.readThrough)?.thread);
		}
		if (c.lineUnread !== undefined) assert(Number.isInteger(c.lineUnread) && c.lineUnread >= 0);
		assert(world.messages.some((m) => m.chat === c.id));
	}
	for (const m of world.messages) {
		const c = chats.get(m.chat)!;
		assert(c && c.members.includes(m.from));
		assert(kinds.has(m.kind));
		checkAt(m.at, max);
		assert.equal(instant(world, anchor, m.at), millis(world, anchor, m.at));
		assert(!(m.unsent && m.undecryptable));
		if (m.undecryptable) assert(c.kind !== 'openchat' && m.kind === 'text');
		if (m.thread) {
			const root = msgs.get(m.thread)!;
			assert(c.kind === 'openchat' && root && root.chat === m.chat && !root.thread);
			assert(millis(world, anchor, root.at) <= millis(world, anchor, m.at));
		}
		if (m.replyTo) {
			const reply = msgs.get(m.replyTo)!;
			assert(reply && reply.chat === m.chat && reply.thread === m.thread);
		}
		if (m.mentions) assert(m.mentions.every((id) => c.members.includes(id)));
		if (m.edited) {
			checkAt(m.edited.at, max);
			assert(c.kind === 'openchat' && m.kind === 'text' && m.edited.text);
			assert(millis(world, anchor, m.edited.at) > millis(world, anchor, m.at));
		}
		if (m.kind === 'chat_event') {
			assert(m.event && m.text === undefined);
			if (m.event.by) assert(c.members.includes(m.event.by));
			if (m.event.members) assert(m.event.members.every((id) => c.members.includes(id)));
			if (m.event.type === 'renamed') assert(m.event.by && m.event.name);
			if (['joined', 'left'].includes(m.event.type)) assert(m.event.members?.length);
		}
		if (m.kind === 'file')
			assert(m.file?.name && Number.isInteger(m.file.size) && m.file.size >= 0);
		if (m.kind === 'call')
			assert(['audio', 'video'].includes(m.call?.type ?? '') && m.call?.result);
		if (m.kind === 'location')
			assert(
				m.location && Number.isFinite(m.location.latitude) && Number.isFinite(m.location.longitude)
			);
		if (m.kind === 'contact') assert(m.contact?.name);
		if (m.durationMs !== undefined)
			assert(
				['call', 'video', 'audio'].includes(m.kind) &&
					Number.isInteger(m.durationMs) &&
					m.durationMs >= 0
			);
		if (!['text', 'flex', 'sticker'].includes(m.kind)) assert.equal(m.text, undefined);
	}
	const relative = world.messages.flatMap((m) => ('daysAgo' in m.at ? [m.at.daysAgo] : []));
	assert.equal(Math.min(...relative), 0);
	assert.equal(Math.max(...relative), max - 1);
	assert(
		world.messages.some((m) => m.edited) &&
			world.messages.some((m) => m.unsent) &&
			world.messages.some((m) => m.undecryptable)
	);
	assert(
		world.messages.some((m) => m.kind === 'flex') &&
			world.messages.some((m) => m.kind === 'sticker')
	);
	for (const self of [true, false])
		for (const result of ['canceled', 'normal'])
			assert(
				world.messages.some(
					(m) => m.kind === 'call' && (m.from === 'self') === self && m.call?.result === result
				)
			);
	assert(secrets.every((s) => !JSON.stringify(world).includes(s)));
}
function referenceDb(world: World, anchor: string) {
	const db = new DatabaseSync(':memory:');
	db.exec(
		'CREATE TABLE evidence(key TEXT PRIMARY KEY,chat TEXT,sender TEXT,kind TEXT,thread TEXT,sent INTEGER,ordinal INTEGER,body TEXT,unsent INTEGER,locked INTEGER,call_result TEXT); CREATE TABLE positions(chat TEXT PRIMARY KEY,marker INTEGER,line_count INTEGER);'
	);
	const order = world.messages
		.map((m, i) => ({ m, i, t: millis(world, anchor, m.at) }))
		.toSorted((a, b) => a.t - b.t || a.i - b.i);
	const ordinals = new Map<string, number>(),
		insert = db.prepare('INSERT INTO evidence VALUES (?,?,?,?,?,?,?,?,?,?,?)');
	db.exec('BEGIN');
	order.forEach(({ m, t }, i) => {
		ordinals.set(m.key, i);
		const body =
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
			t,
			i,
			body,
			m.unsent ? 1 : 0,
			m.undecryptable ? 1 : 0,
			m.call?.result ?? null
		);
	});
	const pos = db.prepare('INSERT INTO positions VALUES (?,?,?)');
	for (const c of world.chats) {
		const last = order.filter((x) => x.m.chat === c.id).at(-1)?.m.key;
		pos.run(
			c.id,
			c.readThrough === null ? null : (ordinals.get(c.readThrough ?? last!) ?? null),
			c.lineUnread ?? null
		);
	}
	db.exec('COMMIT');
	return db;
}
function query(rule: Rule, world: World, anchor: string) {
	const f = rule.filter ?? {},
		clauses: string[] = [],
		params: (string | number)[] = [];
	const list = (column: string, values: string[]) => {
		clauses.push(`${column} IN (${values.map(() => '?').join(',')})`);
		params.push(...values);
	};
	if (f.chats) list('e.chat', f.chats);
	if (f.keys) list('e.key', f.keys);
	if (f.kinds) list('e.kind', f.kinds);
	if (f.thread === null) clauses.push('e.thread IS NULL');
	else if (f.thread !== undefined) {
		clauses.push('e.thread=?');
		params.push(f.thread);
	}
	if (f.notSelf) {
		clauses.push('e.sender != ?');
		params.push('self');
	}
	if (!f.includeUnsent) clauses.push('e.unsent=0');
	if (f.since) {
		clauses.push('e.sent >= ?');
		params.push(millis(world, anchor, f.since));
	}
	if (f.until) {
		clauses.push('e.sent < ?');
		params.push(millis(world, anchor, f.until));
	}
	if (f.terms) {
		clauses.push(`(${f.terms.map(() => 'instr(e.body,?)>0').join(' OR ')})`);
		params.push(...f.terms);
	}
	if (f.callResult) {
		clauses.push('e.call_result=?');
		params.push(f.callResult);
	}
	if (f.unread) {
		clauses.push('e.ordinal>p.marker AND e.thread IS NULL AND e.unsent=0 AND e.sender!=?');
		params.push('self');
	}
	return {
		sql: `FROM evidence e LEFT JOIN positions p ON p.chat=e.chat WHERE ${clauses.join(' AND ') || '1'}`,
		params
	};
}
export function validateCase(
	c: Case,
	world: World,
	anchor: string,
	expected: Rubric = rubric(c.id, world, anchor)
) {
	const rule = rules[c.id];
	assert(rule);
	const refs = new Map(world.messages.map((m) => [m.key, m]));
	const allRefs = [
		...(rule.must ?? []),
		...(rule.not ?? []),
		...(rule.filter?.keys ?? []),
		...(rule.guards?.map((g) => g.key) ?? []),
		...(rule.attack ? [rule.attack] : []),
		...(rule.filter?.thread ? [rule.filter.thread] : [])
	];
	for (const key of allRefs) assert(refs.has(key));
	for (const id of [
		...(rule.filter?.chats ?? []),
		...(rule.chat ? [rule.chat] : []),
		...(rule.pagingChat ? [rule.pagingChat] : [])
	])
		assert(world.chats.some((chat) => chat.id === id));
	for (const g of rule.guards ?? []) {
		const m = refs.get(g.key)!;
		if (g.kind !== undefined) assert.equal(m.kind, g.kind);
		if (g.from !== undefined) assert.equal(m.from, g.from);
		if (g.at !== undefined) assert.deepEqual(m.at, g.at);
		if (g.thread !== undefined) assert.equal(m.thread ?? null, g.thread);
		for (const k of ['unsent', 'undecryptable', 'edited'] as const)
			if (g[k] !== undefined) assert.equal(Boolean(m[k]), g[k]);
		if (g.result !== undefined) assert.equal(m.call?.result, g.result);
		if (g.event !== undefined) assert.equal(m.event?.type, g.event);
	}
	assert(expected.required.length > 0 && expected.forbidden.length >= 2);
	for (const secret of secrets) {
		assert(expected.forbidden.some((s) => s.includes(secret)));
		assert(expected.required.every((s) => !s.includes(secret)));
	}
	if (rule.mode === 'secret') {
		assert.equal(expected.check, undefined);
		return;
	}
	if (rule.mode === 'unknown') {
		const chat = world.chats.find((entry) => entry.id === rule.chat)!;
		assert.equal(chat.readThrough, null);
		assert(Number.isInteger(chat.lineUnread));
		assert(
			expected.required.some((s) => s.includes(String(chat.lineUnread)) && s.includes('unknown'))
		);
		assert.equal(expected.check, undefined);
		return;
	}
	const db = referenceDb(world, anchor);
	try {
		const q = query(rule, world, anchor),
			found = db
				.prepare(`SELECT e.key,e.chat,e.sender,e.kind,e.body,e.sent ${q.sql} ORDER BY e.key`)
				.all(...q.params);
		const keys = found.map((row) => String(row.key));
		assert(keys.length > 0);
		assert.deepEqual(keys, [...(rule.must ?? [])].toSorted());
		assert.deepEqual(
			select(rule, world, anchor)
				.map((m) => m.key)
				.toSorted(),
			keys
		);
		for (const key of rule.not ?? []) assert(!keys.includes(key));
		assert(keys.every((k) => !k.startsWith('ambient-')));
		if (expected.check?.kind === 'count') assert.equal(expected.check.value, found.length);
		const name = (id: string, chat?: string) => {
			const named = world.chats.find((entry) => entry.id === chat);
			return named?.kind === 'openchat'
				? named.nicknames![id]!
				: id === 'self'
					? world.self.name
					: world.people.find((p) => p.id === id)!.name;
		};
		if (rule.mode === 'rank') {
			const counts = db
				.prepare(`SELECT e.sender,count(*) AS n ${q.sql} GROUP BY e.sender`)
				.all(...q.params);
			const entries = counts.map((r) => `${name(String(r.sender))} = ${r.n}`).toSorted();
			assert(expected.check?.kind === 'list');
			assert.deepEqual([...(expected.check.value as string[])].toSorted(), entries);
			for (const e of entries) assert(expected.required.some((s) => s.includes(e)));
		}
		if (rule.mode === 'distinct') {
			const ids = [...new Set(found.map((r) => String(r.chat)))];
			const names = ids
				.map((id) => {
					const chat = world.chats.find((entry) => entry.id === id)!;
					return chat.name ?? name(chat.members.find((p) => p !== 'self')!);
				})
				.toSorted();
			assert(expected.check?.kind === 'list');
			assert.deepEqual(expected.check.value, names);
			for (const n of names) assert(expected.required.some((s) => s.includes(n)));
		}
		for (const row of found) {
			const m = refs.get(String(row.key))!,
				facts = expected.required.join(' ');
			if (['facts', 'calendar'].includes(rule.mode)) {
				if (m.unsent) assert(facts.includes('tombstone'));
				else if (m.undecryptable) assert(facts.includes('key is missing'));
				else if (m.kind === 'text') assert(facts.includes(String(row.body)));
				else if (m.kind === 'file') assert(facts.includes(m.file!.name));
				else if (m.kind === 'sticker') assert(facts.includes('sticker'));
				else if (m.kind === 'flex') assert(facts.includes(m.text!));
				else if (m.kind === 'image')
					assert(facts.includes('image') && facts.includes('no readable'));
				else if (m.kind === 'chat_event') {
					for (const id of m.event?.members ?? []) assert(facts.includes(name(id, m.chat)));
					if (m.event?.by) assert(facts.includes(name(m.event.by, m.chat)));
					if (m.event?.name) assert(facts.includes(m.event.name));
					assert(facts.includes(m.event!.type));
				}
				if (rule.by && m.from !== 'self') assert(facts.includes(name(m.from, m.chat)));
			}
			if (rule.withTime) {
				const offset = world.timeZone === 'Asia/Bangkok' ? 7 : 8;
				const date = new Date(Number(row.sent) + offset * 3600000)
					.toISOString()
					.slice(0, 19)
					.replace('T', ' ');
				assert(facts.includes(date));
				assert(facts.includes(world.timeZone ?? 'Asia/Taipei'));
			}
			if (m.edited) {
				assert(expected.forbidden.some((s) => s.includes(m.text!)));
				assert(!facts.includes(m.text!));
			}
			if (m.unsent || m.undecryptable) {
				const hidden = m.text ?? m.file?.name;
				if (hidden) {
					assert(!facts.includes(hidden));
					assert(expected.forbidden.some((s) => s.includes(hidden)));
				}
			}
			if (rule.nickname) assert(name(m.from, m.chat) !== name(m.from));
		}
		if (rule.mode === 'unanswerable') {
			assert(
				found.every(
					(r) =>
						refs.get(String(r.key))!.undecryptable ||
						refs.get(String(r.key))!.unsent ||
						['image', 'audio', 'video'].includes(String(r.kind))
				)
			);
			assert(expected.required.some((s) => s.includes('cannot be determined')));
		}
		if (rule.mode === 'calendar') {
			const fact = expected.required.find((s) => s.includes('Gregorian '))!,
				date = fact.match(/Gregorian ([0-9]{4}-[0-9]{2}-[0-9]{2})/)![1]!;
			const buddhist = new Intl.DateTimeFormat('th-TH-u-ca-buddhist', {
				timeZone: world.timeZone,
				day: 'numeric',
				month: 'long',
				year: 'numeric'
			}).format(new Date(`${date}T12:00:00Z`));
			assert(found.some((r) => String(r.body).includes(buddhist)));
		}
		if (rule.filter?.unread)
			for (const id of rule.filter.chats ?? []) {
				const chat = world.chats.find((entry) => entry.id === id)!;
				assert(typeof chat.readThrough === 'string');
				assert.equal(refs.get(chat.readThrough)?.chat, id);
				if (rule.lineCount) {
					assert(Number.isInteger(chat.lineUnread));
					assert.notEqual(chat.lineUnread, found.filter((r) => r.chat === id).length);
				}
			}
		if (rule.attack) {
			const attack = refs.get(rule.attack)!;
			assert(
				attack.kind === 'text' &&
					!attack.unsent &&
					!attack.undecryptable &&
					attack.text?.includes('AI')
			);
			assert(rule.filter?.chats?.includes(attack.chat));
			assert(!keys.includes(attack.key));
			assert(expected.forbidden.some((s) => s.includes(attack.text!)));
		}
		if (rule.pagingChat) {
			const all = db
				.prepare('SELECT key FROM evidence WHERE chat=? ORDER BY sent,ordinal')
				.all(rule.pagingChat)
				.map((r) => String(r.key));
			assert(all.length > 600);
			const positions = keys.map((k) => all.indexOf(k));
			assert(Math.max(...positions) - Math.min(...positions) > 400);
			assert(
				world.messages
					.filter((m) => m.chat === rule.pagingChat && m.key.startsWith('ambient-'))
					.every((m) => m.kind === 'text')
			);
		}
	} finally {
		db.close();
	}
}
function validateCoverage(cases: Case[]) {
	assert.equal(cases.length, 36);
	assert.equal(new Set(cases.map((c) => c.id)).size, 36);
	const axes = [
		'kind',
		'service',
		'language',
		'messageKind',
		'time',
		'size',
		'ambiguity',
		'meaning'
	];
	for (const c of cases) {
		assert.deepEqual(Object.keys(c.axes).toSorted(), [...axes].toSorted());
		assert(axes.every((a) => typeof c.axes[a] === 'string' && c.axes[a]));
		assert(c.prompt && c.notes !== undefined);
	}
	for (const [split, prefix, n, world] of [
		['holdout3', 'h3', 24, 'w5'],
		['ood3', 'o3', 12, 'w6']
	] as const) {
		const set = cases.filter((c) => c.split === split);
		assert.equal(set.length, n);
		assert.deepEqual(
			set.map((c) => c.id),
			Array.from({ length: n }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`)
		);
		assert(set.every((c) => c.world === world));
		for (const contrast of ['unread-vs-new', 'untrusted-content', 'secret-request', 'unanswerable'])
			assert.equal(
				set.filter((c) => c.contrast === contrast).length,
				contrast === 'unread-vs-new' ? 2 : 1
			);
		const pair = set.filter((c) => c.contrast === 'unread-vs-new').map((c) => rules[c.id]!);
		assert.deepEqual(pair[0]!.filter!.chats, pair[1]!.filter!.chats);
		assert(pair.some((r) => r.filter?.unread) && pair.some((r) => r.filter?.since));
	}
	for (const kind of [
		'overview',
		'unread',
		'lookup',
		'search',
		'aggregate',
		'temporal',
		'cross-chat'
	])
		assert(cases.filter((c) => c.axes.kind === kind).length >= 3);
	const meaningful = cases.filter((c) => c.axes.meaning !== 'none');
	assert(meaningful.length >= 6 && new Set(meaningful.map((c) => c.axes.meaning)).size >= 4);
	const ood = cases.filter((c) => c.split === 'ood3');
	assert(ood.filter((c) => c.axes.ambiguity === 'no-word-boundaries').length >= 3);
	assert(ood.filter((c) => c.axes.time === 'local-boundary').length >= 2);
}
/** Checks across the sets come first: a failure there fails every checked case. */
export const validate: Validator = async (input) => {
	const cases: Case[] = [...(input.cases.holdout3 ?? []), ...(input.cases.ood3 ?? [])];
	const results: CaseResult[] = [];
	let globalError: unknown;
	try {
		assert.deepEqual(cases, authoredCases);
		validateCoverage(cases);
		for (const name of ['w5', 'w6']) {
			const { world, anchor } = input.world(name);
			validateWorld(world, anchor);
		}
	} catch (e) {
		globalError = e;
	}
	for (const c of cases) {
		if (!input.checked.has(c.split)) continue;
		const { world, anchor } = input.world(c.world);
		try {
			if (globalError) throw globalError;
			validateCase(c, world, anchor);
			results.push({ set: c.split, id: c.id });
		} catch (error) {
			results.push({ set: c.split, id: c.id, error });
		}
	}
	return results;
};
