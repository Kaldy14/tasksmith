export type RunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "waiting_for_control"
  | "verifying"
  | "fixing"
  | "reviewing"
  | "watching_ci"
  | "delivering"
  | "creating_pr"
  | "pr_created"
  | "completed"
  | "failed"
  | "cancelled";

export type RuntimeAdapter = "pi" | "demo";
export type ControlKind = "prompt" | "steer" | "follow_up";

export type RunSourceType = "manual" | "github_issue" | "jira";

export interface RunSourceSnapshot {
  type: RunSourceType;
  key: string;
  title: string;
  url?: string;
  body?: string;
  labels: string[];
}

export type ReviewSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface ReviewFinding {
  id: string;
  severity: ReviewSeverity;
  title: string;
  description: string;
  file?: string;
  line?: number;
  suggestedFix?: string;
}

export interface PullRequestSummary {
  provider: "github";
  url: string;
  number?: number;
  branch: string;
  status: "open";
}

export interface RunRecord {
  id: string;
  sourceType: RunSourceType;
  title: string;
  prompt: string;
  repoKey: string;
  adapter: RuntimeAdapter;
  source?: RunSourceSnapshot;
  claimKey?: string;
  pullRequest?: PullRequestSummary;
  status: RunStatus;
  currentAttemptId: string;
  runDir: string;
  workspaceDir: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  sessionId?: string;
  sessionFile?: string;
  error?: string;
}

export interface CreateRunInput {
  title: string;
  prompt: string;
  repoKey: string;
  adapter: RuntimeAdapter;
}

export interface RepositorySummary {
  key: string;
  displayName: string;
  defaultBranch: string;
  hasGitUrl: boolean;
  gitProvider?: { type: "github"; owner: string; repo: string };
  issueProvider?: { type: "github_issues" | "jira" };
  workflow?: { deliveryMode: "ready_pr" | "squash_merge_main"; maxFixAttempts: number; maxCiFixAttempts: number };
  initCommandCount: number;
  hasVerificationProfile: boolean;
}

export interface EditableConfigResponse {
  path?: string;
  writable: boolean;
  config: unknown;
}

export interface PublicAppConfig {
  auth: { enabled: boolean };
  repositories: RepositorySummary[];
  sourceFlow: {
    readinessLabel: string;
    pollIntervalSeconds: number;
    jiraRepoRouting: { strategy: "label"; labels: Record<string, string> };
  };
  workflow: {
    type: "single_task_sandcastle";
    stages: ["plan", "implement", "deep_review", "fix", "deliver"];
    maxFixAttempts: number;
    maxCiFixAttempts: number;
    ciPollIntervalMs: number;
    ciTimeoutMs: number;
    deliveryMode: "ready_pr" | "squash_merge_main";
    mergeTargetBranch?: string;
  };
}

export type NormalizedRunEvent =
  | { type: "run_status"; status: RunStatus; detail?: string }
  | {
      type: "user_message";
      control: ControlKind;
      text: string;
      delivery: "received" | "forwarded" | "accepted" | "failed";
      error?: string;
    }
  | { type: "assistant_delta"; text: string }
  | { type: "assistant_message"; text: string; stopReason?: string }
  | { type: "tool_call"; name: string; toolCallId?: string; input?: unknown }
  | { type: "tool_result"; name: string; toolCallId?: string; output: string; isError?: boolean }
  | { type: "command"; command: string; toolCallId?: string }
  | {
      type: "command_output";
      command?: string;
      output: string;
      toolCallId?: string;
      isError?: boolean;
    }
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | {
      type: "session_state";
      sessionId: string;
      sessionFile?: string;
      isStreaming: boolean;
      messageCount: number;
      pendingMessageCount: number;
    }
  | {
      type: "verification";
      name: string;
      command: string;
      status: "running" | "passed" | "failed" | "skipped";
      exitCode?: number;
      durationMs?: number;
      stdout?: string;
      stderr?: string;
      stdoutPath?: string;
      stderrPath?: string;
      error?: string;
    }
  | {
      type: "review";
      status: "running" | "passed" | "failed";
      summary?: string;
      findings?: ReviewFinding[];
      diffStat?: string;
      error?: string;
    }
  | {
      type: "delivery";
      mode: "ready_pr" | "squash_merge_main";
      status: "running" | "created" | "skipped" | "failed";
      provider?: "github";
      branch?: string;
      url?: string;
      number?: number;
      detail?: string;
      error?: string;
    }
  | {
      type: "ci";
      provider: "github";
      status: "running" | "passed" | "failed" | "skipped";
      summary: string;
      attempt?: number;
      detailsUrl?: string;
      log?: string;
    }
  | { type: "error"; message: string; detail?: string }
  | { type: "attempt_done"; status: "completed" | "aborted" | "failed"; summary?: string };

export interface StoredRunEvent {
  version: 1;
  id: string;
  runId: string;
  attemptId: string;
  sequence: number;
  type: NormalizedRunEvent["type"];
  createdAt: string;
  data: NormalizedRunEvent;
}

export type ConnectionStatus = "idle" | "connecting" | "online" | "offline";
