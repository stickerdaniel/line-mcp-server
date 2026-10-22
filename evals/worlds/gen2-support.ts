// Helpers of the second generation's worlds (w3, w4) and oracles: local
// clock times in a zone, names, and seeded background messages.
import assert from 'node:assert/strict';
import type { At, Chat, Message, World } from '../world-format.ts';
const formats = new Map<string, Intl.DateTimeFormat>();
export function zone(world: World) {
	return world.timeZone ?? 'Asia/Taipei';
}
export function clock(ms: number, timeZone: string) {
	let format = formats.get(timeZone);
	if (!format) {
		format = new Intl.DateTimeFormat('en-CA', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hourCycle: 'h23'
		});
		formats.set(timeZone, format);
	}
	const p = Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, part.value]));
	return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
export function today(timeZone: string) {
	return clock(Date.now(), timeZone).slice(0, 10);
}
export function localDate(anchor: string, at: At) {
	if ('date' in at) return at.date;
	return new Date(Date.parse(`${anchor}T12:00:00Z`) - at.daysAgo * 86400000)
		.toISOString()
		.slice(0, 10);
}
export function instant(anchor: string, at: At, timeZone: string) {
	const target = `${localDate(anchor, at)}T${at.time.length === 5 ? `${at.time}:00` : at.time}`;
	const wall = Date.parse(`${target}Z`);
	assert(
		Number.isFinite(wall) && new Date(wall).toISOString().slice(0, 19) === target,
		'invalid local date/time'
	);
	const offsets = new Set<number>();
	for (let h = -36; h <= 36; h += 6) {
		const sample = wall + h * 3600000;
		offsets.add(Date.parse(`${clock(sample, timeZone)}Z`) - sample);
	}
	const matches = [...offsets]
		.map((offset) => wall - offset)
		.filter((ms) => clock(ms, timeZone) === target);
	assert.equal(matches.length, 1, 'local time is nonexistent or ambiguous');
	return matches[0]!;
}
export function stamp(world: World, anchor: string, at: At) {
	const ms = instant(anchor, at, zone(world)),
		local = clock(ms, zone(world));
	const minutes = (Date.parse(`${local}Z`) - ms) / 60000,
		sign = minutes >= 0 ? '+' : '-';
	const offset = `${sign}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`;
	return `${local.replace('T', ' ')} UTC${offset} (${zone(world)})`;
}
export function person(world: World, id: string, chatId?: string) {
	const chat = world.chats.find((c) => c.id === chatId);
	if (chat?.kind === 'openchat') {
		assert(chat.nicknames?.[id]);
		return chat.nicknames[id]!;
	}
	if (id === 'self') return world.self.name;
	const entry = world.people.find((p) => p.id === id);
	assert(entry);
	return entry.name;
}
export function chatName(world: World, id: string) {
	const chat = world.chats.find((c) => c.id === id);
	assert(chat);
	return (
		chat.name ??
		(chat.kind === 'direct'
			? person(
					world,
					chat.members.find((p) => p !== 'self')!
				)
			: `unnamed room with ${chat.members
					.filter((p) => p !== 'self')
					.map((p) => person(world, p))
					.join(', ')}`)
	);
}
export function body(m: Message) {
	return m.unsent || m.undecryptable ? undefined : (m.edited?.text ?? m.text);
}
export function sorted(world: World, anchor: string) {
	return world.messages
		.map((m, i) => ({ m, i, ms: instant(anchor, m.at, zone(world)) }))
		.toSorted((a, b) => a.ms - b.ms || a.i - b.i)
		.map((x) => x.m);
}
export function seeded(seed: number) {
	let state = seed >>> 0;
	return (n: number) => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) % n;
	};
}
const taiwanText = [
	'我先去買早餐。',
	'收到，謝謝你。',
	'這邊有點下雨。',
	'晚點再回你。',
	'捷運今天人好多。',
	'我帶了保溫瓶。',
	'週末再看看吧。',
	'可以，沒有問題。',
	'照片拍得真好。',
	'Thanks, got it.',
	'I will check after lunch.',
	'ありがとうございます。'
];
const germanText = [
	'Bin gleich unterwegs.',
	'Danke, ist angekommen.',
	'Morgen passt mir besser.',
	'Der Bus hat etwas Verspätung.',
	'Ich bringe eine Thermoskanne mit.',
	'Hier regnet es schon wieder.',
	'Klingt gut, bis später.',
	'Could you send me the address?',
	'Thanks, see you later.',
	'I will check after lunch.',
	'Tamam, teşekkürler.',
	'Yarın tekrar konuşalım.'
];
/** Background messages never contain case targets. Cases count only hand-written evidence. */
export function filler(
	key: string,
	chat: Chat,
	at: At,
	random: (n: number) => number,
	german = false,
	quiet = false
): Message {
	const from = chat.members[random(chat.members.length)]!,
		roll = random(100),
		base = { key, chat: chat.id, from, at };
	if (chat.id.startsWith('official-'))
		return {
			...base,
			from: chat.members.find((p) => p !== 'self')!,
			kind: 'flex',
			text: german ? 'Unsere Öffnungszeiten stehen in der Filiale.' : '最新營業時間請見門市公告。'
		};
	if (roll < 70)
		return {
			...base,
			kind: 'text',
			text: (german ? germanText : taiwanText)[
				random(german ? germanText.length : taiwanText.length)
			]!
		};
	if (roll < 81) return { ...base, kind: 'sticker', text: random(2) ? '[OK]' : '[Thanks]' };
	if (roll < 89 || quiet) return { ...base, kind: 'image' };
	if (roll < 93) return { ...base, kind: 'audio', durationMs: 3000 + random(20) * 1000 };
	if (roll < 96) return { ...base, kind: 'video', durationMs: 7000 + random(40) * 1000 };
	if (roll < 98)
		return {
			...base,
			kind: 'file',
			file: { name: `notes-${key}.pdf`, size: 30000 + random(40000) }
		};
	return {
		...base,
		kind: 'call',
		durationMs: random(120) * 1000,
		call: { type: 'audio', result: 'normal' }
	};
}
