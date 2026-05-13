import { spawn } from "node:child_process";
import type { AppConfig, GitHubProviderConfig, IssueProviderConfig, RepositoryConfig } from "../domain/types.js";
import type { FileStore } from "../storage/file-store.js";
import { SourceIntakeService } from "./source-intake.js";

interface GitHubIssueLabel {
  name: string;
}

interface GitHubIssueListItem {
  number: number;
  title: string;
  body?: string;
  url: string;
  labels?: GitHubIssueLabel[];
}

interface JiraSearchIssueFields {
  summary: string;
  description?: unknown;
  labels?: string[];
}

interface JiraSearchIssue {
  key: string;
  self?: string;
  fields: JiraSearchIssueFields;
}

interface JiraClientConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

interface SourcePollError {
  repoKey: string;
  message: string;
}

export interface SourcePollResult {
  checkedRepositories: number;
  createdRuns: number;
  skippedExistingClaims: number;
  errors: SourcePollError[];
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const GH_OUTPUT_LIMIT = 1_000_000;

export class SourcePoller {
  private readonly intake: SourceIntakeService;

  constructor(
    private readonly config: AppConfig,
    private readonly store: FileStore,
  ) {
    this.intake = new SourceIntakeService(config, store);
  }

  async pollOnce(): Promise<SourcePollResult> {
    const result: SourcePollResult = { checkedRepositories: 0, createdRuns: 0, skippedExistingClaims: 0, errors: [] };
    for (const [repoKey, repo] of Object.entries(this.config.repositories)) {
      if (!repo.issueProvider) continue;
      result.checkedRepositories += 1;
      try {
        const repoResult = repo.issueProvider.type === "github_issues"
          ? await this.pollGitHubRepository(repoKey, repo, repo.issueProvider)
          : await this.pollJiraRepository(repoKey, repo, repo.issueProvider);
        result.createdRuns += repoResult.createdRuns;
        result.skippedExistingClaims += repoResult.skippedExistingClaims;
      } catch (error: unknown) {
        result.errors.push({ repoKey, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  }

  private async pollGitHubRepository(
    repoKey: string,
    repo: RepositoryConfig,
    issueProvider: Extract<IssueProviderConfig, { type: "github_issues" }>,
  ): Promise<Pick<SourcePollResult, "createdRuns" | "skippedExistingClaims">> {
    const gitProvider = repo.gitProvider;
    if (!gitProvider || gitProvider.type !== "github") throw new Error(`Repository ${repoKey} has github_issues source but no GitHub provider config`);
    const issues = await listGitHubIssues(gitProvider, issueProvider, this.config.sourceFlow.readinessLabel);
    let createdRuns = 0;
    let skippedExistingClaims = 0;

    for (const issue of issues) {
      const intakeResult = await this.intake.intakeGitHubIssue(repoKey, repo, {
        owner: gitProvider.owner,
        repo: gitProvider.repo,
        number: issue.number,
        title: issue.title,
        ...(issue.body === undefined ? {} : { body: issue.body }),
        url: issue.url,
        labels: issue.labels?.map((label) => label.name) ?? [],
      });
      createdRuns += intakeResult.createdRuns;
      skippedExistingClaims += intakeResult.skippedExistingClaims;
    }

    return { createdRuns, skippedExistingClaims };
  }

  private async pollJiraRepository(
    repoKey: string,
    repo: RepositoryConfig,
    issueProvider: Extract<IssueProviderConfig, { type: "jira" }>,
  ): Promise<Pick<SourcePollResult, "createdRuns" | "skippedExistingClaims">> {
    const client = loadJiraClientConfig();
    const issues = await searchJiraIssues(client, buildJiraJql(issueProvider, this.config.sourceFlow.readinessLabel));
    let createdRuns = 0;
    let skippedExistingClaims = 0;

    for (const issue of issues) {
      const labels = issue.fields.labels ?? [];
      const routedRepoKey = resolveJiraRepoKey(labels, this.config.sourceFlow.jiraRepoRouting.labels);
      if (routedRepoKey && routedRepoKey !== repoKey) continue;
      if (!routedRepoKey && issueProvider.repoLabel && !labels.includes(issueProvider.repoLabel)) continue;

      const sourceUrl = `${client.baseUrl}/browse/${encodeURIComponent(issue.key)}`;
      const intakeResult = await this.intake.intakeJiraIssue({
        repoKey,
        repo,
        issueKey: issue.key,
        title: issue.fields.summary,
        body: stringifyJiraDescription(issue.fields.description),
        labels,
        sourceUrl,
        comment: (text) => commentOnJiraIssue(client, issue.key, text),
      });
      createdRuns += intakeResult.createdRuns;
      skippedExistingClaims += intakeResult.skippedExistingClaims;
    }

    return { createdRuns, skippedExistingClaims };
  }
}


async function listGitHubIssues(
  provider: GitHubProviderConfig,
  issueProvider: Extract<IssueProviderConfig, { type: "github_issues" }>,
  readinessLabel: string,
): Promise<GitHubIssueListItem[]> {
  const labels = issueProvider.labels && issueProvider.labels.length > 0 ? issueProvider.labels : [readinessLabel];
  const args = [
    "issue",
    "list",
    "--repo",
    `${provider.owner}/${provider.repo}`,
    "--state",
    issueProvider.state ?? "open",
    "--json",
    "number,title,body,url,labels",
  ];
  for (const label of labels) args.push("--label", label);
  const result = await runGh(args, provider.ghConfigDir);
  if (result.code !== 0) throw new Error(`gh issue list failed: ${result.stderr || result.stdout}`);
  const parsed = JSON.parse(result.stdout) as unknown;
  if (!Array.isArray(parsed)) throw new Error("gh issue list returned non-array JSON");
  return parsed.map(parseGitHubIssue);
}

function loadJiraClientConfig(): JiraClientConfig {
  const baseUrl = process.env.TASKSMITH_JIRA_BASE_URL?.trim().replace(/\/$/, "");
  const email = process.env.TASKSMITH_JIRA_EMAIL?.trim();
  const apiToken = process.env.TASKSMITH_JIRA_API_TOKEN?.trim();
  if (!baseUrl) throw new Error("TASKSMITH_JIRA_BASE_URL is required for Jira source polling");
  if (!email) throw new Error("TASKSMITH_JIRA_EMAIL is required for Jira source polling");
  if (!apiToken) throw new Error("TASKSMITH_JIRA_API_TOKEN is required for Jira source polling");
  return { baseUrl, email, apiToken };
}

function buildJiraJql(issueProvider: Extract<IssueProviderConfig, { type: "jira" }>, readinessLabel: string): string {
  if (issueProvider.jql?.trim()) return issueProvider.jql.trim();
  const clauses = [`labels = ${quoteJiraString(readinessLabel)}`];
  if (issueProvider.projectKey) clauses.unshift(`project = ${quoteJiraString(issueProvider.projectKey)}`);
  if (issueProvider.repoLabel) clauses.push(`labels = ${quoteJiraString(issueProvider.repoLabel)}`);
  return clauses.join(" AND ");
}

function quoteJiraString(value: string): string {
  return JSON.stringify(value);
}

function resolveJiraRepoKey(labels: string[], routingLabels: Record<string, string>): string | undefined {
  for (const label of labels) {
    const repoKey = routingLabels[label];
    if (repoKey) return repoKey;
  }
  return undefined;
}

async function searchJiraIssues(client: JiraClientConfig, jql: string): Promise<JiraSearchIssue[]> {
  const searchUrl = new URL("/rest/api/3/search", client.baseUrl);
  searchUrl.searchParams.set("jql", jql);
  searchUrl.searchParams.set("fields", "summary,description,labels");
  searchUrl.searchParams.set("maxResults", "50");
  const response = await fetch(searchUrl, { headers: jiraHeaders(client) });
  const text = await response.text();
  if (!response.ok) throw new Error(`Jira search failed (${response.status}): ${text}`);
  const parsed = text ? JSON.parse(text) as unknown : {};
  if (!isRecord(parsed) || !Array.isArray(parsed.issues)) throw new Error("Jira search returned invalid JSON");
  return parsed.issues.map(parseJiraIssue);
}

async function commentOnJiraIssue(client: JiraClientConfig, issueKey: string, text: string): Promise<void> {
  const commentUrl = new URL(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, client.baseUrl);
  const response = await fetch(commentUrl, {
    method: "POST",
    headers: { ...jiraHeaders(client), "content-type": "application/json" },
    body: JSON.stringify({
      body: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      },
    }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Jira comment failed (${response.status}): ${body}`);
}

function jiraHeaders(client: JiraClientConfig): Record<string, string> {
  return {
    accept: "application/json",
    authorization: `Basic ${Buffer.from(`${client.email}:${client.apiToken}`, "utf8").toString("base64")}`,
  };
}

function parseGitHubIssue(value: unknown): GitHubIssueListItem {
  if (!isRecord(value)) throw new Error("GitHub issue must be an object");
  if (typeof value.number !== "number") throw new Error("GitHub issue number must be a number");
  if (typeof value.title !== "string") throw new Error("GitHub issue title must be a string");
  if (typeof value.url !== "string") throw new Error("GitHub issue url must be a string");
  const labels = Array.isArray(value.labels) ? value.labels.map(parseGitHubIssueLabel) : [];
  return {
    number: value.number,
    title: value.title,
    url: value.url,
    body: typeof value.body === "string" ? value.body : "",
    labels,
  };
}

function parseGitHubIssueLabel(value: unknown): GitHubIssueLabel {
  if (!isRecord(value) || typeof value.name !== "string") throw new Error("GitHub issue label must have a name");
  return { name: value.name };
}

function parseJiraIssue(value: unknown): JiraSearchIssue {
  if (!isRecord(value)) throw new Error("Jira issue must be an object");
  if (typeof value.key !== "string") throw new Error("Jira issue key must be a string");
  if (!isRecord(value.fields)) throw new Error("Jira issue fields must be an object");
  if (typeof value.fields.summary !== "string") throw new Error("Jira issue summary must be a string");
  const labels = Array.isArray(value.fields.labels) ? value.fields.labels.filter((label): label is string => typeof label === "string") : [];
  return {
    key: value.key,
    ...(typeof value.self === "string" ? { self: value.self } : {}),
    fields: {
      summary: value.fields.summary,
      ...(value.fields.description !== undefined ? { description: value.fields.description } : {}),
      labels,
    },
  };
}

function stringifyJiraDescription(description: unknown): string {
  const text = extractText(description).replace(/\n{3,}/g, "\n\n").trim();
  if (text) return text.slice(0, 20_000);
  if (description === undefined || description === null) return "";
  return JSON.stringify(description).slice(0, 20_000);
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n");
  if (!isRecord(value)) return "";
  const text = typeof value.text === "string" ? value.text : "";
  const content = Array.isArray(value.content) ? value.content.map(extractText).filter(Boolean).join("\n") : "";
  return [text, content].filter(Boolean).join("\n");
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
  if (Buffer.byteLength(merged, "utf8") <= GH_OUTPUT_LIMIT) return merged;
  return `${merged.slice(-GH_OUTPUT_LIMIT)}\n[TaskSmith truncated gh output]\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
