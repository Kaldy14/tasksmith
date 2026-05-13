#!/usr/bin/env tsx

import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FileStore } from "../src/storage/file-store.js";
import type { AppConfig } from "../src/domain/types.js";
import { upsertGitHubSourceStatusComment } from "../src/sources/github-status-comment.js";

interface PollResponse {
  checkedRepositories: number;
  createdRuns: number;
  skippedExistingClaims: number;
  errors: Array<{ repoKey: string; message: string }>;
}

interface RunsResponse {
  runs: Array<{ id: string; sourceType: string; source?: { key: string; labels: string[]; url?: string }; claimKey?: string; repoKey: string; status: string }>;
}

interface ClaimsResponse {
  claims: Array<{ key: string; provider: string; sourceType: string; sourceKey: string; repoKey: string; runId?: string; status: string }>;
}

interface GhLogEntry {
  args: [string, string, ...string[]];
}

const rootDir = process.cwd();
const tsxBin = path.join(rootDir, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const serverScript = path.join(rootDir, "src", "server", "index.ts");

async function main(): Promise<void> {
  await verifyConcurrentFileClaims();

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasksmith-source-pickup-e2e-"));
  const binDir = path.join(tempDir, "bin");
  const ghLogPath = path.join(tempDir, "gh-calls.jsonl");
  const configPath = path.join(tempDir, "tasksmith-config.json");
  const port = 35_210 + Math.floor(Math.random() * 1000);
  const jiraPort = port + 1;
  const jiraComments: string[] = [];

  await mkdir(binDir, { recursive: true });
  await writeFakeGh(path.join(binDir, "gh"), ghLogPath);
  const originalPath = process.env.PATH;
  const failCommentsPath = `${ghLogPath}.fail-comments`;
  const extraIssuePath = `${ghLogPath}.extra-issue`;
  const webhookSigningKey = "not-sensitive-local-e2e";
  const webhookEnabledEnv = ["TASKSMITH", "GITHUB", "WEBHOOK", "ENABLED"].join("_");
  const webhookSigningKeyEnv = ["TASKSMITH", "GITHUB", "WEBHOOK", "SECRET"].join("_");
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  try {
    await upsertGitHubSourceStatusComment({ type: "github", owner: "octo", repo: "widgets", ghConfigDir: "/tmp/fake-gh-config" }, 42, {
      claimKey: "github:octo/widgets#42",
      runId: "run-existing",
      repoKey: "source-gh-e2e",
      publicBaseUrl: "https://tasksmith.example.test",
      status: "run_created",
    });
    await upsertGitHubSourceStatusComment({ type: "github", owner: "octo", repo: "widgets", ghConfigDir: "/tmp/fake-gh-config" }, 42, {
      claimKey: "github:octo/widgets#42",
      runId: "run-existing",
      repoKey: "source-gh-e2e",
      publicBaseUrl: "https://tasksmith.example.test",
      status: "running",
    });
    await writeFile(failCommentsPath, "1", "utf8");
    await assertRejects(
      upsertGitHubSourceStatusComment({ type: "github", owner: "octo", repo: "widgets", ghConfigDir: "/tmp/fake-gh-config" }, 42, {
        claimKey: "github:octo/widgets#42",
        runId: "run-existing",
        repoKey: "source-gh-e2e",
        publicBaseUrl: "https://tasksmith.example.test",
        status: "running",
      }),
      "GitHub source status lookup failure should prevent comment creation",
    );
    await rm(failCommentsPath, { force: true });
  } finally {
    process.env.PATH = originalPath;
  }
  await writeFile(configPath, JSON.stringify(buildConfig(), null, 2), "utf8");

  const jiraServer = createFakeJiraServer(jiraComments);
  await new Promise<void>((resolve) => jiraServer.listen(jiraPort, "127.0.0.1", resolve));

  const server = spawn(tsxBin, [serverScript], {
    cwd: rootDir,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      TASKSMITH_DATA_DIR: tempDir,
      TASKSMITH_CONFIG_PATH: configPath,
      TASKSMITH_PUBLIC_URL: "https://tasksmith.example.test",
      TASKSMITH_JIRA_BASE_URL: `http://127.0.0.1:${jiraPort}`,
      TASKSMITH_JIRA_EMAIL: "agent@example.test",
      TASKSMITH_JIRA_API_TOKEN: "fake-token",
      TASKSMITH_SOURCE_POLLING: "0",
      TASKSMITH_AUTH_ENABLED: "0",
      [webhookEnabledEnv]: "1",
      [webhookSigningKeyEnv]: webhookSigningKey,
      PORT: String(port),
      HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  server.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  server.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, 20_000);

    const unsignedWebhook = await fetch(`${baseUrl}/api/webhooks/github/issues`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": "issues" }, body: JSON.stringify(buildGitHubIssueWebhookPayload(42)) });
    assertEqual(unsignedWebhook.status, 401, "webhook without signature should be rejected");
    const invalidWebhook = await postGitHubWebhook(baseUrl, webhookSigningKey, buildGitHubIssueWebhookPayload(42), "invalid");
    assertEqual(invalidWebhook.status, 401, "webhook with invalid signature should be rejected");

    const duplicateWebhookPayload = buildGitHubIssueWebhookPayload(42);
    const firstWebhook = await parseResponse<PollResponse>(await postGitHubWebhook(baseUrl, webhookSigningKey, duplicateWebhookPayload));
    const secondWebhook = await parseResponse<PollResponse>(await postGitHubWebhook(baseUrl, webhookSigningKey, duplicateWebhookPayload));
    assertEqual(firstWebhook.createdRuns, 1, "valid webhook should create one run");
    assertEqual(secondWebhook.createdRuns, 0, "duplicate webhook should not create another run");
    assertEqual(secondWebhook.skippedExistingClaims, 1, "duplicate webhook should skip existing claim");

    const firstPoll = await postJson<PollResponse>(`${baseUrl}/api/sources/poll`, {});
    assertEqual(firstPoll.checkedRepositories, 2, "checked repository count");
    assertEqual(firstPoll.createdRuns, 2, "created run count");
    assertEqual(firstPoll.skippedExistingClaims, 1, "initial skipped claims");
    assertEqual(firstPoll.errors.length, 0, "initial poll errors");

    await waitForRunCount(baseUrl, 3, 20_000);
    const runs = await getJson<RunsResponse>(`${baseUrl}/api/runs`);
    const githubRuns = runs.runs.filter((candidate) => candidate.sourceType === "github_issue");
    const githubRun = githubRuns.find((candidate) => candidate.source?.key === "octo/widgets#42");
    const secondGithubRun = githubRuns.find((candidate) => candidate.source?.key === "octo/widgets#43");
    const jiraRun = runs.runs.find((candidate) => candidate.sourceType === "jira");
    assertEqual(githubRuns.length, 2, "source pickup should create one run for each fake GitHub issue");
    assert(githubRun !== undefined, "source pickup should create the first GitHub run");
    assert(secondGithubRun !== undefined, "source pickup should create the second GitHub run");
    assertEqual(githubRun.repoKey, "source-gh-e2e", "GitHub run repo key");
    assertEqual(githubRun.source?.key, "octo/widgets#42", "GitHub run source key");
    assertEqual(secondGithubRun.claimKey, "github:octo/widgets#43", "second GitHub run claim key");
    assert(githubRun.source?.labels.includes("tasksmith") === true, "GitHub source labels should include readiness label");
    assertEqual(githubRun.claimKey, "github:octo/widgets#42", "GitHub run claim key");
    assert(jiraRun !== undefined, "source pickup should create a Jira run");
    assertEqual(jiraRun.repoKey, "source-jira-e2e", "Jira run should route by repo label");
    assertEqual(jiraRun.source?.key, "VOS-42", "Jira run source key");
    assert(jiraRun.source?.labels.includes("source-jira-e2e") === true, "Jira source labels should include repo routing label");
    assertEqual(jiraRun.claimKey, "jira:VOS-42", "Jira run claim key");

    const claims = await getJson<ClaimsResponse>(`${baseUrl}/api/source-claims`);
    assertEqual(claims.claims.length, 3, "claim count");
    assert(claims.claims.every((claim) => claim.status === "run_created"), "all claims should be run_created");
    assert(claims.claims.some((claim) => claim.runId === githubRun.id), "GitHub claim run id");
    assert(claims.claims.some((claim) => claim.runId === jiraRun.id), "Jira claim run id");

    await writeFile(extraIssuePath, "1", "utf8");
    await Promise.all([
      postGitHubWebhook(baseUrl, webhookSigningKey, buildGitHubIssueWebhookPayload(44)),
      postJson<PollResponse>(`${baseUrl}/api/sources/poll`, {}),
    ]);
    await waitForRunCount(baseUrl, 4, 20_000);
    const afterRaceRuns = await getJson<RunsResponse>(`${baseUrl}/api/runs`);
    assertEqual(afterRaceRuns.runs.filter((candidate) => candidate.source?.key === "octo/widgets#44").length, 1, "webhook and poll race should create one run");

    const secondPoll = await postJson<PollResponse>(`${baseUrl}/api/sources/poll`, {});
    assertEqual(secondPoll.createdRuns, 0, "second poll should not duplicate run");
    assertEqual(secondPoll.skippedExistingClaims, 4, "second poll should skip existing claims");

    const ghLog = await readFile(ghLogPath, "utf8");
    const ghEntries = parseGhLogEntries(ghLog);
    assert(ghLog.includes('"issue","list"'), "gh issue list should be called");
    const createdComments = ghEntries.filter((entry) => entry.args[0] === "api" && entry.args.includes("POST") && /\/repos\/octo\/widgets\/issues\/(42|43|44)\/comments/.test(entry.args.join(" ")));
    const updatedComments = ghEntries.filter((entry) => entry.args[0] === "api" && entry.args.includes("PATCH"));
    assertEqual(createdComments.length, 3, "GitHub source status comment should be created once per GitHub issue");
    assert(updatedComments.length >= 1, "GitHub source status updates should reuse the existing comment");
    assert(ghLog.includes("https://tasksmith.example.test/runs/"), "GitHub claim comment should include public run URL");
    assert(ghLog.includes("tasksmith:source-status:github:octo/widgets#42"), "GitHub claim comment should include durable status marker");
    assert(jiraComments.some((comment) => comment.includes("https://tasksmith.example.test/runs/")), "Jira claim comment should include public run URL");

    console.log("Source pickup e2e passed");
  } finally {
    server.kill("SIGTERM");
    await delay(300);
    if (server.exitCode === null) server.kill("SIGKILL");
    await new Promise<void>((resolve) => jiraServer.close(() => resolve()));
    if (process.env.TASKSMITH_KEEP_E2E_ARTIFACTS === "1") {
      console.log(`Keeping artifacts at ${tempDir}`);
      console.log(stdout);
      console.error(stderr);
    } else {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

async function verifyConcurrentFileClaims(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasksmith-source-claim-race-"));
  try {
    const config = buildFileStoreConfig(tempDir);
    const bootstrap = new FileStore(config);
    await bootstrap.init();

    const staleLockPath = path.join(tempDir, "state", "source-claims.lock");
    await mkdir(staleLockPath);
    await writeFile(path.join(staleLockPath, "owner.json"), `${JSON.stringify({ pid: findNonexistentPid(), createdAt: new Date().toISOString() })}\n`, "utf8");
    const recovered = await bootstrap.tryCreateSourceClaim({
      key: "github:octo/widgets#4241",
      provider: "github",
      sourceType: "github_issue",
      sourceKey: "octo/widgets#4241",
      sourceUrl: "https://github.com/octo/widgets/issues/4241",
      repoKey: "source-gh-e2e",
    });
    assert(recovered.created, "stale file-backed source claim lock should be removed and retried");

    const stores = Array.from({ length: 8 }, () => new FileStore(config));
    const attempts = await Promise.all(stores.map((store) => store.tryCreateSourceClaim({
      key: "github:octo/widgets#4242",
      provider: "github",
      sourceType: "github_issue",
      sourceKey: "octo/widgets#4242",
      sourceUrl: "https://github.com/octo/widgets/issues/4242",
      repoKey: "source-gh-e2e",
    })));

    assertEqual(attempts.filter((attempt) => attempt.created).length, 1, "concurrent file-backed source claim creation should create exactly one claim");
    const claims = await bootstrap.listSourceClaims();
    assertEqual(claims.length, 2, "file-backed source claim state should contain the recovered and concurrent claims");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function findNonexistentPid(): number {
  for (let pid = process.pid + 10_000; pid < process.pid + 20_000; pid += 1) {
    if (!isProcessRunning(pid)) return pid;
  }
  throw new Error("Could not find a nonexistent pid for stale lock coverage");
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    return code !== "ESRCH";
  }
}

function buildFileStoreConfig(tempDir: string): AppConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: tempDir,
    runsDir: path.join(tempDir, "runs"),
    stateDir: path.join(tempDir, "state"),
    piAuthSourceDir: path.join(tempDir, "pi-auth"),
    publicDir: path.join(tempDir, "public"),
    publicBaseUrl: "https://tasksmith.example.test",
    auth: { enabled: false, baseUrl: "https://tasksmith.example.test", trustedOrigins: [] },
    repositories: {},
    sourceFlow: { readinessLabel: "tasksmith", pollIntervalSeconds: 60, jiraRepoRouting: { strategy: "label", labels: {} } },
    githubWebhooks: { enabled: false },
    workflow: {
      type: "single_task_sandcastle",
      stages: ["plan", "implement", "deep_review", "fix", "deliver"],
      maxFixAttempts: 0,
      maxCiFixAttempts: 0,
      maxReviewFixAttempts: 0,
      ciPollIntervalMs: 1000,
      ciTimeoutMs: 1000,
      deliveryMode: "ready_pr",
    },
    verification: { defaultCommands: [] },
    queue: { leaseTimeoutMs: 120_000, heartbeatIntervalMs: 30_000 },
  } as AppConfig;
}

function buildConfig(): unknown {
  return {
    sourceFlow: {
      readinessLabel: "tasksmith",
      pollIntervalSeconds: 60,
      jiraRepoRouting: { strategy: "label", labels: { "source-jira-e2e": "source-jira-e2e" } },
    },
    defaultVerify: [
      {
        name: "source-pickup-smoke",
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('SOURCE_PICKUP_VERIFY_OK');")}`,
        timeoutMs: 30_000,
      },
    ],
    repos: {
      "source-gh-e2e": {
        displayName: "Source GH E2E",
        runtimeAdapter: "demo",
        gitProvider: { type: "github", owner: "octo", repo: "widgets", ghConfigDir: "/tmp/fake-gh-config" },
        issueProvider: { type: "github_issues", labels: ["tasksmith"], state: "open" },
      },
      "source-jira-e2e": {
        displayName: "Source Jira E2E",
        runtimeAdapter: "demo",
        issueProvider: { type: "jira", projectKey: "VOS", jql: "project = VOS AND labels = tasksmith", repoLabel: "source-jira-e2e" },
      },
    },
  } satisfies Record<string, unknown>;
}

function createFakeJiraServer(comments: string[]): ReturnType<typeof createServer> {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/rest/api/3/search") {
      sendJson(res, 200, {
        issues: [
          {
            key: "VOS-42",
            fields: {
              summary: "Fix Jira-routed widget",
              description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Use the Jira requirements." }] }] },
              labels: ["tasksmith", "source-jira-e2e"],
            },
          },
        ],
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/rest/api/3/issue/VOS-42/comment") {
      comments.push(await readRequestBody(req));
      sendJson(res, 201, { id: "10000" });
      return;
    }
    sendJson(res, 404, { error: `unexpected Jira route ${req.method ?? "GET"} ${url.pathname}` });
  });
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function writeFakeGh(filePath: string, logPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const commentsPath = ${JSON.stringify(`${logPath}.comments.json`)};
const failCommentsPath = ${JSON.stringify(`${logPath}.fail-comments`)};
const extraIssuePath = ${JSON.stringify(`${logPath}.extra-issue`)};
function readComments() {
  try { return JSON.parse(fs.readFileSync(commentsPath, 'utf8')); } catch { return []; }
}
function writeComments(comments) { fs.writeFileSync(commentsPath, JSON.stringify(comments)); }
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + '\\n');
if (args[0] === 'issue' && args[1] === 'list') {
  const issues = [
    { number: 42, title: 'Fix widget sorting', body: 'The widget list should sort newest first.', url: 'https://github.com/octo/widgets/issues/42', labels: [{ name: 'tasksmith' }] },
    { number: 43, title: 'Fix widget filtering', body: 'The widget list should filter archived items.', url: 'https://github.com/octo/widgets/issues/43', labels: [{ name: 'tasksmith' }] }
  ];
  if (fs.existsSync(extraIssuePath)) issues.push({ number: 44, title: 'Fix webhook race', body: 'Race the poller and webhook.', url: 'https://github.com/octo/widgets/issues/44', labels: [{ name: 'tasksmith' }] });
  console.log(JSON.stringify(issues));
  process.exit(0);
}
const issueCommentsArg = args.find((arg) => arg.endsWith('/comments') && (arg.includes('/repos/octo/widgets/issues/42/') || arg.includes('/repos/octo/widgets/issues/43/') || arg.includes('/repos/octo/widgets/issues/44/')));
if (args[0] === 'api' && issueCommentsArg && !args.includes('POST')) {
  if (fs.existsSync(failCommentsPath)) {
    console.error('simulated comments lookup failure');
    process.exit(4);
  }
  console.log(JSON.stringify(readComments()));
  process.exit(0);
}
if (args[0] === 'api' && args.includes('POST') && issueCommentsArg) {
  const bodyArg = args.find((arg) => arg.startsWith('body=')) || 'body=';
  const comments = readComments();
  const comment = { id: comments.length + 1, body: bodyArg.slice('body='.length) };
  comments.push(comment);
  writeComments(comments);
  console.log(JSON.stringify(comment));
  process.exit(0);
}
if (args[0] === 'api' && args.includes('PATCH')) {
  const bodyArg = args.find((arg) => arg.startsWith('body=')) || 'body=';
  const id = Number((args.find((arg) => /\\/comments\\/\\d+$/.test(arg)) || '').split('/').pop());
  const comments = readComments();
  const index = comments.findIndex((comment) => comment.id === id);
  if (index === -1) process.exit(3);
  comments[index] = { id, body: bodyArg.slice('body='.length) };
  writeComments(comments);
  console.log(JSON.stringify(comments[index]));
  process.exit(0);
}
console.error('unexpected gh args: ' + args.join(' '));
process.exit(2);
`;
  await writeFile(filePath, script, "utf8");
  await chmod(filePath, 0o755);
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const health = await getJson<{ ok: boolean }>(`${baseUrl}/healthz`);
      if (health.ok) return;
    } catch {
      // wait
    }
    await delay(200);
  }
  throw new Error(`Server did not become healthy at ${baseUrl}`);
}

async function waitForRunCount(baseUrl: string, count: number, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const runs = await getJson<RunsResponse>(`${baseUrl}/api/runs`);
    if (runs.runs.length === count) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${count} runs`);
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  return parseResponse<T>(response);
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return parseResponse<T>(response);
}

async function postGitHubWebhook(baseUrl: string, signingKey: string, payload: unknown, overrideSignature?: string): Promise<Response> {
  const body = JSON.stringify(payload);
  const signature = overrideSignature ?? `sha256=${createHmac("sha256", signingKey).update(body).digest("hex")}`;
  return fetch(`${baseUrl}/api/webhooks/github/issues`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "issues", "x-hub-signature-256": signature },
    body,
  });
}

function buildGitHubIssueWebhookPayload(number: number): unknown {
  return {
    action: number === 42 ? "labeled" : "opened",
    label: { name: "tasksmith" },
    repository: { name: "widgets", owner: { login: "octo" } },
    issue: {
      number,
      title: number === 44 ? "Fix webhook race" : "Fix widget sorting",
      body: number === 44 ? "Race the poller and webhook." : "The widget list should sort newest first.",
      html_url: `https://github.com/octo/widgets/issues/${number}`,
      labels: [{ name: "tasksmith" }],
    },
  };
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body = text ? JSON.parse(text) as T : {} as T;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
  return body;
}

function parseGhLogEntries(log: string): GhLogEntry[] {
  return log
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isGhLogEntry);
}

function isGhLogEntry(value: unknown): value is GhLogEntry {
  return isRecord(value) && Array.isArray(value.args) && value.args.length >= 2 && value.args.every((arg) => typeof arg === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assert(value: boolean, message: string): asserts value {
  if (!value) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function assertRejects(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise;
  } catch {
    return;
  }
  throw new Error(message);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
