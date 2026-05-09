import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AppConfig,
  GitHubProviderConfig,
  IssueProviderConfig,
  RepositoryConfig,
  SingleTaskWorkflowConfig,
  SourceFlowConfig,
  VerificationCommandConfig,
  VerificationConfig,
} from "../domain/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

interface ParsedConfigFile {
  defaultVerify?: VerificationCommandConfig[];
  repos: Record<string, RepositoryConfig>;
  sourceFlow?: SourceFlowConfig;
  workflow?: SingleTaskWorkflowConfig;
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
  return {
    port: parsePort(process.env.PORT ?? "3000"),
    host: process.env.HOST ?? "0.0.0.0",
    dataDir,
    runsDir: path.join(dataDir, "runs"),
    stateDir: path.join(dataDir, "state"),
    piAuthSourceDir: path.resolve(process.env.TASKSMITH_PI_AUTH_SOURCE ?? "/run/tasksmith/pi-auth"),
    publicDir: path.join(repoRoot, "src", "server", "public"),
    publicBaseUrl: parsePublicBaseUrl(process.env.TASKSMITH_PUBLIC_URL, process.env.HOST ?? "0.0.0.0", process.env.PORT ?? "3000"),
    ...(configFilePath ? { configFilePath } : {}),
    repositories: fileConfig?.repos ?? {},
    sourceFlow: fileConfig?.sourceFlow ?? defaultSourceFlow(),
    workflow: fileConfig?.workflow ?? defaultWorkflow(),
    verification: parseVerificationConfig(fileConfig?.defaultVerify),
  };
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
  return {
    repos,
    ...(record.defaultVerify === undefined ? {} : { defaultVerify: parseVerificationCommandArray(record.defaultVerify, "defaultVerify") }),
    ...(sourceFlow === undefined ? {} : { sourceFlow }),
    ...(workflow === undefined ? {} : { workflow }),
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
}

function configToEditableObject(config: AppConfig): ParsedConfigFile {
  return {
    sourceFlow: config.sourceFlow,
    workflow: config.workflow,
    defaultVerify: config.verification.defaultCommands,
    repos: config.repositories,
  };
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
  if (record.gitProvider !== undefined) config.gitProvider = parseGitProvider(record.gitProvider, `${label}.gitProvider`);
  if (record.issueProvider !== undefined) config.issueProvider = parseIssueProvider(record.issueProvider, `${label}.issueProvider`);
  if (record.runtimeAdapter !== undefined) config.runtimeAdapter = parseRuntimeAdapter(record.runtimeAdapter, `${label}.runtimeAdapter`);
  if (record.initCommands !== undefined) config.initCommands = parseVerificationCommandArray(record.initCommands, `${label}.initCommands`);
  if (record.verify !== undefined) config.verify = parseVerificationCommandArray(record.verify, `${label}.verify`);
  if (record.workflow !== undefined) config.workflow = parseWorkflow(record.workflow, `${label}.workflow`);
  return config;
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

function parsePublicBaseUrl(value: string | undefined, host: string, port: string): string {
  if (value?.trim()) return value.trim().replace(/\/$/, "");
  const resolvedHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `http://${resolvedHost}:${port}`;
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
