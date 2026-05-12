import { spawn } from "node:child_process";
import type { GitHubProviderConfig } from "../domain/types.js";
import { redactForStorage } from "../domain/redaction.js";

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface GitHubComment {
  id: number;
  body: string;
}

export interface GitHubSourceStatusCommentInput {
  claimKey: string;
  runId: string;
  repoKey: string;
  publicBaseUrl: string;
  status: string;
  detail?: string;
}

const OUTPUT_LIMIT = 1_000_000;
const DETAIL_LIMIT = 1_000;

export async function upsertGitHubSourceStatusComment(
  provider: GitHubProviderConfig,
  issueNumber: number,
  input: GitHubSourceStatusCommentInput,
): Promise<void> {
  const body = buildSourceStatusComment(input);
  const existing = await findExistingStatusComment(provider, issueNumber, input.claimKey);
  if (existing) {
    const result = await runGh(["api", "--method", "PATCH", `/repos/${provider.owner}/${provider.repo}/issues/comments/${existing.id}`, "-f", `body=${body}`], provider.ghConfigDir);
    if (result.code !== 0) throw new Error(`gh issue comment update failed: ${result.stderr || result.stdout}`);
    return;
  }

  const result = await runGh(["api", "--method", "POST", `/repos/${provider.owner}/${provider.repo}/issues/${issueNumber}/comments`, "-f", `body=${body}`], provider.ghConfigDir);
  if (result.code !== 0) throw new Error(`gh issue comment create failed: ${result.stderr || result.stdout}`);
}

export function buildSourceStatusComment(input: GitHubSourceStatusCommentInput): string {
  const lines = [
    statusMarker(input.claimKey),
    "TaskSmith status for this source claim.",
    "",
    `Run: ${input.publicBaseUrl}/runs/${input.runId}`,
    `Repository: ${input.repoKey}`,
    `Status: ${input.status}`,
  ];
  if (input.detail?.trim()) lines.push(`Details: ${redactForStorage(input.detail).trim().slice(0, DETAIL_LIMIT)}`);
  return lines.join("\n");
}

export function parseGitHubIssueNumber(sourceKey: string): number | undefined {
  const match = /#(\d+)$/u.exec(sourceKey);
  if (!match) return undefined;
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

async function findExistingStatusComment(provider: GitHubProviderConfig, issueNumber: number, claimKey: string): Promise<GitHubComment | undefined> {
  const result = await runGh(["api", `/repos/${provider.owner}/${provider.repo}/issues/${issueNumber}/comments`, "--paginate"], provider.ghConfigDir);
  if (result.code !== 0) return undefined;
  const parsed = JSON.parse(result.stdout) as unknown;
  const comments = parseGitHubComments(parsed);
  const marker = statusMarker(claimKey);
  return comments.find((comment) => comment.body.includes(marker));
}

function parseGitHubComments(value: unknown): GitHubComment[] {
  if (!Array.isArray(value)) throw new Error("gh issue comments returned non-array JSON");
  return value.map(parseGitHubComment);
}

function parseGitHubComment(value: unknown): GitHubComment {
  if (!isRecord(value)) throw new Error("GitHub comment must be an object");
  if (typeof value.id !== "number") throw new Error("GitHub comment id must be a number");
  if (typeof value.body !== "string") throw new Error("GitHub comment body must be a string");
  return { id: value.id, body: value.body };
}

function statusMarker(claimKey: string): string {
  return `<!-- tasksmith:source-status:${claimKey} -->`;
}

async function runGh(args: string[], ghConfigDir: string | undefined): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const child = spawn("gh", args, {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ...(ghConfigDir ? { GH_CONFIG_DIR: ghConfigDir } : {}),
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
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function appendCapped(current: string, next: string): string {
  const merged = current + next;
  if (Buffer.byteLength(merged, "utf8") <= OUTPUT_LIMIT) return merged;
  return `${merged.slice(-OUTPUT_LIMIT)}\n[TaskSmith truncated gh output]\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
