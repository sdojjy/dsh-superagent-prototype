/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  stateDir: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }
}

/** The GitHub repositories the Source watches when its settings name none; the first is also the default repository. */
export const DEFAULT_GITHUB_REPOSITORIES: readonly string[] = ['tidbcloud/serverless-service', 'tidbcloud/dataflow-service',
  'tidbcloud/cluster-service-ng', 'tidbcloud/infra-provider']
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const LEGACY_REPOSITORY_NAME = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/
/** Splits a repository list written as text, by commas, semicolons, or whitespace. */
const splitRepositories = (value: string): string[] => value.split(/[\s,;]+/).filter(Boolean)
/**
 * Normalizes configured repositories for code that reads stored settings directly (such as the migration and search):
 * the legacy single `repository` first, then `repositories`, deduplicated case-insensitively, and the built-in list when empty.
 * Entries are kept as written; validation happens in `GithubAccountsSchema`.
 */
export function configuredRepositories(value: { repositories?: unknown; repository?: unknown } | undefined): string[] {
  const raw = value?.repositories
  const listed = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [])
    .flatMap(item => typeof item === 'string' ? splitRepositories(item) : [])
  const legacy = typeof value?.repository === 'string' ? value.repository.trim() : ''
  const names = [...legacy ? [legacy] : [], ...listed].filter(Boolean)
  const unique = [...new Map(names.map(name => [name.toLowerCase(), name])).values()]
  return unique.length ? unique : [...DEFAULT_GITHUB_REPOSITORIES]
}
/**
 * GitHub Source account settings: `repositories`, the legacy single `repository` (kept readable so settings saved before
 * multiple repositories still resolve), and `cli`. Both forms normalize to `repositories`, the legacy name first, defaulting
 * to `DEFAULT_GITHUB_REPOSITORIES`; the legacy key is dropped so a later save stores only the list.
 */
export const GithubAccountsFields = z.object({
  repositories: z.union([z.string(), z.array(z.string())]).optional(),
  repository: z.string().trim().regex(LEGACY_REPOSITORY_NAME, 'owner/name').optional(),
  cli: z.string().trim().default(''),
})
/**
 * Normalizes the GitHub Source's account fields: `repositories` is the legacy single repository first, then the list,
 * deduplicated, defaulting to `DEFAULT_GITHUB_REPOSITORIES`; every name must be `owner/name`, and the legacy key is dropped.
 * @param ctx - the schema refinement context that receives an issue for an invalid repository name.
 */
export function normalizeGithubAccounts<T extends { repositories?: unknown; repository?: string }>(value: T, ctx: z.RefinementCtx):
Omit<T, 'repositories' | 'repository'> & { repositories: string[] } {
  const repositories = configuredRepositories(value)
  const invalid = repositories.filter(name => !REPOSITORY_NAME.test(name))
  if (invalid.length) {
    ctx.addIssue({ code: 'custom', message: `repositories must be owner/name: ${invalid.join(', ')}` })
    return z.NEVER
  }
  const { repository: _legacy, repositories: _repositories, ...rest } = value
  return { ...rest, repositories }
}
/** Validated GitHub Source settings, with `repositories` normalized to a non-empty list of `owner/name` names. */
export const GithubAccountsSchema = GithubAccountsFields.transform(normalizeGithubAccounts)
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = { github: Object.keys(GithubAccountsFields.shape), feishu: Object.keys(FeishuBotSchema.shape) }

export interface Deployment extends Machine {
  /** The first configured repository, the one a Trigger without one of its own belongs to. */
  repository: string
  /** Every configured repository as GitHub returns its canonical `full_name`, in configuration order. */
  repositories: string[]
  github: { cli: string; login: string; noreply: string }
  feishu?: FeishuBot
}
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** Verify the agent's GitHub CLI identity and push access to every configured repository, naming the one that fails. */
export async function resolveDeployment(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const configured = accounts.repositories
  if (!configured.length) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const repositories: string[] = []
  for (const remote of configured) {
    const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
      throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
    }))
    if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
    if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository: access.name })
    // Two configured names can be one renamed repository; keep the first canonical name.
    if (!repositories.some(name => name.toLowerCase() === access.name.toLowerCase())) repositories.push(access.name)
  }
  if (!repositories.length) throw new SetupError('repositoryUnset')
  return { ...machine, repository: repositories[0]!, repositories,
    github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1', cli, ...args]).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}
