# Research Summary

This document captures the relevant findings from evaluating existing projects and tools before building TaskSmith.

## Summary verdict

- **Kandev** is the closest existing product to the desired workflow.
- **CodeForge** is a useful smaller runner/control-plane reference.
- **OpenHands** is strong as a general coding-agent product but not the best OSS base for Jira-driven self-hosted PR automation.
- **Sandcastle** is a useful execution/sandbox/provider reference.
- **Open Agents** is useful UI/control-plane inspiration but is Vercel-shaped.
- **Pi** should be first-class in TaskSmith, not hidden behind ACP.

## Kandev

### What Kandev gets right

Kandev has unusually strong overlap with the TaskSmith vision:

- Jira issue watches via JQL.
- Internal task creation from Jira issues.
- Agent profiles and executor profiles.
- Workflow steps.
- Docker-based execution.
- Codex ACP support.
- Pi ACP support.
- Multi-phase lifecycle: spec, work, review, QA, PR, CI fixup.

Kandev source references:

- Jira issue watch model: `IssueWatch` includes workspace, workflow, workflow step, JQL, agent profile, executor profile, prompt, enabled flag, and poll interval.  
  https://github.com/kdlbs/kandev/blob/7ec639bf2f6aaa9d7f594f54f034f76e2738ce44/apps/backend/internal/jira/models.go#L131-L152

- Jira poller runs enabled watches and emits events for matching tickets.  
  https://github.com/kdlbs/kandev/blob/7ec639bf2f6aaa9d7f594f54f034f76e2738ce44/apps/backend/internal/jira/poller.go#L110-L151

- New Jira issues are converted into Kandev tasks and may auto-start.  
  https://github.com/kdlbs/kandev/blob/7ec639bf2f6aaa9d7f594f54f034f76e2738ce44/apps/backend/internal/orchestrator/event_handlers_jira.go#L43-L114

- Full workflow documentation includes Spec, Work, Review, QA, PR, CI Fixup.  
  https://github.com/kdlbs/kandev/blob/7ec639bf2f6aaa9d7f594f54f034f76e2738ce44/docs/workflow-tips.md#L74-L86

- Codex ACP support exists.  
  https://github.com/kdlbs/kandev/blob/7ec639bf2f6aaa9d7f594f54f034f76e2738ce44/apps/backend/internal/agent/agents/codex_acp.go#L25-L53

- Pi ACP support exists.  
  https://github.com/kdlbs/kandev/blob/7ec639bf2f6aaa9d7f594f54f034f76e2738ce44/apps/backend/internal/agent/agents/pi_acp.go#L25-L50

### Why Kandev was rated 7.5/10

Kandev is the best benchmark, but it is not obviously the final base:

1. **Jira import vs Jira source of truth**  
   Kandev can create tasks from Jira, but TaskSmith likely wants Jira status, comments, labels, PR links, and failure reports to remain first-class and synchronized.

2. **Repository routing**  
   Kandev notes that Jira issues have no repository affinity, so workflow defaults decide where tasks run. TaskSmith may need issue-based routing across `vosime-admin`, `core-hub`, or a monorepo.

3. **Pi hidden behind ACP**  
   Kandev uses `pi-acp`. TaskSmith wants native Pi SDK/RPC to expose steer, follow-up, abort, get messages, get state, and session stats directly.

4. **Pi auth/session uncertainty**  
   Kandev's Pi ACP runtime has `RemoteAuth() nil` and a TODO around session dir persistence. TaskSmith should explicitly persist per-run Pi session state and auth material.

5. **Sandbox/security model**  
   Kandev Docker mode can require mounting the Docker socket, which gives broad host Docker access. TaskSmith should treat Jira text as hostile and design narrow isolation.

6. **Verifier should be deterministic**  
   Kandev documents QA, but TaskSmith should have explicit verifier commands outside the agent loop.

7. **Opinionated internal model**  
   Kandev has its own workspace/workflow/task concepts. TaskSmith should be Jira/run/event-centric.

## CodeForge

### Useful ideas

CodeForge is a useful reference for:

