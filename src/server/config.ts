import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AppConfig,
  CodeRabbitConfig,
  GitHubProviderConfig,
  IssueProviderConfig,
  RepositoryConfig,
  SingleTaskWorkflowConfig,
  SourceFlowConfig,
  QueueLeaseConfig,
  VerificationCommandConfig,
  VerificationConfig,
} from "../domain/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

interface ParsedConfigFile {
  defaultVerify?: VerificationCommandConfig[];
  repos: Record<string, RepositoryConfig>;
  sourceFlow?: SourceFlowConfig;
  workflow?: SingleTaskWorkflowConfig;
  queue?: Pick<QueueLeaseConfig, "maxActiveRuns" | "maxActiveRunsPerRepo">;
}

export interface EditableConfigResponse {
  path?: string;
  writable: boolean;
  config: unknown;
}

export function loadConfig(): AppConfig {
  const dataDir = path.resolve(process.env.TASKSMITH_DATA_DIR ?? ".data/tasksmith");
  const configFilePath = getConfigFilePath();
  const fileConfig = parseConfigFile(configFilePath);
  const databaseUrl = parseOptionalDatabaseUrl(process.env.TASKSMITH_DATABASE_URL);
  const queue = parseQueueLeaseConfig(fileConfig?.queue);
  return {
    port: parsePort(process.env.PORT ?? "3000"),
    host: process.env.HOST ?? "0.0.0.0",
    dataDir,
    runsDir: path.join(dataDir, "runs"),
    stateDir: path.join(dataDir, "state"),
    piAuthSourceDir: path.resolve(process.env.TASKSMITH_PI_AUTH_SOURCE ?? "/run/tasksmith/pi-auth"),
    publicDir: path.join(repoRoot, "dist", "web"),
    publicBaseUrl: parsePublicBaseUrl(process.env.TASKSMITH_PUBLIC_URL, process.env.HOST ?? "0.0.0.0", process.env.PORT ?? "3000"),
    ...(databaseUrl ? { databaseUrl } : {}),
    auth: parseAuthConfig(databaseUrl, process.env.HOST ?? "0.0.0.0", process.env.PORT ?? "3000"),
    ...(configFilePath ? { configFilePath } : {}),
    repositories: fileConfig?.repos ?? {},
    sourceFlow: fileConfig?.sourceFlow ?? defaultSourceFlow(),
    githubWebhooks: parseGitHubWebhookConfig(),
    jiraWebhooks: parseJiraWebhookConfig(),
    qualityAudit: parseQualityAuditConfig(dataDir),
    workflow: fileConfig?.workflow ?? defaultWorkflow(),
    verification: parseVerificationConfig(fileConfig?.defaultVerify),
    queue,
  };
}

function parseGitHubWebhookConfig(): AppConfig["githubWebhooks"] {
  const enabled = parseBooleanEnv(process.env[["TASKSMITH", "GITHUB", "WEBHOOK", "ENABLED"].join("_")]);
  if (!enabled) return { enabled: false };
  const signingKey = process.env[["TASKSMITH", "GITHUB", "WEBHOOK", "SECRET"].join("_")]?.trim();
  if (!signingKey || Buffer.byteLength(signingKey, "utf8") < 16) throw new Error("GitHub webhook signing key must be at least 16 bytes when enabled");
  return { enabled: true, signingKey };
}

function parseJiraWebhookConfig(): AppConfig["jiraWebhooks"] {
  const enabled = parseBooleanEnv(process.env[["TASKSMITH", "JIRA", "WEBHOOK", "ENABLED"].join("_")]);
  if (!enabled) return { enabled: false };
  const signingKey = process.env[["TASKSMITH", "JIRA", "WEBHOOK", "SECRET"].join("_")]?.trim();
  if (!signingKey || Buffer.byteLength(signingKey, "utf8") < 16) throw new Error("Jira webhook signing key must be at least 16 bytes when enabled");
  return { enabled: true, signingKey };
}

