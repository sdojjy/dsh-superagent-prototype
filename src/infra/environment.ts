/**
 * Process environment and CLI shims that bind git, gh, and lark-cli to the deployment's accounts and block disallowed commands.
 * Variables read by workers avoid `KEY|PASSWORD|SECRET|TOKEN` in their names because DSH strips credential-shaped variables from child environments.
 * Provides default-path guardrails rather than an OS-level security boundary, as workers run under the operator's OS user.
 */
import { access, chmod, lstat, mkdir, readdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { constants, realpathSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Deployment } from '../deployment.ts'
import type { ExecutionMode } from '../policy.ts'
import { SetupError } from '../setup.ts'
import { CliError } from './commands.ts'

const MARKER = '# Written by dsh-superagent on every start; edits are lost.'
/**
 * The operator's HOME and XDG bases as the process had them before dsh-superagent changed the environment, so host CLI calls
 * and the account wrappers keep reading the configuration the operator set up, while review-mode worker shells do not.
 */
const OPERATOR_ENVIRONMENT: Readonly<Record<string, string | undefined>> = Object.freeze({
  HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
})
/**
 * The operator's HOME and XDG bases, for host commands and for the CLI a shim runs. A base the operator did not set is
 * `undefined`, which removes it from a child environment instead of leaving review mode's isolated value in place.
 */
export const operatorEnvironment = (): Record<string, string | undefined> => ({ ...OPERATOR_ENVIRONMENT })
/** The operator's environment as assignments, for a shell command that exports or prefixes them. */
const operatorAssignments = (): [string, string][] => Object.entries(OPERATOR_ENVIRONMENT).filter((entry): entry is [string, string] => entry[1] !== undefined)
/** Markers of files written under the project's earlier names (`dsh-tag`, `dsh-go`, `dsh-freelancer`), which `dsh-superagent` owns and replaces too. */
const LEGACY_MARKERS = ['dsh-tag', 'dsh-go', 'dsh-freelancer'].map(name => `# Written by ${name} on every start; edits are lost.`)
/** Commands workers need, which `blockedCommands` cannot block: the shims and git. */
export const WORKER_COMMANDS: readonly string[] = ['gh', 'git', 'lark-cli']
export const workerBin = (stateDir: string): string => join(stateDir, 'worker-bin')
export const workerGitConfig = (stateDir: string): string => join(stateDir, 'worker-gitconfig')
/** Review mode: the git hooks workers read through `core.hooksPath`, which refuse commits, pushes and rebases. */
export const workerHooks = (stateDir: string): string => join(stateDir, 'worker-hooks')
/** Review mode: the isolated `HOME` of worker processes, so they read neither the operator's dotfiles nor their caches. */
export const workerHome = (stateDir: string): string => join(stateDir, 'worker-home')
/**
 * Commands review mode always blocks, on top of the configured `blockedCommands`, because they open outbound or local
 * channels a read-only reviewer never needs: SSH/SCP/rsync ship or fetch files, `security` reads the operator's keychain,
 * `osascript` drives other applications, `curl` and `wget` move data off the machine, and `open` hands a file to a local app.
 * Reading GitHub instead goes through `gh api` (GET), which the wrapper keeps.
 */
export const REVIEW_BLOCKED_COMMANDS: readonly string[] = ['ssh', 'scp', 'rsync', 'security', 'osascript', 'curl', 'wget', 'open']
/** The commands the worker shims actually block: the configured ones, plus review mode's fixed list. */
export const effectiveBlockedCommands = (blocked: readonly string[], mode: ExecutionMode = 'develop'): readonly string[] =>
  mode === 'review' ? [...new Set([...blocked, ...REVIEW_BLOCKED_COMMANDS])] : blocked
/**
 * Sensitive variables review mode clears besides the default ones. They point at operator credentials, local agents or a
 * display, which a reviewer reading one ticket directory never needs; clearing them keeps a read-only worker from acting with
 * the operator's cloud, cluster or desktop identity even if prompt text is overridden.
 */
export const REVIEW_PRIVATE_VARIABLES: readonly string[] = [
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GIT_SSH', 'GIT_SSH_COMMAND',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN', 'AWS_PROFILE', 'AWS_DEFAULT_PROFILE',
  'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'KUBECONFIG', 'DISPLAY', 'GPG_AGENT_INFO', 'DOCKER_HOST', 'DOCKER_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_CONFIG',
  'AZURE_CONFIG_DIR', 'VAULT_ADDR',
]
/** The git hooks review mode installs, each refusing its operation with one sentence. */
export const REVIEW_HOOKS: readonly ('pre-commit' | 'pre-push' | 'pre-rebase')[] = ['pre-commit', 'pre-push', 'pre-rebase']
const hookBody = (name: string): string => [
  `echo 'dsh-superagent runs in review mode: it reads code and reports findings, so ${name} refuses to let git write. Report the review instead.' >&2`,
  'exit 1',
].join('\n')
/** The sentence every refused `gh` command prints in review mode, which names the one write review may still do. */
const GH_REFUSAL = 'refused in review mode: this installation only reads GitHub. Read with gh api <path> (GET), and post an English '
  + 'review comment with gh api --method POST repos/<owner>/<repo>/pulls/<number>/reviews.'
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const gitQuote = (value: string): string => `"${value.replace(/[\\"]/g, char => `\\${char}`)}"`
export const credentialHelper = (cli: string): string => `!${shellQuote(cli)} auth git-credential`
/**
 * Shell lines that remove the shim directory from `PATH`, so a shim or wrapper that resolves its target by name reaches the
 * real binary instead of calling itself again.
 */
const stripShimDirectory = (dir: string): string => [
  `self=${shellQuote(dir)}`, 'rest=', 'IFS=:', 'set -f',
  'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done',
  'set +f', 'unset IFS', 'PATH=$rest', 'export PATH',
].join('\n')

export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
  return real(a) === real(b)
}
export function withoutDirectory(path: string, dir: string): string {
  return path.split(delimiter).filter(entry => !sameDirectory(entry, dir)).join(delimiter)
}