- task API,
- worker queue,
- cloned workspaces,
- AI CLI runner abstraction,
- normalized event streaming,
- SSE reconnect/replay,
- review flow,
- PR creation,
- GitHub/GitLab PR review webhook handling.

Source references:

- Architecture summary: receives task requests, clones repositories, runs AI CLI tools, streams progress, supports review/instruct/create PR/post review comments.  
  https://github.com/freema/codeforge/blob/a4cb47a340b4f7534abdb6e871828ad236fac6ef/docs/architecture.md#L7-L8

- Worker pool and task service.  
  https://github.com/freema/codeforge/blob/a4cb47a340b4f7534abdb6e871828ad236fac6ef/docs/architecture.md#L41-L55

- Codex runner using JSONL.  
  https://github.com/freema/codeforge/blob/a4cb47a340b4f7534abdb6e871828ad236fac6ef/internal/tool/runner/codex.go#L37-L56

- PR creation service.  
  https://github.com/freema/codeforge/blob/a4cb47a340b4f7534abdb6e871828ad236fac6ef/internal/session/pr_service.go#L73-L227

- Jira exists as an MCP tool, not as the core issue pickup loop.  
  https://github.com/freema/codeforge/blob/a4cb47a340b4f7534abdb6e871828ad236fac6ef/internal/tools/catalog.go#L24-L35

### Drawbacks for TaskSmith

- Jira is a tool for agents, not the primary orchestrator.
- Pi is not first-class.
- Codex path is API-key oriented.
- Workflow would need customization for Jira-driven autonomous PR generation.

## OpenHands

### Useful ideas

OpenHands is valuable as a reference for:

- coding-agent UI,
- local GUI experience,
- SDK and runtime concepts,
- sandboxed agent runtime,
- conversation-based interaction.

Source references:

- OpenHands modes: SDK, CLI, Local GUI.  
  https://github.com/All-Hands-AI/OpenHands/blob/779176e18647687006ed3f0338bfda47bd0c7d43/README.md#L34-L51

- Cloud/Enterprise features include Slack, Jira, Linear, multi-user, RBAC, collaboration.  
  https://github.com/All-Hands-AI/OpenHands/blob/779176e18647687006ed3f0338bfda47bd0c7d43/README.md#L53-L69

- Enterprise license warning.  
  https://github.com/All-Hands-AI/OpenHands/blob/779176e18647687006ed3f0338bfda47bd0c7d43/enterprise/README.md#L1-L8

- Web app model config is LiteLLM/API-key oriented.  
  https://github.com/All-Hands-AI/OpenHands/blob/779176e18647687006ed3f0338bfda47bd0c7d43/Development.md#L40-L49

### Drawbacks for TaskSmith

- Jira integration is cloud/enterprise-shaped.
- Self-hosted Cloud requires Enterprise/commercial path.
- OSS Local GUI is not the same as Jira-driven autonomous PR automation.
- Model/auth path is less aligned with Pi subscription-style usage.

## Sandcastle and Open Agents

### Sandcastle

Useful as a reference for:

- Docker/runner design,
- agent provider abstraction,
- Codex/Pi command execution patterns,
- backlog/issue manager ideas.

Known useful command shape from prior research:

```bash
pi -p --mode json --no-session --model <model>
```

TaskSmith should not copy this as the main runtime because TaskSmith wants live control. Prefer Pi RPC or SDK.

### Open Agents

Useful as UI/control-plane inspiration, especially for run visibility. Less suitable as backend base because it is Vercel-shaped: Vercel Workflow and Vercel Sandbox.

## Pi findings

Pi has three relevant integration modes:

1. **JSON mode** — useful for one-shot event stream integrations.
2. **RPC mode** — useful for process-based live control.
3. **SDK** — best for Node/TypeScript workers and direct session control.

References from local Pi docs:

- JSON mode outputs session events as JSON lines and is useful for custom UIs.
- RPC mode supports prompt, steer, follow_up, abort, new_session, get_state, get_messages, session stats.
- SDK exposes `createAgentSession`, `session.subscribe`, `session.prompt`, `session.steer`, `session.followUp`, and `session.abort`.

TaskSmith should start with Pi RPC or SDK, not ACP.
