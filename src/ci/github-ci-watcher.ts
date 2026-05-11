import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type {
  GitHubProviderConfig,
  NormalizedRunEvent,
  PullRequestRecord,
  RepositoryConfig,
  RunRecord,
  SingleTaskWorkflowConfig,
} from "../domain/types.js";
import { redactForStorage } from "../domain/redaction.js";

type CiEmitter = (event: NormalizedRunEvent) => Promise<void>;

interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface GitHubCheck {
  name: string;
  bucket?: string;
  state?: string;
  conclusion?: string;
  link?: string;
  detailsUrl?: string;
}

export interface CiWatchResult {
  status: "passed" | "failed" | "skipped";
  summary: string;
  log?: string;
}

const OUTPUT_LIMIT = 120_000;

export class GitHubCiWatcher {
  constructor(
    private readonly repositories: Readonly<Record<string, RepositoryConfig>>,
    private readonly globalWorkflow: SingleTaskWorkflowConfig,
  ) {}

  async watchPullRequest(run: RunRecord, pullRequest: PullRequestRecord, emit: CiEmitter): Promise<CiWatchResult> {
    const repo = this.repositories[run.repoKey];
    const provider = repo?.gitProvider;
    if (!repo || !provider || provider.type !== "github") {
      const summary = "No GitHub provider configured for CI polling.";
      await emit({ type: "ci", provider: "github", status: "skipped", summary });
      return { status: "skipped", summary };
    }

    const prRef = pullRequest.number === undefined ? pullRequest.url : String(pullRequest.number);
    const workflow = repo.workflow ?? this.globalWorkflow;
    const deadline = Date.now() + workflow.ciTimeoutMs;
    let pollCount = 0;
    await emit({ type: "ci", provider: "github", status: "running", summary: `Polling GitHub CI checks for PR ${prRef}` });

    while (Date.now() <= deadline) {
      pollCount += 1;
      const checks = await listPullRequestChecks(provider, prRef);
      if (checks.length === 0) {
        const summary = "No GitHub checks found for this pull request.";
        await emit({ type: "ci", provider: "github", status: "skipped", summary, attempt: pollCount });
        return { status: "skipped", summary };
      }

      const failed = checks.filter((check) => checkState(check) === "failed");
      if (failed.length > 0) {
        const summary = `${failed.length} GitHub check(s) failed: ${failed.map((check) => check.name).join(", ")}`;
        const log = await fetchFailedLogs(provider, failed);
        const detailsUrl = firstDetailsUrl(failed);
        await emit({
          type: "ci",
          provider: "github",
          status: "failed",
          summary,
          attempt: pollCount,
          ...(detailsUrl ? { detailsUrl } : {}),
          ...(log ? { log } : {}),
        });
        return { status: "failed", summary, ...(log ? { log } : {}) };
      }

      const pending = checks.filter((check) => checkState(check) === "pending");
      if (pending.length === 0) {
        const summary = `${checks.length} GitHub check(s) passed.`;
        await emit({ type: "ci", provider: "github", status: "passed", summary, attempt: pollCount });
        return { status: "passed", summary };
      }

      await emit({
        type: "ci",
        provider: "github",
        status: "running",
        summary: `${pending.length} GitHub check(s) still pending: ${pending.map((check) => check.name).join(", ")}`,
        attempt: pollCount,
      });
      await delay(Math.min(workflow.ciPollIntervalMs, Math.max(250, deadline - Date.now())));
    }

    const summary = `Timed out after ${workflow.ciTimeoutMs}ms waiting for GitHub checks.`;
    await emit({ type: "ci", provider: "github", status: "failed", summary, attempt: pollCount });
    return { status: "failed", summary };
  }
}

async function listPullRequestChecks(provider: GitHubProviderConfig, prRef: string): Promise<GitHubCheck[]> {
  const result = await runGh([
    "pr",
    "checks",
    prRef,
    "--repo",
    `${provider.owner}/${provider.repo}`,
    "--json",
    "name,bucket,state,conclusion,link,detailsUrl",
  ], provider);
  const text = result.stdout.trim();
  if (!text) {
    if (result.code === 0) return [];
    throw new Error(`gh pr checks failed: ${summarizeCommandFailure(result)}`);
  }
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) throw new Error("gh pr checks did not return a JSON array");
  return parsed.map(parseCheck).filter((check) => check.name.length > 0);
}