function parseQualityAuditConfig(dataDir: string): AppConfig["qualityAudit"] {
  const enabled = parseBooleanEnv(process.env.TASKSMITH_QUALITY_AUDIT_ENABLED);
  if (!enabled) return { enabled: false };
  const signingKey = process.env.TASKSMITH_QUALITY_WEBHOOK_SECRET?.trim();
  if (!signingKey || Buffer.byteLength(signingKey, "utf8") < 16) {
    throw new Error(
      "Quality audit webhook signing key must be at least 16 bytes when enabled",
    );
  }
  const repository = process.env.TASKSMITH_QUALITY_GITHUB_REPOSITORY?.trim();
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(
      "TASKSMITH_QUALITY_GITHUB_REPOSITORY must be owner/repository",
    );
  }
  const ghConfigDir = process.env.TASKSMITH_QUALITY_GH_CONFIG_DIR?.trim();
  if (!ghConfigDir) {
    throw new Error(
      "TASKSMITH_QUALITY_GH_CONFIG_DIR is required when quality audits are enabled",
    );
  }
  const reportsPublicUrl =
    process.env.TASKSMITH_QUALITY_REPORTS_PUBLIC_URL?.trim();
  if (!reportsPublicUrl) {
    throw new Error(
      "TASKSMITH_QUALITY_REPORTS_PUBLIC_URL is required when quality audits are enabled",
    );
  }
  const slackBotToken = process.env.SLACK_BOT_TOKEN?.trim();
  if (!slackBotToken) {
    throw new Error(
      "SLACK_BOT_TOKEN is required when quality audits are enabled",
    );
  }
  const slackChannelId =
    process.env.SLACK_QUALITY_CHANNEL_ID?.trim() ||
    process.env.SLACK_RELEASE_CHANNEL_ID?.trim();
  if (!slackChannelId) {
    throw new Error(
      "SLACK_QUALITY_CHANNEL_ID or SLACK_RELEASE_CHANNEL_ID is required when quality audits are enabled",
    );
  }
  return {
    enabled: true,
    signingKey,
    repository,
    allowedRef:
      process.env.TASKSMITH_QUALITY_ALLOWED_REF?.trim() || "refs/heads/main",
    ghCommand: process.env.TASKSMITH_QUALITY_GH_COMMAND?.trim() || "gh",
    ghConfigDir: path.resolve(ghConfigDir),
    reportsDir: path.resolve(
      process.env.TASKSMITH_QUALITY_REPORTS_DIR ||
        path.join(dataDir, "quality-reports"),
    ),
    reportsPublicUrl: parseHttpBaseUrl(
      reportsPublicUrl,
      "TASKSMITH_QUALITY_REPORTS_PUBLIC_URL",
    ),
    slackBotToken,
    slackChannelId,
    slackApiUrl:
      process.env.TASKSMITH_SLACK_API_URL?.trim() ||
      "https://slack.com/api/chat.postMessage",
    notifyOnClean: parseBooleanEnv(
      process.env.TASKSMITH_QUALITY_NOTIFY_ON_CLEAN,
    ),
  };
}

function parseQueueLeaseConfig(fileQueue?: Pick<QueueLeaseConfig, "maxActiveRuns" | "maxActiveRunsPerRepo">): AppConfig["queue"] {
  const leaseTimeoutMs = parsePositiveInteger(process.env.TASKSMITH_QUEUE_LEASE_TIMEOUT_MS, 120_000, "TASKSMITH_QUEUE_LEASE_TIMEOUT_MS");
  const heartbeatIntervalMs = parsePositiveInteger(process.env.TASKSMITH_QUEUE_HEARTBEAT_INTERVAL_MS, 30_000, "TASKSMITH_QUEUE_HEARTBEAT_INTERVAL_MS");
  if (heartbeatIntervalMs >= leaseTimeoutMs) throw new Error("TASKSMITH_QUEUE_HEARTBEAT_INTERVAL_MS must be less than TASKSMITH_QUEUE_LEASE_TIMEOUT_MS");
  const maxActiveRuns = parseOptionalPositiveInteger(process.env.TASKSMITH_QUEUE_MAX_ACTIVE_RUNS, fileQueue?.maxActiveRuns, "TASKSMITH_QUEUE_MAX_ACTIVE_RUNS");
  const maxActiveRunsPerRepo = parseOptionalPositiveInteger(process.env.TASKSMITH_QUEUE_MAX_ACTIVE_RUNS_PER_REPO, fileQueue?.maxActiveRunsPerRepo, "TASKSMITH_QUEUE_MAX_ACTIVE_RUNS_PER_REPO");
  return {
    leaseTimeoutMs,
    heartbeatIntervalMs,
    ...(maxActiveRuns === undefined ? {} : { maxActiveRuns }),
    ...(maxActiveRunsPerRepo === undefined ? {} : { maxActiveRunsPerRepo }),
  };
}

