import { nonTextColumns } from '../non-text.ts';

// What the `query` tool lets agents read, declared once: the relations and
// their readable columns, the notes on what they mean, and the caps. The
// guard's allowlist (`guard.ts`) and the tool description both come from here,
// so a column is readable exactly when the description lists it, and a new
// column stays unreadable until it is listed.

/** Rows one result carries at most. */
export const maxRows = 200;
/** Bytes of the serialized result object (`columns`, `rows`, `truncated`) at most. */
export const maxResultBytes = 64 * 1024;
/** Bytes of a failed result's JSON at most; SQLite's message is cut to fit. */
export const maxErrorBytes = 4 * 1024;
/**
 * Columns one result has at most. node:sqlite hands over a whole row at once,
 * so with values of at most 1 MiB this bounds the memory one row takes.
 */
export const maxColumns = 64;

export interface Relation {
	name: string;
	/** The columns a query reads, in the order the description lists them. */
	columns: readonly string[];
	/** Further readable columns the description leaves out: FTS5's own. */
	hidden?: readonly string[];
	/** What follows the signature on its description line, punctuation included. */
	gloss: string;
}

/** The relations as the description lists them, one description line per inner list. */
const relationLines: readonly (readonly Relation[])[] = [
	[
		{
			name: 'chat',
			columns: ['service', 'chat_id', 'type', 'name', 'member_count', 'last_activity_at'],
			gloss: ', key `(service, chat_id)`'
		}
	],
	[
		{
			name: 'participant',
			columns: ['service', 'participant_id', 'display_name'],
			gloss: ', key `(service, participant_id)`'
		}
	],
	[
		{
			name: 'message',
			columns: [
				'id',
				'service',
				'chat_id',
				'message_id',
				'thread_id',
				'sender',
				'sent_at',
				'edited_at',
				'content_type',
				'text',
				'reply_to',
				'mentions',
				'decrypt_state',
				'unsent',
				'seq',
				...nonTextColumns
			],
			gloss: '; `id` is the row ID'
		}
	],
	[
		{
			name: 'read_state',
			columns: ['service', 'chat_id', 'marker', 'line_count', 'count_marker', 'count_at'],
			gloss: ''
		}
	],
	[
		{ name: 'account', columns: ['mid'], gloss: ": the user's own Talk ID" },
		{
			name: 'square_self_member',
			columns: ['chat_id', 'member_id'],
			gloss: ": the user's own member IDs per OpenChat"
		}
	],
	[
		{
			name: 'message_fts',
			columns: ['text'],
			// SQLite names a read of an FTS5 table's rowid `ROWID`; the hidden
			// column named like the table takes MATCH, `rank` the ranking.
			hidden: ['rowid', 'message_fts', 'rank'],
			gloss: ': FTS5 trigram index over `message.text`, `message_fts.rowid` = `message.id`'
		}
	]
];

export const relations: readonly Relation[] = relationLines.flat();

/**
 * Table-valued functions a query may read like a table. Their rows come from
 * their arguments, which the guard has already checked.
 */
export const tableFunctions: ReadonlySet<string> = new Set([
	'json_each',
	'json_tree',
	'jsonb_each',
	'jsonb_tree'
]);

/**
 * FTS5's shadow tables of `message_fts`. They keep trigrams of unsent text,
 * since FTS5 deletes postings only logically, so agent SQL never reads them;
 * only FTS5's own statements do (`guard.ts`).
 */
export const ftsShadowTables: ReadonlySet<string> = new Set([
	'message_fts_data',
	'message_fts_idx',
	'message_fts_config',
	'message_fts_docsize',
	'message_fts_content'
]);

/** Functions no query calls, though SQLite has them built in. */
export const deniedFunctions: ReadonlySet<string> = new Set(['load_extension']);

/**
 * The archive's other tables and SQLite's own, none of them readable, and
 * none of them a name a CTE may hide behind (`guard.ts`).
 */
export const unlistedTables = [
	'line_kv',
	'sync_state',
	'change_counter',
	'coverage_gap',
	'outbox',
	'sqlite_master',
	'sqlite_temp_master',
	'sqlite_schema',
	'sqlite_temp_schema',
	'sqlite_sequence',
	'sqlite_stat1',
	'sqlite_stat4',
	'dbstat',
	'sqlite_dbpage'
];

