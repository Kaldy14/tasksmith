# Configuration

TaskSmith can run as separate personal and work instances by giving each server its own config file, auth material, and data directory.

## Config file

Set:

```bash
TASKSMITH_CONFIG_PATH=/opt/tasksmith/config/repos.json
```

`TASKSMITH_REPO_CONFIG_PATH` remains supported as a backwards-compatible alias, but `TASKSMITH_CONFIG_PATH` is preferred.

Minimal shape:

```json
{
  "defaultVerify": [
    { "name": "typecheck", "command": "pnpm typecheck", "timeoutMs": 180000 }
  ],
  "repos": {
    "repo-key": {
      "displayName": "Repo Name",
      "gitUrl": "git@github.com:OWNER/REPO.git",
      "defaultBranch": "main",
      "gitProvider": { "type": "github", "owner": "OWNER", "repo": "REPO" },
      "issueProvider": { "type": "github_issues", "labels": ["ai-ready"], "state": "open" },
      "verify": [
        { "name": "test", "command": "pnpm test", "timeoutMs": 300000 }
      ]
    }
  }
}
```

Configured repositories appear in the manual intake UI. When a Run uses a configured repository with `gitUrl`, TaskSmith clones it into the per-run workspace before starting Pi or the demo runtime.

## Personal GitHub instance

Use GitHub Issues as the intake source. Start from:

```txt
config/examples/personal.github.json
```

Current intended repos:

- `tasksmith` -> `Kaldy14/tasksmith`
- `robodoggo` -> `Kaldy14/robodoggo`
- `clui` -> `Kaldy14/clui`

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

GitHub auth for private repositories should be configured for the `deploy` user. On the personal server, GitHub CLI is installed and the example config points at `/home/deploy/.config/gh-kaldy14`.

```bash
ssh tasksmith
mkdir -p /home/deploy/.config/gh-kaldy14
GH_CONFIG_DIR=/home/deploy/.config/gh-kaldy14 gh auth login -h github.com -p https -w
GH_CONFIG_DIR=/home/deploy/.config/gh-kaldy14 gh auth setup-git
GH_CONFIG_DIR=/home/deploy/.config/gh-kaldy14 gh auth status
```

Public HTTPS clones do not need auth. Private HTTPS clones, GitHub Issues intake, and future PR creation do. Do not copy `ghConfigDir` auth directories into agent workspaces.

## Work Jira instance

Use a separate Hetzner server, a separate `deploy` user auth setup, and a separate config file. Start from:

```txt
config/examples/work.jira.github.json
```

In that config:

- `issueProvider.type = "jira"` marks the repo for Jira intake.
- `jql` defines the readiness query for that repo.
- `repoLabel` documents the expected Jira repo-routing label.
- `gitProvider.ghConfigDir` points at the work GitHub CLI profile for future PR creation.
- `gitSshCommand` can force a work-only SSH key for clones.

For the work server, create a separate GitHub CLI profile and/or SSH key, for example:

```bash
mkdir -p /home/deploy/.config/gh-work
GH_CONFIG_DIR=/home/deploy/.config/gh-work gh auth login -h github.com -p https -w
GH_CONFIG_DIR=/home/deploy/.config/gh-work gh auth setup-git
```

Jira tokens should be environment variables or a secrets manager in a later Jira poller slice, not committed to the config file.

## Verification precedence

For each Run:

1. `repos.<repoKey>.verify` if present.
2. Otherwise `TASKSMITH_VERIFICATION_COMMANDS` if set.
3. Otherwise `defaultVerify` from the config file.
4. Otherwise the built-in workspace smoke check.

Verifier commands run outside Pi with `cwd` set to the per-run workspace and `HOME` set to the per-run home directory.
