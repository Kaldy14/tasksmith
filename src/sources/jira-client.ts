import type { SourceAttachmentSnapshot, SourceCommentSnapshot, SourceMetadataSnapshot } from "../domain/types.js";

export interface JiraClientConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

export interface JiraIssueContext {
  key: string;
  url: string;
  title: string;
  description: string;
  labels: string[];
  comments: SourceCommentSnapshot[];
  attachments: SourceAttachmentSnapshot[];
  metadata: SourceMetadataSnapshot;
}

interface JiraSearchIssue {
  key: string;
}

interface JiraIssueFields {
  summary: string;
  description?: unknown;
  labels: string[];
  status?: { name?: string };
  project?: { key?: string };
  issuetype?: { name?: string };
  components: string[];
  attachments: SourceAttachmentSnapshot[];
}

interface JiraCommentPage {
  comments: SourceCommentSnapshot[];
  startAt: number;
  maxResults: number;
  total: number;
}

const JIRA_SEARCH_MAX_RESULTS = 50;
const JIRA_COMMENT_MAX_RESULTS = 100;
const JIRA_COMMENT_MAX_PAGES = 100;
const JIRA_TEXT_LIMIT = 20_000;

export function loadJiraClientConfig(): JiraClientConfig {
  const baseUrl = process.env.TASKSMITH_JIRA_BASE_URL?.trim().replace(/\/$/, "");
  const email = process.env.TASKSMITH_JIRA_EMAIL?.trim();
  const apiToken = process.env.TASKSMITH_JIRA_API_TOKEN?.trim();
  if (!baseUrl) throw new Error("TASKSMITH_JIRA_BASE_URL is required for Jira source polling");
  if (!email) throw new Error("TASKSMITH_JIRA_EMAIL is required for Jira source polling");
  if (!apiToken) throw new Error("TASKSMITH_JIRA_API_TOKEN is required for Jira source polling");
  return { baseUrl, email, apiToken };
}

export async function searchJiraIssueContexts(client: JiraClientConfig, jql: string): Promise<JiraIssueContext[]> {
  const contexts: JiraIssueContext[] = [];
  let nextPageToken: string | undefined;

  do {
    const response = await jiraJson(client, "/rest/api/3/search/jql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jql,
        fields: ["summary"],
        maxResults: JIRA_SEARCH_MAX_RESULTS,
        ...(nextPageToken ? { nextPageToken } : {}),
      }),
    });
    const page = parseJiraSearchPage(response);
    for (const issue of page.issues) {
      contexts.push(await getJiraIssueContext(client, issue.key));
    }
    nextPageToken = page.isLast ? undefined : page.nextPageToken;
  } while (nextPageToken);

  return contexts;
}

export async function getJiraIssueContext(client: JiraClientConfig, issueKey: string): Promise<JiraIssueContext> {
  const issuePath = new URL(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, client.baseUrl);
  issuePath.searchParams.set("fields", "summary,description,labels,status,project,issuetype,components,attachment");
  const issue = await jiraJson(client, issuePath);
  const parsedIssue = parseJiraIssueDetails(issue);
  const comments = await getJiraIssueComments(client, parsedIssue.key);

  return {
    key: parsedIssue.key,
    url: `${client.baseUrl}/browse/${encodeURIComponent(parsedIssue.key)}`,
    title: parsedIssue.fields.summary,
    description: stringifyJiraDocument(parsedIssue.fields.description),
    labels: parsedIssue.fields.labels,
    comments,
    attachments: parsedIssue.fields.attachments,
    metadata: {
      ...(parsedIssue.fields.status?.name ? { status: parsedIssue.fields.status.name } : {}),
      ...(parsedIssue.fields.project?.key ? { projectKey: parsedIssue.fields.project.key } : {}),
      ...(parsedIssue.fields.issuetype?.name ? { issueType: parsedIssue.fields.issuetype.name } : {}),
      ...(parsedIssue.fields.components.length > 0 ? { components: parsedIssue.fields.components } : {}),
    },
  };
}

