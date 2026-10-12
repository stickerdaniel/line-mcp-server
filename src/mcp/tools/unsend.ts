import { LINEStruct } from '@evex/linejs/thrift';
import { z } from 'zod';
import { LineMcpError } from '../../errors.ts';
import type { Payload } from '../../outbox.ts';
import { chatId, defineTool, idempotencyKey, messageId, service } from '../tool.ts';
import { chatKind, pooled, targetMessage } from './mutation.ts';

export const unsend = defineTool({
	name: 'unsend',
	description:
		'Unsends a message the connected LINE account sent, for everyone. An OpenChat thread message is unsent in its thread. Needs an idempotency_key: a retry with the same key never acts twice. A result with state unknown means LINE may have unsent it.',
	upstream: true,
	mutating: true,
	input: z.object({
		service,
		chat_id: chatId,
		message_id: messageId,
		idempotency_key: idempotencyKey
	}),
	run: async (args, context, signal) => {
		chatKind(args.service, args.chat_id);
		const target = targetMessage(context, args.service, args.chat_id, args.message_id);
		if (target.own === false) {
			throw new LineMcpError('invalid_argument', 'Only own messages can be unsent');
		}
		const { threadId } = target;
		const payload: Payload = {
			operation: 'unsend',
			service: args.service,
			chatId: args.chat_id,
			threadId,
			targetId: args.message_id,
			text: null,
			reaction: null,
			attachmentSha256: null
		};
		const { base } = context;
		return await context.outbox.execute(
			args.idempotency_key,
			payload,
			async () => {
				if (args.service === 'talk') {
					const seq = await base.getReqseq('talk');
					return {
						requestSeq: seq,
						correlation: {},
						dispatch: async () => {
							await base.request.request(
								LINEStruct.unsendMessage_args({ seq, messageId: args.message_id }),
								'unsendMessage',
								4,
								true,
								'/S4'
							);
							return { messageId: null };
						}
					};
				}
				// With `threadMid` for a thread message (base/service/square/mod.ts:518-538).
				return {
					requestSeq: null,
					correlation: {},
					dispatch: async () => {
						await base.square.unsendMessage({
							squareChatMid: args.chat_id,
							messageId: args.message_id,
							...(threadId ? { threadMid: threadId } : {})
						});
						return { messageId: null };
					}
				};
			},
			pooled(context, signal)
		);
	}
});
