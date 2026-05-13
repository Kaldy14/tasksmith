# Configuration

TaskSmith can run multiple deployments by giving each server its own config file, auth material, and data directory. The config is generic: choose GitHub Issues or Jira as a source per repository, define repository metadata, and choose delivery behavior per deployment or repo.

## Config file

Set:

```bash
TASKSMITH_CONFIG_PATH=/opt/tasksmith/config/repos.json
```

`TASKSMITH_REPO_CONFIG_PATH` remains supported as a backwards-compatible alias, but `TASKSMITH_CONFIG_PATH` is preferred.

Minimal shape:

```json
{
  "sourceFlow": {
    "readinessLabel": "tasksmith",
    "pollIntervalSeconds": 60,
    "jiraRepoRouting": { "strategy": "label", "labels": { "vosime-admin": "vosime-admin" } }
  },
  "workflow": {
    "type": "single_task_sandcastle",
    "stages": ["plan", "implement", "deep_review", "fix", "deliver"],
    "maxFixAttempts": 1,
    "maxCiFixAttempts": 1,
    "maxReviewFixAttempts": 1,
    "ciPollIntervalMs": 30000,
    "ciTimeoutMs": 900000,
    "deliveryMode": "ready_pr"
  },
  "defaultVerify": [
    { "name": "typecheck", "command": "pnpm typecheck", "timeoutMs": 180000 }
  ],
  "repos": {
    "repo-key": {
      "displayName": "Repo Name",
      "gitUrl": "git@github.com:OWNER/REPO.git",
      "defaultBranch": "main",
      "gitProvider": { "type": "github", "owner": "OWNER", "repo": "REPO" },
      "issueProvider": { "type": "github_issues", "labels": ["tasksmith"], "state": "open" },
      "runtimeAdapter": "pi",
      "initCommands": [
        { "name": "install", "command": "pnpm install --frozen-lockfile", "timeoutMs": 300000 }
      ],
      "verify": [
        { "name": "test", "command": "pnpm test", "timeoutMs": 300000 }
      ]
    }
  }
}
```

Configured repositories appear in the manual intake UI. When a Run uses a configured repository with `gitUrl`, TaskSmith clones it into the per-run workspace before starting Pi or the demo runtime. It is currently a fresh per-run checkout, not a shared `git worktree` from a local cache; that keeps isolation simple while preserving the same workspace semantics. Source-created Runs default to `runtimeAdapter: "pi"`; tests and local demos may set `runtimeAdapter: "demo"` on a repository.

## Project config UI

TaskSmith exposes a project config page at:

```txt
/config
```

The page edits the JSON file pointed at by `TASKSMITH_CONFIG_PATH`. Use it to configure repos, source pickup, verification, delivery mode, and per-project initialization commands. The API endpoints are:

```txt
GET /api/admin/config
PUT /api/admin/config
```

When `TASKSMITH_AUTH_ENABLED=1`, this admin surface requires a Better Auth session. Without auth, keep it internal/tailnet-only and do not expose it publicly.

## Queue leases and crash recovery

When a scheduler worker claims a queued Run it stores `workerId`, `leaseExpiresAt`, `lastHeartbeatAt`, and `leaseAttempt`, then heartbeats while the runtime/workflow is active. Configure timings with environment variables:

```bash
TASKSMITH_QUEUE_LEASE_TIMEOUT_MS=120000
TASKSMITH_QUEUE_HEARTBEAT_INTERVAL_MS=30000
```

A Run with an unexpired lease is not claimed by another worker. On boot and each scheduler tick, expired leases are recovered deterministically: `claimed` and `preparing` Runs are requeued because no non-resumable runtime phase should have started; `running`, `fixing`, `verifying`, `reviewing`, `delivering`, `creating_pr`, and `watching_ci` are failed because TaskSmith does not yet support safe Pi/session resume for those phases. Recovery writes a Run status event with the stale-lease outcome for operators.

By default, queued Runs have no global or per-repository concurrency cap. Set optional limits in the JSON config or with environment variables:

```json
{
  "queue": {
    "maxActiveRuns": 2,
    "maxActiveRunsPerRepo": 1
  }
}
```

