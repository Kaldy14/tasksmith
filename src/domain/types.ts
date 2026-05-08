export type RunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "waiting_for_control"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export type AttemptStatus = "queued" | "starting" | "streaming" | "completed" | "failed" | "aborted";

export type RuntimeAdapter = "pi" | "demo";

export type ControlKind = "prompt" | "steer" | "follow_up";

export interface RunRecord {
  id: string;
  sourceType: "manual";
  title: string;
  prompt: string;
  repoKey: string;
  adapter: RuntimeAdapter;
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

export interface VerificationCommandConfig {
  name: string;
  command: string;
  timeoutMs: number;
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
  verificationCommands: VerificationCommandConfig[];
}

export interface RuntimeHandle {
  send(kind: ControlKind, message: string): Promise<void>;
  abort(): Promise<void>;
  abortBash(): Promise<void>;
  dispose(): Promise<void>;
}
