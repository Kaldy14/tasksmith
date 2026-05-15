import type { SourceClaim } from "../domain/types.js";
import { redactForStorage } from "../domain/redaction.js";
import {
  commentOnJiraIssueDocument,
  getJiraIssueComments,
  updateJiraIssueCommentDocument,
  type JiraClientConfig,
} from "./jira-client.js";

export interface JiraStatusRunSummary {
  runId: string;
  repoKey: string;
  status: string;
  pullRequestUrl?: string;
}

export interface JiraStatusCommentInput {
  issueKey: string;
  publicBaseUrl: string;
  claims: readonly SourceClaim[];
  runs?: readonly JiraStatusRunSummary[];
  detail?: string;
}

interface JiraAdfTextNode {
  type: "text";
  text: string;
  marks?: Array<{ type: "link"; attrs: { href: string } } | { type: "strong" } | { type: "code" }>;
}

interface JiraAdfParagraphNode {
  type: "paragraph";
  content: JiraAdfTextNode[];
}

interface JiraAdfListItemNode {
  type: "listItem";
  content: JiraAdfParagraphNode[];
}

interface JiraAdfBulletListNode {
  type: "bulletList";
  content: JiraAdfListItemNode[];
}

type JiraAdfNode = JiraAdfParagraphNode | JiraAdfBulletListNode;

const STATUS_HEADER = "TaskSmith status for this Jira issue.";
const LEGACY_MARKER_PREFIX = "<!-- tasksmith:jira-status:";
const DETAIL_LIMIT = 1_000;
const issueLocks = new Map<string, Promise<void>>();

export async function upsertJiraStatusComment(client: JiraClientConfig, input: JiraStatusCommentInput): Promise<void> {
  await upsertFreshJiraStatusComment(client, input.issueKey, async () => input);
}

export async function upsertFreshJiraStatusComment(client: JiraClientConfig, issueKey: string, buildInput: () => Promise<JiraStatusCommentInput>): Promise<void> {
  await withIssueStatusLock(issueKey, async () => {
    const input = await buildInput();
    const document = buildJiraStatusCommentDocument(input);
    const comments = await getJiraIssueComments(client, input.issueKey);
    const existing = comments.find((comment) => isExistingTaskSmithStatusComment(comment.body));
    if (existing) {
      await updateJiraIssueCommentDocument(client, input.issueKey, existing.id, document);
      return;
    }
    await commentOnJiraIssueDocument(client, input.issueKey, document);
  });
}

export function buildJiraStatusComment(input: JiraStatusCommentInput): string {
  const claims = sortedClaims(input.claims);
  const claimLines = claims.length > 0
    ? claims.map((claim) => `- ${formatClaimText(input.publicBaseUrl, claim, input.runs ?? [])}`)
    : ["- No TaskSmith repository runs are recorded yet."];
  const lines = [STATUS_HEADER, "", "Repository runs:", ...claimLines];
  if (input.detail?.trim()) lines.push("", `Details: ${redactForStorage(input.detail).trim().slice(0, DETAIL_LIMIT)}`);
  return lines.join("\n");
}

export function buildJiraStatusCommentDocument(input: JiraStatusCommentInput): Record<string, unknown> {
  const claims = sortedClaims(input.claims);
  const content: JiraAdfNode[] = [
    paragraph([strong(STATUS_HEADER)]),
    paragraph([text("Repository runs:")]),
  ];
  if (claims.length > 0) {
    content.push({
      type: "bulletList",
      content: claims.map((claim) => ({
        type: "listItem",
        content: [paragraph(formatClaimNodes(input.publicBaseUrl, claim, input.runs ?? []))],
      })),
    });
  } else {
    content.push(paragraph([text("No TaskSmith repository runs are recorded yet.")]));
  }
  if (input.detail?.trim()) {
    content.push(paragraph([strong("Details: "), text(redactForStorage(input.detail).trim().slice(0, DETAIL_LIMIT))]));
  }
  return { type: "doc", version: 1, content };
}

function sortedClaims(claims: readonly SourceClaim[]): SourceClaim[] {
  return [...claims].sort((left, right) => left.repoKey.localeCompare(right.repoKey));
}

function formatClaimText(publicBaseUrl: string, claim: SourceClaim, runs: readonly JiraStatusRunSummary[]): string {
  const run = claim.runId ? runs.find((candidate) => candidate.runId === claim.runId) : undefined;
  const status = displayStatus(claim, run);
  const runPart = claim.runId ? ` — Run: ${publicBaseUrl}/runs/${claim.runId}` : "";
  const prPart = run?.pullRequestUrl ? ` — PR: ${run.pullRequestUrl}` : "";
  const errorPart = claim.error ? ` — Error: ${redactForStorage(claim.error).slice(0, 240)}` : "";
  return `${claim.repoKey}: ${status}${runPart}${prPart}${errorPart}`;
}

function formatClaimNodes(publicBaseUrl: string, claim: SourceClaim, runs: readonly JiraStatusRunSummary[]): JiraAdfTextNode[] {
  const run = claim.runId ? runs.find((candidate) => candidate.runId === claim.runId) : undefined;
  const status = displayStatus(claim, run);
  const nodes: JiraAdfTextNode[] = [strong(claim.repoKey), text(`: ${status}`)];
  if (claim.runId) {
    const runUrl = `${publicBaseUrl}/runs/${claim.runId}`;
    nodes.push(text(" — "), link("Run", runUrl));
  }
  if (run?.pullRequestUrl) nodes.push(text(" — "), link("PR", run.pullRequestUrl));
  if (claim.error) nodes.push(text(` — Error: ${redactForStorage(claim.error).slice(0, 240)}`));
  return nodes;
}

function displayStatus(claim: SourceClaim, run: JiraStatusRunSummary | undefined): string {
  return humanizeStatus(isTerminalSourceClaimStatus(claim.status) ? claim.status : run?.status ?? claim.status);
}

function humanizeStatus(status: string): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "claimed":
      return "Claimed";
    case "preparing":
      return "Preparing workspace";
    case "running":
      return "AI working";
    case "verifying":
      return "Verifying";
    case "reviewing":
      return "Reviewing";
    case "fixing":
      return "Fixing";
    case "creating_pr":
      return "Creating PR";
    case "watching_ci":
      return "Watching CI";
    case "pr_created":
      return "PR ready";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "run_created":
      return "Run created";
    case "skipped_existing":
      return "Already queued";
    default:
      return status.replace(/_/gu, " ");
  }
}

function isExistingTaskSmithStatusComment(body: string): boolean {
  return body.includes(STATUS_HEADER) || body.includes(LEGACY_MARKER_PREFIX);
}

function isTerminalSourceClaimStatus(status: SourceClaim["status"]): boolean {
  return status === "pr_created" || status === "completed" || status === "failed";
}

function paragraph(content: JiraAdfTextNode[]): JiraAdfParagraphNode {
  return { type: "paragraph", content };
}

function text(value: string): JiraAdfTextNode {
  return { type: "text", text: value };
}

function strong(value: string): JiraAdfTextNode {
  return { type: "text", text: value, marks: [{ type: "strong" }] };
}

function link(label: string, href: string): JiraAdfTextNode {
  return { type: "text", text: label, marks: [{ type: "link", attrs: { href } }] };
}

async function withIssueStatusLock<T>(issueKey: string, operation: () => Promise<T>): Promise<T> {
  const previous = issueLocks.get(issueKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current, () => current);
  issueLocks.set(issueKey, chained);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (issueLocks.get(issueKey) === chained) issueLocks.delete(issueKey);
  }
}