```bash
TASKSMITH_QUEUE_MAX_ACTIVE_RUNS=2
TASKSMITH_QUEUE_MAX_ACTIVE_RUNS_PER_REPO=1
```

The scheduler counts non-terminal, non-queued Runs that still hold a lease. If capacity is full, eligible Runs stay `queued` and their Run error text notes the capacity limit until they can be claimed.

## Workspace initialization commands

Each repository can define commands that run after the checkout is prepared and before Pi/demo implementation starts:

```json
{
  "repos": {
    "repo-key": {
      "initCommands": [
        { "name": "copy-env", "command": "cp .env.example .env", "timeoutMs": 30000 },
        { "name": "install", "command": "pnpm install --frozen-lockfile", "timeoutMs": 300000 }
      ]
    }
  }
}
```

Init commands run outside the agent in the per-run workspace with `HOME` set to the per-run home directory. They are deterministic setup, not prompt-controlled implementation. TaskSmith adds `.env`, `.env.*`, `node_modules/`, and `.pnpm-store/` to `.git/info/exclude` for cloned workspaces before init commands run, reducing accidental PR leakage of local setup files. Keep init commands idempotent and avoid changing tracked files unless those changes are intended for the final PR.

## GitHub Issues source example

Use GitHub Issues as the intake source. The readiness label is `tasksmith`, not `ai-ready`. Start from:

```txt
config/examples/personal.github.json
```

Current intended repos:

- `tasksmith` -> `Kaldy14/tasksmith`
- `robodoggo` -> `Kaldy14/robodoggo`
- `clui` -> `Kaldy14/clui`

Because GitHub Issues are already scoped to a repository, no extra repo-routing label is needed. The source poller queries each configured repo for open issues with label `tasksmith`, creates exactly one claim/run per issue, and comments back with the TaskSmith Run link.

Source pickup idempotency depends on the source-claim store. Postgres deployments use the `tasksmith_source_claims` primary key. File-backed deployments also take a short filesystem lock around `source-claims.json` updates so repeated polls, restarts, or overlapping app processes cannot each believe they created the same claim and post duplicate pickup comments.

Manual source poll endpoint:

```bash
curl -X POST http://127.0.0.1:3000/api/sources/poll
curl http://127.0.0.1:3000/api/source-claims
```

Optional GitHub Issues webhooks can reduce pickup latency. Enable the GitHub webhook flag with `TASKSMITH_GITHUB_WEBHOOK_ENABLED` and provide the GitHub webhook signing key with `TASKSMITH_GITHUB_WEBHOOK_SECRET` through the environment, then configure the repository webhook to send Issues events to `/api/webhooks/github/issues` using the same signing key. TaskSmith verifies GitHub's SHA-256 signature before reading the event. Missing or invalid signatures are rejected. Handled issue actions are label additions plus opened, reopened, and edited issues that already carry the readiness label; each accepted event uses the same source-claim path as polling, so duplicate deliveries and webhook/poller races still create one run and one pickup comment per issue.

Expose the endpoint only through your chosen private path, such as Tailscale or a reverse proxy with TLS. Public internet exposure decisions are deployment-specific and outside TaskSmith's source intake logic.

Automatic polling is opt-in for now:

```txt
Environment=TASKSMITH_SOURCE_POLLING=1
Environment=TASKSMITH_PUBLIC_URL=https://tasksmith.tail1a218f.ts.net
```

`TASKSMITH_PUBLIC_URL` is used in source issue comments. If it is omitted, TaskSmith builds a local URL from `HOST`/`PORT`.

Server setup outline:

```bash
sudo mkdir -p /opt/tasksmith/config
sudo cp config/examples/personal.github.json /opt/tasksmith/config/repos.json
sudo chown -R deploy:deploy /opt/tasksmith/config
```

Then add to the systemd unit:

```txt
Environment=TASKSMITH_CONFIG_PATH=/opt/tasksmith/config/repos.json
```

## Postgres app database

TaskSmith uses Postgres for app state and normalized UI events while keeping Pi session/chat files and large/raw artifacts on disk. Enable it with:

```txt
TASKSMITH_DATABASE_URL=postgres://tasksmith:<password>@127.0.0.1:5432/tasksmith
```

When this is set, startup applies Drizzle/Postgres migrations and imports existing legacy file-backed state. New app-state writes go to Postgres for:

