// Review mode: its git hooks, read-only `gh` wrapper, isolated HOME, added blocked commands, prompt section and setup check.
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import {
  REVIEW_BLOCKED_COMMANDS, agentVariables, effectiveBlockedCommands, verifyReviewEnvironment, workerBin, workerGitConfig, workerHome, workerHooks,
  writeEnvironment,
} from '../src/infra/environment.ts'
import { SetupError } from '../src/setup.ts'
import { Prompts, composePrompt, defaultPrompts, promptParts } from '../src/app/prompts.ts'
import { reviewPrompt } from '../src/app/context.ts'
import { Store } from '../src/app/store.ts'
import { testDeployment } from './fixtures/deployment.ts'

// Shell and git subprocesses can exceed the 5s default timeout when the test suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 })
const exec = promisify(execFile)
let dir: string
const program = (path: string, body: string): string => { writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); return path }
/** A deployment whose agent CLI is the echo stub the wrapper calls, so each allowed command shows the arguments it received. */
const deployment = (cli = join(dir, 'gh-agent')) => testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli } })
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'review-mode-')); mkdirSync(join(dir, 'real')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('review-mode git hooks', () => {
  it('writes pre-commit, pre-push and pre-rebase that refuse, and points the worker git configuration at them', async () => {
    await writeEnvironment(deployment(), [], 'review')
    const hooks = workerHooks(dir)
    expect(readdirSync(hooks).sort()).toEqual(['pre-commit', 'pre-push', 'pre-rebase'])
    for (const name of readdirSync(hooks)) {
      const file = join(hooks, name)
      expect(statSync(file).mode & 0o777).toBe(0o755)
      await expect(exec(file, [])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('review mode') })
    }
    expect(statSync(hooks).mode & 0o777).toBe(0o700)
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toContain(`[core]\n\thooksPath = "${hooks}"`)
  })
  it('removes the hooks and the hooksPath setting when the mode goes back to develop', async () => {
    await writeEnvironment(deployment(), [], 'review')
    await writeEnvironment(deployment(), [], 'develop')
    expect(existsSync(workerHooks(dir))).toBe(false)
    expect(readFileSync(workerGitConfig(dir), 'utf8')).not.toContain('hooksPath')
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toContain('Written by dsh-superagent')
  })
  it('refuses to replace a hook file it did not write', async () => {
    mkdirSync(workerHooks(dir), { recursive: true })
    writeFileSync(join(workerHooks(dir), 'pre-push'), '#!/bin/sh\n')
    await expect(writeEnvironment(deployment(), [], 'review')).rejects.toThrow(`${join(workerHooks(dir), 'pre-push')} was not written by dsh-superagent`)
    expect(readFileSync(join(workerHooks(dir), 'pre-push'), 'utf8')).toBe('#!/bin/sh\n')
  })
})

describe('review-mode gh wrapper', () => {
  /** Run the worker's `gh` shim with the stub CLI in front of the real PATH, returning its output or throwing its refusal. */
  const gh = (...args: string[]) => {
    const bin = workerBin(dir)
    return exec(join(bin, 'gh'), args, { env: { PATH: [bin, process.env.PATH ?? ''].join(':') } }) as unknown as Promise<{ stdout: string }>
  }
  beforeEach(async () => {
    program(join(dir, 'gh-agent'), 'echo "REAL $*"')
    await writeEnvironment(deployment(), [], 'review')
  })
  it.each([
    ['api', 'repos/acme/widgets/pulls/1'],
    ['api', '--method', 'GET', 'repos/acme/widgets/pulls/1/files'],
    ['api', '--method', 'POST', 'repos/acme/widgets/pulls/1/reviews', '-f', 'body=Please fix this.'],
    ['api', '-XPOST', 'repos/acme/widgets/pulls/comments', '-f', 'body=Answered.'],
    ['pr', 'view', '1'],
    ['pr', 'list'],
    ['pr', 'diff'],
    ['pr', 'checks'],
    ['issue', 'view', '1'],
    ['issue', 'list'],
    ['repo', 'view'],
    ['search', 'prs', 'fix'],
    ['auth', 'status'],
    ['auth', 'git-credential', 'get'],
    ['--version'],
  ])('runs the read command %s', async (...args: string[]) => {
    const { stdout } = await gh(...args)
    expect(stdout.trim()).toBe(`REAL ${args.join(' ')}`)
  })
  it.each([
    ['pr', 'create', '--title', 'x'],
    ['pr', 'merge', '1'],
    ['pr', 'close', '1'],
    ['pr', 'edit', '1'],
    ['pr', 'comment', '1', '-b', 'x'],
    ['issue', 'create'],
    ['issue', 'close', '1'],
    ['issue', 'comment', '1', '-b', 'x'],
    ['api', '-X', 'DELETE', 'repos/acme/widgets/contents/x'],
    ['api', '-X', 'PATCH', 'repos/acme/widgets'],
    ['api', '--method', 'POST', 'repos/acme/widgets/issues/1/comments', '-f', 'body=x'],
    ['api', 'repos/acme/widgets/issues', '-f', 'title=x'],
    ['api', 'graphql', '-f', 'query={viewer{login}}'],
    ['api', 'https://api.github.com/repos/acme/widgets'],
    ['auth', 'token'],
    ['release', 'create', 'v1'],
  ])('refuses the write command %s', async (...args: string[]) => {
    await expect(gh(...args)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('refused in review mode') })
  })
  it('runs every command in develop mode, as before', async () => {
    await writeEnvironment(deployment(), [], 'develop')
    const { stdout } = await gh('pr', 'create', '--title', 'x')
    expect(stdout.trim()).toBe('REAL pr create --title x')
  })
})

