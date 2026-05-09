export type RunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "waiting_for_control"
  | "verifying"
  | "creating_pr"
  | "pr_created"
  | "completed"
  | "failed"
  | "cancelled";

export type AttemptStatus = "queued" | "starting" | "streaming" | "completed" | "failed" | "aborted";

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
  source?: RunSourceSnapshot;
  claimKey?: string;
}

export type SourceClaimStatus = "claimed" | "run_created" | "failed";

export interface SourceClaim {
  key: string;
  provider: "github" | "jira";
  sourceType: Exclude<RunSourceType, "manual">;
  sourceKey: string;
  sourceUrl?: string;
  repoKey: string;
  runId?: string;
  status: SourceClaimStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSourceClaimInput {
  key: string;
  provider: SourceClaim["provider"];
  sourceType: SourceClaim["sourceType"];
  sourceKey: string;
  sourceUrl?: string;
  repoKey: string;
}

export interface PullRequestRecord {
  id: string;
  runId: string;
  provider: "github";
  url: string;
  number?: number;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
  status: "open";
  createdAt: string;
  updatedAt: string;
}

export interface CreatePullRequestRecordInput {
  runId: string;
  provider: PullRequestRecord["provider"];
  url: string;
  number?: number;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}

export interface VerificationCommandConfig {
  name: string;
  command: string;
  timeoutMs: number;
}

export interface GitHubProviderConfig {
  type: "github";
  owner: string;
  repo: string;
  ghConfigDir?: string;
}

export type IssueProviderConfig =
  | {
      type: "github_issues";
      labels?: string[];
      state?: "open" | "closed" | "all";
    }
  | {
      type: "jira";
      projectKey?: string;
      jql?: string;
      repoLabel?: string;
    };

export interface SourceFlowConfig {
  readinessLabel: string;
  pollIntervalSeconds: number;
  jiraRepoRouting: {
    strategy: "label";
    labels: Record<string, string>;
  };
}

export type DeliveryMode = "ready_pr" | "squash_merge_main";

export interface SingleTaskWorkflowConfig {
  type: "single_task_sandcastle";
  stages: ["plan", "implement", "deep_review", "fix", "deliver"];
  maxFixAttempts: number;
  deliveryMode: DeliveryMode;
  mergeTargetBranch?: string;
}

export interface RepositoryConfig {
  displayName?: string;
  gitUrl?: string;
  defaultBranch?: string;
  cloneDepth?: number;
  gitSshCommand?: string;
  gitProvider?: GitHubProviderConfig;
  issueProvider?: IssueProviderConfig;
  runtimeAdapter?: RuntimeAdapter;
  initCommands?: VerificationCommandConfig[];
  verify?: VerificationCommandConfig[];
  workflow?: SingleTaskWorkflowConfig;
}

export interface VerificationConfig {
  defaultCommands: VerificationCommandConfig[];
}

export type NormalizedRunEvent =
  | { type: "run_status"; status: RunStatus; detail?: string }
  | { type: "user_message"; control: ControlKind; text: string; delivery: "received" | "forwarded" | "accepted" | "failed"; error?: string }
  | { type: "assistant_delta"; text: string }
  | { type: "assistant_message"; text: string; stopReason?: string }
  | { type: "tool_call"; name: string; toolCallId?: string; input?: unknown }
  | { type: "tool_result"; name: string; toolCallId?: string; output: string; isError?: boolean }
  | { type: "command"; command: string; toolCallId?: string }
  | { type: "command_output"; command?: string; output: string; toolCallId?: string; isError?: boolean }
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "session_state"; sessionId: string; sessionFile?: string; isStreaming: boolean; messageCount: number; pendingMessageCount: number }
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
      type: "delivery";
      mode: DeliveryMode;
      status: "running" | "created" | "skipped" | "failed";
      provider?: "github";
      branch?: string;
      url?: string;
      number?: number;
      detail?: string;
      error?: string;
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

export interface RunPaths {
  runDir: string;
  workspaceDir: string;
  homeDir: string;
  agentDir: string;
  authPath: string;
  modelsPath: string;
  settingsPath: string;
  sessionDir: string;
  eventsDir: string;
  rawEventsPath: string;
  normalizedEventsPath: string;
  controlEventsPath: string;
  logsDir: string;
  artifactsDir: string;
  metadataPath: string;
}

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  runsDir: string;
  stateDir: string;
  piAuthSourceDir: string;
  publicDir: string;
  publicBaseUrl: string;
  configFilePath?: string;
  repositories: Record<string, RepositoryConfig>;
  sourceFlow: SourceFlowConfig;
  workflow: SingleTaskWorkflowConfig;
  verification: VerificationConfig;
}

export interface RuntimeHandle {
  send(kind: ControlKind, message: string): Promise<void>;
  abort(): Promise<void>;
  abortBash(): Promise<void>;
  dispose(): Promise<void>;
}
