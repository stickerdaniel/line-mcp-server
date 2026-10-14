// The readable fields of non-text messages (architecture, Non-text messages).
// The sync write path derives them from the plaintext metadata of a message's
// envelope whenever it writes that envelope and stores them as columns of
// `message`, so no read ever parses an envelope to describe a message.

/**
 * What a non-text message holds, one column of `message` each. A field is
 * null when LINE gave no valid value for it; text and unsent messages have none.
 */
export interface NonTextFields {
	/** Flex `ALT_TEXT` or sticker `STKTXT`. */
	alt_text: string | null;
	/** `FILE_NAME` of a file, sent in plaintext only without E2EE. */
	file_name: string | null;
	/** `DURATION` of a video, audio message or call. */
	duration_ms: number | null;
	/** 1-based position of an image sent with others; set together with `image_total`. */
	image_index: number | null;
	image_total: number | null;
	call_type: 'audio' | 'video' | null;
	/** LINE's call result in lower case, such as `normal` or `canceled`. */
	call_result: string | null;
	/** The type of a verified chat event, such as `joined`; null leaves every `event_*` null. */
	event: string | null;
	/** MID of who caused the event. */
	event_by: string | null;
	/** MIDs the event names, separated by `,`. */
	event_members: string | null;
	/** The new chat name of a `renamed` event. */
	event_name: string | null;
}

/** The fields of a text or unsent message. */
export const noFields: Readonly<NonTextFields> = Object.freeze({
	alt_text: null,
	file_name: null,
	duration_ms: null,
	image_index: null,
	image_total: null,
	call_type: null,
	call_result: null,
	event: null,
	event_by: null,
	event_members: null,
	event_name: null
});

/** The `message` columns that hold the fields, in declaration order. */
export const nonTextColumns = Object.keys(noFields) as (keyof NonTextFields)[];

/**
 * The plaintext `contentMetadata` keys non-text messages are described by.
 * Only these leave the envelope; chunks, URLs, OID, SID, FLEX_JSON and the
 * rest stay in it.
 */
const metadataKeys = [
	'ALT_TEXT',
	'STKTXT',
	'FILE_NAME',
	'DURATION',
	'GSEQ',
	'GTOTAL',
	'TYPE',
	'RESULT',
	'LOC_KEY',
	'LOC_ARGS'
] as const;
type Metadata = Partial<Record<(typeof metadataKeys)[number], string>>;

const isText = (contentType: string | null): contentType is null | 'NONE' =>
	contentType === null || contentType === 'NONE';

const isMid = (value: string) => /^[a-z][0-9a-f]{32}$/.test(value);

