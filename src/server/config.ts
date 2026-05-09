import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AppConfig,
  GitHubProviderConfig,
  IssueProviderConfig,
  RepositoryConfig,
  VerificationCommandConfig,
  VerificationConfig,
} from "../domain/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

interface ParsedConfigFile {
  defaultVerify?: VerificationCommandConfig[];
  repos: Record<string, RepositoryConfig>;
}

export function loadConfig(): AppConfig {
  const dataDir = path.resolve(process.env.TASKSMITH_DATA_DIR ?? ".data/tasksmith");
  const fileConfig = parseConfigFile();
  return {
    port: parsePort(process.env.PORT ?? "3000"),
    host: process.env.HOST ?? "0.0.0.0",
    dataDir,
    runsDir: path.join(dataDir, "runs"),
    stateDir: path.join(dataDir, "state"),
    piAuthSourceDir: path.resolve(process.env.TASKSMITH_PI_AUTH_SOURCE ?? "/run/tasksmith/pi-auth"),
    publicDir: path.join(repoRoot, "src", "server", "public"),
    repositories: fileConfig?.repos ?? {},
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

function parseConfigFile(): ParsedConfigFile | undefined {
  const configPath = process.env.TASKSMITH_CONFIG_PATH ?? process.env.TASKSMITH_REPO_CONFIG_PATH;
  if (!configPath?.trim()) return undefined;
  const absolutePath = path.resolve(configPath);
  const parsed = JSON.parse(readFileSync(absolutePath, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("TaskSmith config file must contain a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const repos = parseRepositoryConfigs(record.repos);
  if (record.defaultVerify === undefined) return { repos };
  return { defaultVerify: parseVerificationCommandArray(record.defaultVerify, "defaultVerify"), repos };
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
  if (record.verify !== undefined) config.verify = parseVerificationCommandArray(record.verify, `${label}.verify`);
  return config;
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
