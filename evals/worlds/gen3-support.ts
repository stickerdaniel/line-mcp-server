// Helpers of the third generation's worlds (w5, w6): chat and message
// builders and seeded background messages.
import type { At, Chat, Message, MessageKind, World } from '../world-format.ts';
export const at = (daysAgo: number, time = '00:00'): At => ({ daysAgo, time });
export const direct = (id: string, peer: string, extra: Partial<Chat> = {}): Chat => ({
	id,
	kind: 'direct',
	members: ['self', peer],
	...extra
});
export const group = (
	id: string,
	name: string,
	peers: string[],
	extra: Partial<Chat> = {}
): Chat => ({ id, kind: 'group', name, members: ['self', ...peers], ...extra });
export function author(messages: Message[]) {
	return (
		key: string,
		chat: string,
		from: string,
		days: number,
		time: string,
		text: string | undefined,
		extra: Partial<Message> = {}
	) => {
		const m: Message = { key, chat, from, at: at(days, time), kind: 'text', ...extra };
		if (text !== undefined) m.text = text;
		messages.push(m);
	};
}
/** Background is never an answer-bearing row. The long chat has text-only filler. */
export function background(
	world: World,
	target: number,
	days: number,
	seed: number,
	longChat: string,
	thai = false
) {
	let state = seed >>> 0;
	const pick = (n: number) => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) % n;
	};
	const zh = [
		'先放桌邊就好',
		'這裡訊號不太好',
		'我搭下一班車',
		'今天風好大',
		'謝謝你幫忙',
		'晚點再聊',
		'午餐吃完了',
		'有空再一起去',
		'茶快喝完了',
		'到了再傳訊息'
	];
	const th = [
		'รถติดนิดหน่อย',
		'เดี๋ยวเจอกันนะ',
		'วันนี้ฝนตกหนัก',
		'ขอบคุณมากเลย',
		'ไว้คุยกันตอนเย็น',
		'เพิ่งกินข้าวเสร็จ',
		'ขอพักแป๊บนึง',
		'เดินทางดีๆนะ',
		'กำลังออกจากบ้าน',
		'แถวนี้อากาศดี'
	];
	const en = [
		'I will bring a spare.',
		'Thanks for checking.',
		'Almost there.',
		'That sounds fine.'
	];
	const ja = ['電車に乗りました', 'また連絡します', '助かりました', '今日は涼しいですね'];
	const simplified = ['我刚下班', '等会儿联系', '下次一起去', '谢谢帮忙'];
	const kinds: MessageKind[] = [
		'text',
		'text',
		'text',
		'text',
		'text',
		'text',
		'text',
		'text',
		'sticker',
		'image',
		'audio',
		'video',
		'file',
		'location',
		'contact',
		'call'
	];
	const roots = new Map<string, string>();
	for (const c of world.chats.filter((entry) => entry.kind === 'openchat')) {
		const key = `ambient-root-${c.id}`;
		world.messages.push({
			key,
			chat: c.id,
			from: c.members[1]!,
			at: at(days - 1, '06:05'),
			kind: 'text',
			text: thai ? 'คุยทั่วไปของเดือนนี้' : '本月日常閒聊區'
		});
		roots.set(c.id, key);
	}
	for (let i = 0; world.messages.length < target; i++) {
		const c =
			world.chats.find((entry) => entry.id === longChat && i < 650) ??
			world.chats[pick(world.chats.length)]!;
		const official = c.id.startsWith('official-');
		const from = official ? c.members[1]! : c.members[pick(c.members.length)]!;
		const roll = pick(100),
			pool = thai
				? roll < 85
					? th
					: roll < 97
						? en
						: zh
				: from.startsWith('s-')
					? simplified
					: roll < 82
						? zh
						: roll < 94
							? en
							: ja;
		let kind = official ? 'flex' : kinds[pick(kinds.length)]!;
		if (c.id === longChat) kind = 'text';
		if (c.kind === 'openchat' && kind === 'call') kind = 'image';
		const m: Message = {
			key: `ambient-${i}`,
			chat: c.id,
			from,
			at: at(
				8 + pick(days - 8),
				`${String(7 + pick(16)).padStart(2, '0')}:${String(pick(60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`
			),
			kind
		};
		if (kind === 'text') m.text = pool[pick(pool.length)]!;
		if (kind === 'sticker') m.text = thai ? '[ขอบคุณ]' : '[謝謝]';
		if (kind === 'flex')
			m.text = thai ? 'แจ้งข่าวสมาชิก ร้านเปิดตามเวลาปกติ' : '會員提醒：平日營業時間不變。';
		if (kind === 'file') m.file = { name: `memo-${i}.pdf`, size: 4096 + i };
		if (kind === 'contact') m.contact = { name: thai ? 'ฝ่ายประชาสัมพันธ์' : '聯絡窗口' };
		if (kind === 'location')
			m.location = thai
				? { title: 'ทางออกสถานี', latitude: 13.74, longitude: 100.53 }
				: { title: '車站旁小公園', latitude: 24.15, longitude: 120.68 };
		if (['audio', 'video', 'call'].includes(kind)) m.durationMs = (20 + pick(180)) * 1000;
		if (kind === 'call') {
			m.call = { type: i % 2 ? 'audio' : 'video', result: i % 3 ? 'normal' : 'canceled' };
			if (m.call.result === 'canceled') m.durationMs = 0;
		}
		if (c.kind === 'openchat' && i % 4 === 0) m.thread = roots.get(c.id);
		if (kind === 'text' && c.id !== longChat && i % 83 === 0) m.unsent = true;
		if (kind === 'text' && c.id !== longChat && c.kind !== 'openchat' && !m.unsent && i % 137 === 0)
			m.undecryptable = true;
		world.messages.push(m);
	}
	return world;
}