/**
 * The variables that tell git which repository, work tree and index to act on. A host started inside git, such as by
 * `git rebase --exec`, passes them on, and a git started below it would act on that repository. GIT_CEILING_DIRECTORIES is
 * kept: it names no repository, and it stops git's search for one where the operator chose.
 */
export const GIT_LOCATION: readonly string[] = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']

/**
 * Returns environment variable overrides that strip ambient GitHub tokens, interactive prompts, the repository the host's own
 * environment may name, and operator git identity/config overrides. Review mode additionally isolates `HOME` (so workers read
 * no operator dotfiles) and clears `REVIEW_PRIVATE_VARIABLES`.
 */
export function agentVariables(stateDir: string, mode: ExecutionMode = 'develop'): Record<string, string | undefined> {
  const review = mode === 'review' ? {
    // A worker that reads code needs no home of the operator's: point HOME and the XDG bases at an empty, private directory.
    HOME: workerHome(stateDir), XDG_CONFIG_HOME: join(workerHome(stateDir), '.config'), XDG_CACHE_HOME: join(workerHome(stateDir), '.cache'),
    ...Object.fromEntries(REVIEW_PRIVATE_VARIABLES.map(name => [name, undefined])),
  } : {}
  return {
    GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
    // A worker's git finds the repository from its directory, never from the host's environment.
    ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])),
    GIT_CONFIG_GLOBAL: workerGitConfig(stateDir), GIT_CONFIG_NOSYSTEM: '1',
    // Clear environment git config overrides; configuration passed through the environment would otherwise reach every git command the agent runs.
    GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined,
    // When the credential helper has no answer, git must fail rather than prompt; `GIT_ASKPASS: ''` also overrides `core.askPass` and `SSH_ASKPASS`.
    GIT_ASKPASS: '', SSH_ASKPASS: undefined, GIT_TERMINAL_PROMPT: '0',
    // Clear operator commit identity variables; prompts specify commit identity and operator env vars would override what a worker sets.
    GIT_AUTHOR_NAME: undefined, GIT_COMMITTER_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_EMAIL: undefined,
    ...review,
  }
}

/** True when a regular file starts with the dsh-superagent marker in its first two lines; a symbolic link, directory, or other non-regular file never counts as written by dsh-superagent. */
async function written(file: string): Promise<boolean> {
  if (!(await lstat(file)).isFile()) return false
  const head = (await readFile(file, 'utf8')).split('\n', 2)
  return [MARKER, ...LEGACY_MARKERS].some(marker => head.includes(marker))
}
async function own(file: string, text: string, mode = 0o644): Promise<void> {
  let foreign = false
  try { foreign = !await written(file) } catch { /* The file does not exist yet. */ }
  if (foreign) throw new SetupError('foreignFile', { file })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, file)
}

