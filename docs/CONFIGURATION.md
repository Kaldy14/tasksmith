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
    "deliveryMode": "draft_pr"
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
      "verify": [
        { "name": "test", "command": "pnpm test", "timeoutMs": 300000 }
      ]
    }
  }
}
```

Configured repositories appear in the manual intake UI. When a Run uses a configured repository with `gitUrl`, TaskSmith clones it into the per-run workspace before starting Pi or the demo runtime.

## GitHub Issues source example

Use GitHub Issues as the intake source. The readiness label is `tasksmith`, not `ai-ready`. Start from:

```txt
config/examples/personal.github.json
```

Current intended repos:

- `tasksmith` -> `Kaldy14/tasksmith`
- `robodoggo` -> `Kaldy14/robodoggo`
- `clui` -> `Kaldy14/clui`

Because GitHub Issues are already scoped to a repository, no extra repo-routing label is needed. The poller should query each configured repo for open issues with label `tasksmith`.

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

GitHub auth for private repositories should be configured for the `deploy` user. The GitHub Issues example config points at `/home/deploy/.config/gh-kaldy14`.

```bash
ssh tasksmith
mkdir -p /home/deploy/.config/gh-kaldy14
GH_CONFIG_DIR=/home/deploy/.config/gh-kaldy14 gh auth login -h github.com -p https -w
GH_CONFIG_DIR=/home/deploy/.config/gh-kaldy14 gh auth setup-git
GH_CONFIG_DIR=/home/deploy/.config/gh-kaldy14 gh auth status
```

GitHub CLI login is intentionally manual: it avoids putting GitHub credentials into TaskSmith prompts, config files, or shell history. Public HTTPS clones do not need auth. Private HTTPS clones, GitHub Issues intake, and future PR creation do. Do not copy `ghConfigDir` auth directories into agent workspaces.

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
- `gitProvider.ghConfigDir` points at the work GitHub CLI profile for future PR creation.
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

Jira tokens should be environment variables or a secrets manager in a later Jira poller slice, not committed to the config file.

## Sandcastle-inspired single-task workflow

The configured workflow is based on Sandcastle's template flow, adapted to TaskSmith and Pi:

```txt
plan -> implement -> deep_review -> fix -> deliver
```

- `plan`: fresh planning pass over the issue and repo context.
- `implement`: Pi implementation attempt in a per-run workspace/branch.
- `deep_review`: fresh-context review of the diff.
- `fix`: bounded fix attempts based on review/verifier findings.
- `deliver`: either create a draft PR or squash-merge to main, depending on config.

Delivery is configurable:

```json
{ "workflow": { "deliveryMode": "draft_pr" } }
```

or:

```json
{ "workflow": { "deliveryMode": "squash_merge_main", "mergeTargetBranch": "main" } }
```

`draft_pr` is the safe default. `squash_merge_main` is an explicit delivery mode for deployments/repos where direct merge is desired.

## Verification precedence

For each Run:

1. `repos.<repoKey>.verify` if present.
2. Otherwise `TASKSMITH_VERIFICATION_COMMANDS` if set.
3. Otherwise `defaultVerify` from the config file.
4. Otherwise the built-in workspace smoke check.

Verifier commands run outside Pi with `cwd` set to the per-run workspace and `HOME` set to the per-run home directory.
