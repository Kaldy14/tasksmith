import { spawn } from "node:child_process";
import type {
  AppConfig,
  GitHubProviderConfig,
  NormalizedRunEvent,
  PullRequestRecord,
  RepositoryConfig,
  RunPaths,
  RunRecord,
} from "../domain/types.js";
import { redactForStorage } from "../domain/redaction.js";
import type { FileStore } from "../storage/file-store.js";

interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface DeliveryResult {
  status: "created" | "skipped";
  summary: string;
  pullRequest?: PullRequestRecord;
}

interface JiraClientConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

type DeliveryEmitter = (event: NormalizedRunEvent) => Promise<void>;

const OUTPUT_LIMIT = 200_000;

export class PullRequestDelivery {
  constructor(
    private readonly config: AppConfig,
    private readonly store: FileStore,
  ) {}

  async deliver(run: RunRecord, paths: RunPaths, emit: DeliveryEmitter): Promise<DeliveryResult> {
    const repo = this.config.repositories[run.repoKey];
    const workflow = repo?.workflow ?? this.config.workflow;
    if (workflow.deliveryMode === "squash_merge_main") {
      await emit({ type: "delivery", mode: workflow.deliveryMode, status: "failed", detail: "squash_merge_main delivery is not implemented yet" });
      throw new Error("squash_merge_main delivery is not implemented yet");
    }

    if (!repo?.gitUrl || !repo.gitProvider) {
      const summary = "No GitHub PR delivery configured for this repository.";
      await emit({ type: "delivery", mode: workflow.deliveryMode, status: "skipped", detail: summary });
      return { status: "skipped", summary };
    }

    if (repo.gitProvider.type !== "github") {
      await emit({ type: "delivery", mode: workflow.deliveryMode, status: "failed", detail: "Only GitHub PR delivery is implemented" });
      throw new Error("Only GitHub PR delivery is implemented");
    }

    const existing = await this.store.getPullRequestForRun(run.id);
    if (existing) {
      const summary = `Pull request already recorded: ${existing.url}`;
      await emit({
        type: "delivery",
        mode: workflow.deliveryMode,
        status: "created",
        provider: existing.provider,
        branch: existing.branch,
        url: existing.url,
        ...(existing.number === undefined ? {} : { number: existing.number }),
        detail: summary,
      });
      return { status: "created", summary, pullRequest: existing };
    }

    await emit({ type: "delivery", mode: workflow.deliveryMode, status: "running", provider: "github", detail: "Preparing ready-to-review PR" });

    const changedFiles = parseChangedFiles((await runGit(["status", "--porcelain=v1", "--untracked-files=all"], paths.workspaceDir, repo)).stdout);
    if (changedFiles.length === 0) {
      await emit({ type: "delivery", mode: workflow.deliveryMode, status: "failed", provider: "github", detail: "No workspace changes to deliver" });
      throw new Error("No workspace changes to deliver");
    }

    const branch = buildBranchName(run);
    const baseBranch = repo.defaultBranch ?? "main";
    const prTitle = buildPullRequestTitle(run);
    const prBody = buildPullRequestBody(run, changedFiles, this.config.publicBaseUrl);

    await emitCommand(emit, `git checkout -B ${branch}`, runGit(["checkout", "-B", branch], paths.workspaceDir, repo));
    await emitCommand(emit, "git add -A", runGit(["add", "-A"], paths.workspaceDir, repo));
    await emitCommand(
      emit,
      `git commit -m ${JSON.stringify(commitSubject(run))}`,
      runGit(["-c", "user.name=TaskSmith", "-c", "user.email=tasksmith@example.invalid", "commit", "-m", commitSubject(run)], paths.workspaceDir, repo),
    );
    await emitCommand(emit, `git push -u origin HEAD:refs/heads/${branch}`, runGit(["push", "-u", "origin", `HEAD:refs/heads/${branch}`], paths.workspaceDir, repo));

    const ghResult = await emitCommand(
      emit,
      `gh pr create --repo ${repo.gitProvider.owner}/${repo.gitProvider.repo} --base ${baseBranch} --head ${branch} --title ${JSON.stringify(prTitle)} --body <generated>`,
      runGh([
        "pr",
        "create",
        "--repo",
        `${repo.gitProvider.owner}/${repo.gitProvider.repo}`,
        "--base",
        baseBranch,
        "--head",
        branch,
        "--title",
        prTitle,
        "--body",
        prBody,
      ], repo.gitProvider),
    );

    const url = parsePullRequestUrl(ghResult.stdout);
    const number = parsePullRequestNumber(url);
    const pullRequest = await this.store.recordPullRequest({
      runId: run.id,
      provider: "github",
      url,
      ...(number === undefined ? {} : { number }),
      branch,
      baseBranch,
      title: prTitle,
      body: prBody,
    });

    const sourceUpdateError = await updateSourceWithPullRequest(run, repo.gitProvider, pullRequest, this.config.publicBaseUrl);
    const summary = `Ready-to-review PR created: ${pullRequest.url}`;
    await emit({
      type: "delivery",
      mode: workflow.deliveryMode,
      status: "created",
      provider: "github",
      branch,
      url: pullRequest.url,
      ...(pullRequest.number === undefined ? {} : { number: pullRequest.number }),
      detail: sourceUpdateError ? `${summary}\nSource update failed: ${sourceUpdateError}` : summary,
    });
    return { status: "created", summary, pullRequest };
  }
}