- `tasksmith_runs`
- `tasksmith_attempts`
- `tasksmith_source_claims`
- `tasksmith_run_events`
- `tasksmith_control_messages`
- `tasksmith_pull_requests`
- `tasksmith_reviews`
- `tasksmith_review_findings`
- `tasksmith_artifacts`
- `tasksmith_event_checkpoints`

The database stores normalized/redacted TaskSmith UI events and pointers such as `raw_events_path`, `run_dir`, `workspace_dir`, and `session_dir`. It does not store raw Pi chat/session transcript structures; those stay in the per-run filesystem artifacts.

Useful commands:

```bash
pnpm db:migrate        # apply app database migrations only
pnpm db:sync-metadata  # import/resync legacy file-backed state into Postgres
```

## UI/API authentication

TaskSmith can protect the browser UI, `/api/**` routes, WebSocket run streams, `/config`, source polling, and run controls with Better Auth email/password sessions backed by the same Postgres database:

```txt
TASKSMITH_AUTH_ENABLED=1
TASKSMITH_AUTH_SECRET=<32+ random bytes>
BETTER_AUTH_URL=https://tasksmith.example.com
```

`BETTER_AUTH_URL` is the canonical public origin for auth cookies and callbacks. `TASKSMITH_AUTH_URL` is accepted as an optional alias/fallback when `BETTER_AUTH_URL` is not set. `TASKSMITH_AUTH_TRUSTED_ORIGINS` is optional and adds comma- or whitespace-separated Better Auth trusted origins/patterns for reverse proxies or multi-host deployments:

```txt
TASKSMITH_AUTH_TRUSTED_ORIGINS=https://tasksmith.example.com,https://tasksmith-admin.example.com
```

Config precedence is implemented in `src/server/config.ts`: `BETTER_AUTH_URL` wins over `TASKSMITH_AUTH_URL`, then `TASKSMITH_PUBLIC_URL`/host/port-derived defaults are used; trusted origins always include the configured base URL plus localhost origins for the configured listener port.

When auth is enabled, `TASKSMITH_DATABASE_URL` is required. Startup migrations create Better Auth's `user`, `session`, `account`, and `verification` tables alongside TaskSmith app-state tables. Public sign-up is disabled; create the first admin with:

```bash
TASKSMITH_BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
TASKSMITH_BOOTSTRAP_ADMIN_PASSWORD='<long random passphrase>' \
TASKSMITH_BOOTSTRAP_ADMIN_NAME='TaskSmith Admin' \
pnpm auth:bootstrap-admin
```

Keep `TASKSMITH_AUTH_SECRET` and bootstrap passwords in root-owned env files or one-shot secret input, not in repository config.

GitHub auth for private repositories should be configured for the `deploy` user. The GitHub Issues example config points at `/home/deploy/.config/gh-kaldy14`.

```bash
ssh tasksmith
mkdir -p /home/deploy/.config/gh-kaldy14
GH_CONFIG_DIR=/home/deploy/.config/gh-kaldy14 gh auth login -h github.com -p https -w
GH_CONFIG_DIR=/home/deploy/.config/gh-kaldy14 gh auth setup-git
GH_CONFIG_DIR=/home/deploy/.config/gh-kaldy14 gh auth status
```

GitHub CLI login is intentionally manual: it avoids putting GitHub credentials into TaskSmith prompts, config files, or shell history. Public HTTPS clones do not need auth. Private HTTPS clones, GitHub Issues intake, and PR creation do. Do not copy `ghConfigDir` auth directories into agent workspaces.

## Jira source example

For Jira-backed deployments, use a separate config file and auth setup. Start from:

```txt
config/examples/work.jira.github.json
```

In that config:

- `sourceFlow.readinessLabel = "tasksmith"` is the global Jira pickup label.
- `sourceFlow.jiraRepoRouting.labels` maps Jira labels to TaskSmith repo keys.
- `issueProvider.type = "jira"` marks the repo for Jira intake.
- `jql` defines the readiness query for that repo.
- `repoLabel` documents the expected Jira repo-routing label.
- `gitProvider.ghConfigDir` points at the work GitHub CLI profile for PR creation.
- `gitSshCommand` can force a work-only SSH key for clones.

