import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { AppConfig, RepositoryConfig } from "../domain/types.js";
import type { SourceIntakeService } from "./source-intake.js";
import { getJiraIssueContext, loadJiraClientConfig, stringifyJiraDocument } from "./jira-client.js";
import { upsertFreshJiraStatusComment } from "./jira-status-comment.js";
import { extractTaskSmithCommand } from "./tasksmith-command.js";

export interface JiraWebhookResult {
  accepted: boolean;
  createdRuns: number;
  skippedExistingClaims: number;
  commandDetected: boolean;
  ignored?: string;
  errors: Array<{ repoKey: string; message: string }>;
}

export async function handleJiraWebhook(config: AppConfig, intake: SourceIntakeService, headers: IncomingHttpHeaders, rawBody: Buffer): Promise<JiraWebhookResult> {
  if (!config.jiraWebhooks.enabled) throw Object.assign(new Error("Jira webhooks are disabled"), { statusCode: 404 });
  if (!verifyJiraWebhookSecret(config.jiraWebhooks.signingKey, headers)) throw Object.assign(new Error("Invalid Jira webhook secret"), { statusCode: 401 });

  const payload = parseJsonPayload(rawBody);
  if (!isRecord(payload)) throw Object.assign(new Error("Invalid Jira webhook payload"), { statusCode: 400 });
  const issueKey = parseIssueKey(payload);
  const webhookCommand = parseWebhookCommand(payload);
  const commandDetected = webhookCommand !== undefined;

  const client = loadJiraClientConfig();
  const fetchedIssue = await getJiraIssueContext(client, issueKey);
  const issue = webhookCommand ? {
    ...fetchedIssue,
    comments: ensureWebhookCommandComment(fetchedIssue.comments, payload, webhookCommand),
  } : fetchedIssue;
  const readinessLabel = config.sourceFlow.readinessLabel;
  if (!issue.labels.includes(readinessLabel)) return { accepted: true, createdRuns: 0, skippedExistingClaims: 0, commandDetected, ignored: "readiness_label", errors: [] };

  const repoKeys = resolveJiraRepoKeys(issue.labels, config.sourceFlow.jiraRepoRouting.labels);
  if (repoKeys.length === 0) return { accepted: true, createdRuns: 0, skippedExistingClaims: 0, commandDetected, ignored: "repo_route", errors: [] };

  let createdRuns = 0;
  let skippedExistingClaims = 0;
  const errors: Array<{ repoKey: string; message: string }> = [];
  for (const repoKey of repoKeys) {
    const repo = findJiraRepository(config.repositories, repoKey);
    if (!repo) {
      errors.push({ repoKey, message: `No Jira repository config found for routed repo ${repoKey}` });
      continue;
    }
    try {
      const result = await intake.intakeJiraIssue({
        repoKey,
        repo,
        issueKey: issue.key,
        title: issue.title,
        body: issue.description,
        labels: issue.labels,
        sourceUrl: issue.url,
        comments: issue.comments,
        attachments: issue.attachments,
        metadata: issue.metadata,
        upsertStatusComment: (buildInput) => upsertFreshJiraStatusComment(client, issue.key, buildInput),
      });
      createdRuns += result.createdRuns;
      skippedExistingClaims += result.skippedExistingClaims;
    } catch (error: unknown) {
      errors.push({ repoKey, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return { accepted: true, createdRuns, skippedExistingClaims, commandDetected, errors };
}

function verifyJiraWebhookSecret(signingKey: string, headers: IncomingHttpHeaders): boolean {
  const header = firstHeader(headers["x-tasksmith-webhook-secret"]);
  const authorization = firstHeader(headers.authorization);
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
  const candidate = header ?? bearer;
  if (!candidate) return false;
  const expected = Buffer.from(signingKey, "utf8");
  const actual = Buffer.from(candidate, "utf8");
  if (actual.byteLength !== expected.byteLength) return false;
  return timingSafeEqual(actual, expected);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseJsonPayload(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString("utf8")) as unknown;
  } catch {
    throw Object.assign(new Error("Invalid Jira webhook JSON"), { statusCode: 400 });
  }
}

function parseIssueKey(payload: Record<string, unknown>): string {
  const issue = expectRecord(payload.issue, "issue");
  return parseString(issue.key, "issue.key");
}

function parseWebhookCommand(payload: Record<string, unknown>): string | undefined {
  if (!isRecord(payload.comment)) return undefined;
  const body = stringifyJiraDocument(payload.comment.body);
  return extractTaskSmithCommand(body);
}

function ensureWebhookCommandComment(
  comments: Array<{ id: string; author?: string; created?: string; updated?: string; body: string }>,
  payload: Record<string, unknown>,
  command: string,
): Array<{ id: string; author?: string; created?: string; updated?: string; body: string }> {
  const comment = isRecord(payload.comment) ? payload.comment : undefined;
  const id = typeof comment?.id === "string" ? comment.id : "webhook";
  const marker = `@tasksmith ${command}`;
  if (comments.some((candidate) => candidate.id === id || candidate.body.includes(marker) || candidate.body.includes(command))) return comments;
  return [...comments, { id: `webhook:${id}`, body: marker }];
}

function resolveJiraRepoKeys(labels: string[], routingLabels: Record<string, string>): string[] {
  const repoKeys = new Set<string>();
  for (const label of labels) {
    const repoKey = routingLabels[label];
    if (repoKey) repoKeys.add(repoKey);
  }
  return [...repoKeys];
}

function findJiraRepository(repositories: Record<string, RepositoryConfig>, repoKey: string): RepositoryConfig | undefined {
  const repo = repositories[repoKey];
  if (repo?.issueProvider?.type === "jira") return repo;
  return undefined;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw Object.assign(new Error(`${label} must be an object`), { statusCode: 400 });
  return value;
}

function parseString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw Object.assign(new Error(`${label} must be a string`), { statusCode: 400 });
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
