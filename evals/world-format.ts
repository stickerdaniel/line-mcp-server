// Shared format of a synthetic LINE world for the evals.
// The case author writes worlds in this format; the loader turns one into a
// line-mcp archive through production write paths. Handles (`id`, `key`) are
// stable names for oracles; the loader assigns real-looking LINE IDs.

/**
 * Local clock time in the world's time zone: `daysAgo` days before the batch
 * anchor date, or on a fixed local `date` (`YYYY-MM-DD`), for example on a
 * daylight-saving change. A local time that does not exist or occurs twice on
 * such a day is rejected by the loader.
 */
export type At =
	| {
			daysAgo: number;
			/** `HH:MM` or `HH:MM:SS`, 24-hour. */
			time: string;
	  }
	| {
			date: string;
			time: string;
	  };

export interface Person {
	id: string;
	/** The LINE display name (Talk). */
	name: string;
}

export interface Chat {
	id: string;
	kind: 'direct' | 'group' | 'room' | 'openchat';
	/** Group and OpenChat names; a room may have none; a direct chat takes the peer's name. */
	name?: string;
	/** Person ids, including 'self'. A direct chat has exactly 'self' and the peer. */
	members: string[];
	/**
	 * The key of the last message the account has read in this chat. `null`:
	 * line-mcp does not know the read position. Omitted: everything is read.
	 */
	readThrough?: string | null;
	/** LINE's own unread count, when it should differ from what the archive implies. */
	lineUnread?: number;
	/** OpenChat only: person id -> display name in this OpenChat (members pick a name per OpenChat). */
	nicknames?: Record<string, string>;
}

export type MessageKind =
	| 'text'
	| 'sticker'
	| 'image'
	| 'video'
	| 'audio'
	| 'file'
	| 'location'
	| 'contact'
	| 'call'
	/** A rich message, typically from an official account; `text` holds its alt text. */
	| 'flex'
	/** A chat event such as a member joining or leaving; `event` describes it. */
	| 'chat_event';

/** What a `chat_event` message reports, as LINE's chat event codes carry it. */
export interface ChatEventSpec {
	type:
		| 'joined'
		| 'left'
		| 'invited'
		| 'invitation_canceled'
		| 'removed'
		| 'renamed'
		| 'picture_changed'
		| 'link_join_allowed'
		| 'link_join_disabled';
	/** Person id of who did it; required for invited, invitation_canceled, renamed, picture_changed. */
	by?: string;
	/** Person ids it names; required for joined, left, invited, invitation_canceled, removed. */
	members?: string[];
	/** The new chat name of `renamed`. */
	name?: string;
}

export interface Message {
	key: string;
	chat: string;
	/** OpenChat only: key of the thread's root message (the root itself has no `thread`). */
	thread?: string;
	/** Person id or 'self'. */
	from: string;
	at: At;
	kind: MessageKind;
	/** The text; a sticker's text (`[OK]`) and a flex message's alt text; never for chat_event. */
	text?: string;
	file?: { name: string; size: number };
	location?: { title: string; address?: string; latitude: number; longitude: number };
	/** Contact card: the shared person's display name. */
	contact?: { name: string };
	/** Video, audio and call length in milliseconds. */
	durationMs?: number;
	/** Call only: audio or video, and LINE's result in lower case (`normal`, `canceled`, ...). */
	call?: { type: 'audio' | 'video'; result: string };
	/** chat_event only, required there. */
	event?: ChatEventSpec;
	replyTo?: string;
	mentions?: string[];
	/** Where LINE supports edits; the loader rejects an edit it cannot apply through sync. */
	edited?: { at: At; text: string };
	/** Unsent later: line-mcp keeps a tombstone without text. */
	unsent?: boolean;
	/** E2EE message whose key line-mcp lacks: no text in the archive. */
	undecryptable?: boolean;
}

export interface World {
	/** IANA time zone the owner lives in and the daemon runs in; Asia/Taipei when omitted. */
	timeZone?: string;
	self: { name: string };
	people: Person[];
	chats: Chat[];
	/** In any order; the loader sorts by time. */
	messages: Message[];
}
