# References

## Local Pi documentation

Read these when implementing the Pi runtime:

- Main README: `/Users/kaldy/.nvm/versions/node/v24.14.0/lib/node_modules/@mariozechner/pi-coding-agent/README.md`
- JSON mode: `/Users/kaldy/.nvm/versions/node/v24.14.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/json.md`
- RPC mode: `/Users/kaldy/.nvm/versions/node/v24.14.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/rpc.md`
- SDK: `/Users/kaldy/.nvm/versions/node/v24.14.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/sdk.md`
- Providers: `/Users/kaldy/.nvm/versions/node/v24.14.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/providers.md`

## Pi commands

### RPC mode candidate

```bash
HOME=/data/tasksmith/runs/<run-id>/home \
pi --mode rpc \
  --session-dir /data/tasksmith/runs/<run-id>/pi-session
```

### JSON mode one-shot reference

```bash
pi --mode json "Inspect this repository and summarize it"
```

### Pi auth path

Expected auth file to preserve/copy narrowly:

```txt
~/.pi/agent/auth.json
```

## Repositories inspected

### Kandev

Repo: `kdlbs/kandev`  
Inspected commit: `7ec639bf2f6aaa9d7f594f54f034f76e2738ce44`

Important links:

- Jira watch model:  
  https://github.com/kdlbs/kandev/blob/7ec639bf2f6aaa9d7f594f54f034f76e2738ce44/apps/backend/internal/jira/models.go#L131-L152

- Jira poller:  
  https://github.com/kdlbs/kandev/blob/7ec639bf2f6aaa9d7f594f54f034f76e2738ce44/apps/backend/internal/jira/poller.go#L110-L151

- Jira event handler/task creation:  
  https://github.com/kdlbs/kandev/blob/7ec639bf2f6aaa9d7f594f54f034f76e2738ce44/apps/backend/internal/orchestrator/event_handlers_jira.go#L43-L114

- Full workflow docs:  
  https://github.com/kdlbs/kandev/blob/7ec639bf2f6aaa9d7f594f54f034f76e2738ce44/docs/workflow-tips.md#L74-L86

- Codex ACP:  
  https://github.com/kdlbs/kandev/blob/7ec639bf2f6aaa9d7f594f54f034f76e2738ce44/apps/backend/internal/agent/agents/codex_acp.go#L25-L53

- Pi ACP:  
  https://github.com/kdlbs/kandev/blob/7ec639bf2f6aaa9d7f594f54f034f76e2738ce44/apps/backend/internal/agent/agents/pi_acp.go#L25-L50

- Docker socket warning:  
  https://github.com/kdlbs/kandev/blob/7ec639bf2f6aaa9d7f594f54f034f76e2738ce44/docs/docker.md#L210-L220

### CodeForge

Repo: `freema/codeforge`  
Inspected commit: `a4cb47a340b4f7534abdb6e871828ad236fac6ef`

Important links:

- Architecture summary:  
  https://github.com/freema/codeforge/blob/a4cb47a340b4f7534abdb6e871828ad236fac6ef/docs/architecture.md#L7-L8

- Task service and worker pool:  
  https://github.com/freema/codeforge/blob/a4cb47a340b4f7534abdb6e871828ad236fac6ef/docs/architecture.md#L41-L55

- Codex runner:  
  https://github.com/freema/codeforge/blob/a4cb47a340b4f7534abdb6e871828ad236fac6ef/internal/tool/runner/codex.go#L37-L56

- PR service:  
  https://github.com/freema/codeforge/blob/a4cb47a340b4f7534abdb6e871828ad236fac6ef/internal/session/pr_service.go#L73-L227

- Jira MCP catalog entry:  
  https://github.com/freema/codeforge/blob/a4cb47a340b4f7534abdb6e871828ad236fac6ef/internal/tools/catalog.go#L24-L35

### OpenHands

Repo: `All-Hands-AI/OpenHands`  
Inspected commit: `779176e18647687006ed3f0338bfda47bd0c7d43`

Important links:

- SDK, CLI, Local GUI:  
  https://github.com/All-Hands-AI/OpenHands/blob/779176e18647687006ed3f0338bfda47bd0c7d43/README.md#L34-L51

- Cloud/Enterprise features and Jira/Linear/Slack mention:  
  https://github.com/All-Hands-AI/OpenHands/blob/779176e18647687006ed3f0338bfda47bd0c7d43/README.md#L53-L69

- Enterprise license warning:  
  https://github.com/All-Hands-AI/OpenHands/blob/779176e18647687006ed3f0338bfda47bd0c7d43/enterprise/README.md#L1-L8

- LiteLLM/API-key config docs:  
  https://github.com/All-Hands-AI/OpenHands/blob/779176e18647687006ed3f0338bfda47bd0c7d43/Development.md#L40-L49

### Sandcastle

Repo: `mattpocock/sandcastle`

Relevant local files previously inspected:

- `/tmp/pi-github-repos/mattpocock/sandcastle/README.md`
- `/tmp/pi-github-repos/mattpocock/sandcastle/src/AgentProvider.ts`
- `/tmp/pi-github-repos/mattpocock/sandcastle/src/InitService.ts`
- `/tmp/pi-github-repos/mattpocock/sandcastle/docs/agents/issue-tracker.md`
- `/tmp/pi-github-repos/mattpocock/sandcastle/docs/agents/adding-a-backlog-manager.md`

### Open Agents

Repo: `vercel-labs/open-agents`

Relevant local files previously inspected:

- `/tmp/pi-github-repos/vercel-labs/open-agents/AGENTS.md`
- `/tmp/pi-github-repos/vercel-labs/open-agents/docs/agents/architecture.md`
- `/tmp/pi-github-repos/vercel-labs/open-agents/apps/web/SANDBOX-LIFECYCLE.md`

## Other alternatives considered

- Kandev
- OpenHands
- CodeForge
- Sandcastle
- Open Agents
- orch/orchestrator
- GitHub Copilot coding agent
- Codex GitHub Action

## Key architecture inspirations

- Kandev: Jira watches, workflow stages, agent/executor profiles.
- CodeForge: worker queue, event streaming, PR service, review service.
- OpenHands: GUI/conversation/sandbox product feel.
- Sandcastle: lightweight provider/runner abstraction.
- Pi: native live interactive agent runtime.