/**
 * The names a `query_denied` log line may carry as its object; any other
 * object a denial reports could be text from the SQL, and logs as `other`.
 */
export const knownNames: ReadonlySet<string> = new Set([
	...relations.flatMap((relation) => [
		relation.name,
		...relation.columns,
		...(relation.hidden ?? [])
	]),
	...tableFunctions,
	...ftsShadowTables,
	...deniedFunctions,
	...unlistedTables
]);

/** What the columns mean; each note is one description line. */
const notes = [
	"Times are UTC milliseconds. `local_time(ms)` gives the user's local time as ISO 8601 with its UTC offset, which can differ by date (daylight saving); `SELECT local_time(unixepoch('now', 'subsec') * 1000)` is the current local time. Filter and sort on the millisecond columns; write a local bound with the offset `local_time` shows for that date, for example `unixepoch('2026-10-14T00:00:00+08:00') * 1000`.",
	'`service` is `talk` (chat `type` `user` for one-to-one, `group`, `room`) or `square` (OpenChat, `type` `square`). Join on `service` as well as the ID.',
	"Names: `participant.display_name` for `(service, sender)`. A one-to-one chat's `chat_id` is the peer's ID, so its name is the peer's `display_name`; the chat whose `chat_id` is `account.mid` is the user's own Keep Memo. Each OpenChat gives the user and every member a separate member ID and name.",
	"Own messages: in Talk `sender = account.mid`; in OpenChat `sender` is one of the chat's `square_self_member.member_id`. With no sender, or in an OpenChat without one, it is unknown.",
	'`message_id` is a decimal string: order and compare it numerically as `(length(message_id), message_id)`.',
	"`content_type` is `NONE` for text (NULL is also text in OpenChat); otherwise LINE's type: `IMAGE`, `VIDEO`, `AUDIO`, `FILE`, `STICKER`, `CALL`, `CHATEVENT`, `FLEX`, `LOCATION`, `CONTACT`. Readable fields of non-text messages: `alt_text` (sticker or Flex text), `file_name`, `duration_ms` (video, audio, call), `image_index` of `image_total` (an image set), `call_type` (`audio`, `video`), `call_result` (`canceled` from someone else: a missed call); a chat event has `event` (joined, left, invited, invitation_canceled, removed, renamed, picture_changed, link_join_allowed, link_join_disabled), `event_by`, `event_members` (member IDs joined by `,`) and `event_name` (the new chat name).",
	'`unsent = 1`: unsent by its sender, text and fields gone. Text is also NULL when `decrypt_state` is `missing_key` (key unavailable) or `invalid` (decryption failed). `edited_at`: time of the last edit; `text` is the edited text.',
	'`thread_id` is set inside an OpenChat thread and NULL in the main chat.',
	'`seq` grows whenever a message row changes (new, edited, unsent, decrypted later); a row shows only its latest state.',
	'Text search: `message_fts MATCH \'"term"\'` finds a quoted term of three or more characters anywhere in the text, ignoring case; shorter terms need `instr(text, ...)`. Both match text as written: search Traditional and Simplified Chinese separately.',
	"Unread: `read_state.marker` is the ID of the last message the user read in that chat; NULL or no row means unknown. Unread messages are in the main chat (`thread_id IS NULL`), not unsent, not the user's own, with an ID numerically above `marker`. `line_count` is LINE's own unread count as of `count_at`, valid while `count_marker IS marker`. It names no messages and can differ from the archive's count; the archive does not record why."
];

const signature = (relation: Relation) =>
	`\`${relation.name}(${relation.columns.join(', ')})\`${relation.gloss}.`;

/**
 * The `query` tool description, for MCP and CLI help alike. Claude Code shows
 * a description only up to its first blank line and cuts it near 4,096
 * characters, so it is one block without blank lines. It names no time zone:
 * `local_time` is the authority on offsets.
 */
export const description = [
	`Read-only SQL over the local SQLite archive of the user's LINE account. Pass one SELECT statement (WITH is fine); the result is \`{ columns, rows }\`, at most ${maxRows} rows and ${maxResultBytes / 1024} KiB, with \`truncated: true\` when rows were cut.`,
	'Tables and columns:',
	...relationLines.map((line) => `- ${line.map(signature).join(' ')}`),
	'Meaning:',
	...notes.map((note) => `- ${note}`)
].join('\n');
