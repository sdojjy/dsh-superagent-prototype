import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import type { EffectKind } from '../src/app/effects.ts'
import { en, zh, type DshSuperagentKey } from '../src/client/locales.ts'
import { fullTime, localized, reasonLabel, uiLanguage, valueLabel, when, type T } from '../src/client/text.ts'
import { REASONS, USER_ERRORS } from '../src/core/index.ts'

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
const translate = (dictionary: Record<string, string>) => ((key: DshSuperagentKey, values: Record<string, string> = {}) =>
  (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => values[name] ?? '')) as T

it('names the same placeholders in both languages', () => {
  const keys = Object.keys(zh) as DshSuperagentKey[]
  expect(keys.filter(key => placeholders(zh[key]).join() !== placeholders(en[key]).join())).toEqual([])
  expect(keys.filter(key => !zh[key] || !en[key])).toEqual([])
})

it('words a reason by its code with its values, each of a batch, and words a person or an assessor wrote as written', () => {
  const t = ((key: DshSuperagentKey, values: Record<string, string> = {}) => (zh[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => values[name] ?? '')) as T
  expect(reasonLabel(t, 'retried')).toBe(zh['reason.retried'])
  expect(reasonLabel(t, [{ code: 'routed', values: { ticket: 't1' } }])).toBe('已转给工单 t1')
  expect(reasonLabel(t, [{ code: 'not_a_member', triggerId: '1' }, { code: 'no_mention', triggerId: '2' }]))
    .toBe(`${zh['reason.not_a_member']}；${zh['reason.no_mention']}`)
  expect(reasonLabel(t, [{ code: 'said', values: { text: 'The button is already blue' } }])).toBe('The button is already blue')
  // A code the panel has no words for reads as the host words it.
  expect(reasonLabel(t, { code: 'some_new_filter' })).toBe('some_new_filter')
  expect(reasonLabel(t, 'The button is already blue')).toBe('The button is already blue')
})

it('names every health entry of dsh-superagent itself, which the overview shows when it fails', () => {
  // Each entry by its writer: dsh-superagent, the model budget retries, every kind of the effect queue, Channel messages, the
  // Executor and the unavailable Evals of the last hour.
  const entries = { runtime: 0, models: 0, reply: 0, worker: 0, assessment: 0, launch: 0, delivery: 0, relay: 0,
    notice: 0, evals: 0 } satisfies Record<EffectKind | 'runtime' | 'models' | 'reply' | 'worker' | 'evals', 0>
  expect(Object.keys(entries).filter(name => !(`health.${name}` in zh))).toEqual([])
})

it('words every refusal the host words by code, in both languages', () => {
  expect(Object.keys(USER_ERRORS).filter(code => !zh[`userError.${code}` as DshSuperagentKey]
    || !en[`userError.${code}` as DshSuperagentKey])).toEqual([])
})

it('has words for every reason code the core records', () => {
  expect(Object.keys(REASONS).filter(code => code !== 'said' && !(`reason.${code}` in zh))).toEqual([])
})

it('words the reasons agents read in the glossary\'s words: a sender on the list, a Thread', () => {
  expect(Object.values(REASONS).filter(text => /\b(member|members|topic)\b/i.test(text))).toEqual([])
})

// Every value the panel words from a domain code through `valueLabel`; a code with no entry would surface as a raw identifier.
const VALUE_GROUPS = {
  outcome: ['completed', 'merged', 'closed', 'dropped', 'stopped'],
  stage: ['answer', 'review', 'blocked', 'failed', 'delivery', 'queued', 'working', 'idle'],
  assignment: ['pending', 'running', 'ended'],
  report: ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped', 'completed', 'merged', 'closed', 'stopped', 'open'],
  input: ['trigger', 'policy-changed', 'reopen', 'resumed', 'text', 'note'],
  decision: ['accept', 'reopen', 'stop', 'ignore', 'unavailable'],
  strength: ['explicit', 'inferred'],
  basis: ['admission', 'followup', 'observation', 'bot', 'mode', 'rules', 'legacyAuthority', 'sender', 'addressed'],
  addressed: ['mention', 'direct'],
  targetBasis: ['specified', 'existing-standard', 'undetermined'],
  executionMode: ['develop', 'review'],
  mode: ['off', 'observe', 'auto'],
  legacy: ['explicit_mention', 'proactive_rule', 'thread_followup'],
  promptRole: ['orchestrator', 'worker'],
} as const

it('words every domain value the panel labels, in both languages, so no raw identifier reaches a label', () => {
  const missing = Object.entries(VALUE_GROUPS).flatMap(([group, values]) =>
    values.filter(value => !(`${group}.${value}` in zh) || !(`${group}.${value}` in en)).map(value => `${group}.${value}`))
  expect(missing).toEqual([])
  for (const [group, values] of Object.entries(VALUE_GROUPS))
    for (const value of values) expect(valueLabel(translate(zh), group, value)).not.toBe(`${group}.${value}`)
})

it('reads Chinese for every interface language but English, so Chinese is the default rather than a blank', () => {
  expect(uiLanguage(translate(zh))).toBe('zh')
  expect(uiLanguage(translate(en))).toBe('en')
  // A language pack without its own dictionary falls back to the host's English text; the copy this module picks stays Chinese.
  const third = ((key: DshSuperagentKey) => key === 'lang' ? 'ja' : en[key] ?? key) as T
  expect(uiLanguage(third)).toBe('zh')
  expect(localized(third, { zh: '监听仓库', en: 'Watches repositories' })).toBe('监听仓库')
  expect(localized(third, 'plain text')).toBe('plain text')
  expect(localized(translate(zh), undefined)).toBe('')
})

it('formats times in Chinese for every interface language but English', () => {
  const at = '2026-11-26T03:04:00.000Z'
  expect(when(at, 'en')).toMatch(/[A-Za-z]/)
  expect(when(at, 'zh')).toMatch(/[\u4e00-\u9fff]/)
  expect(when(at, 'zh')).toBe(when(at, 'zh-CN'))
  expect(fullTime(at, 'zh')).toMatch(/\d/)
  expect(fullTime(at, 'en')).toMatch(/\d/)
  expect(fullTime(undefined, 'zh')).toBe('')
})

it('describes the plugin itself in both locale files, in Chinese for Chinese readers', () => {
  const meta = (file: string) => (JSON.parse(readFileSync(new URL(`../locale/${file}`, import.meta.url), 'utf8')) as
    { meta?: { title?: string; description?: string } }).meta
  const chinese = meta('zh.json'), english = meta('en.json')
  expect(chinese?.title).toBeTruthy()
  expect(english?.title).toBeTruthy()
  expect(chinese?.description).toMatch(/[\u4e00-\u9fff]/)
  expect(english?.description).not.toMatch(/[\u4e00-\u9fff]/)
})
