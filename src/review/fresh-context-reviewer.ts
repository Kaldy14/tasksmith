import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NormalizedRunEvent, ReviewFinding, ReviewRecord, ReviewSeverity, RunPaths, RunRecord } from "../domain/types.js";
import { redactForStorage } from "../domain/redaction.js";

interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface AddedLine {
  file: string;
  line: number;
  text: string;
}

interface ReviewResultInput {
  status: ReviewRecord["status"];
  summary: string;
  findings: ReviewFinding[];
  diffStat?: string;
}

type ReviewEmitter = (event: NormalizedRunEvent) => Promise<void>;

const OUTPUT_LIMIT = 300_000;
const BLOCKING_SEVERITIES = new Set<ReviewSeverity>(["high", "critical"]);
const SECRET_LINE_PATTERN = /(?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*["']?[^"'\s]{8,}/iu;
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/u;

export class FreshContextReviewer {
  async review(run: RunRecord, paths: RunPaths, emit: ReviewEmitter): Promise<ReviewResultInput> {
    await emit({ type: "review", status: "running", summary: "Reviewing workspace diff in a fresh TaskSmith context" });

    const gitCheck = await runGit(["rev-parse", "--is-inside-work-tree"], paths.workspaceDir);
    if (gitCheck.code !== 0) {
      const result = {
        status: "passed" as const,
        summary: "Review skipped because the workspace is not a Git checkout.",
        findings: [],
      };
      await emit({ type: "review", status: result.status, summary: result.summary, findings: result.findings });
      return result;
    }

    const [statusResult, diffResult, statResult] = await Promise.all([
      runGit(["status", "--porcelain=v1", "--untracked-files=all"], paths.workspaceDir),
      runGit(["diff", "--no-ext-diff", "--unified=0", "--"], paths.workspaceDir),
      runGit(["diff", "--stat", "--"], paths.workspaceDir),
    ]);

    if (statusResult.code !== 0 || diffResult.code !== 0 || statResult.code !== 0) {
      const message = summarizeFailure(statusResult, diffResult, statResult);
      await emit({ type: "review", status: "failed", summary: "Review could not inspect the Git diff.", error: message });
      return {
        status: "failed",
        summary: `Review could not inspect the Git diff: ${message}`,
        findings: [{ id: "review-git-inspect-failed", severity: "critical", title: "Review could not inspect Git diff", description: message }],
      };
    }

    const changedFiles = parseChangedFiles(statusResult.stdout);
    const untrackedLines = await readUntrackedAddedLines(paths.workspaceDir, parseUntrackedFiles(statusResult.stdout));
    const addedLines = [...parseAddedLines(diffResult.stdout), ...untrackedLines];
    await persistReviewInputs(paths, [diffResult.stdout, formatUntrackedLines(untrackedLines)].filter(Boolean).join("\n"), statResult.stdout);
    const findings = [
      ...reviewChangedFiles(changedFiles),
      ...reviewAddedLines(addedLines),
      ...reviewDiffSize(changedFiles, addedLines),
    ];
    const status: ReviewRecord["status"] = findings.some((finding) => BLOCKING_SEVERITIES.has(finding.severity)) ? "failed" : "passed";
    const summary = summarizeReview(status, findings);
    const result: ReviewResultInput = {
      status,
      summary,
      findings,
      ...(statResult.stdout.trim() ? { diffStat: redactForStorage(statResult.stdout.trim()) } : {}),
    };
    await emit({ type: "review", status, summary, findings, ...(result.diffStat ? { diffStat: result.diffStat } : {}) });
    return result;
  }
}

function reviewChangedFiles(files: readonly string[]): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const file of files) {
    const base = path.basename(file);
    if (base === ".env" || (base.startsWith(".env.") && base !== ".env.example" && base !== ".env.sample")) {
      findings.push({
        id: `tracked-env-${safeId(file)}`,
        severity: "critical",
        title: "Local environment file would be included",
        description: `The diff includes ${file}. Local environment files often contain secrets and must not be committed by TaskSmith.`,
        file,
        suggestedFix: "Remove the local env file from the diff and keep it in the per-run setup/init command only.",
      });
    }
    if (file.includes("node_modules/") || file === "node_modules") {
      findings.push({
        id: `node-modules-${safeId(file)}`,
        severity: "high",
        title: "Dependency directory would be included",
        description: `The diff includes ${file}. Generated dependency directories must not be committed.`,
        file,
        suggestedFix: "Remove node_modules from the workspace diff and rely on project init commands to install dependencies.",
      });
    }
  }
  return findings;
}

function reviewAddedLines(lines: readonly AddedLine[]): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  let secretCount = 0;
  for (const line of lines) {
    if (PRIVATE_KEY_PATTERN.test(line.text) || SECRET_LINE_PATTERN.test(line.text)) {
      secretCount += 1;
      findings.push({
        id: `secret-like-${secretCount}-${safeId(line.file)}-${line.line}`,
        severity: "critical",
        title: "Secret-like value added to diff",
        description: `An added line in ${line.file}:${line.line} looks like a token, password, private key, or secret: ${redactForStorage(line.text).slice(0, 180)}`,
        file: line.file,
        line: line.line,
        suggestedFix: "Remove the secret-like value from tracked code and load it through safe local configuration outside the PR.",
      });
    }
  }
  return findings;
}

