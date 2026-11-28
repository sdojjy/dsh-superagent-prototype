# Customizations in this fork

This fork of `deepseek-ai/dsh-superagent-prototype` implements six operator requirements. Upstream documents stay authoritative for
everything else; this file maps each requirement to the code and the check that covers it.

| # | Requirement | Where it lives | How it is verified |
| --- | --- | --- | --- |
| 1 | Several GitHub repositories, defaulting to `tidbcloud/serverless-service`, `tidbcloud/dataflow-service`, `tidbcloud/cluster-service-ng`, `tidbcloud/infra-provider` and `tidbcloud/tidb-management-service`, each removable | `GithubAccountsSchema.repositories` and `resolveDeployment` in `src/deployment.ts`; thread identity `github:<owner/name>#<number>` in `src/sources/github-trigger.ts`; notification filtering and per-repository polling in `src/sources/github.ts`; environment variables `DSH_SUPERAGENT_GITHUB_REPOSITORY` and `DSH_SUPERAGENT_GITHUB_REPOSITORIES` | `tests/deployment.spec.ts`, `tests/github*.spec.ts`, schema 11→12 migration tests |
| 2 | Review-only mode: read code, never push, never open a pull request, never modify files | `executor.mode = review` in `src/policy.ts`; `prompts/review.md` injected as `runtime/review`; `worker-hooks/{pre-commit,pre-push,pre-rebase}` plus `core.hooksPath` in `src/infra/environment.ts`; read-only `gh` shim; `worker-home` HOME isolation | `tests/review-mode.spec.ts` (hooks executed for real, `gh` allow/deny matrix, environment isolation) |
| 3 | Chinese panel and conversation, English on GitHub | `locale/`, `src/client/locales.ts`, `src/client/text.ts`; English-on-GitHub rule in `prompts/review.md` and the Communication team section | `tests/locales.spec.ts`, `tests/prompts.spec.ts` |
| 4 | One Feishu topic per Ticket, mention the requester when the review is ready, conclusions only in group chats; findings are posted on the pull request as English inline comments without asking first | `--reply-in-thread` only outside an existing topic, with a plain-reply fallback, in `src/sources/feishu-channel.ts`; `mention` on outbound messages in `src/core/replies.ts`; `chatType` and `threaded` in the Feishu channel address | `tests/feishu-channel.spec.ts`, `tests/feishu-mention.spec.ts` |
| 5 | An editable section for team instructions of my own | `custom` team section in `src/app/prompts.ts`, injected after the three built-in team sections | `tests/prompts.spec.ts`, schema 12→13 migration test |
| 6 | No leaking of local privacy: paths, user names, tokens, home directory contents | Review prompt rules in `prompts/review.md`; `agentVariables()` scrubbing and `worker-home` in `src/infra/environment.ts`; review-mode blocked commands | `tests/review-mode.spec.ts`, `tests/environment.spec.ts` |

## Known limits

Review mode is a set of default-path guardrails, not an operating-system sandbox. A worker runs as the operator's OS user, so
`git commit --no-verify`, `git -c core.hooksPath=…`, an absolute path to the real `gh` or `curl`, and reading `/Users/...` directly
remain possible. Strong isolation needs a dedicated OS account; `docs/003-execution.md` states this.

## Worktree pruning

`scripts/dsh-superagent prune` removes the worktrees, branches and `refs/dsh-superagent/*` refs of Tickets that ended with no Assignment running, so a review leaves no checkout behind; a later resume recreates it through the prepare command. `--dry-run` lists what it would remove. The hourly check runs it after a healthy status.

## Operating notes

- The GitHub Source field holds a list; separate entries with commas or spaces.
- Preparing a Ticket reuses the hardlink clone in `~/work/dsh-superagent/repos/<repository name>`, which the operator primes from
  an existing clone with `git clone --local --no-checkout`; a repository without such a clone is cloned with `--filter=blob:none`
  on first use. Ticket checkouts live in `~/work/dsh-superagent/work/`.
- `scripts/dsh-superagent restart` refuses with exit 4 while tickets are running, because a restart stops their workers; pass
  `--force` when that is intended.
- The scheduler is disabled in the deployment profile; the hourly health check runs in the operator's own DeepSeek Harness profile.

## Later changes

These came after the six requirements and are part of how this installation behaves.

| Change | Where it lives | How it is verified |
| --- | --- | --- |
| Reviews report correctness and compatibility only, decline style, naming and taste silently, ask for no defence the change does not need, and ask one question instead of guessing | `prompts/review.md`; the `review-pr` policy rule | `pnpm check` plus the assembled prompt |
| Review work carries distilled system knowledge of the four tiers, the five repositories, the creation DAGs and the backup path | `prompts/review-context.md`, injected as `runtime/review-context` right after `runtime/review` and only in review mode | `tests/review-mode.spec.ts`, `tests/prompts.spec.ts` |
| Pull requests the agent account authored are out of scope: the worker reads the author first and reports `dropped` without commenting or messaging | `prompts/review.md`, the `review-pr` rule | assembled prompt, real runs |
| No acknowledgements at all: the result is the only message a person receives | `acknowledgements` in `Plugin Config` (`src/deployment.ts`), enforced in `src/core/replies.ts`; the profile patch sets it to `false`; prompt overrides of `runtime/{admission,dispatch,replies,work}` and the Communication team section remove every instruction that asked for one | `tests/core-engine.spec.ts` (accept queuing nothing and `ackOff` from the worker), `tests/deployment.spec.ts` |
| A reply inside an existing Feishu topic no longer asks Feishu to start another one; a refusal falls back to a plain reply so the conclusion still lands | `src/sources/feishu-channel.ts` | `tests/feishu-channel.spec.ts` |
| Releasing a worker's subagents is skipped when the installed DSH exposes no such service, instead of failing the stop | `src/executor/background.ts` | `tests/executor*.spec.ts` |
| Host-side CLI checks name the operator's `XDG` bases, and the account shims unset the isolated ones, so `gh` finds its credentials under review-mode isolation | `src/infra/environment.ts` | `tests/review-mode.spec.ts` |

How follow-up reviews happen, for the record: a Ticket subscribes its pull request thread, and each poll round reads the
notifications, the observed streams, the pull requests of open Tickets with their CI, and the new comments on subscribed
threads. A new human comment or a change in the CI snapshot reaches the same Ticket as another input, so the author's fix is
reviewed again without a new link or an @. A new commit alone does not trigger a round; only human activity and CI changes do.
