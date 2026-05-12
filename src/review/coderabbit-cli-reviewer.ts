import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NormalizedRunEvent, RepositoryConfig, ReviewFinding, ReviewRecord, ReviewSeverity, RunPaths, RunRecord } from "../domain/types.js";
import { redactForStorage } from "../domain/redaction.js";

interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut: boolean;
}

interface CodeRabbitReviewContext {
  currentBranch?: string;
  headSha?: string;
  baseRef: string;
  baseSha?: string;
  targetBranch: string;
  changedFiles: string[];
  command: string;
  args: string[];
}

export interface CodeRabbitReviewResult {
  status: ReviewRecord["status"] | "skipped";
  summary: string;
  findings: ReviewFinding[];
  skippedReason?: "disabled" | "rate_limited" | "unavailable";
}

type ReviewEmitter = (event: NormalizedRunEvent) => Promise<void>;

const OUTPUT_LIMIT = 300_000;
const BLOCKING_SEVERITIES = new Set<ReviewSeverity>(["critical", "high"]);
const RATE_LIMIT_PATTERN = /\b(rate[-\s]?limit(?:ed)?|quota|bucket is empty|too many requests|http\s*429|429)\b/iu;

export class CodeRabbitCliReviewer {
  async review(run: RunRecord, paths: RunPaths, repo: RepositoryConfig | undefined, emit: ReviewEmitter): Promise<CodeRabbitReviewResult> {
    const config = repo?.codeRabbit;
    if (!config?.enabled || !config.cli.enabled) {
      return { status: "skipped", summary: "CodeRabbit CLI review is not enabled for this repository.", findings: [], skippedReason: "disabled" };
    }

    await emit({ type: "run_status", status: "reviewing", detail: "Running CodeRabbit CLI review" });
    await emit({ type: "review", status: "running", summary: "Running CodeRabbit CLI review with structured agent output" });

    const targetBranch = repo?.workflow?.mergeTargetBranch ?? repo?.defaultBranch ?? "main";
    const gitContext = await inspectGitContext(paths.workspaceDir, targetBranch);
    const baseRef = gitContext.baseSha ?? gitContext.headSha ?? targetBranch;
    const args = ["review", "--agent", "--dir", paths.workspaceDir, "--base", baseRef];
    const reviewContext: CodeRabbitReviewContext = {
      ...gitContext,
      baseRef,
      targetBranch,
      command: config.cli.command,
      args,
    };
    await emit({ type: "command", command: `${config.cli.command} ${args.map(shellQuote).join(" ")}` });

    const result = await runCommand(config.cli.command, args, paths.workspaceDir, config.cli.timeoutMs);
    await persistCodeRabbitLogs(paths, result, reviewContext);

    const combinedOutput = [result.stdout, result.stderr, result.error ?? ""].join("\n");
    const parsed = parseAgentOutput(result.stdout);
    const rateLimited = isRateLimited(combinedOutput) || parsed.messages.some(isRateLimited);

    if (rateLimited) {
      const summary = "CodeRabbit CLI review skipped because CodeRabbit reported a rate limit; TaskSmith fresh-context review is sufficient for this run.";
      await emit({ type: "review", status: "passed", summary });
      return { status: "skipped", summary, findings: [], skippedReason: "rate_limited" };
    }

    if (result.timedOut) {
      const summary = `CodeRabbit CLI review skipped after ${config.cli.timeoutMs}ms timeout; TaskSmith fresh-context review is sufficient for this run.`;
      await emit({ type: "review", status: "passed", summary });
      return { status: "skipped", summary, findings: [], skippedReason: "unavailable" };
    }

    if (result.error || (result.code !== 0 && parsed.findings.length === 0)) {
      const detail = summarizeFailure(result);
      const summary = `CodeRabbit CLI review skipped because the CLI was unavailable or failed (${detail}); TaskSmith fresh-context review is sufficient for this run.`;
      await emit({ type: "review", status: "passed", summary });
      return { status: "skipped", summary, findings: [], skippedReason: "unavailable" };
    }

    const status: ReviewRecord["status"] = parsed.findings.some((finding) => BLOCKING_SEVERITIES.has(finding.severity)) ? "failed" : "passed";
    const summary = summarizeFindings(status, parsed.findings);
    await emit({ type: "review", status, summary, findings: parsed.findings });
    return { status, summary, findings: parsed.findings };
  }
}

function parseAgentOutput(stdout: string): { findings: ReviewFinding[]; messages: string[] } {
  const findings: ReviewFinding[] = [];
  const messages: string[] = [];
  let findingIndex = 0;
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseJsonObject(trimmed);
    if (!parsed) {
      messages.push(trimmed);
      continue;
    }
    const message = stringifyInterestingFields(parsed);
    if (message) messages.push(message);
    if (stringField(parsed.type) !== "finding") continue;
    findingIndex += 1;
    findings.push(toFinding(parsed, findingIndex));
  }
  return { findings, messages };
}

function toFinding(record: Record<string, unknown>, index: number): ReviewFinding {
  const severity = mapSeverity(stringField(record.severity));
  const file = stringField(record.fileName) ?? stringField(record.file) ?? stringField(record.path);
  const line = numberField(record.line) ?? numberField(record.lineNumber) ?? numberField(record.startLine);
  const title = stringField(record.title) ?? stringField(record.message) ?? `CodeRabbit ${severity} finding`;
  const description = [
    stringField(record.description),
    stringField(record.explanation),
    stringField(record.message),
    stringField(record.codegenInstructions),
  ].filter((value): value is string => Boolean(value)).join("\n\n") || title;
  const suggestedFix = formatSuggestedFix(record);
  return {
    id: `coderabbit-${index}-${safeId(file ?? title)}`,
    severity,
    title: `CodeRabbit: ${title}`.slice(0, 180),
    description: redactForStorage(description),
    ...(file ? { file } : {}),
    ...(line === undefined ? {} : { line }),
    ...(suggestedFix ? { suggestedFix: redactForStorage(suggestedFix) } : {}),
  };
}