function parseOptionalPositiveInteger(raw: string | undefined, fallback: number | undefined, label: string): number | undefined {
  if (raw === undefined || raw.trim() === "") return fallback;
  return parsePositiveInteger(raw, 1, label);
}

function parsePositiveInteger(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function parseVerificationConfig(fileDefault: VerificationCommandConfig[] | undefined): VerificationConfig {
  return { defaultCommands: parseDefaultVerificationCommands(fileDefault) };
}

function parseDefaultVerificationCommands(fileDefault: VerificationCommandConfig[] | undefined): VerificationCommandConfig[] {
  const raw = process.env.TASKSMITH_VERIFICATION_COMMANDS;
  if (raw?.trim()) return parseVerificationCommandArray(JSON.parse(raw) as unknown, "TASKSMITH_VERIFICATION_COMMANDS");
  return fileDefault ?? [defaultWorkspaceSmokeCommand()];
}

function parseConfigFile(configFilePath: string | undefined): ParsedConfigFile | undefined {
  if (!configFilePath) return undefined;
  const parsed = JSON.parse(readFileSync(configFilePath, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("TaskSmith config file must contain a JSON object");
  }
  return parseConfigObject(parsed);
}

export function getConfigFilePath(): string | undefined {
  const configPath = process.env.TASKSMITH_CONFIG_PATH ?? process.env.TASKSMITH_REPO_CONFIG_PATH;
  if (!configPath?.trim()) return undefined;
  return path.resolve(configPath);
}

export function parseConfigObject(parsed: unknown): ParsedConfigFile {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("TaskSmith config file must contain a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const repos = parseRepositoryConfigs(record.repos);
  const sourceFlow = record.sourceFlow === undefined ? undefined : parseSourceFlow(record.sourceFlow, "sourceFlow");
  const workflow = record.workflow === undefined ? undefined : parseWorkflow(record.workflow, "workflow");
  const queue = record.queue === undefined ? undefined : parseQueueConfig(record.queue, "queue");
  return {
    repos,
    ...(record.defaultVerify === undefined ? {} : { defaultVerify: parseVerificationCommandArray(record.defaultVerify, "defaultVerify") }),
    ...(sourceFlow === undefined ? {} : { sourceFlow }),
    ...(workflow === undefined ? {} : { workflow }),
    ...(queue === undefined ? {} : { queue }),
  };
}

export async function readEditableConfig(config: AppConfig): Promise<EditableConfigResponse> {
  if (!config.configFilePath) {
    return { writable: false, config: configToEditableObject(config) };
  }
  const text = await readFile(config.configFilePath, "utf8");
  return { path: config.configFilePath, writable: true, config: JSON.parse(text) as unknown };
}

export async function saveEditableConfig(config: AppConfig, value: unknown): Promise<EditableConfigResponse> {
  if (!config.configFilePath) throw new Error("TASKSMITH_CONFIG_PATH is required before config can be saved from the UI");
  const parsed = parseConfigObject(value);
  await mkdir(path.dirname(config.configFilePath), { recursive: true });
  await writeFile(config.configFilePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  applyParsedConfig(config, parsed);
  return { path: config.configFilePath, writable: true, config: value };
}

function applyParsedConfig(config: AppConfig, parsed: ParsedConfigFile): void {
  for (const key of Object.keys(config.repositories)) delete config.repositories[key];
  Object.assign(config.repositories, parsed.repos);
  config.sourceFlow = parsed.sourceFlow ?? defaultSourceFlow();
  config.workflow = parsed.workflow ?? defaultWorkflow();
  config.verification.defaultCommands = parseDefaultVerificationCommands(parsed.defaultVerify);
  config.queue = parseQueueLeaseConfig(parsed.queue);
}

function configToEditableObject(config: AppConfig): ParsedConfigFile {
  return {
    sourceFlow: config.sourceFlow,
    workflow: config.workflow,
    defaultVerify: config.verification.defaultCommands,
    queue: pickEditableQueueConfig(config.queue),
    repos: config.repositories,
  };
}

function pickEditableQueueConfig(queue: QueueLeaseConfig): Pick<QueueLeaseConfig, "maxActiveRuns" | "maxActiveRunsPerRepo"> {
  return {
    ...(queue.maxActiveRuns === undefined ? {} : { maxActiveRuns: queue.maxActiveRuns }),
    ...(queue.maxActiveRunsPerRepo === undefined ? {} : { maxActiveRunsPerRepo: queue.maxActiveRunsPerRepo }),
  };
}

function parseQueueConfig(value: unknown, label: string): Pick<QueueLeaseConfig, "maxActiveRuns" | "maxActiveRunsPerRepo"> {
  const record = expectRecord(value, label);
  return {
    ...(record.maxActiveRuns === undefined ? {} : { maxActiveRuns: parsePositiveIntegerValue(record.maxActiveRuns, `${label}.maxActiveRuns`) }),
    ...(record.maxActiveRunsPerRepo === undefined ? {} : { maxActiveRunsPerRepo: parsePositiveIntegerValue(record.maxActiveRunsPerRepo, `${label}.maxActiveRunsPerRepo`) }),
  };
}

function parsePositiveIntegerValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function parseRepositoryConfigs(value: unknown): Record<string, RepositoryConfig> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("repo config 'repos' must be an object");
  }
  const repos: Record<string, RepositoryConfig> = {};
  for (const [repoKey, repoValue] of Object.entries(value)) {
    if (!repoKey.trim()) throw new Error("repo config contains an empty repo key");
    repos[repoKey] = parseRepositoryConfig(repoValue, `repos.${repoKey}`);
  }
  return repos;
}

function parseRepositoryConfig(value: unknown, label: string): RepositoryConfig {
  const record = expectRecord(value, label);
  const config: RepositoryConfig = {};
  assignOptionalString(config, "displayName", record.displayName, `${label}.displayName`, 160);
  assignOptionalString(config, "gitUrl", record.gitUrl, `${label}.gitUrl`, 2_000);
  assignOptionalString(config, "defaultBranch", record.defaultBranch, `${label}.defaultBranch`, 160);
  assignOptionalString(config, "gitSshCommand", record.gitSshCommand, `${label}.gitSshCommand`, 2_000);
  if (record.cloneDepth !== undefined) config.cloneDepth = parseCloneDepth(record.cloneDepth, `${label}.cloneDepth`);
  if (record.checkout !== undefined) config.checkout = parseRepositoryCheckout(record.checkout, `${label}.checkout`);
  if (record.gitProvider !== undefined) config.gitProvider = parseGitProvider(record.gitProvider, `${label}.gitProvider`);
  if (record.issueProvider !== undefined) config.issueProvider = parseIssueProvider(record.issueProvider, `${label}.issueProvider`);
  if (record.runtimeAdapter !== undefined) config.runtimeAdapter = parseRuntimeAdapter(record.runtimeAdapter, `${label}.runtimeAdapter`);
  if (record.initCommands !== undefined) config.initCommands = parseVerificationCommandArray(record.initCommands, `${label}.initCommands`);
  if (record.verify !== undefined) config.verify = parseVerificationCommandArray(record.verify, `${label}.verify`);
  if (record.workflow !== undefined) config.workflow = parseWorkflow(record.workflow, `${label}.workflow`);
  if (record.codeRabbit !== undefined) config.codeRabbit = parseCodeRabbitConfig(record.codeRabbit, `${label}.codeRabbit`);
  return config;
}

function parseRepositoryCheckout(value: unknown, label: string): NonNullable<RepositoryConfig["checkout"]> {
  const record = expectRecord(value, label);
  const mode = record.mode === undefined ? "clone" : parseRequiredString(record.mode, `${label}.mode`, 40);
  if (mode !== "clone" && mode !== "worktree") throw new Error(`${label}.mode must be 'clone' or 'worktree'`);
  const modeLit: "clone" | "worktree" = mode === "clone" ? "clone" : "worktree";
  return {
    mode: modeLit,
    ...(record.cacheDir === undefined ? {} : { cacheDir: path.resolve(parseRequiredString(record.cacheDir, `${label}.cacheDir`, 2_000)) }),
  };
}

function parseSourceFlow(value: unknown, label: string): SourceFlowConfig {
  const record = expectRecord(value, label);
  return {
    readinessLabel: record.readinessLabel === undefined ? "tasksmith" : parseRequiredString(record.readinessLabel, `${label}.readinessLabel`, 80),
    pollIntervalSeconds: record.pollIntervalSeconds === undefined ? 60 : parsePollInterval(record.pollIntervalSeconds, `${label}.pollIntervalSeconds`),
    jiraRepoRouting: parseJiraRepoRouting(record.jiraRepoRouting, `${label}.jiraRepoRouting`),
  };
}

function parseJiraRepoRouting(value: unknown, label: string): SourceFlowConfig["jiraRepoRouting"] {
  if (value === undefined) return { strategy: "label", labels: {} };
  const record = expectRecord(value, label);
  const strategy = record.strategy === undefined ? "label" : parseRequiredString(record.strategy, `${label}.strategy`, 40);
  if (strategy !== "label") throw new Error(`${label}.strategy must be 'label'`);
  return { strategy: "label", labels: parseLabelRouteMap(record.labels, `${label}.labels`) };
}

function parseLabelRouteMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  const record = expectRecord(value, label);
  const result: Record<string, string> = {};
  for (const [jiraLabel, repoKey] of Object.entries(record)) {
    if (!jiraLabel.trim()) throw new Error(`${label} contains an empty label`);
    result[jiraLabel] = parseRequiredString(repoKey, `${label}.${jiraLabel}`, 160);
  }
  return result;
}

function parseWorkflow(value: unknown, label: string): SingleTaskWorkflowConfig {
  const record = expectRecord(value, label);
  const type = record.type === undefined ? "single_task_sandcastle" : parseRequiredString(record.type, `${label}.type`, 80);
  if (type !== "single_task_sandcastle") throw new Error(`${label}.type must be 'single_task_sandcastle'`);
  const workflow: SingleTaskWorkflowConfig = {
    type: "single_task_sandcastle",
    stages: parseWorkflowStages(record.stages, `${label}.stages`),
    maxFixAttempts: record.maxFixAttempts === undefined ? 1 : parseFixAttempts(record.maxFixAttempts, `${label}.maxFixAttempts`),
    maxCiFixAttempts: record.maxCiFixAttempts === undefined ? 1 : parseFixAttempts(record.maxCiFixAttempts, `${label}.maxCiFixAttempts`),
    maxReviewFixAttempts: record.maxReviewFixAttempts === undefined ? 1 : parseFixAttempts(record.maxReviewFixAttempts, `${label}.maxReviewFixAttempts`),
    ciPollIntervalMs: record.ciPollIntervalMs === undefined ? 30_000 : parseCiPollInterval(record.ciPollIntervalMs, `${label}.ciPollIntervalMs`),
    ciTimeoutMs: record.ciTimeoutMs === undefined ? 900_000 : parseCiTimeout(record.ciTimeoutMs, `${label}.ciTimeoutMs`),
    deliveryMode: record.deliveryMode === undefined ? "ready_pr" : parseDeliveryMode(record.deliveryMode, `${label}.deliveryMode`),
  };
  assignOptionalString(workflow, "mergeTargetBranch", record.mergeTargetBranch, `${label}.mergeTargetBranch`, 160);
  return workflow;
}

function parseWorkflowStages(value: unknown, label: string): SingleTaskWorkflowConfig["stages"] {
  const defaultStages: SingleTaskWorkflowConfig["stages"] = ["plan", "implement", "deep_review", "fix", "deliver"];
  if (value === undefined) return defaultStages;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const expected = defaultStages;
  if (value.length !== expected.length || value.some((stage, index) => stage !== expected[index])) {
    throw new Error(`${label} must be exactly ${JSON.stringify(expected)}`);
  }
  return defaultStages;
}

function parseDeliveryMode(value: unknown, label: string): "ready_pr" | "squash_merge_main" {
  if (value === "ready_pr" || value === "squash_merge_main") return value;
  if (value === "draft_pr") return "ready_pr";
  throw new Error(`${label} must be 'ready_pr' or 'squash_merge_main'`);
}

function parseCodeRabbitConfig(value: unknown, label: string): CodeRabbitConfig {
  const record = expectRecord(value, label);
  const enabled = record.enabled === undefined ? true : parseBoolean(record.enabled, `${label}.enabled`);
  return {
    enabled,
    cli: parseCodeRabbitCliConfig(record.cli, enabled, `${label}.cli`),
  };
}

function parseCodeRabbitCliConfig(value: unknown, defaultEnabled: boolean, label: string): CodeRabbitConfig["cli"] {
  if (value === undefined) {
    return { enabled: defaultEnabled, command: "cr", timeoutMs: 1_800_000 };
  }
  const record = expectRecord(value, label);
  return {
    enabled: record.enabled === undefined ? defaultEnabled : parseBoolean(record.enabled, `${label}.enabled`),
    command: record.command === undefined ? "cr" : parseRequiredString(record.command, `${label}.command`, 200),
    timeoutMs: record.timeoutMs === undefined ? 1_800_000 : parseTimeout(record.timeoutMs, `${label}.timeoutMs`),
  };
}

function defaultSourceFlow(): SourceFlowConfig {
  return {
    readinessLabel: "tasksmith",
    pollIntervalSeconds: 60,
    jiraRepoRouting: { strategy: "label", labels: {} },
  };
}

function defaultWorkflow(): SingleTaskWorkflowConfig {
  return {
    type: "single_task_sandcastle",
    stages: ["plan", "implement", "deep_review", "fix", "deliver"],
    maxFixAttempts: 1,
    maxCiFixAttempts: 1,
    maxReviewFixAttempts: 1,
    ciPollIntervalMs: 30_000,
    ciTimeoutMs: 900_000,
    deliveryMode: "ready_pr",
  };
}

function parseGitProvider(value: unknown, label: string): GitHubProviderConfig {
  const record = expectRecord(value, label);
  const type = parseRequiredString(record.type, `${label}.type`, 40);
  if (type !== "github") throw new Error(`${label}.type must be 'github'`);
  const config: GitHubProviderConfig = {
    type: "github",
    owner: parseRequiredString(record.owner, `${label}.owner`, 160),
    repo: parseRequiredString(record.repo, `${label}.repo`, 160),
  };
  assignOptionalString(config, "ghConfigDir", record.ghConfigDir, `${label}.ghConfigDir`, 2_000);
  return config;
}

function parseIssueProvider(value: unknown, label: string): IssueProviderConfig {
  const record = expectRecord(value, label);
  const type = parseRequiredString(record.type, `${label}.type`, 40);
  if (type === "github_issues") {
    const config: IssueProviderConfig = { type };
    if (record.labels !== undefined) config.labels = parseStringArray(record.labels, `${label}.labels`, 80);
    if (record.state !== undefined) config.state = parseIssueState(record.state, `${label}.state`);
    return config;
  }
  if (type === "jira") {
    const config: IssueProviderConfig = { type };
    assignOptionalString(config, "projectKey", record.projectKey, `${label}.projectKey`, 80);
    assignOptionalString(config, "jql", record.jql, `${label}.jql`, 2_000);
    assignOptionalString(config, "repoLabel", record.repoLabel, `${label}.repoLabel`, 160);
    return config;
  }
  throw new Error(`${label}.type must be 'github_issues' or 'jira'`);
}

function parseRuntimeAdapter(value: unknown, label: string): "pi" | "demo" {
  if (value === "pi" || value === "demo") return value;
  throw new Error(`${label} must be 'pi' or 'demo'`);
}

function parseVerificationCommandArray(value: unknown, label: string): VerificationCommandConfig[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a JSON array`);
  return value.map((entry, index) => parseVerificationCommand(entry, `${label}[${index}]`));
}

function parseVerificationCommand(value: unknown, label: string): VerificationCommandConfig {
  const record = expectRecord(value, label);
  const name = parseRequiredString(record.name, `${label}.name`, 80);
  const command = parseRequiredString(record.command, `${label}.command`, 4_000);
  const timeoutMs = record.timeoutMs === undefined ? 120_000 : parseTimeout(record.timeoutMs, `${label}.timeoutMs`);
  return { name, command, timeoutMs };
}

function defaultWorkspaceSmokeCommand(): VerificationCommandConfig {
  const script = "const fs=require('fs'); if (!fs.existsSync('README.md')) { console.error('README.md missing'); process.exit(1); } console.log('workspace smoke ok');";
  return {
    name: "workspace-smoke",
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
    timeoutMs: 30_000,
  };
}

function parseStringArray(value: unknown, label: string, maxBytes: number): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => parseRequiredString(entry, `${label}[${index}]`, maxBytes));
}

function parseIssueState(value: unknown, label: string): "open" | "closed" | "all" {
  if (value === "open" || value === "closed" || value === "all") return value;
  throw new Error(`${label} must be 'open', 'closed', or 'all'`);
}

function parseBoolean(value: unknown, label: string): boolean {
  if (typeof value === "boolean") return value;
  throw new Error(`${label} must be a boolean`);
}

function parseRequiredString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  if (Buffer.byteLength(trimmed, "utf8") > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  return trimmed;
}

function assignOptionalString<T extends object, K extends keyof T & string>(target: T, key: K, value: unknown, label: string, maxBytes: number): void {
  if (value === undefined) return;
  target[key] = parseRequiredString(value, label, maxBytes) as T[K];
}

function parsePollInterval(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 5 || value > 86_400) {
    throw new Error(`${label} must be an integer between 5 and 86400`);
  }
  return value;
}

function parseFixAttempts(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10) {
    throw new Error(`${label} must be an integer between 0 and 10`);
  }
  return value;
}

function parseCloneDepth(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 10_000) {
    throw new Error(`${label} must be an integer between 1 and 10000`);
  }
  return value;
}

function parseTimeout(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 3_600_000) {
    throw new Error(`${label} must be an integer between 1 and 3600000`);
  }
  return value;
}

function parseCiPollInterval(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 250 || value > 300_000) {
    throw new Error(`${label} must be an integer between 250 and 300000`);
  }
  return value;
}

function parseCiTimeout(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1_000 || value > 86_400_000) {
    throw new Error(`${label} must be an integer between 1000 and 86400000`);
  }
  return value;
}

function parseAuthConfig(databaseUrl: string | undefined, host: string, port: string): AppConfig["auth"] {
  const enabled = parseBooleanEnv(process.env.TASKSMITH_AUTH_ENABLED);
  const secret = (process.env.TASKSMITH_AUTH_SECRET ?? process.env.BETTER_AUTH_SECRET)?.trim();
  const baseUrl = (process.env.BETTER_AUTH_URL ?? process.env.TASKSMITH_AUTH_URL)?.trim()
    || parsePublicBaseUrl(process.env.TASKSMITH_PUBLIC_URL, host, port);
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const trustedOrigins = parseTrustedOrigins(baseUrl, process.env.TASKSMITH_AUTH_TRUSTED_ORIGINS, host, port);
  if (enabled) {
    if (!databaseUrl) throw new Error("TASKSMITH_DATABASE_URL is required when TASKSMITH_AUTH_ENABLED=1");
    if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
      throw new Error("TASKSMITH_AUTH_SECRET or BETTER_AUTH_SECRET must be at least 32 bytes when TASKSMITH_AUTH_ENABLED=1");
    }
    return {
      enabled: true,
      secret,
      baseUrl: normalizedBaseUrl,
      trustedOrigins,
    };
  }
  return {
    enabled: false,
    baseUrl: normalizedBaseUrl,
    trustedOrigins,
  };
}

function parseBooleanEnv(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}

function parseTrustedOrigins(baseUrl: string, raw: string | undefined, host: string, port: string): string[] {
  const origins = new Set<string>();
  origins.add(originOf(baseUrl));
  origins.add(originOf(parsePublicBaseUrl(undefined, host, port)));
  origins.add(originOf(parsePublicBaseUrl(undefined, "localhost", port)));
  for (const entry of raw?.split(/[\s,]+/) ?? []) {
    const trimmed = entry.trim().replace(/\/$/, "");
    if (trimmed) origins.add(trimmed);
  }
  return [...origins];
}

function originOf(value: string): string {
  return new URL(value).origin;
}

function parseOptionalDatabaseUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("TASKSMITH_DATABASE_URL must use postgres:// or postgresql://");
  }
  return parsed.toString();
}

function parsePublicBaseUrl(value: string | undefined, host: string, port: string): string {
  if (value?.trim()) return value.trim().replace(/\/$/, "");
  const resolvedHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `http://${resolvedHost}:${port}`;
}

function parseHttpBaseUrl(value: string, label: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http:// or https://`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`Invalid PORT: ${value}`);
  return port;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