export async function getJiraIssueComments(client: JiraClientConfig, issueKey: string): Promise<SourceCommentSnapshot[]> {
  const comments: SourceCommentSnapshot[] = [];
  let startAt = 0;

  for (let pageCount = 0; pageCount < JIRA_COMMENT_MAX_PAGES; pageCount += 1) {
    const previousCount = comments.length;
    const commentsPath = new URL(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, client.baseUrl);
    commentsPath.searchParams.set("startAt", String(startAt));
    commentsPath.searchParams.set("maxResults", String(JIRA_COMMENT_MAX_RESULTS));
    commentsPath.searchParams.set("orderBy", "created");
    const page = parseJiraCommentPage(await jiraJson(client, commentsPath));
    comments.push(...page.comments);
    if (page.comments.length === 0 || comments.length >= page.total || comments.length <= previousCount) return comments;
    startAt = comments.length;
  }

  return comments;
}

export async function commentOnJiraIssue(client: JiraClientConfig, issueKey: string, text: string): Promise<void> {
  await commentOnJiraIssueDocument(client, issueKey, jiraTextDoc(text));
}

export async function commentOnJiraIssueDocument(client: JiraClientConfig, issueKey: string, document: Record<string, unknown>): Promise<void> {
  const commentPath = `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`;
  await jiraJson(client, commentPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: document }),
  });
}

export async function updateJiraIssueComment(client: JiraClientConfig, issueKey: string, commentId: string, text: string): Promise<void> {
  await updateJiraIssueCommentDocument(client, issueKey, commentId, jiraTextDoc(text));
}

export async function updateJiraIssueCommentDocument(client: JiraClientConfig, issueKey: string, commentId: string, document: Record<string, unknown>): Promise<void> {
  const commentPath = `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`;
  await jiraJson(client, commentPath, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: document }),
  });
}