function reviewDiffSize(files: readonly string[], lines: readonly AddedLine[]): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  if (files.length > 80) {
    findings.push({
      id: "large-file-count",
      severity: "medium",
      title: "Large number of files changed",
      description: `The diff touches ${files.length} files. This may be appropriate, but it deserves careful human review.`,
    });
  }
  if (lines.length > 2_000) {
    findings.push({
      id: "large-added-line-count",
      severity: "medium",
      title: "Large diff size",
      description: `The diff adds ${lines.length} lines. This may be appropriate, but it deserves careful human review.`,
    });
  }
  return findings;
}

function summarizeReview(status: ReviewRecord["status"], findings: readonly ReviewFinding[]): string {
  if (findings.length === 0) return "Review passed with no findings.";
  const counts = new Map<ReviewSeverity, number>();
  for (const finding of findings) counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  const parts = (["critical", "high", "medium", "low", "info"] as const)
    .map((severity) => {
      const count = counts.get(severity);
      return count ? `${count} ${severity}` : "";
    })
    .filter(Boolean);
  return `${status === "failed" ? "Review blocked delivery" : "Review passed with findings"}: ${parts.join(", ")}.`;
}

function parseChangedFiles(statusOutput: string): string[] {
  return statusOutput
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .map((file) => file.includes(" -> ") ? file.split(" -> ").at(-1) ?? file : file);
}

function parseUntrackedFiles(statusOutput: string): string[] {
  return statusOutput
    .split("\n")
    .filter((line) => line.trim().startsWith("?? "))
    .map((line) => line.trim().slice(3).trim())
    .filter(Boolean);
}

async function readUntrackedAddedLines(workspaceDir: string, files: readonly string[]): Promise<AddedLine[]> {
  const lines: AddedLine[] = [];
  for (const file of files) {
    const filePath = path.resolve(workspaceDir, file);
    if (!isPathInside(workspaceDir, filePath)) continue;
    try {
      const info = await stat(filePath);
      if (!info.isFile() || info.size > 200_000) continue;
      const text = await readFile(filePath, "utf8");
      text.split("\n").forEach((line, index) => {
        lines.push({ file, line: index + 1, text: line });
      });
    } catch {
      // Ignore files that disappear between status and review.
    }
  }
  return lines;
}

function parseAddedLines(diff: string): AddedLine[] {
  const lines: AddedLine[] = [];
  let currentFile = "";
  let newLineNumber = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      currentFile = "";
      newLineNumber = 0;
      continue;
    }
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice("+++ b/".length);
      continue;
    }
    if (line.startsWith("@@")) {
      const match = /\+(\d+)(?:,(\d+))?/u.exec(line);
      newLineNumber = match ? Number.parseInt(match[1] ?? "0", 10) : 0;
      continue;
    }
    if (!currentFile || line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("+")) {
      lines.push({ file: currentFile, line: newLineNumber, text: line.slice(1) });
      newLineNumber += 1;
      continue;
    }
    if (!line.startsWith("-")) newLineNumber += 1;
  }
  return lines;
}

function formatUntrackedLines(lines: readonly AddedLine[]): string {
  if (lines.length === 0) return "";
  const grouped = new Map<string, AddedLine[]>();
  for (const line of lines) grouped.set(line.file, [...(grouped.get(line.file) ?? []), line]);
  return Array.from(grouped.entries()).map(([file, fileLines]) => [
    `diff --git a/${file} b/${file}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${file}`,
    "@@ -0,0 +1 @@",
    ...fileLines.map((line) => `+${line.text}`),
  ].join("\n")).join("\n");
}

async function persistReviewInputs(paths: RunPaths, diff: string, diffStat: string): Promise<void> {
  await mkdir(paths.logsDir, { recursive: true });
  await writeFile(path.join(paths.logsDir, "review-diff.patch"), redactForStorage(diff), "utf8");
  await writeFile(path.join(paths.logsDir, "review-diff-stat.txt"), redactForStorage(diffStat), "utf8");
}

async function runGit(args: readonly string[], cwd: string): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const child = spawn("git", args, {
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

function summarizeFailure(...results: readonly CommandResult[]): string {
  return results
    .map((result) => result.stderr.trim() || result.stdout.trim() || String(result.code ?? result.signal ?? "unknown"))
    .filter(Boolean)
    .map((value) => redactForStorage(value).split("\n").slice(0, 2).join(" "))
    .join(" ")
    .slice(0, 1_000);
}

function appendCapped(current: string, next: string): string {
  const merged = current + next;
  if (Buffer.byteLength(merged, "utf8") <= OUTPUT_LIMIT) return merged;
  return `${merged.slice(-OUTPUT_LIMIT)}\n[TaskSmith truncated review command output]\n`;
}

function isPathInside(basePath: string, candidatePath: string): boolean {
  const relative = path.relative(basePath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "item";
}
