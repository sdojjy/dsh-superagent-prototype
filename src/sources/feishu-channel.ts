/** Feishu outbound channel: posts threaded bot replies and constructs chat deep links. */
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { IM_WORDS, checkedImText, wordCount } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { feishuTriggerId } from './feishu-trigger.ts'

/** Feishu or Lark AppLink that opens a chat; used when the message's own link was not delivered with the event. */
export const feishuChatLink = (brand: 'feishu' | 'lark', chatId: string): string =>
  `https://applink.${brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`
/** Feishu's at tag: `user_id` carries the person's open_id (an `ou_…` id), which is the id this tag names. */
const atTag = (openId: string): string => `<at user_id="${openId}"></at>`
/**
 * The body a reply sends: the requester is mentioned in a group chat, where notifying them matters, and only when the message
 * names one. A direct chat has nobody else to notify, and an address stored before `chatType` existed cannot say it is a group,
 * so neither mentions; a person the Source cannot name is not guessed at.
 */
export function feishuReplyText(message: OutboundMessage): string {
  const { mention } = message
  if (!mention || mention.source !== 'feishu' || message.channel.address.chatType !== 'group' || !/^ou_[a-zA-Z0-9]+$/.test(mention.id)) return message.text
  const mentioned = `${atTag(mention.id)} ${message.text}`
  // The tag counts toward the IM limit: keep the conclusion deliverable and drop the mention when both would not fit.
  return wordCount(mentioned) <= IM_WORDS ? mentioned : message.text
}
/**
 * True when Feishu permanently rejects a reply because the target message was recalled, withdrawn, or not found.
 * Only a Feishu response carrying one of these error codes means the target message is gone; timeouts or crashes do not.
 */
const gone = (error: unknown): boolean => error instanceof CliError && error.code !== undefined && (error.code === 230011
  || /withdrawn/i.test(error.message) || (Math.floor(error.code / 100) === 2300 && /not found/i.test(error.message)))
/**
 * Replies in the topic of the target message, which is always the ticket's own message (or the message a person is answered
 * on), so every message of one ticket stays in one topic. Feishu keeps at most one reply per idempotency key (the outgoing
 * message's `message.id`).
 */
export async function sendFeishu(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const messageId = message.channel.address.messageId
  if (!messageId) throw new Error('Missing Feishu reply target')
  const text = checkedImText(feishuReplyText(message))
  const reply = ['im', '+messages-reply', '--message-id', messageId, '--markdown', text, '--reply-in-thread', '--idempotency-key', message.id]
  try { await host.commands.lark(reply) }
  catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
  return 'sent'
}
/** Fallback chat link on the bot's brand; the message's own deep link on its Trigger is preferred when available. */
export const feishuLink = (address: Record<string, string>, links: ChannelLinks): ChannelLink => ({
  url: feishuChatLink(links.feishu?.brand ?? 'feishu', address.chatId ?? ''), label: { zh: '飞书消息', en: 'Feishu message' },
  ...address.messageId ? { triggerId: feishuTriggerId(address.messageId) } : {},
})
