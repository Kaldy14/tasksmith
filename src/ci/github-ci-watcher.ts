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

interface CiWatchOptions {
  signal?: AbortSignal;
}

interface CommandOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

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

interface CodeRabbitReviewFeedback {
  summary: string;
  prompt: string;
  url?: string;
}

export interface CiWatchResult {
  status: "passed" | "failed" | "skipped";
  summary: string;
  log?: string;
}

const OUTPUT_LIMIT = 120_000;
const FORCE_KILL_GRACE_MS = 2_000;

export class GitHubCiWatcher {
  constructor(
    private readonly repositories: Readonly<Record<string, RepositoryConfig>>,
    private readonly globalWorkflow: SingleTaskWorkflowConfig,
  ) {}

  async watchPullRequest(run: RunRecord, pullRequest: PullRequestRecord, emit: CiEmitter, options: CiWatchOptions = {}): Promise<CiWatchResult> {
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
      assertNotAborted(options.signal);
      let checks: GitHubCheck[];
      try {
        checks = await listPullRequestChecks(provider, prRef, commandOptionsForDeadline(deadline, options.signal));
      } catch (error: unknown) {
        const summary = `GitHub CI polling failed: ${error instanceof Error ? error.message : String(error)}`;
        await emit({ type: "ci", provider: "github", status: "failed", summary, attempt: pollCount });
        return { status: "failed", summary };
      }
      if (checks.length === 0) {
        const summary = "No GitHub checks found for this pull request.";
        await emit({ type: "ci", provider: "github", status: "skipped", summary, attempt: pollCount });
        return { status: "skipped", summary };
      }

      const failed = checks.filter((check) => checkState(check) === "failed");
      if (failed.length > 0) {
        const summary = `${failed.length} GitHub check(s) failed: ${failed.map((check) => check.name).join(", ")}`;
        const log = await fetchFailedLogs(provider, failed, commandOptionsForDeadline(deadline, options.signal));
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
        const codeRabbitFeedback = await findCodeRabbitReviewFeedback(provider, pullRequest, commandOptionsForDeadline(deadline, options.signal));
        if (codeRabbitFeedback) {
          await emit({
            type: "ci",
            provider: "github",
            status: "failed",
            summary: codeRabbitFeedback.summary,
            attempt: pollCount,
            ...(codeRabbitFeedback.url ? { detailsUrl: codeRabbitFeedback.url } : {}),
            log: codeRabbitFeedback.prompt,
          });
          return { status: "failed", summary: codeRabbitFeedback.summary, log: codeRabbitFeedback.prompt };
        }
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
      await waitForNextPoll(Math.min(workflow.ciPollIntervalMs, Math.max(250, deadline - Date.now())), options.signal);
    }

    const summary = `Timed out after ${workflow.ciTimeoutMs}ms waiting for GitHub checks.`;
    await emit({ type: "ci", provider: "github", status: "failed", summary, attempt: pollCount });
    return { status: "failed", summary };
  }
}

async function listPullRequestChecks(provider: GitHubProviderConfig, prRef: string, options: CommandOptions): Promise<GitHubCheck[]> {
  const result = await runGh([
    "pr",
    "checks",
    prRef,
    "--repo",
    `${provider.owner}/${provider.repo}`,
    "--json",
    "name,bucket,state,link",
  ], provider, options);
  const text = result.stdout.trim();
  if (!text) {
    if (result.code === 0) return [];
    throw new Error(`gh pr checks failed: ${summarizeCommandFailure(result)}`);
  }
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) throw new Error("gh pr checks did not return a JSON array");
  return parsed.map(parseCheck).filter((check) => check.name.length > 0);
}

async function findCodeRabbitReviewFeedback(provider: GitHubProviderConfig, pullRequest: PullRequestRecord, options: CommandOptions): Promise<CodeRabbitReviewFeedback | undefined> {
  if (pullRequest.number === undefined) return undefined;
  const pr = await readPullRequest(provider, pullRequest.number, options);
  const headSha = readNestedString(pr, "head", "sha");
  if (!headSha) return undefined;
  const reviews = await readPullRequestReviews(provider, pullRequest.number, options);
  const currentHeadReviews = reviews.filter((review) => {
    const login = readNestedString(review, "user", "login")?.toLowerCase() ?? "";
    return login.includes("coderabbit") && stringField(review.commit_id) === headSha;
  });
  const latestActionable = currentHeadReviews.reverse().find((review) => extractCodeRabbitPrompt(stringField(review.body) ?? "") !== undefined);
  if (!latestActionable) return undefined;
  const body = stringField(latestActionable.body) ?? "";
  const prompt = extractCodeRabbitPrompt(body) ?? body.trim();
  return {
    summary: "CodeRabbit review left actionable comments on the current PR head.",
    prompt: appendCapped("", prompt),
    ...(stringField(latestActionable.html_url) ? { url: stringField(latestActionable.html_url)! } : {}),
  };
}