export async function transitionJiraIssueToStatus(client: JiraClientConfig, issueKey: string, targetStatus: string): Promise<boolean> {
  const normalizedTarget = normalizeStatusName(targetStatus);
  const current = await getJiraIssueCurrentStatus(client, issueKey);
  if (normalizeStatusName(current) === normalizedTarget) return false;

  const transitions = parseJiraTransitions(await jiraJson(client, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`));
  const transition = transitions.find((candidate) => normalizeStatusName(candidate.toStatus) === normalizedTarget)
    ?? transitions.find((candidate) => normalizeStatusName(candidate.name) === normalizedTarget);
  if (!transition) throw new Error(`No Jira transition from ${current} to ${targetStatus} for ${issueKey}`);

  await jiraJson(client, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transition: { id: transition.id } }),
  });
  return true;
}

export function stringifyJiraDocument(document: unknown): string {
  const text = extractText(document).replace(/\n{3,}/g, "\n\n").trim();
  if (text) return text.slice(0, JIRA_TEXT_LIMIT);
  if (document === undefined || document === null) return "";
  return JSON.stringify(document).slice(0, JIRA_TEXT_LIMIT);
}

function jiraTextDoc(text: string): Record<string, unknown> {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

async function jiraJson(client: JiraClientConfig, pathOrUrl: string | URL, init: RequestInit = {}): Promise<unknown> {
  const url = typeof pathOrUrl === "string" ? new URL(pathOrUrl, client.baseUrl) : pathOrUrl;
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Basic ${Buffer.from(`${client.email}:${client.apiToken}`, "utf8").toString("base64")}`,
      ...init.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Jira request failed (${response.status}) for ${url.pathname}: ${text.slice(0, 1_000)}`);
  return text ? JSON.parse(text) as unknown : {};
}

function parseJiraSearchPage(value: unknown): { issues: JiraSearchIssue[]; isLast: boolean; nextPageToken?: string } {
  if (!isRecord(value) || !Array.isArray(value.issues)) throw new Error("Jira search returned invalid JSON");
  return {
    issues: value.issues.map(parseJiraSearchIssue),
    isLast: value.isLast === true || typeof value.nextPageToken !== "string",
    ...(typeof value.nextPageToken === "string" ? { nextPageToken: value.nextPageToken } : {}),
  };
}

function parseJiraSearchIssue(value: unknown): JiraSearchIssue {
  if (!isRecord(value) || typeof value.key !== "string") throw new Error("Jira search issue must include a key");
  return { key: value.key };
}

function parseJiraIssueDetails(value: unknown): { key: string; fields: JiraIssueFields } {
  if (!isRecord(value) || typeof value.key !== "string") throw new Error("Jira issue must include a key");
  if (!isRecord(value.fields)) throw new Error("Jira issue fields must be an object");
  if (typeof value.fields.summary !== "string") throw new Error("Jira issue summary must be a string");

  const fields: JiraIssueFields = {
    summary: value.fields.summary,
    ...(value.fields.description !== undefined ? { description: value.fields.description } : {}),
    labels: parseStringArray(value.fields.labels),
    components: parseComponents(value.fields.components),
    attachments: parseAttachments(value.fields.attachment),
  };
  const status = parseNamedField(value.fields.status);
  const project = parseKeyedField(value.fields.project);
  const issuetype = parseNamedField(value.fields.issuetype);
  if (status) fields.status = status;
  if (project) fields.project = project;
  if (issuetype) fields.issuetype = issuetype;
  return { key: value.key, fields };
}

function parseJiraCommentPage(value: unknown): JiraCommentPage {
  if (!isRecord(value) || !Array.isArray(value.comments)) throw new Error("Jira comments returned invalid JSON");
  return {
    comments: value.comments.map(parseJiraComment),
    startAt: typeof value.startAt === "number" ? value.startAt : 0,
    maxResults: typeof value.maxResults === "number" ? value.maxResults : JIRA_COMMENT_MAX_RESULTS,
    total: typeof value.total === "number" ? value.total : value.comments.length,
  };
}

async function getJiraIssueCurrentStatus(client: JiraClientConfig, issueKey: string): Promise<string> {
  const issuePath = new URL(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, client.baseUrl);
  issuePath.searchParams.set("fields", "status");
  const issue = await jiraJson(client, issuePath);
  if (!isRecord(issue) || !isRecord(issue.fields) || !isRecord(issue.fields.status) || typeof issue.fields.status.name !== "string") {
    throw new Error("Jira issue status response was invalid");
  }
  return issue.fields.status.name;
}

function parseJiraTransitions(value: unknown): Array<{ id: string; name: string; toStatus: string }> {
  if (!isRecord(value) || !Array.isArray(value.transitions)) throw new Error("Jira transitions returned invalid JSON");
  return value.transitions.map((transition) => {
    if (!isRecord(transition) || typeof transition.id !== "string" || typeof transition.name !== "string" || !isRecord(transition.to) || typeof transition.to.name !== "string") {
      throw new Error("Jira transition entry was invalid");
    }
    return { id: transition.id, name: transition.name, toStatus: transition.to.name };
  });
}

function normalizeStatusName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

function parseJiraComment(value: unknown): SourceCommentSnapshot {
  if (!isRecord(value) || typeof value.id !== "string") throw new Error("Jira comment must include an id");
  const author = isRecord(value.author) && typeof value.author.displayName === "string" ? value.author.displayName : undefined;
  const body = stringifyJiraDocument(value.body);
  return {
    id: value.id,
    ...(author ? { author } : {}),
    ...(typeof value.created === "string" ? { created: value.created } : {}),
    ...(typeof value.updated === "string" ? { updated: value.updated } : {}),
    body,
  };
}

function parseAttachments(value: unknown): SourceAttachmentSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((attachment) => {
    const id = typeof attachment.id === "string" ? attachment.id : typeof attachment.id === "number" ? String(attachment.id) : undefined;
    const filename = typeof attachment.filename === "string" ? attachment.filename : undefined;
    if (!id || !filename) return [];
    return [{
      id,
      filename,
      ...(typeof attachment.mimeType === "string" ? { mimeType: attachment.mimeType } : {}),
      ...(typeof attachment.size === "number" ? { size: attachment.size } : {}),
    }];
  });
}

function parseNamedField(value: unknown): { name?: string } | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.name === "string" ? { name: value.name } : undefined;
}

function parseKeyedField(value: unknown): { key?: string } | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.key === "string" ? { key: value.key } : undefined;
}

function parseComponents(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((component) => typeof component.name === "string" ? [component.name] : []);
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n");
  if (!isRecord(value)) return "";

  const nodeType = typeof value.type === "string" ? value.type : undefined;
  const ownText = typeof value.text === "string" ? value.text : "";
  const content = Array.isArray(value.content) ? value.content.map(extractText).filter(Boolean).join(nodeType === "paragraph" || nodeType === "heading" || nodeType === "listItem" ? " " : "\n") : "";
  const combined = [ownText, content].filter(Boolean).join(ownText && content ? " " : "");
  if (!combined) return "";
  return isBlockNode(nodeType) ? `\n${combined}\n` : combined;
}

function isBlockNode(nodeType: string | undefined): boolean {
  return nodeType === "paragraph" || nodeType === "heading" || nodeType === "blockquote" || nodeType === "bulletList" || nodeType === "orderedList" || nodeType === "listItem" || nodeType === "codeBlock" || nodeType === "panel";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