async function emitCommand(emit: DeliveryEmitter, command: string, promise: Promise<CommandResult>): Promise<CommandResult> {
  await emit({ type: "command", command });
  const result = await promise;
  await emit({
    type: "command_output",
    command,
    output: formatCommandOutput(result),
    isError: result.code !== 0,
  });
  if (result.code !== 0) throw new Error(`${command} failed: ${summarizeCommandFailure(result)}`);
  return result;
}

async function runGit(args: readonly string[], cwd: string, repo: RepositoryConfig): Promise<CommandResult> {
  return runCommand("git", args, cwd, commandEnv(repo));
}

async function runGh(args: readonly string[], provider: GitHubProviderConfig): Promise<CommandResult> {
  return runCommand("gh", args, process.cwd(), commandEnv({ gitProvider: provider }));
}

async function runCommand(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<CommandResult> {
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

function commandEnv(repo: Pick<RepositoryConfig, "gitProvider" | "gitSshCommand">): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    GIT_TERMINAL_PROMPT: "0",
    ...(repo.gitSshCommand ? { GIT_SSH_COMMAND: repo.gitSshCommand } : {}),
    ...(repo.gitProvider?.ghConfigDir ? { GH_CONFIG_DIR: repo.gitProvider.ghConfigDir } : {}),
  };
}

function parseChangedFiles(statusOutput: string): string[] {
  return statusOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function buildBranchName(run: RunRecord): string {
  const source = run.source?.key ?? run.title;
  const slug = source.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "run";
  return `tasksmith/${slug}-${run.id.slice(-8)}`;
}

function buildPullRequestTitle(run: RunRecord): string {
  const prefix = run.source?.key ? `${run.source.key}: ` : "";
  return `${prefix}${run.title}`.slice(0, 180);
}

function commitSubject(run: RunRecord): string {
  const source = run.source?.key ?? run.title;
  return `TaskSmith: ${source}`.slice(0, 100);
}

function buildPullRequestBody(run: RunRecord, changedFiles: readonly string[], publicBaseUrl: string): string {
  const runUrl = `${publicBaseUrl}/runs/${run.id}`;
  const sourceUrl = run.source?.url;
  const sourceLine = sourceUrl ? `[${run.source?.key ?? "source issue"}](${sourceUrl})` : run.source?.key ?? "manual run";
  return [
    "TaskSmith created this ready-to-review pull request.",
    "",
    `Run: ${runUrl}`,
    `Source: ${sourceLine}`,
    `Repository: ${run.repoKey}`,
    "Verification: passed before PR creation.",
    "Review: fresh-context review is not implemented yet.",
    "",
    "Changed files:",
    ...changedFiles.slice(0, 50).map((file) => `- ${file}`),
    changedFiles.length > 50 ? `- ...and ${changedFiles.length - 50} more` : "",
    "",
    "AI-generated change: yes. Human review is required before merge.",
  ].filter((line) => line !== "").join("\n");
}

function parsePullRequestUrl(stdout: string): string {
  const match = /https?:\/\/\S+/u.exec(stdout);
  if (!match) throw new Error(`gh pr create did not return a pull request URL: ${stdout.trim() || "<empty>"}`);
  return match[0].replace(/[),.;]+$/u, "");
}

