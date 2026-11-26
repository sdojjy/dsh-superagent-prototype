import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, executable, machineOf, resolveDeployment, resolveFeishuBot, type Machine, type Probe } from '../src/deployment.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
let dir: string
let path: string
const program = (file: string, body = ''): string => { writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); return file }
/**
 * Fake gh CLI signed in as `login`; `access` maps each configured repository to the canonical name GitHub reports for it
 * (its new name after a rename) and whether the account may push, or 'unreadable' for a repository it cannot read.
 */
const gh = (file: string, login: string, access: Record<string, { name?: string; push?: boolean } | 'unreadable'> = { 'acme/widgets': {} }): string => {
  const cases = Object.entries(access).map(([configured, value]) => value === 'unreadable'
    ? `  "api repos/${configured} --jq "*) echo 'HTTP 404' >&2; exit 1 ;;`
    : `  "api repos/${configured} --jq "*) echo '${JSON.stringify({ name: value.name ?? configured, push: value.push ?? true })}' ;;`)
  return program(file, `case "$*" in\n  "api user") echo '{"login":"${login}","id":7}' ;;\n${cases.join('\n')}\n  *) exit 1 ;;\nesac`)
}
/** Fake lark-cli script body returning canned auth, strict-mode, and bot info responses. */
const lark = (status: object, mode = 'bot', bot: object = { bot: { open_id: 'ou_bot', app_name: 'Widgets Bot' }, code: 0 }): string =>
  `case "$*" in\n  "auth status") echo '${JSON.stringify(status)}' ;;\n  "config strict-mode") echo 'strict-mode: ${mode} (source: profile)' ;;\n  "api GET /open-apis/bot/v3/info --as bot --format ndjson") echo '${JSON.stringify(bot)}' ;;\nesac`