Example routing:

```json
{
  "sourceFlow": {
    "readinessLabel": "tasksmith",
    "jiraRepoRouting": {
      "strategy": "label",
      "labels": {
        "vosime-admin": "vosime-admin",
        "core-hub": "core-hub"
      }
    }
  }
}
```

That means a Jira issue with labels `tasksmith` and `vosime-admin` routes to the `vosime-admin` repository. This mapping is per-instance configurable.

For a deployment that needs a different GitHub account, create a separate GitHub CLI profile and/or SSH key, for example:

```bash
mkdir -p /home/deploy/.config/gh-work
GH_CONFIG_DIR=/home/deploy/.config/gh-work gh auth login -h github.com -p https -w
GH_CONFIG_DIR=/home/deploy/.config/gh-work gh auth setup-git
```

Jira credentials are read from environment variables and must not be committed to config:

```txt
TASKSMITH_JIRA_BASE_URL=https://your-site.atlassian.net
TASKSMITH_JIRA_EMAIL=deploy@example.com
TASKSMITH_JIRA_API_TOKEN=<token-from-secret-store>
```

The Jira poller uses each repo's configured `issueProvider.jql` when present. If `jql` is omitted, it builds a simple readiness-label query from `projectKey`, `sourceFlow.readinessLabel`, and `repoLabel`. Claim keys are `jira:<ISSUEKEY>`, so duplicate polling or overlapping repo queries do not create duplicate Runs.

## Sandcastle-inspired single-task workflow

The configured workflow is based on Sandcastle's template flow, adapted to TaskSmith and Pi:

```txt
plan -> implement -> deep_review -> fix -> deliver
```

- `plan`: fresh planning pass over the issue and repo context.
- `implement`: Pi implementation attempt in a per-run workspace/branch.
- `deep_review`: fresh-context review of the diff.
- `fix`: bounded fix attempts based on review/verifier findings.
- `deliver`: either create a ready-to-review PR or squash-merge to main, depending on config.

Delivery is configurable:

```json
{ "workflow": { "deliveryMode": "ready_pr" } }
```

or:

```json
{ "workflow": { "deliveryMode": "squash_merge_main", "mergeTargetBranch": "main" } }
```

`ready_pr` is the safe default and creates a non-draft, ready-to-review PR. `squash_merge_main` is an explicit delivery mode for deployments/repos where direct merge is desired. Older configs containing `draft_pr` are accepted as a compatibility alias for `ready_pr`; update them when touched.

Ready PR delivery requires:

- `gitUrl`, so TaskSmith can clone and push a branch,
- `gitProvider.type = "github"`,
- `gitProvider.owner` and `gitProvider.repo`,
- a working `gh` auth profile via `gitProvider.ghConfigDir` when the repo is private or PR creation requires auth.

## Optional CodeRabbit CLI review

CodeRabbit CLI can be enabled per repository as an extra review pass after TaskSmith's fresh-context review and before delivery. This works for both `ready_pr` and `squash_merge_main` because it reviews the workspace diff before TaskSmith creates a PR or pushes the direct-merge commit.

Install and authenticate CodeRabbit on the TaskSmith host, outside agent sandboxes:

```bash
curl -fsSL https://cli.coderabbit.ai/install.sh | sh
# or: brew install coderabbit
cr auth login
```

Then opt in only the repositories that should use CodeRabbit:

```json
{
  "repos": {
    "repo-key": {
      "codeRabbit": {
        "enabled": true,
        "cli": { "enabled": true, "command": "cr", "timeoutMs": 1800000 }
      }
    }
  }
}
```

TaskSmith runs:

```bash
cr review --agent --dir <run-workspace> --base <merge-base-sha>
```

The base is the merge-base between the workspace `HEAD` and `origin/<mergeTargetBranch>` (or the configured default branch when no merge target is set). If that cannot be resolved, TaskSmith falls back to the workspace `HEAD` SHA and then the target branch name. This keeps direct-merge (`squash_merge_main`) and dirty-workspace reviews anchored to the pre-change merge target instead of asking CodeRabbit to compare `main` to `main`. TaskSmith also writes `coderabbit-cli.context.json` alongside stdout/stderr logs with the current branch, selected base, target branch, and changed files for diagnosis.