/**
 * Writes the review-mode git hooks, or removes the ones dsh-superagent wrote when the mode is not review. The hooks live in
 * `<stateDir>/worker-hooks`, which the worker git configuration names as `core.hooksPath`; refusing here stops `git commit`,
 * `git push` and `git rebase` before they run, whatever the prompt says.
 */
async function writeHooks(stateDir: string, mode: ExecutionMode): Promise<void> {
  const dir = workerHooks(stateDir)
  if (mode !== 'review') {
    let entries: string[]
    try { entries = await readdir(dir) } catch { return }
    for (const name of entries) {
      const file = join(dir, name)
      if (await written(file).catch(() => false)) await unlink(file)
    }
    // A directory that still holds files dsh-superagent did not write stays; nothing reads it once `core.hooksPath` is gone.
    await rmdir(dir).catch(() => {})
    return
  }
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const kept = new Set<string>(REVIEW_HOOKS)
  for (const name of await readdir(dir)) {
    if (kept.has(name)) continue
    const file = join(dir, name)
    if (!await written(file).catch(() => false)) throw new SetupError('foreignFile', { file })
    await unlink(file)
  }
  for (const name of REVIEW_HOOKS) await own(join(dir, name), `#!/bin/sh\n${MARKER}\n${hookBody(name)}\n`, 0o755)
  await chmod(dir, 0o700)
}
/**
 * The `gh` shim body in review mode. It resolves the agent's CLI only after checking the command: reads through a fixed
 * subcommand allowlist and `gh api` GET, and review comments through one `gh api` POST path. Everything else fails with a
 * sentence naming what review may do, so a worker cannot open, merge or close anything on GitHub.
 */
const reviewGhBody = (preamble: string, cli: string): string => [
  preamble,
  // As with every review-mode shim, the CLI keeps reading the operator's configuration while the worker shell does not.
  ...operatorAssignments().map(([name, value]) => `export ${name}=${shellQuote(value)}`),
  'deny() {',
  `  echo "gh $*: ${GH_REFUSAL}" >&2`,
  '  exit 1',
  '}',
  'check_api() {',
  '  method=GET',
  '  chosen=',
  '  fields=',
  '  path=',
  '  while [ $# -gt 0 ]; do',
  '    case "$1" in',
  '      -X|--method) [ $# -ge 2 ] || deny; method=$2; chosen=1; shift 2 ;;',
  '      -X*) method=${1#-X}; chosen=1; shift ;;',
  '      --method=*) method=${1#--method=}; chosen=1; shift ;;',
  '      -f|-F|--field|--raw-field|--input) fields=1; shift; [ $# -gt 0 ] && shift ;;',
  '      --field=*|--raw-field=*|--input=*) fields=1; shift ;;',
  '      --hostname|--hostname=*) deny ;;',
  '      --) shift; [ $# -gt 0 ] && [ -z "$path" ] && path=$1; shift ;;',
  '      -*) shift ;;',
  '      *) [ -z "$path" ] && path=$1; shift ;;',
  '    esac',
  '  done',
  '  [ -n "$path" ] || deny',
  '  path=${path#/}',
  '  case "$path" in graphql|http://*|https://*) deny ;; esac',
  '  case "$method" in [Gg][Ee][Tt]) method=GET ;; [Pp][Oo][Ss][Tt]) method=POST ;; *) deny ;; esac',
  '  if [ "$method" = GET ]; then [ -z "$fields" ] || deny; return 0; fi',
  '  [ -n "$chosen" ] || deny',
  '  case "$path" in',
  '    repos/*/pulls/*/reviews|repos/*/pulls/comments) return 0 ;;',
  '    *) deny ;;',
  '  esac',
  '}',
  'command=${1:-}',
  '[ $# -gt 0 ] && shift',
  'case "$command" in',
  `  --version|--help) exec ${shellQuote(cli)} "$command" "$@" ;;`,
  `  api) check_api "$@"; exec ${shellQuote(cli)} api "$@" ;;`,
  `  pr) case "\${1:-list}" in view|list|diff|checks|status) exec ${shellQuote(cli)} pr "$@" ;; *) deny ;; esac ;;`,
  `  issue) case "\${1:-list}" in view|list|status) exec ${shellQuote(cli)} issue "$@" ;; *) deny ;; esac ;;`,
  `  repo) case "\${1:-view}" in view|list) exec ${shellQuote(cli)} repo "$@" ;; *) deny ;; esac ;;`,
  `  search) exec ${shellQuote(cli)} search "$@" ;;`,
  `  auth) [ "\${1:-}" = status ] && [ $# -eq 1 ] && exec ${shellQuote(cli)} auth status; deny ;;`,
  '  *) deny ;;',
  'esac',
].join('\n')

