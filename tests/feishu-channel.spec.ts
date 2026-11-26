import { describe, expect, it, vi } from 'vitest'
import type { OutboundMessage } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { feishuChannel } from '../src/sources/feishu-trigger.ts'
import { feishuReplyText, sendFeishu } from '../src/sources/feishu-channel.ts'
import { testDeployment } from './fixtures/deployment.ts'

const deployment = testDeployment()
/** A bot CLI that succeeds, with its arguments recorded. */
function lark() {
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const run = vi.spyOn(commands, 'run').mockResolvedValue('{"ok":true,"data":{}}')
  const args = async (message: OutboundMessage) => {
    await sendFeishu({ commands }, message)
    return run.mock.calls.at(-1)![1] as string[]
  }
  return { args }
}
/** The value a flag was given, or undefined when the argument list omits it. */
const flag = (args: string[], name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
const message = (overrides: Partial<OutboundMessage> = {}): OutboundMessage =>
  ({ id: 'result-1', channel: feishuChannel('oc_team', 'om_1'), text: '结论：已修复。', kind: 'reply', ...overrides })

describe('Feishu replies', () => {
  it('mentions the requester of a result in a group chat, in the ticket\'s topic', async () => {
    const args = await lark().args(message({ mention: { source: 'feishu', id: 'ou_alice' } }))
    expect(flag(args, '--markdown')).toBe('<at user_id="ou_alice"></at> 结论：已修复。')
    expect(flag(args, '--message-id')).toBe('om_1')
    expect(args).toContain('--reply-in-thread')
    expect(flag(args, '--idempotency-key')).toBe('result-1')
  })
  it('mentions nobody in a direct chat, where the person is already the only reader', async () => {
    const args = await lark().args(message({ channel: feishuChannel('oc_dm', 'om_1', true), mention: { source: 'feishu', id: 'ou_alice' } }))
    expect(flag(args, '--markdown')).toBe('结论：已修复。')
    expect(args).toContain('--reply-in-thread')
  })
  it('mentions nobody on an acknowledgement, which carries no mention', async () => {
    const args = await lark().args(message({ id: 'ack-1', kind: 'acknowledgement', text: '收到，开始处理。' }))
    expect(flag(args, '--markdown')).toBe('收到，开始处理。')
  })
  it('mentions nobody for a reply stored before the chat type was recorded, rather than guess it is a group', async () => {
    const old: OutboundMessage = { ...message(), channel: { source: 'feishu', thread: 'feishu:oc_team', address: { chatId: 'oc_team', messageId: 'om_1' } },
      mention: { source: 'feishu', id: 'ou_alice' } }
    expect(feishuReplyText(old)).toBe('结论：已修复。')
    const args = await lark().args(old)
    expect(flag(args, '--markdown')).toBe('结论：已修复。')
  })
  it('mentions nobody the Source cannot name, and nobody of another Source', async () => {
    expect(feishuReplyText(message({ mention: { source: 'feishu', id: 'not-an-open-id' } }))).toBe('结论：已修复。')
    expect(feishuReplyText(message({ mention: { source: 'github', id: 'ou_alice' } }))).toBe('结论：已修复。')
  })
  it('keeps a notice in the ticket\'s topic too, and mentions the requester there', async () => {
    const args = await lark().args(message({ id: 'notice-1', kind: 'notice', text: 'PR 已合并。', mention: { source: 'feishu', id: 'ou_alice' } }))
    expect(args).toContain('--reply-in-thread')
    expect(flag(args, '--markdown')).toBe('<at user_id="ou_alice"></at> PR 已合并。')
  })
  it('keeps the conclusion deliverable when the mention would push it over the IM limit', async () => {
    const text = Array.from({ length: 100 }, () => 'word').join(' ')
    const args = await lark().args(message({ text, mention: { source: 'feishu', id: 'ou_alice' } }))
    expect(flag(args, '--markdown')).toBe(text)
  })
})