async function readPullRequest(provider: GitHubProviderConfig, pullRequestNumber: number, options: CommandOptions): Promise<Record<string, unknown>> {
  const result = await runGh(["api", `repos/${provider.owner}/${provider.repo}/pulls/${pullRequestNumber}`], provider, options);
  if (result.code !== 0) throw new Error(`gh api pull request failed: ${summarizeCommandFailure(result)}`);
  const parsed = JSON.parse(result.stdout.trim()) as unknown;
  if (!isRecord(parsed)) throw new Error("gh api pull request did not return an object");
  return parsed;
}

async function readPullRequestReviews(provider: GitHubProviderConfig, pullRequestNumber: number, options: CommandOptions): Promise<Record<string, unknown>[]> {
  const result = await runGh(["api", `repos/${provider.owner}/${provider.repo}/pulls/${pullRequestNumber}/reviews`], provider, options);
  if (result.code !== 0) throw new Error(`gh api pull request reviews failed: ${summarizeCommandFailure(result)}`);
  const parsed = JSON.parse(result.stdout.trim()) as unknown;
  if (!Array.isArray(parsed)) throw new Error("gh api pull request reviews did not return an array");
  return parsed.filter(isRecord);
}

function extractCodeRabbitPrompt(body: string): string | undefined {
  if (!hasActionableCodeRabbitFeedback(body)) return undefined;
  const promptSection = /Prompt for all review comments with AI agents[\s\S]*?```(?<prompt>[\s\S]*?)```/iu.exec(body)?.groups?.prompt?.trim();
  if (promptSection) return `${promptSection}\n\nVerify each finding against current code. Fix only still-valid, relevant issues. If a comment is stale, cosmetic-only, or not worth changing, skip it with a brief reason.`;
  const compact = body.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
  return compact ? `${compact.slice(0, 8_000)}\n\nVerify each finding against current code. Fix only still-valid, relevant issues. Skip stale or cosmetic-only comments with a brief reason.` : undefined;
}

function hasActionableCodeRabbitFeedback(body: string): boolean {
  const hasActionableSection = /(?:Actionable comments|Potential issues|Potential issue|Bug risk|Security concern|High confidence comments|Review comments \([1-9]\d*\))/iu.test(body);
  if (hasActionableSection) return true;
  const hasNitpickOnly = /Nitpick comments/iu.test(body) && !hasActionableSection;
  if (hasNitpickOnly) return false;
  return false;
}

function readNestedString(record: Record<string, unknown>, key: string, nestedKey: string): string | undefined {
  const child = record[key];
  if (!isRecord(child)) return undefined;
  return stringField(child[nestedKey]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

async function fetchFailedLogs(provider: GitHubProviderConfig, failedChecks: readonly GitHubCheck[], options: CommandOptions): Promise<string | undefined> {
  const logs: string[] = [];
  for (const check of failedChecks.slice(0, 3)) {
    const runId = extractActionsRunId(check.detailsUrl ?? check.link ?? "");
    if (!runId) {
      logs.push(`${check.name}: failed; no GitHub Actions run id found (${check.detailsUrl ?? check.link ?? "no details URL"})`);
      continue;
    }
    const result = await runGh(["run", "view", runId, "--repo", `${provider.owner}/${provider.repo}`, "--log-failed"], provider, options);
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

async function runGh(args: readonly string[], provider: GitHubProviderConfig, options: CommandOptions): Promise<CommandResult> {
  return runCommand("gh", args, process.cwd(), commandEnv(provider), options);
}

function runCommand(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, options: CommandOptions): Promise<CommandResult> {
  if (options.timeoutMs <= 0) {
    return Promise.resolve({ code: null, signal: null, stdout: "", stderr: "Command deadline elapsed before start\n" });
  }
  if (options.signal?.aborted) {
    return Promise.resolve({ code: null, signal: null, stdout: "", stderr: "Command aborted before start\n" });
  }

  return new Promise<CommandResult>((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const terminate = (reason: string): void => {
      if (settled) return;
      stderr = appendCapped(stderr, `${reason}\n`);
      if (!child.kill("SIGTERM")) {
        finish({ code: null, signal: null, stdout, stderr });
        return;
      }
      forceKill = setTimeout(() => {
        child.kill("SIGKILL");
      }, FORCE_KILL_GRACE_MS);
      forceKill.unref();
    };

    function onAbort(): void {
      terminate("Command aborted");
    }

    timeout = setTimeout(() => {
      terminate(`Command timed out after ${options.timeoutMs}ms`);
    }, options.timeoutMs);
    timeout.unref();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      stderr = appendCapped(stderr, `${error.message}\n`);
      finish({ code: null, signal: null, stdout, stderr });
    });
    child.on("close", (code, signal) => finish({ code, signal, stdout, stderr }));
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

function remainingMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function commandOptionsForDeadline(deadline: number, signal: AbortSignal | undefined): CommandOptions {
  return {
    timeoutMs: remainingMs(deadline),
    ...(signal ? { signal } : {}),
  };
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("CI polling aborted");
}

async function waitForNextPoll(ms: number, signal: AbortSignal | undefined): Promise<void> {
  try {
    await delay(ms, undefined, signal ? { signal } : undefined);
  } catch (error: unknown) {
    if (isAbortError(error)) throw new Error("CI polling aborted");
    throw error;
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}