/**
 * Atomically writes worker CLI shims, the isolated git configuration, the review-mode git hooks and HOME directory into the
 * state directory, refusing to overwrite foreign files.
 * Each shim strips the shim directory from PATH before exec so wrapper scripts resolving `gh` or `lark-cli` by name reach the real binary.
 */
export async function writeEnvironment(deployment: Pick<Deployment, 'stateDir' | 'repository' | 'github' | 'feishu'>, blockedCommands: readonly string[],
  mode: ExecutionMode = 'develop'): Promise<void> {
  const { stateDir, repository, github, feishu } = deployment
  const dir = workerBin(stateDir)
  await mkdir(dir, { recursive: true })
  const before = await readdir(dir)
  for (const name of before) { const file = join(dir, name); if (!await written(file)) throw new SetupError('foreignFile', { file }) }
  // Workers may be running concurrently: write each shim to a temp file and atomically rename it so no command ever resolves past the shim directory.
  const kept = new Set<string>()
  const shim = async (name: string, body: string): Promise<void> => {
    const temporary = join(dir, `.${name}.${process.pid}.tmp`)
    await writeFile(temporary, `#!/bin/sh\n${MARKER}\n${body}\n`, { mode: 0o755 })
    await rename(temporary, join(dir, name))
    kept.add(name)
  }
  const withoutShims = stripShimDirectory(dir)
  // Review mode isolates the worker shell's HOME; the account CLIs still read the operator's configuration, as before, so a
  // wrapper that resolves its configuration through HOME keeps working.
  const cliEnvironment = mode === 'review'
    ? operatorAssignments().map(([name, value]) => `${name}=${shellQuote(value)}`).join('\n') : ''
  const run = (program: string): string => [withoutShims, cliEnvironment, `exec ${shellQuote(program)} "$@"`].filter(Boolean).join('\n')
  const fail = (message: string): string => `echo ${shellQuote(message)} >&2\nexit 1`
  await shim('gh', mode === 'review' ? reviewGhBody(withoutShims, github.cli) : run(github.cli))
  await shim('lark-cli', feishu ? run(feishu.cli) : fail('lark-cli is unavailable: this installation has no Feishu bot.'))
  for (const name of new Set(effectiveBlockedCommands(blockedCommands, mode).filter(name => !WORKER_COMMANDS.includes(name)))) {
    await shim(name, fail(`${name} is blocked in this installation; use gh, which acts as ${github.login}.`))
  }
  for (const name of before) if (!kept.has(name)) await unlink(join(dir, name))
  await writeHooks(stateDir, mode)
  if (mode === 'review') {
    // Workers read no operator dotfiles: an empty HOME of their own, which only they may read or enter.
    await mkdir(workerHome(stateDir), { recursive: true, mode: 0o700 })
    await chmod(workerHome(stateDir), 0o700)
  }
  await own(workerGitConfig(stateDir), [
    MARKER,
    // Make git refuse to commit without an explicit identity set by the worker instead of guessing from the operator's OS user.
    '[user]', '\tuseConfigOnly = true',
    // Review mode refuses commits, pushes and rebases through the hooks, whatever a Session runs.
    ...mode === 'review' ? ['[core]', `\thooksPath = ${gitQuote(workerHooks(stateDir))}`] : [],
    '[credential]', '\thelper =',
    '[credential "https://github.com"]', `\thelper = ${gitQuote(credentialHelper(github.cli))}`,
    '[url "https://github.com/"]', '\tinsteadOf = git@github.com:', '\tinsteadOf = ssh://git@github.com/',
    // Include Git LFS filters because the operator's global gitconfig (which usually holds them) is ignored.
    '[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true',
  ].join('\n') + '\n')
}