function parseCheck(value: unknown): GitHubCheck {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { name: "unknown" };
  const record = value as Record<string, unknown>;
  const bucket = stringField(record.bucket);
  const state = stringField(record.state);
  const conclusion = stringField(record.conclusion);
  const link = stringField(record.link);
  const detailsUrl = stringField(record.detailsUrl);
  return {
    name: stringField(record.name) ?? "unknown",
    ...(bucket ? { bucket } : {}),
    ...(state ? { state } : {}),
    ...(conclusion ? { conclusion } : {}),
    ...(link ? { link } : {}),
    ...(detailsUrl ? { detailsUrl } : {}),
  };
}

function checkState(check: GitHubCheck): "passed" | "failed" | "pending" {
  const values = [check.bucket, check.state, check.conclusion].filter(Boolean).map((value) => value!.toLowerCase());
  if (values.some((value) => ["fail", "failure", "failed", "error", "cancelled", "canceled", "timed_out", "action_required"].includes(value))) return "failed";
  if (values.some((value) => ["pending", "queued", "in_progress", "waiting", "requested", "expected"].includes(value))) return "pending";
  return "passed";
}

async function fetchFailedLogs(provider: GitHubProviderConfig, failedChecks: readonly GitHubCheck[]): Promise<string | undefined> {
  const logs: string[] = [];
  for (const check of failedChecks.slice(0, 3)) {
    const runId = extractActionsRunId(check.detailsUrl ?? check.link ?? "");
    if (!runId) {
      logs.push(`${check.name}: failed; no GitHub Actions run id found (${check.detailsUrl ?? check.link ?? "no details URL"})`);
      continue;
    }
    const result = await runGh(["run", "view", runId, "--repo", `${provider.owner}/${provider.repo}`, "--log-failed"], provider);
    const output = formatCommandOutput(result);
    logs.push(`## ${check.name}\n${output}`);
  }
  const text = logs.join("\n\n").trim();
  return text ? appendCapped("", text) : undefined;
}

function firstDetailsUrl(checks: readonly GitHubCheck[]): string | undefined {
  for (const check of checks) {
    const url = check.detailsUrl ?? check.link;
    if (url) return url;
  }
  return undefined;
}

function extractActionsRunId(url: string): string | undefined {
  const match = /\/actions\/runs\/(\d+)/u.exec(url);
  return match?.[1];
}

async function runGh(args: readonly string[], provider: GitHubProviderConfig): Promise<CommandResult> {
  return runCommand("gh", args, process.cwd(), commandEnv(provider));
}

function runCommand(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      stderr = appendCapped(stderr, `${error.message}\n`);
    });
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function commandEnv(provider: GitHubProviderConfig): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    GIT_TERMINAL_PROMPT: "0",
    ...(provider.ghConfigDir ? { GH_CONFIG_DIR: provider.ghConfigDir } : {}),
  };
}

function formatCommandOutput(result: CommandResult): string {
  const chunks = [result.stdout, result.stderr].filter((value) => value.trim().length > 0);
  const text = chunks.length > 0 ? chunks.join("\n") : `exited with ${result.code ?? result.signal ?? "unknown"}`;
  return redactForStorage(text);
}

function summarizeCommandFailure(result: CommandResult): string {
  return redactForStorage(result.stderr.trim() || result.stdout.trim() || String(result.code ?? result.signal ?? "unknown"))
    .split("\n")
    .slice(0, 3)
    .join(" ");
}

function appendCapped(current: string, next: string): string {
  const merged = current + next;
  if (Buffer.byteLength(merged, "utf8") <= OUTPUT_LIMIT) return merged;
  return `${merged.slice(-OUTPUT_LIMIT)}\n[TaskSmith truncated CI output]\n`;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