describe('review-mode isolation', () => {
  it('points HOME and the XDG bases at an empty private directory and clears the operator connection variables', async () => {
    await writeEnvironment(deployment(), [], 'review')
    const home = workerHome(dir)
    expect(statSync(home).mode & 0o777).toBe(0o700)
    expect(readdirSync(home)).toEqual([])
    const review = agentVariables(dir, 'review')
    expect(review.HOME).toBe(home)
    expect(review.XDG_CONFIG_HOME).toBe(join(home, '.config'))
    expect(review.XDG_CACHE_HOME).toBe(join(home, '.cache'))
    for (const name of ['SSH_AUTH_SOCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'KUBECONFIG', 'DISPLAY']) {
      expect(Object.hasOwn(review, name)).toBe(true)
      expect(review[name]).toBeUndefined()
    }
    // The agent account still comes from the gh configuration, which review mode leaves in place.
    expect(review.GH_TOKEN).toBeUndefined()
    expect(review.GIT_CONFIG_GLOBAL).toBe(workerGitConfig(dir))
  })
  it('lets the account CLIs keep the operator\'s HOME, so wrappers resolving their configuration through it work', async () => {
    program(join(dir, 'gh-agent'), 'echo "HOME=$HOME"')
    const base = testDeployment()
    program(join(dir, 'lark-bot'), 'echo "HOME=$HOME"')
    await writeEnvironment(deployment(), [], 'review')
    const bin = workerBin(dir), env = { PATH: [bin, process.env.PATH ?? ''].join(':'), HOME: workerHome(dir) }
    expect((await exec(join(bin, 'gh'), ['api', 'user'], { env }) as unknown as { stdout: string }).stdout.trim()).toBe(`HOME=${process.env.HOME}`)
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...base.github, cli: join(dir, 'gh-agent') },
      feishu: { ...base.feishu!, cli: join(dir, 'lark-bot') } }), [], 'review')
    expect((await exec(join(bin, 'lark-cli'), ['im'], { env }) as unknown as { stdout: string }).stdout.trim()).toBe(`HOME=${process.env.HOME}`)
  })
  it('leaves HOME and the connection variables as develop mode has them', () => {
    const develop = agentVariables(dir)
    expect(Object.hasOwn(develop, 'HOME')).toBe(false)
    expect(Object.hasOwn(develop, 'SSH_AUTH_SOCK')).toBe(false)
    expect(develop.GIT_CONFIG_GLOBAL).toBe(workerGitConfig(dir))
  })
  it('blocks review mode\'s own commands whatever the settings name, and keeps the configured ones', async () => {
    expect(effectiveBlockedCommands([], 'review')).toEqual(expect.arrayContaining([...REVIEW_BLOCKED_COMMANDS]))
    expect(effectiveBlockedCommands(['my-cli'], 'review')).toEqual(expect.arrayContaining(['my-cli', 'ssh', 'curl', 'wget']))
    expect(effectiveBlockedCommands(['my-cli'], 'develop')).toEqual(['my-cli'])
    await writeEnvironment(deployment(), ['my-cli'], 'review')
    const bin = workerBin(dir)
    for (const name of ['ssh', 'scp', 'rsync', 'security', 'osascript', 'curl', 'wget', 'open', 'my-cli']) {
      await expect(exec(join(bin, name), [])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(`${name} is blocked`) })
    }
    await writeEnvironment(deployment(), ['my-cli'], 'develop')
    expect(readdirSync(bin).sort()).toEqual(['gh', 'lark-cli', 'my-cli'])
  })
})