/** Applies environment overrides and prepends worker shims to `process.env.PATH`, returning a restore callback. */
export function applyEnvironment(variables: Record<string, string | undefined>, stateDir: string, path: string): () => void {
  const values = { ...variables, PATH: [workerBin(stateDir), path].join(delimiter) }
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]))
  const apply = (env: Record<string, string | undefined>): void => { for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } }
  apply(values)
  return () => { apply(previous) }
}

/** Spawns a command through the DSH subprocess runtime, which strips credential-shaped environment variables. */
export async function runAsWorker(subprocess: SubprocessRuntime, argv: string[], cwd: string, signal: AbortSignal, env?: Record<string, string>): Promise<string> {
  const handle = subprocess.spawn({ argv, cwd, graceMs: 2000, signal, ...env ? { env } : {}, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } } })
  const { exitCode } = await handle.done
  const read = (reader: SubprocessOutputReader | undefined): string => reader?.readFrom(0).text ?? ''
  if (exitCode === 0) return read(handle.collected.stdout)
  const ended = exitCode === null ? 'was stopped before it finished' : `exited with ${exitCode}`
  throw new CliError(read(handle.collected.stderr).trim() || `${argv.join(' ')} ${ended}`, undefined, exitCode ?? undefined)
}

/** Verifies that worker git invocations resolve the deployment's GitHub credential helper. */
export async function verifyEnvironment(deployment: Pick<Deployment, 'github' | 'stateDir'>, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const { github, stateDir } = deployment
  // `-z` separates fields with NUL and never quotes paths.
  const helpers = (await runAsWorker(subprocess, ['git', 'config', '-z', '--show-origin', '--get-all', 'credential.https://github.com.helper'], stateDir, AbortSignal.any([signal, AbortSignal.timeout(60_000)])).catch(() => '')).split('\0')
  if (helpers.join('\0') !== [`file:${workerGitConfig(stateDir)}`, credentialHelper(github.cli), ''].join('\0')) throw new SetupError('gitTooOld')
}

/**
 * Verifies that review mode's hard guards are the ones workers actually read: `core.hooksPath` resolves to the hooks
 * dsh-superagent writes, every hook is an executable file, and the `gh` shim is the review wrapper. A failure stops setup,
 * because review mode without these guards would rely on prompt text alone.
 */
export async function verifyReviewEnvironment(deployment: Pick<Deployment, 'stateDir'>, mode: ExecutionMode, subprocess: SubprocessRuntime,
  signal: AbortSignal): Promise<void> {
  if (mode !== 'review') return
  const { stateDir } = deployment
  const expected = workerHooks(stateDir)
  const hooksPath = (await runAsWorker(subprocess, ['git', 'config', '--get', 'core.hooksPath'], stateDir,
    AbortSignal.any([signal, AbortSignal.timeout(60_000)])).catch(() => '')).trim()
  // A path git reports may be relative to its working directory, so compare resolved paths.
  if (!sameDirectory(hooksPath, expected)) throw new SetupError('reviewGuardMissing', { expected, found: hooksPath || 'no core.hooksPath' })
  for (const name of REVIEW_HOOKS) {
    const file = join(expected, name)
    await access(file, constants.X_OK).catch(() => { throw new SetupError('reviewGuardMissing', { expected: file, found: 'missing or not executable' }) })
  }
  const shim = await readFile(join(workerBin(stateDir), 'gh'), 'utf8').catch(() => '')
  if (!shim.includes('refused in review mode')) throw new SetupError('reviewGuardMissing', { expected: 'the review wrapper of gh', found: 'another gh shim' })
}

/**
 * Verifies that a ticket directory's local or worktree git config defines no custom `credential.*` or `http.*extraheader`
 * keys, which the agent's git would read from the repository's own config and act on.
 */
export async function verifyDirectory(directory: string, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const keys = ['git', 'config', '-z', '--show-scope', '--get-regexp', '^(credential\\..*|http\\..*extraheader)$']
  // `git config --get-regexp` exits with code 1 when no keys match.
  const output = await runAsWorker(subprocess, keys, directory, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
    .catch((error: unknown) => { if (error instanceof CliError && error.exitCode === 1) return ''; throw error })
  const scoped = output.split('\0')
  const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === 'local' || scope === 'worktree') ? [scoped[index + 1]!.split('\n')[0]!] : [])
  if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(', ')}, which the agent's git would also read; remove them.`)
}