/** A count from a metadata value: a non-negative safe integer written in decimal digits. */
function count(value: string | undefined): number | null {
	if (value === undefined || !/^\d+$/.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

// Maps, so a metadata value such as `__proto__` finds nothing rather than an inherited property.
const callTypes = new Map<string, 'audio' | 'video'>([
	['A', 'audio'],
	['V', 'video']
]);

const optionalActor = ([first]: string[]) =>
	first !== undefined && isMid(first) ? first : undefined;

/**
 * Chat events by `LOC_KEY`, only codes whose arguments are verified against
 * LINE's own client: the event type, the arity it accepts and which argument
 * names whom. Every MID argument holds one MID or several separated by U+001F.
 */
const chatEvents = new Map<
	string,
	{
		type: string;
		arity: number[];
		by?: (args: string[]) => string | undefined;
		members?: (args: string[]) => string | undefined;
		name?: (args: string[]) => string | undefined;
	}
>([
	['C_MJ', { type: 'joined', arity: [1], members: (args) => args[0] }],
	['C_ML', { type: 'left', arity: [1], members: (args) => args[0] }],
	['C_GI', { type: 'invited', arity: [2], by: (args) => args[0], members: (args) => args[1] }],
	['C_MI', { type: 'invited', arity: [2], by: (args) => args[0], members: (args) => args[1] }],
	[
		'C_IC',
		{
			type: 'invitation_canceled',
			arity: [2],
			by: (args) => args[0],
			members: (args) => args[1]
		}
	],
	[
		'C_MR',
		{
			type: 'removed',
			arity: [1, 2],
			by: (args) => (args.length === 2 ? args[0] : undefined),
			members: (args) => args.at(-1)
		}
	],
	['C_PN', { type: 'renamed', arity: [2], by: (args) => args[0], name: (args) => args[1] }],
	['C_PI', { type: 'picture_changed', arity: [1], by: (args) => args[0] }],
	// The actor is optional here: an argument that is not a MID is left out, not refused.
	['C_SN', { type: 'link_join_allowed', arity: [0, 1], by: optionalActor }],
	['C_SP', { type: 'link_join_disabled', arity: [0, 1], by: optionalActor }]
]);

type EventFields = Pick<NonTextFields, 'event' | 'event_by' | 'event_members' | 'event_name'>;

const noEvent: EventFields = { event: null, event_by: null, event_members: null, event_name: null };

/** The event a CHATEVENT's `LOC_KEY` and `LOC_ARGS` describe; none for anything unverified or malformed. */
function chatEvent(metadata: Metadata): EventFields {
	const shape = metadata.LOC_KEY === undefined ? undefined : chatEvents.get(metadata.LOC_KEY);
	if (!shape) return noEvent;
	const args = metadata.LOC_ARGS ? metadata.LOC_ARGS.split('\u001e') : [];
	if (!shape.arity.includes(args.length)) return noEvent;
	const event: EventFields = { ...noEvent, event: shape.type };
	if (shape.by) {
		const by = shape.by(args);
		if (by !== undefined) {
			if (!isMid(by)) return noEvent;
			event.event_by = by;
		}
	}
	if (shape.members) {
		const mids = shape.members(args)?.split('\u001f') ?? [];
		if (mids.length === 0 || !mids.every(isMid)) return noEvent;
		event.event_members = mids.join(',');
	}
	if (shape.name) {
		const name = shape.name(args);
		if (!name) return noEvent;
		event.event_name = name;
	}
	return event;
}

/** What a message of LINE content type `contentType` holds, from its allowlisted metadata. */
function nonTextFields(contentType: string | null, metadata: Metadata): NonTextFields {
	if (isText(contentType)) return noFields;
	const index = count(metadata.GSEQ);
	const total = count(metadata.GTOTAL);
	const imageSet =
		contentType === 'IMAGE' && index !== null && total !== null && index >= 1 && index <= total;
	const call = contentType === 'CALL';
	return {
		alt_text:
			(contentType === 'FLEX'
				? metadata.ALT_TEXT
				: contentType === 'STICKER'
					? metadata.STKTXT
					: undefined) || null,
		file_name: (contentType === 'FILE' && metadata.FILE_NAME) || null,
		duration_ms: ['VIDEO', 'AUDIO', 'CALL'].includes(contentType) ? count(metadata.DURATION) : null,
		image_index: imageSet ? index : null,
		image_total: imageSet ? total : null,
		call_type: call ? (callTypes.get(metadata.TYPE ?? '') ?? null) : null,
		call_result: call && metadata.RESULT ? metadata.RESULT.toLowerCase() : null,
		...(contentType === 'CHATEVENT' ? chatEvent(metadata) : noEvent)
	};
}

/**
 * The allowlisted keys of an envelope's `contentMetadata` with string values.
 * An envelope no JSON parser reads holds none.
 */
function envelopeMetadata(envelope: string): Metadata {
	let source: unknown;
	try {
		source = (JSON.parse(envelope) as { contentMetadata?: unknown } | null)?.contentMetadata;
	} catch {
		return {};
	}
	const metadata: Metadata = {};
	if (typeof source !== 'object' || source === null) return metadata;
	for (const key of metadataKeys) {
		const value = (source as Record<string, unknown>)[key];
		if (typeof value === 'string') metadata[key] = value;
	}
	return metadata;
}

/**
 * The fields of a message written with `envelope` (see `encodeEnvelope`). A
 * text message's envelope is never parsed.
 */
export function envelopeFields(contentType: string | null, envelope: string): NonTextFields {
	return isText(contentType) ? noFields : nonTextFields(contentType, envelopeMetadata(envelope));
}
