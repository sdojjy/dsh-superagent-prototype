import { describe, expect, it } from 'vitest'
import { Engine, MemoryRepositories, type OutboundMessage, type Policy, type Ticket, type Trigger } from '../src/core/index.ts'
import { feishuTrigger } from '../src/sources/feishu-trigger.ts'

const CHAT = 'oc_team'
const AT = Date.parse('2026-09-09T00:00:00Z')
/** A live event as the Feishu consumer prints it; `group` unless the overrides make it a direct chat. */
const event = (id: string, overrides: Record<string, unknown> = {}) => ({ message_id: `om_${id}`, chat_id: CHAT, chat_type: 'group',
  sender_id: 'ou_alice', sender_type: 'user', content: `message ${id}`, mentions: [{ id: 'ou_bot' }], create_time: String(AT), ...overrides })
/** A core Engine over memory repositories, with the messages queued for Channels recorded. */
function harness() {
  const repo = new MemoryRepositories()
  const outbox: OutboundMessage[] = []
  const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 60_000, gate: () => ({ admissible: true, strength: 'explicit',
    basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => true }
  const engine = new Engine({ repo, policy: () => policy, scope: { scope: () => ({ listened: true, observed: false }) },
    assessor: { request: () => {} }, executor: { start: () => {}, deliver: () => {}, stop: () => {} },
    outbox: {
      send: message => { if (!outbox.some(item => item.id === message.id)) outbox.push(message) },
      status: id => outbox.some(item => item.id === id) ? 'pending' : undefined,
      withdraw: () => {},
    }, now: () => new Date(AT).toISOString() })
  return { repo, engine, outbox }
}
/** Saves a Feishu Trigger for a message, as intake would, and returns it. */
function received(h: ReturnType<typeof harness>, id: string, overrides: Record<string, unknown> = {}): Trigger {
  const trigger = feishuTrigger(event(id, overrides), 'ou_bot', 'cli_bot')!
  h.repo.triggers.save(trigger)
  return trigger
}
/** A Ticket started by `origin`, ended with `outcome` when given, so its result may be sent. */
function ticket(origin: Trigger, overrides: Partial<Ticket> = {}): Ticket {
  return { id: 't1', title: 'Fix the login', decisionId: 'd1', mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' },
    actor: origin.actor, scope: CHAT }, channels: [origin.channel!], assignments: [], inputs: [], undelivered: [],
  createdAt: origin.at, updatedAt: origin.at, origin: { triggerId: origin.id, triggerIds: [origin.id] }, ...overrides }
}
const outcome = (origin: Trigger) => ({ ended: { at: origin.at, by: 'executor' as const, outcome: 'completed' as const } })

