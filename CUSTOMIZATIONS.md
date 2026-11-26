# Customizations in this fork

This fork of `deepseek-ai/dsh-superagent-prototype` implements six operator requirements. Upstream documents stay authoritative for
everything else; this file maps each requirement to the code and the check that covers it.

| # | Requirement | Where it lives | How it is verified |
| --- | --- | --- | --- |
| 1 | Several GitHub repositories, defaulting to `tidbcloud/serverless-service`, `tidbcloud/dataflow-service`, `tidbcloud/cluster-service-ng`, `tidbcloud/infra-provider`, each removable | `GithubAccountsSchema.repositories` and `resolveDeployment` in `src/deployment.ts`; thread identity `github:<owner/name>#<number>` in `src/sources/github-trigger.ts`; notification filtering and per-repository polling in `src/sources/github.ts`; environment variables `DSH_SUPERAGENT_GITHUB_REPOSITORY` and `DSH_SUPERAGENT_GITHUB_REPOSITORIES` | `tests/deployment.spec.ts`, `tests/github*.spec.ts`, schema 11→12 migration tests |
| 2 | Review-only mode: read code, never push, never open a pull request, never modify files | `executor.mode = review` in `src/policy.ts`; `prompts/review.md` injected as `runtime/review`; `worker-hooks/{pre-commit,pre-push,pre-rebase}` plus `core.hooksPath` in `src/infra/environment.ts`; read-only `gh` shim; `worker-home` HOME isolation | `tests/review-mode.spec.ts` (hooks executed for real, `gh` allow/deny matrix, environment isolation) |
| 3 | Chinese panel and conversation, English on GitHub | `locale/`, `src/client/locales.ts`, `src/client/text.ts`; English-on-GitHub rule in `prompts/review.md` and the Communication team section | `tests/locales.spec.ts`, `tests/prompts.spec.ts` |
| 4 | One Feishu topic per Ticket, mention the requester when the review is ready, conclusions only in group chats; findings are posted on the pull request as English inline comments without asking first | `--reply-in-thread` in `src/sources/feishu-channel.ts`; `mention` on outbound messages in `src/core/replies.ts`; `chatType` in the Feishu channel address | `tests/feishu-channel.spec.ts`, `tests/feishu-mention.spec.ts` |
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
- Preparing a Ticket for `tidbcloud/dataflow-service` reuses the operator's existing clone; other repositories are cloned with
  `--filter=blob:none` into `~/src/<repository name>` the first time a Ticket needs them.
- The scheduler is disabled in the deployment profile; the hourly health check runs in the operator's own DeepSeek Harness profile.
