import { LINEStruct } from '@evex/linejs/thrift';
import { z } from 'zod';
import type { Payload } from '../../outbox.ts';
import { int64 } from '../../sync/normalize.ts';
import { chatId, defineTool, idempotencyKey, messageId, service } from '../tool.ts';
import { chatKind, pooled, targetMessage } from './mutation.ts';

const reactions = ['nice', 'love', 'fun', 'amazing', 'sad', 'omg'] as const;

export const react = defineTool({
	name: 'react',
	description:
		'Reacts to a message as the connected LINE account. An OpenChat thread message is reacted to in its thread. Needs an idempotency_key: a retry with the same key never reacts twice. A result with state unknown means LINE may have applied it.',
	upstream: true,
	mutating: true,
	input: z.object({
		service,
		chat_id: chatId,
		message_id: messageId,
		reaction: z.enum(reactions).describe('One of nice, love, fun, amazing, sad, omg'),
		idempotency_key: idempotencyKey
	}),
	run: async (args, context, signal) => {
		chatKind(args.service, args.chat_id);
		const { threadId } = targetMessage(context, args.service, args.chat_id, args.message_id);
		const reaction = args.reaction.toUpperCase() as Uppercase<(typeof reactions)[number]>;
		const payload: Payload = {
			operation: 'react',
			service: args.service,
			chatId: args.chat_id,
			threadId,
			targetId: args.message_id,
			text: null,
			reaction,
			attachmentSha256: null
		};
		const { base } = context;
		return await context.outbox.execute(
			args.idempotency_key,
			payload,
			async () => {
				if (args.service === 'talk') {
					// As LINEJS's `react` (base/service/talk/mod.ts:852-876).
					const reqSeq = await base.getReqseq('talk');
					return {
						requestSeq: reqSeq,
						correlation: {},
						dispatch: async () => {
							await base.request.request(
								LINEStruct.react_args({
									reactRequest: {
										reqSeq,
										messageId: int64(args.message_id),
										reactionType: { predefinedReactionType: reaction }
									}
								}),
								'react',
								4,
								true,
								'/S4'
							);
							return { messageId: null };
						}
					};
				}
				// `reactToMessage` carries the thread (client/features/message/square.ts:539-554).
				const reqSeq = await base.getReqseq('sq');
				return {
					requestSeq: reqSeq,
					correlation: {},
					dispatch: async () => {
						await base.square.reactToMessage({
							request: {
								reqSeq,
								squareChatMid: args.chat_id,
								messageId: args.message_id,
								reactionType: reaction,
								...(threadId ? { threadMid: threadId } : {})
							}
						});
						return { messageId: null };
					}
				};
			},
			pooled(context, signal)
		);
	}
});