function parsePullRequestNumber(url: string): number | undefined {
  const match = /\/pull\/(\d+)(?:\D|$)/u.exec(url);
  if (!match) return undefined;
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isInteger(parsed) ? parsed : undefined;
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
  return `${merged.slice(-OUTPUT_LIMIT)}\n[TaskSmith truncated delivery command output]\n`;
}

async function updateSourceWithPullRequest(
  run: RunRecord,
  provider: GitHubProviderConfig,
  pullRequest: PullRequestRecord,
  publicBaseUrl: string,
): Promise<string | undefined> {
  if (!run.source) return undefined;
  const body = buildSourcePullRequestComment(run, pullRequest, publicBaseUrl);
  try {
    if (run.source.type === "github_issue") {
      const issueNumber = parseIssueNumber(run.source.key);
      if (issueNumber === undefined) return `Could not parse GitHub issue number from ${run.source.key}`;
      const result = await runGh(["issue", "comment", String(issueNumber), "--repo", `${provider.owner}/${provider.repo}`, "--body", body], provider);
      if (result.code !== 0) return summarizeCommandFailure(result);
      return undefined;
    }
    if (run.source.type === "jira") {
      await commentOnJiraIssue(loadJiraClientConfig(), run.source.key, body);
      return undefined;
    }
    return undefined;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

function buildSourcePullRequestComment(run: RunRecord, pullRequest: PullRequestRecord, publicBaseUrl: string): string {
  return `TaskSmith created a ready-to-review PR:\n\n${pullRequest.url}\n\nVerification: passed\nReview: not yet implemented\nRun: ${publicBaseUrl}/runs/${run.id}`;
}

function parseIssueNumber(sourceKey: string): number | undefined {
  const match = /#(\d+)$/u.exec(sourceKey);
  if (!match) return undefined;
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function loadJiraClientConfig(): JiraClientConfig {
  const baseUrl = process.env.TASKSMITH_JIRA_BASE_URL?.trim().replace(/\/$/, "");
  const email = process.env.TASKSMITH_JIRA_EMAIL?.trim();
  const apiToken = process.env.TASKSMITH_JIRA_API_TOKEN?.trim();
  if (!baseUrl) throw new Error("TASKSMITH_JIRA_BASE_URL is required for Jira PR comments");
  if (!email) throw new Error("TASKSMITH_JIRA_EMAIL is required for Jira PR comments");
  if (!apiToken) throw new Error("TASKSMITH_JIRA_API_TOKEN is required for Jira PR comments");
  return { baseUrl, email, apiToken };
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
  const responseText = await response.text();
  if (!response.ok) throw new Error(`Jira comment failed (${response.status}): ${responseText}`);
}

function jiraHeaders(client: JiraClientConfig): Record<string, string> {
  return {
    accept: "application/json",
    authorization: `Basic ${Buffer.from(`${client.email}:${client.apiToken}`, "utf8").toString("base64")}`,
  };
}
