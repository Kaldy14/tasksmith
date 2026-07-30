export type RunStatus =
  | "queued"
  | "claimed"
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

export type AttemptStatus = "queued" | "starting" | "streaming" | "completed" | "failed" | "aborted";

export type RuntimeAdapter = "pi" | "demo";

export type ControlKind = "prompt" | "steer" | "follow_up";

export interface ReopenRunInput {
  message: string;
}

export type RunSourceType = "manual" | "github_issue" | "jira";

export interface SourceCommentSnapshot {
  id: string;
  author?: string;
  created?: string;
  updated?: string;
  body: string;
}

export interface SourceAttachmentSnapshot {
  id: string;
  filename: string;
  mimeType?: string;
  size?: number;
}

export interface SourceMetadataSnapshot {
  status?: string;
  projectKey?: string;
  issueType?: string;
  components?: string[];
}

export interface RunSourceSnapshot {
  type: RunSourceType;
  key: string;
  title: string;
  url?: string;
  body?: string;
  labels: string[];
  comments?: SourceCommentSnapshot[];
  attachments?: SourceAttachmentSnapshot[];
  metadata?: SourceMetadataSnapshot;
}

export interface PullRequestSummary {
  provider: "github";
  url: string;
  number?: number;
  branch: string;
  status: "open";
}

export interface RunLease {
  workerId: string;
  expiresAt: string;
  lastHeartbeatAt?: string;
  attempt: number;
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
  ciFixAttempts: number;
  reviewFixAttempts: number;
  runDir: string;
  workspaceDir: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  sessionId?: string;
  sessionFile?: string;
  error?: string;
  lease?: RunLease;
}

export interface CreateRunInput {
  title: string;
  prompt: string;
  repoKey: string;
  adapter: RuntimeAdapter;
  source?: RunSourceSnapshot;
  claimKey?: string;
}

export type SourceClaimStatus = "claimed" | "run_created" | "failed" | "pr_created" | "completed";

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

export interface ReviewRecord {
  id: string;
  runId: string;
  status: "passed" | "failed";
  summary: string;
  findings: ReviewFinding[];
  diffStat?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateReviewRecordInput {
  runId: string;
  status: ReviewRecord["status"];
  summary: string;
  findings: ReviewFinding[];
  diffStat?: string;
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

export type GitHubWebhookConfig =
  | { enabled: false }
  | { enabled: true; signingKey: string };

export type JiraWebhookConfig =
  | { enabled: false }
  | { enabled: true; signingKey: string };

export type QualityAuditConfig =
  | { enabled: false }
  | {
      enabled: true;
      signingKey: string;
      repository: string;
      allowedRef: string;
      ghCommand: string;
      ghConfigDir: string;
      reportsDir: string;
      reportsPublicUrl: string;
      slackBotToken: string;
      slackChannelId: string;
      slackApiUrl: string;
      notifyOnClean: boolean;
    };

export type DeliveryMode = "ready_pr" | "squash_merge_main";

export interface CodeRabbitCliConfig {
  enabled: boolean;
  command: string;
  timeoutMs: number;
}

export interface CodeRabbitConfig {
  enabled: boolean;
  cli: CodeRabbitCliConfig;
}

export interface SingleTaskWorkflowConfig {
  type: "single_task_sandcastle";
  stages: ["plan", "implement", "deep_review", "fix", "deliver"];
  maxFixAttempts: number;
  maxCiFixAttempts: number;
  maxReviewFixAttempts: number;
  ciPollIntervalMs: number;
  ciTimeoutMs: number;
  deliveryMode: DeliveryMode;
  mergeTargetBranch?: string;
}

export interface RepositoryCheckoutConfig {
  mode: "clone" | "worktree";
  cacheDir?: string;
}

export interface RepositoryConfig {
  displayName?: string;
  gitUrl?: string;
  defaultBranch?: string;
  cloneDepth?: number;
  checkout?: RepositoryCheckoutConfig;
  gitSshCommand?: string;
  gitProvider?: GitHubProviderConfig;
  issueProvider?: IssueProviderConfig;
  runtimeAdapter?: RuntimeAdapter;
  initCommands?: VerificationCommandConfig[];
  verify?: VerificationCommandConfig[];
  workflow?: SingleTaskWorkflowConfig;
  codeRabbit?: CodeRabbitConfig;
}

export interface VerificationConfig {
  defaultCommands: VerificationCommandConfig[];
}

export interface RunClaimCapacity {
  maxActiveRuns?: number;
  maxActiveRunsPerRepo?: number;
}

export interface QueueLeaseConfig extends RunClaimCapacity {
  leaseTimeoutMs: number;
  heartbeatIntervalMs: number;
}

export type AuthConfig =
  | {
      enabled: false;
      baseUrl: string;
      trustedOrigins: string[];
    }
  | {
      enabled: true;
      secret: string;
      baseUrl: string;
      trustedOrigins: string[];
    };

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
      type: "review";
      status: "running" | "passed" | "failed";
      summary?: string;
      findings?: ReviewFinding[];
      diffStat?: string;
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
  databaseUrl?: string;
  auth: AuthConfig;
  configFilePath?: string;
  repositories: Record<string, RepositoryConfig>;
  sourceFlow: SourceFlowConfig;
  githubWebhooks: GitHubWebhookConfig;
  jiraWebhooks: JiraWebhookConfig;
  qualityAudit: QualityAuditConfig;
  workflow: SingleTaskWorkflowConfig;
  verification: VerificationConfig;
  queue: QueueLeaseConfig;
}

export interface RuntimeHandle {
  send(kind: ControlKind, message: string): Promise<void>;
  abort(): Promise<void>;
  abortBash(): Promise<void>;
  dispose(): Promise<void>;
}