function formatSuggestedFix(record: Record<string, unknown>): string | undefined {
  const instructions = stringField(record.codegenInstructions);
  const suggestions = record.suggestions;
  const parts: string[] = [];
  if (instructions) parts.push(instructions);
  if (Array.isArray(suggestions) && suggestions.length > 0) {
    parts.push(suggestions.map((suggestion) => typeof suggestion === "string" ? suggestion : JSON.stringify(suggestion)).join("\n"));
  }
  const text = parts.join("\n\n").trim();
  return text || undefined;
}

function mapSeverity(value: string | undefined): ReviewSeverity {
  switch (value?.toLowerCase()) {
    case "critical":
      return "critical";
    case "major":
      return "high";
    case "minor":
      return "medium";
    case "trivial":
      return "low";
    case "info":
      return "info";
    default:
      return "medium";
  }
}

function summarizeFindings(status: ReviewRecord["status"], findings: readonly ReviewFinding[]): string {
  if (findings.length === 0) return "CodeRabbit CLI review passed with no findings.";
  const counts = new Map<ReviewSeverity, number>();
  for (const finding of findings) counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  const parts = (["critical", "high", "medium", "low", "info"] as const)
    .map((severity) => {
      const count = counts.get(severity);
      return count ? `${count} ${severity}` : "";
    })
    .filter(Boolean);
  return `${status === "failed" ? "CodeRabbit CLI review blocked delivery" : "CodeRabbit CLI review passed with findings"}: ${parts.join(", ")}.`;
}

async function persistCodeRabbitLogs(paths: RunPaths, result: CommandResult, context: CodeRabbitReviewContext): Promise<void> {
  await mkdir(paths.logsDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(paths.logsDir, "coderabbit-cli.context.json"), redactForStorage(JSON.stringify(context, null, 2)), "utf8"),
    writeFile(path.join(paths.logsDir, "coderabbit-cli.stdout.jsonl"), redactForStorage(result.stdout), "utf8"),
    writeFile(path.join(paths.logsDir, "coderabbit-cli.stderr.txt"), redactForStorage(result.stderr), "utf8"),
  ]);
}

async function inspectGitContext(cwd: string, targetBranch: string): Promise<Omit<CodeRabbitReviewContext, "baseRef" | "targetBranch" | "command" | "args">> {
  const [branchResult, headResult, remoteTargetResult, localTargetResult, statusResult] = await Promise.all([
    runGit(["branch", "--show-current"], cwd),
    runGit(["rev-parse", "HEAD"], cwd),
    runGit(["rev-parse", "--verify", `refs/remotes/origin/${targetBranch}^{commit}`], cwd),
    runGit(["rev-parse", "--verify", `${targetBranch}^{commit}`], cwd),
    runGit(["status", "--porcelain=v1", "--untracked-files=all"], cwd),
  ]);
  const targetRef = remoteTargetResult.code === 0 ? `refs/remotes/origin/${targetBranch}` : localTargetResult.code === 0 ? targetBranch : undefined;
  const baseSha = targetRef ? await readMergeBase(cwd, targetRef) : undefined;
  return {
    ...(branchResult.code === 0 && branchResult.stdout.trim() ? { currentBranch: branchResult.stdout.trim() } : {}),
    ...(headResult.code === 0 && isCommitSha(headResult.stdout.trim()) ? { headSha: headResult.stdout.trim() } : {}),
    ...(baseSha ? { baseSha } : {}),
    changedFiles: statusResult.code === 0 ? parseChangedFiles(statusResult.stdout) : [],
  };
}

async function readMergeBase(cwd: string, targetRef: string): Promise<string | undefined> {
  const result = await runGit(["merge-base", "HEAD", targetRef], cwd);
  const sha = result.stdout.trim();
  return result.code === 0 && isCommitSha(sha) ? sha : undefined;
}

async function runGit(args: readonly string[], cwd: string): Promise<CommandResult> {
  return runCommand("git", args, cwd, 30_000);
}

function parseChangedFiles(statusOutput: string): string[] {
  return statusOutput
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/iu.test(value);
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  return undefined;
}

function stringifyInterestingFields(record: Record<string, unknown>): string | undefined {
  return ["message", "summary", "error", "detail", "status"]
    .map((key) => stringField(record[key]))
    .filter((value): value is string => Boolean(value))
    .join("\n") || undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isRateLimited(value: string): boolean {
  return RATE_LIMIT_PATTERN.test(value);
}

function summarizeFailure(result: CommandResult): string {
  if (result.error) return result.error;
  const output = [result.stderr, result.stdout].find((value) => value.trim().length > 0)?.trim();
  if (output) return output.slice(0, 300).replace(/\s+/gu, " ");
  return `exit ${result.code ?? result.signal ?? "unknown"}`;
}

function runCommand(command: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let error: string | undefined;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk.toString("utf8"));
    });
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, ...(error ? { error } : {}), timedOut });
    };
    child.on("error", (spawnError) => {
      error = spawnError.message;
      stderr = appendCapped(stderr, `${spawnError.message}\n`);
      settle(null, null);
    });
    child.on("close", settle);
  });
}

function appendCapped(current: string, chunk: string): string {
  const next = current + chunk;
  if (next.length <= OUTPUT_LIMIT) return next;
  return `${next.slice(0, OUTPUT_LIMIT)}\n...[truncated]`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80) || "finding";
}
