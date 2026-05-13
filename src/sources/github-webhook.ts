import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { AppConfig, RepositoryConfig } from "../domain/types.js";
import type { SourceIntakeService } from "./source-intake.js";

export interface GitHubWebhookResult {
  accepted: boolean;
  createdRuns: number;
  skippedExistingClaims: number;
  ignored?: string;
}

const HANDLED_ACTIONS = new Set(["labeled", "opened", "reopened", "edited"]);

export async function handleGitHubIssuesWebhook(config: AppConfig, intake: SourceIntakeService, headers: IncomingHttpHeaders, rawBody: Buffer): Promise<GitHubWebhookResult> {
  if (!config.githubWebhooks.enabled) throw Object.assign(new Error("GitHub webhooks are disabled"), { statusCode: 404 });
  if (!verifyGitHubSignature(config.githubWebhooks.signingKey, headers["x-hub-signature-256"], rawBody)) {
    throw Object.assign(new Error("Invalid GitHub webhook signature"), { statusCode: 401 });
  }
  if (String(headers["x-github-event"] ?? "") !== "issues") return { accepted: true, createdRuns: 0, skippedExistingClaims: 0, ignored: "event" };

  const payload = parseJsonPayload(rawBody);
  if (!isRecord(payload)) throw Object.assign(new Error("Invalid GitHub webhook payload"), { statusCode: 400 });
  const action = typeof payload.action === "string" ? payload.action : "";
  if (!HANDLED_ACTIONS.has(action)) return { accepted: true, createdRuns: 0, skippedExistingClaims: 0, ignored: "action" };
  const issue = expectRecord(payload.issue, "issue");
  const repository = expectRecord(payload.repository, "repository");
  const owner = parseOwner(repository);
  const repoName = parseString(repository.name, "repository.name");
  const labels = parseLabels(issue.labels);
  const readinessLabel = config.sourceFlow.readinessLabel;
  const labeledName = isRecord(payload.label) && typeof payload.label.name === "string" ? payload.label.name : undefined;
  const isReadyEvent = action === "labeled" ? labeledName === readinessLabel : labels.includes(readinessLabel);
  if (!isReadyEvent) return { accepted: true, createdRuns: 0, skippedExistingClaims: 0, ignored: "label" };

  const routed = findGitHubIssueRepository(config.repositories, owner, repoName);
  if (!routed) return { accepted: true, createdRuns: 0, skippedExistingClaims: 0, ignored: "repository" };

  const result = await intake.intakeGitHubIssue(routed.repoKey, routed.repo, {
    owner,
    repo: repoName,
    number: parseNumber(issue.number, "issue.number"),
    title: parseString(issue.title, "issue.title"),
    body: typeof issue.body === "string" ? issue.body : "",
    url: parseString(issue.html_url ?? issue.url, "issue.html_url"),
    labels,
  });
  return { accepted: true, ...result };
}

function parseJsonPayload(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString("utf8")) as unknown;
  } catch {
    throw Object.assign(new Error("Invalid GitHub webhook JSON"), { statusCode: 400 });
  }
}

function verifyGitHubSignature(signingKey: string, rawSignature: string | string[] | undefined, rawBody: Buffer): boolean {
  const signature = Array.isArray(rawSignature) ? rawSignature[0] : rawSignature;
  if (!signature?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", signingKey).update(rawBody).digest("hex");
  const actual = signature.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/i.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

function findGitHubIssueRepository(repositories: Record<string, RepositoryConfig>, owner: string, repoName: string): { repoKey: string; repo: RepositoryConfig } | undefined {
  for (const [repoKey, repo] of Object.entries(repositories)) {
    if (repo.issueProvider?.type !== "github_issues") continue;
    if (repo.gitProvider?.type === "github" && repo.gitProvider.owner === owner && repo.gitProvider.repo === repoName) return { repoKey, repo };
  }
  return undefined;
}

function parseOwner(repository: Record<string, unknown>): string {
  const owner = expectRecord(repository.owner, "repository.owner");
  return parseString(owner.login ?? owner.name, "repository.owner.login");
}

function parseLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => isRecord(item) && typeof item.name === "string" ? [item.name] : []);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw Object.assign(new Error(`${label} must be an object`), { statusCode: 400 });
  return value;
}

function parseString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw Object.assign(new Error(`${label} must be a string`), { statusCode: 400 });
  return value;
}

function parseNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw Object.assign(new Error(`${label} must be an integer`), { statusCode: 400 });
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