/** Fake gh CLI that reports push access to any repository it is asked about, named as GitHub would. */
const ghAny = (file: string, login: string): string => program(file, `case "$*" in
  "api user") echo '{"login":"${login}","id":7}' ;;
  "api repos/"*) repo=$(echo "$2" | sed 's#^repos/##'); echo "{\\"name\\":\\"$repo\\",\\"push\\":true}" ;;
  *) exit 1 ;;
esac`)
const minimal = (overrides: Record<string, unknown> = {}) => ({ stateDir: join(dir, 'state'), ...overrides })
const machine = (overrides: Partial<Machine> = {}): Machine => ({ ...machineOf(Config(minimal())), ...overrides })
/** Runs commands like worker shells do, but locally: the stand-ins first on PATH, then the system's git. */
const probe: Probe = async argv => (await exec(argv[0]!, argv.slice(1), { env: { PATH: path, HOME: dir } })).stdout
const setupError = (place: string, code: string, values: Record<string, unknown> = {}) => expect.objectContaining({ place, code, values: expect.objectContaining(values) })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deployment-'))
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true }); mkdirSync(join(dir, 'widgets', 'src'), { recursive: true })
  path = [join(dir, 'state-link', 'worker-bin'), `${join(dir, 'state', 'worker-bin')}/`, join(dir, 'bin'), '/usr/bin', '/bin'].join(':')
  gh(join(dir, 'bin', 'gh'), 'Agent-Bot', { 'acme/widgets': {}, 'acme/gadgets': {} })
  program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', brand: 'lark', identities: { bot: { status: 'ready' } } }))
  // Stale worker shims with the same binary name must be skipped regardless of PATH normalization or symlinks.
  program(join(dir, 'state', 'worker-bin', 'gh'))
  symlinkSync(join(dir, 'state'), join(dir, 'state-link'))
  await exec('git', ['init', '-q', join(dir, 'widgets')], { env: gitEnv() })
  await exec('git', ['-C', join(dir, 'widgets'), 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { env: gitEnv() })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// Setup spawns CLI subprocesses that can take several seconds when tests run in parallel.
vi.setConfig({ testTimeout: 30_000 })

describe('configuration schema', () => {
  it('requires only the state directory and reads the editable fields through references', () => {
    expect(() => Config({})).toThrow('stateDir')
    const read = machineOf(Config({ stateDir: join(dir, 'state') }))
    // Limits are volatile references that the loader updates in place and callers read when used.
    expect({ ...read, promptMaxChars: read.promptMaxChars.get(), admissionContextMaxPages: read.admissionContextMaxPages.get(),
      admissionContextTimeoutMs: read.admissionContextTimeoutMs.get() })
      .toEqual({ stateDir: join(dir, 'state'), promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 })
    expect(() => Config(minimal({ stateDir: 'relative/dir' }))).toThrow()
    expect(() => Config(minimal({ stateDir: '~/dir' }))).toThrow()
  })
  it('names keys the configuration does not define, and where the values of older keys live now', () => {
    const raw = minimal({ repository: 'acme/widgets', repositoryPath: '/srv/widgets', blockedCommands: [], author: { name: 'Alice' }, extra: 1 })
    expect(() => machineOf(Config(raw))).toThrow('keys it does not use: repository (now on the GitHub Source), repositoryPath (now in the prepare command of the Execution settings), blockedCommands (now in the Execution settings), author (now prompt text), extra;')
  })
})

describe('setup', () => {
  it('reads the repositories from the GitHub Source and the accounts from their CLIs, skipping the worker shims', async () => {
    const deployment = await resolveDeployment(machine(), { repositories: ['acme/widgets', 'acme/gadgets'], cli: 'gh' }, probe, path)
    expect(deployment).toMatchObject({ repository: 'acme/widgets', repositories: ['acme/widgets', 'acme/gadgets'],
      github: { cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' } })
    expect(deployment.github).toEqual({ cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' })
    expect(deployment).not.toHaveProperty('feishu')
    // A repository list written as text is split, and its first entry is the default repository.
    expect((await resolveDeployment(machine(), { repositories: 'acme/widgets, acme/gadgets', cli: 'gh' }, probe, path)).repositories)
      .toEqual(['acme/widgets', 'acme/gadgets'])
    // The legacy single repository still resolves, and a renamed repository by its old name; notifications carry the current full_name.
    expect(await resolveDeployment(machine(), { repository: 'acme/widgets', cli: 'gh' }, probe, path))
      .toMatchObject({ repository: 'acme/widgets', repositories: ['acme/widgets'] })
    const legacyRenamed = gh(join(dir, 'bin', 'gh-legacy-renamed'), 'Agent-Bot', { 'acme/gadgets': { name: 'acme/widgets' } })
    expect((await resolveDeployment(machine(), { repository: 'acme/gadgets', cli: legacyRenamed }, probe, path)).repositories)
      .toEqual(['acme/widgets'])
    // Settings that name no repository use the built-in list.
    expect((await resolveDeployment(machine(), { cli: ghAny(join(dir, 'bin', 'gh-any'), 'Agent-Bot') }, probe, path)).repositories)
      .toEqual(['tidbcloud/serverless-service', 'tidbcloud/dataflow-service', 'tidbcloud/cluster-service-ng', 'tidbcloud/infra-provider'])
  })
  it('checks push access to every repository, naming the one that fails', async () => {
    const mixed = gh(join(dir, 'bin', 'gh-mixed'), 'Agent-Bot', { 'acme/widgets': {}, 'acme/gadgets': { push: false } })
    await expect(resolveDeployment(machine(), { repositories: ['acme/widgets', 'acme/gadgets'], cli: mixed }, probe, path))
      .rejects.toEqual(setupError('github', 'repositoryReadOnly', { account: 'Agent-Bot', repository: 'acme/gadgets' }))
    // The first failing repository is the one named, in configuration order.
    const outsider = gh(join(dir, 'bin', 'gh-outsider'), 'Agent-Bot', { 'acme/widgets': {}, 'acme/private': 'unreadable' })
    await expect(resolveDeployment(machine(), { repositories: ['acme/private', 'acme/widgets'], cli: outsider }, probe, path))
      .rejects.toEqual(setupError('github', 'repositoryUnreadable', { account: 'Agent-Bot', repository: 'acme/private',
        output: expect.stringContaining('HTTP 404') }))
    // Two names for one renamed repository resolve to one canonical name.
    const renamed = gh(join(dir, 'bin', 'gh-renamed'), 'Agent-Bot', { 'acme/widgets': {}, 'acme/gadgets': { name: 'acme/widgets' } })
    expect((await resolveDeployment(machine(), { repositories: ['acme/gadgets', 'acme/widgets'], cli: renamed }, probe, path)).repositories)
      .toEqual(['acme/widgets'])
  })
  it('names what setup needs and where it is set', async () => {
    const needs = (place: string, code: string, values: Record<string, unknown>, github: unknown) =>
      expect(resolveDeployment(machine(), github, probe, path)).rejects.toEqual(setupError(place, code, values))
    const repository = 'acme/widgets'
    await needs('github', 'agentCliUnset', {}, { repository })
    await needs('github', 'agentCliMissing', { output: `${join(dir, 'missing')} is not an executable file` }, { repository, cli: join(dir, 'missing') })
    await needs('github', 'agentCliMissing', { output: 'bin/gh must be a command name or an absolute path' }, { repository, cli: 'bin/gh' })
    await needs('github', 'agentCliSignedOut', {}, { repository, cli: program(join(dir, 'bin', 'gh-broken'), 'exit 1') })
    const unreadable = program(join(dir, 'bin', 'gh-outsider'),
      `case "$*" in\n  "api user") echo '{"login":"Agent-Bot","id":7}' ;;\n  *) echo 'HTTP 404' >&2; exit 1 ;;\nesac`)
    const output = expect.stringContaining('HTTP 404') as unknown
    await needs('github', 'repositoryUnreadable', { account: 'Agent-Bot', repository: 'acme/widgets', output }, { repository, cli: unreadable })
    await needs('github', 'agentCliNoAccount', {}, { repository, cli: program(join(dir, 'bin', 'gh-anonymous'), `echo '{}'`) })
    await needs('github', 'repositoryUnreported', { repository: 'acme/widgets' },
      { repository, cli: program(join(dir, 'bin', 'gh-nonsense'), `case "$*" in\n  "api user") echo '{"login":"Agent-Bot","id":7}' ;;\n  *) echo 'not json' ;;\nesac`) })
    expect(() => executable('nothing-here', join(dir, 'bin'))).toThrow('nothing-here is not an executable file on PATH')
  })
  it('reads the Feishu bot from a bot-only lark-cli, or finds none when the Feishu Source names no CLI', async () => {
    expect(await resolveFeishuBot(machine(), {}, probe, path)).toBeUndefined()
    expect(await resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).toEqual({ cli: join(dir, 'bin', 'lark-cli'), appId: 'cli_bot', brand: 'lark', botId: 'ou_bot', name: 'Widgets Bot' })
    const refuses = async (code: string, values: Record<string, unknown> = {}) => expect(resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).rejects.toEqual(setupError('feishu', code, values))
    program(join(dir, 'bin', 'lark-cli'), lark({ identities: { bot: { status: 'ready' } } }))
    await refuses('feishuNoApp')
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'missing' } } }))
    await refuses('feishuBotNotReady', { app: 'cli_bot', status: 'missing' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'off'))
    await refuses('feishuUserIdentity', { mode: 'off' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'bot', { code: 0, data: {} }))
    await refuses('feishuNoBot')
    program(join(dir, 'bin', 'lark-cli'), 'echo "not configured" >&2; exit 1')
    await refuses('feishuCliFailed', { output: expect.stringContaining('not configured') })
  })
})