describe('review-mode setup check', () => {
  /** A subprocess service whose commands all succeed with `stdout`, as a worker `git` would. */
  const subprocess = (stdout: string): SubprocessRuntime => ({
    spawn: () => {
      const reader = () => ({ readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) })
      return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: reader(), stderr: reader() } }
    },
  }) as unknown as SubprocessRuntime
  const signal = new AbortController().signal
  it('accepts the hooks path and shims it wrote, and refuses a hooks path something else set', async () => {
    await writeEnvironment(deployment(), [], 'review')
    await expect(verifyReviewEnvironment({ stateDir: dir }, 'review', subprocess(`${workerHooks(dir)}\n`), signal)).resolves.toBeUndefined()
    await expect(verifyReviewEnvironment({ stateDir: dir }, 'review', subprocess('/tmp/other-hooks\n'), signal))
      .rejects.toMatchObject({ code: 'reviewGuardMissing', values: { expected: workerHooks(dir), found: '/tmp/other-hooks' } })
    await expect(verifyReviewEnvironment({ stateDir: dir }, 'develop', subprocess('/tmp/other-hooks\n'), signal)).resolves.toBeUndefined()
  })
  it('refuses a hook that is missing or not executable, and a gh shim that is not the review wrapper', async () => {
    await writeEnvironment(deployment(), [], 'review')
    chmodSync(join(workerHooks(dir), 'pre-push'), 0o644)
    await expect(verifyReviewEnvironment({ stateDir: dir }, 'review', subprocess(`${workerHooks(dir)}\n`), signal))
      .rejects.toBeInstanceOf(SetupError)
    chmodSync(join(workerHooks(dir), 'pre-push'), 0o755)
    writeFileSync(join(workerBin(dir), 'gh'), '#!/bin/sh\n')
    await expect(verifyReviewEnvironment({ stateDir: dir }, 'review', subprocess(`${workerHooks(dir)}\n`), signal))
      .rejects.toMatchObject({ code: 'reviewGuardMissing', values: { found: 'another gh shim' } })
  })
})

describe('review-mode prompt section', () => {
  it('injects the review instructions after the team sections only in review mode, for both roles', () => {
    const store = new Store(join(dir, 'db'))
    try {
      const prompts = new Prompts(store, () => 100000, () => undefined, () => false)
      const config = { ...defaultPrompts(), custom: 'Prefer small diffs.' }
      const develop = promptParts(config, 'worker').map(part => part.name)
      expect(develop).not.toContain('runtime/review')
      expect(composePrompt(config, 'worker')).not.toContain(reviewPrompt)
      store.saveSettings({ ...store.settings(), executor: { ...store.settings().executor, mode: 'review' } })
      for (const role of ['orchestrator', 'worker'] as const) {
        const names = prompts.preview(config).parts[role].map(part => part.name)
        const at = names.indexOf('custom')
        expect(names.slice(at, at + 2)).toEqual(['custom', 'runtime/review'])
        expect(prompts.compose(config, role)).toContain(`## review mode\n${reviewPrompt}`)
      }
      // The section is a built-in part a team may override like any other.
      const preview = prompts.preview(config)
      expect(preview.parts.worker.map(part => part.name)).toContain('runtime/review')
      expect(preview.worker).toBe(prompts.compose(config, 'worker'))
    } finally { store.close() }
  })
  it('states the review rules the worker environment enforces', () => {
    for (const phrase of ['Do not create, modify, move or delete any file', 'no git add, commit, push', 'file:line', 'P1, P2 or P3',
      'in English', 'Reply on Feishu in Chinese', 'Never include a local absolute path', 'Read only inside this ticket']) {
      expect(reviewPrompt).toContain(phrase)
    }
  })
})

describe('custom prompt section', () => {
  it('saves as its own versioned team section and reaches the prompt after the built-in team sections', () => {
    const store = new Store(join(dir, 'db'))
    try {
      const prompts = new Prompts(store, () => 100000, () => undefined, () => false)
      expect(prompts.current().config.custom).toBe('')
      const saved = prompts.save({ ...defaultPrompts(), custom: 'Keep changes small.' }, 0, 'panel')
      expect(saved.config.custom).toBe('Keep changes small.')
      expect(prompts.compose(saved.config, 'worker')).toContain('## Custom instructions\nKeep changes small.')
      expect(prompts.history(0, 2).revisions.find(version => version.revision === 1)?.changed).toEqual(['custom'])
      // The existing prompt length limit counts it.
      expect(() => prompts.save({ ...defaultPrompts(), custom: 'x'.repeat(200000) }, 1, 'panel')).toThrow('exceeds')
    } finally { store.close() }
  })
  it('adds an empty custom section to prompt versions saved before it existed', () => {
    const path = join(dir, 'db.sqlite')
    let store = new Store(path)
    try {
      const { custom: _custom, ...config } = defaultPrompts()
      store.set('prompt-revision', 1)
      store.set('prompt-version:1', { revision: 1, previousRevision: 0, savedAt: '', source: 'panel', config })
      store.set('schema', 12)
    } finally { store.close() }
    store = new Store(path)
    try {
      expect(store.get<{ config: { custom?: string } }>('prompt-version:1')!.config.custom).toBe('')
      const prompts = new Prompts(store, () => 100000, () => undefined, () => false)
      expect(prompts.current().config.custom).toBe('')
      expect(promptParts(prompts.current().config, 'worker').map(part => part.name)).not.toContain('custom')
    } finally { store.close() }
  })
})