The `--agent` JSON findings are converted into TaskSmith review findings. `critical` and `major` CodeRabbit findings are treated as blocking (`critical`/`high` in TaskSmith severity); lower-severity findings are recorded but do not block delivery. If CodeRabbit reports a rate limit, times out, is not installed, or otherwise cannot run, TaskSmith emits a skipped review event and continues with its own deterministic verification plus fresh-context review as the sufficient gate.

CodeRabbit is still optional repository-by-repository. Public/OSS repositories can use CodeRabbit's free public-repo/OSS limits; private repositories require whatever paid/subscription access your CodeRabbit account provides. Do not enable `codeRabbit` for repos that should not be reviewed by CodeRabbit.

Squash-merge delivery requires:

- `gitUrl`, so TaskSmith can clone and push the target branch,
- `mergeTargetBranch` or `defaultBranch` to identify the direct-push branch; when both are absent, TaskSmith uses `main`,
- branch protection/GitHub permissions that allow the configured TaskSmith Git credentials to push without force,
- optional `gitProvider` metadata when source issue comments should include a GitHub commit URL.

The personal example config opts the `tasksmith` repository into `squash_merge_main` while leaving other repositories on the global `ready_pr` default.

If deterministic verification fails, TaskSmith checks `repos.<repoKey>.workflow.maxFixAttempts` first, then the global `workflow.maxFixAttempts`. When the limit is greater than zero, the Run enters `fixing`, advances to the next attempt id (for example `attempt-2`), gives the runtime a follow-up containing the verifier summary and a smallest-fix-only instruction, and reruns verification after that attempt completes. No PR is created during verifier-fix attempts. If the configured attempts are exhausted, the Run fails with the verifier summary.

After verification passes, TaskSmith runs a fresh-context diff review before delivery. The current reviewer is a deterministic guardrail pass over the final workspace diff: it persists `review-diff.patch` and `review-diff-stat.txt`, emits structured findings, and blocks delivery on `high` or `critical` findings such as secret-looking values or local env/dependency files.

If `codeRabbit.cli.enabled` is true for the repository, TaskSmith then runs CodeRabbit CLI and merges its findings into the persisted review record.

When blocking review findings remain, `maxReviewFixAttempts` (default `1`) starts a separate bounded review-fix attempt with a concise, smallest-fix-only prompt built from the blocking findings. This review-fix budget does not consume verifier or CI fix budgets. Review finding text is treated only as untrusted prompt context.

Review metadata is stored in `state/reviews.json` and exposed at `GET /api/reviews` and `GET /api/runs/:id/review`.

If verification and review pass in `ready_pr` mode, TaskSmith checks for a non-empty diff, creates a branch named `tasksmith/<source-or-title>-<run-suffix>`, commits all workspace changes with the TaskSmith bot identity, pushes the branch, and runs `gh pr create` without `--draft`. PR metadata is stored in `state/pull-requests.json` and exposed at `GET /api/pull-requests`. Source issues receive a PR-link comment when credentials are available.

After PR creation, TaskSmith polls GitHub checks with `gh pr checks`. Passing checks, skipped/no checks, or absence of checks complete the Run as `pr_created`. Failed checks fetch failed GitHub Actions logs with `gh run view --log-failed`, start a bounded CI fix attempt, rerun verification/review, push a fix commit to the existing PR branch, and poll checks again. `maxCiFixAttempts` controls this retry loop; `ciPollIntervalMs` and `ciTimeoutMs` control polling cadence and timeout.

If verification and review pass in `squash_merge_main` mode, TaskSmith checks for a non-empty diff, commits all workspace changes as one TaskSmith commit, and pushes `HEAD` to `refs/heads/<mergeTargetBranch>` without force. The Run completes with a delivery event containing the target branch and commit URL/SHA. Source issues receive a direct-merge comment when credentials are available.

## Verification precedence

For each Run:

1. `repos.<repoKey>.verify` if present.
2. Otherwise `TASKSMITH_VERIFICATION_COMMANDS` if set.
3. Otherwise `defaultVerify` from the config file.
4. Otherwise the built-in workspace smoke check.

Verifier commands run outside Pi with `cwd` set to the per-run workspace and `HOME` set to the per-run home directory.