describe('who a reply mentions', () => {
  it('names the person whose message started the ticket, on its result', () => {
    const h = harness()
    const origin = received(h, '1')
    h.repo.tickets.save(ticket(origin, outcome(origin)))
    h.engine.reply({ purpose: 'result', ticketId: 't1', text: '结论：已修复。' })
    expect(h.outbox).toHaveLength(1)
    expect(h.outbox[0]).toMatchObject({ kind: 'reply', text: '结论：已修复。', ticketId: 't1', mention: { source: 'feishu', id: 'ou_alice' },
      channel: { source: 'feishu', address: { chatId: CHAT, messageId: 'om_1', chatType: 'group' } } })
  })
  it('names nobody on an acknowledgement, which only says the work was taken up', () => {
    const h = harness()
    const origin = received(h, '1')
    h.repo.tickets.save(ticket(origin))
    h.engine.reply({ purpose: 'acknowledgement', ticketId: 't1', triggerId: origin.id, text: '收到，开始处理。' })
    expect(h.outbox).toHaveLength(1)
    expect(h.outbox[0]).not.toHaveProperty('mention')
    expect(h.outbox[0]).toMatchObject({ kind: 'acknowledgement', text: '收到，开始处理。' })
  })
  it('names the person whose question raised the ticket\'s attention, not the ticket\'s requester', () => {
    const h = harness()
    const origin = received(h, '1')
    const asker = received(h, '2', { sender_id: 'ou_bob' })
    h.repo.tickets.save(ticket(origin, { attention: { id: 'attention-1', question: 'Which color?', triggerId: asker.id } }))
    h.engine.reply({ purpose: 'attention', ticketId: 't1', question: 'Which color?', text: '请确认颜色。' })
    expect(h.outbox).toHaveLength(1)
    expect(h.outbox[0]).toMatchObject({ text: '请确认颜色。', mention: { source: 'feishu', id: 'ou_bob' },
      channel: { source: 'feishu', address: { messageId: 'om_2' } } })
  })
  it('falls back to the ticket\'s requester when its attention came from a report, not a person\'s message', () => {
    const h = harness()
    const origin = received(h, '1')
    h.repo.tickets.save(ticket(origin, { attention: { id: 'attention-1', question: 'Which color?' } }))
    h.engine.reply({ purpose: 'attention', ticketId: 't1', question: 'Which color?', text: '请确认颜色。' })
    expect(h.outbox[0]).toMatchObject({ mention: { source: 'feishu', id: 'ou_alice' },
      channel: { source: 'feishu', address: { messageId: 'om_1' } } })
  })
  it('names the ticket\'s requester on an answer, and answers on the message it answers', () => {
    const h = harness()
    const origin = received(h, '1')
    const follow = received(h, '3', { sender_id: 'ou_bob', root_id: 'om_1' })
    h.repo.tickets.save(ticket(origin, { inputs: [{ id: 'input-1', kind: 'trigger', triggerId: follow.id, at: follow.at }], answers: [follow.id] }))
    h.engine.reply({ purpose: 'answer', triggerId: follow.id, text: '颜色用蓝色。' })
    expect(h.outbox[0]).toMatchObject({ mention: { source: 'feishu', id: 'ou_alice' },
      channel: { source: 'feishu', address: { messageId: 'om_3' } } })
  })
  it('names nobody when the ticket did not start on Feishu', () => {
    const h = harness()
    const origin: Trigger = { id: 'github:7', source: 'github', threads: [{ source: 'github', id: 'acme/widgets#7' }],
      actor: { source: 'github', id: 'alice' }, human: true, at: new Date(AT).toISOString(), text: 'Fix it',
      channel: { source: 'github', thread: 'github:acme/widgets#7', address: { number: '7' } }, meta: {} }
    h.repo.triggers.save(origin)
    h.repo.tickets.save(ticket(origin, outcome(origin)))
    h.engine.reply({ purpose: 'result', ticketId: 't1', text: 'Done.' })
    expect(h.outbox[0]).not.toHaveProperty('mention')
  })
  it('names nobody when a bot started the ticket, since only a person is asked for work', () => {
    const h = harness()
    const origin = received(h, '1', { sender_id: 'ou_some_bot', sender_type: 'bot' })
    h.repo.tickets.save(ticket(origin, outcome(origin)))
    h.engine.reply({ purpose: 'result', ticketId: 't1', text: '结论：已修复。' })
    expect(h.outbox[0]).not.toHaveProperty('mention')
  })
  it('acknowledges a ticket at most once, so a group hears only the conclusion after it', () => {
    const h = harness()
    const origin = received(h, '1')
    h.repo.tickets.save(ticket(origin))
    h.engine.reply({ purpose: 'acknowledgement', ticketId: 't1', triggerId: origin.id, text: '收到，开始处理。' })
    h.engine.reply({ purpose: 'acknowledgement', ticketId: 't1', triggerId: origin.id, text: '收到，马上看。' })
    expect(h.outbox).toHaveLength(1)
    expect(h.outbox[0]).toMatchObject({ kind: 'acknowledgement', text: '收到，开始处理。' })
  })
})

describe('one topic per ticket', () => {
  it('replies to the ticket\'s starting message however many results it sends', () => {
    const h = harness()
    const origin = received(h, '1')
    h.repo.tickets.save(ticket(origin, outcome(origin)))
    h.engine.reply({ purpose: 'result', ticketId: 't1', text: '结论：已修复。' })
    h.engine.reply({ purpose: 'result', ticketId: 't1', text: '补充：已合并。' })
    expect(h.outbox).toHaveLength(2)
    expect(h.outbox.map(item => item.channel.address.messageId)).toEqual(['om_1', 'om_1'])
    expect(new Set(h.outbox.map(item => item.channel.thread))).toEqual(new Set(['feishu:oc_team']))
  })
  it('keeps a later result on the starting message after answering a question elsewhere', () => {
    const h = harness()
    const origin = received(h, '1')
    const asker = received(h, '2', { sender_id: 'ou_bob' })
    h.repo.tickets.save(ticket(origin, { attention: { id: 'attention-1', question: 'Which color?', triggerId: asker.id } }))
    h.engine.reply({ purpose: 'attention', ticketId: 't1', question: 'Which color?', text: '请确认颜色。' })
    // The worker finished: the question is gone and the ticket ends, and its result still goes to the starting message.
    h.repo.tickets.save({ ...h.repo.tickets.get('t1')!, attention: undefined, ended: { at: origin.at, by: 'executor', outcome: 'completed' } })
    h.engine.reply({ purpose: 'result', ticketId: 't1', text: '结论：已修复。' })
    expect(h.outbox.map(item => item.channel.address.messageId)).toEqual(['om_2', 'om_1'])
  })
})
