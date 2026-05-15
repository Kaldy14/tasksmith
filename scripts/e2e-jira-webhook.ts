#!/usr/bin/env tsx

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

interface PollResponse {
  checkedRepositories: number;
  createdRuns: number;
  skippedExistingClaims: number;
  errors: Array<{ repoKey: string; message: string }>;
}

interface WebhookResponse {
  accepted: boolean;
  createdRuns: number;
  skippedExistingClaims: number;
  commandDetected: boolean;
  ignored?: string;
  errors: Array<{ repoKey: string; message: string }>;
}

interface RunsResponse {
  runs: Array<{
    id: string;
    sourceType: string;
    source?: { key: string; labels: string[] };
    claimKey?: string;
    repoKey: string;
    prompt: string;
  }>;
}

interface ClaimsResponse {
  claims: Array<{ key: string; provider: string; sourceKey: string; repoKey: string; runId?: string; status: string }>;
}

interface FakeJiraComment {
  id: string;
  body: Record<string, unknown>;
  created: string;
  author: { displayName: string };
}

const rootDir = process.cwd();
const tsxBin = path.join(rootDir, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const serverScript = path.join(rootDir, "src", "server", "index.ts");

async function main(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasksmith-jira-webhook-e2e-"));
  const configPath = path.join(tempDir, "tasksmith-config.json");
  const port = 36_200 + Math.floor(Math.random() * 1000);
  const jiraPort = port + 1;
  const webhookSecret = "jira-webhook-secret-for-e2e";
  // Start without the operator comment in Jira's comment API response to cover
  // Jira comment-created webhook races where the webhook payload arrives before
  // the newly-created comment is visible in a fresh issue fetch.
  const comments: FakeJiraComment[] = [];
  const commentWrites: Array<{ method: string; path: string; text: string }> = [];

  await writeFile(configPath, JSON.stringify(buildConfig(), null, 2), "utf8");
  const jiraServer = createFakeJiraServer(comments, commentWrites);
  await new Promise<void>((resolve) => jiraServer.listen(jiraPort, "127.0.0.1", resolve));

  const server = spawn(tsxBin, [serverScript], {
    cwd: rootDir,
    env: {
      ...process.env,
      TASKSMITH_DATA_DIR: tempDir,
      TASKSMITH_CONFIG_PATH: configPath,
      TASKSMITH_PUBLIC_URL: "https://tasksmith.example.test",
      TASKSMITH_JIRA_BASE_URL: `http://127.0.0.1:${jiraPort}`,
      TASKSMITH_JIRA_EMAIL: "agent@example.test",
      TASKSMITH_JIRA_API_TOKEN: "fake-token",
      TASKSMITH_SOURCE_POLLING: "0",
      TASKSMITH_AUTH_ENABLED: "0",
      TASKSMITH_JIRA_WEBHOOK_ENABLED: "1",
      TASKSMITH_JIRA_WEBHOOK_SECRET: webhookSecret,
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

    const unsigned = await fetch(`${baseUrl}/api/webhooks/jira`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(buildJiraWebhookPayload()) });
    assertEqual(unsigned.status, 401, "Jira webhook without secret should be rejected");

    const [first, concurrent] = await Promise.all([
      postJiraWebhook(baseUrl, webhookSecret, buildJiraWebhookPayload()),
      postJiraWebhook(baseUrl, webhookSecret, buildJiraWebhookPayload()),
    ]);
    assertEqual(first.accepted, true, "Jira webhook should be accepted");
    assertEqual(concurrent.accepted, true, "concurrent Jira webhook should be accepted");
    assertEqual(first.commandDetected, true, "Jira webhook should detect @tasksmith command");
    assertEqual(concurrent.commandDetected, true, "concurrent Jira webhook should detect @tasksmith command");
    assertEqual(first.createdRuns + concurrent.createdRuns, 2, "concurrent Jira webhooks should create one child run per repo label total");
    assertEqual(first.skippedExistingClaims + concurrent.skippedExistingClaims, 2, "concurrent Jira webhook should skip claims created by its peer");
    assertEqual(first.errors.length + concurrent.errors.length, 0, "concurrent Jira webhooks should have no errors");

    await waitForRunCount(baseUrl, 2, 20_000);
    const runs = await getJson<RunsResponse>(`${baseUrl}/api/runs`);
    const alphaRun = runs.runs.find((run) => run.repoKey === "alpha");
    const betaRun = runs.runs.find((run) => run.repoKey === "beta");
    assert(alphaRun !== undefined, "alpha child run should exist");
    assert(betaRun !== undefined, "beta child run should exist");
    assertEqual(alphaRun.claimKey, "jira:VOS-42:alpha", "alpha claim key should be repo-scoped");
    assertEqual(betaRun.claimKey, "jira:VOS-42:beta", "beta claim key should be repo-scoped");
    assert(alphaRun.prompt.includes("<tasksmith_operator_instructions>"), "prompt should include explicit TaskSmith instruction section");
    assert(alphaRun.prompt.includes("Prioritize alpha first"), "prompt should include @tasksmith comment instruction");

    const claims = await getJson<ClaimsResponse>(`${baseUrl}/api/source-claims`);
    assertEqual(claims.claims.filter((claim) => claim.sourceKey === "VOS-42").length, 2, "Jira issue should have two repo-scoped claims");
    assert(claims.claims.some((claim) => claim.key === "jira:VOS-42:alpha" && claim.runId === alphaRun.id), "alpha claim should point to alpha run");
    assert(claims.claims.some((claim) => claim.key === "jira:VOS-42:beta" && claim.runId === betaRun.id), "beta claim should point to beta run");

    const statusComments = comments.filter((comment) => adfToText(comment.body).includes("TaskSmith status for this Jira issue."));
    assertEqual(statusComments.length, 1, "Jira status should use one durable issue-level comment");
    const statusText = adfToText(statusComments[0]!.body);
    assert(!statusText.includes("tasksmith:jira-status"), "Jira status marker should not be visible to users");
    assert(statusText.includes("alpha\n: Queued"), "Jira status should include alpha run");
    assert(statusText.includes("beta\n: Queued"), "Jira status should include beta run");
    assert(adfHasLink(statusComments[0]!.body, `https://tasksmith.example.test/runs/${alphaRun.id}`), "Jira status should include clickable alpha run link");
    assert(adfHasLink(statusComments[0]!.body, `https://tasksmith.example.test/runs/${betaRun.id}`), "Jira status should include clickable beta run link");
    assert(commentWrites.some((write) => write.method === "POST"), "status comment should be created once");
    assert(commentWrites.some((write) => write.method === "PUT"), "status comment should be updated for the second child run");

    const duplicate = await postJiraWebhook(baseUrl, webhookSecret, buildJiraWebhookPayload());
    assertEqual(duplicate.createdRuns, 0, "duplicate webhook should not create duplicate runs");
    assertEqual(duplicate.skippedExistingClaims, 2, "duplicate webhook should skip both existing repo-scoped claims");

    const poll = await postJson<PollResponse>(`${baseUrl}/api/sources/poll`, {});
    assertEqual(poll.checkedRepositories, 2, "poll fallback should check both Jira repositories");
    assertEqual(poll.createdRuns, 0, "poll fallback should not duplicate webhook-created runs");
    assertEqual(poll.skippedExistingClaims, 2, "poll fallback should skip repo-scoped claims");
    assertEqual(poll.errors.length, 0, "poll fallback should have no errors");

    console.log("Jira webhook multi-repo e2e passed");
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

function buildConfig(): unknown {
  return {
    sourceFlow: {
      readinessLabel: "tasksmith",
      pollIntervalSeconds: 60,
      jiraRepoRouting: { strategy: "label", labels: { "repo:alpha": "alpha", "repo:beta": "beta" } },
    },
    defaultVerify: [{ name: "smoke", command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('ok')")}`, timeoutMs: 30_000 }],
    repos: {
      alpha: {
        displayName: "Alpha Repo",
        runtimeAdapter: "demo",
        issueProvider: { type: "jira", projectKey: "VOS", jql: "project = VOS AND labels = tasksmith AND labels = repo:alpha", repoLabel: "repo:alpha" },
      },
      beta: {
        displayName: "Beta Repo",
        runtimeAdapter: "demo",
        issueProvider: { type: "jira", projectKey: "VOS", jql: "project = VOS AND labels = tasksmith AND labels = repo:beta", repoLabel: "repo:beta" },
      },
    },
  } satisfies Record<string, unknown>;
}

function createFakeJiraServer(comments: FakeJiraComment[], writes: Array<{ method: string; path: string; text: string }>): ReturnType<typeof createServer> {
  let statusName = "Ready for AI";
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/rest/api/3/search/jql") {
      const body = JSON.parse(await readRequestBody(req)) as unknown;
      assert(isRecord(body) && typeof body.jql === "string" && body.jql.includes("labels = repo:"), "Jira search should use per-repo JQL");
      sendJson(res, 200, { isLast: true, issues: [{ key: "VOS-42" }] });
      return;
    }
    if (req.method === "GET" && url.pathname === "/rest/api/3/issue/VOS-42") {
      sendJson(res, 200, {
        key: "VOS-42",
        fields: {
          summary: "Implement multi-repo feature",
          description: adfDoc("Issue description for both repos."),
          labels: ["tasksmith", "repo:alpha", "repo:beta"],
          status: { name: statusName },
          project: { key: "VOS" },
          issuetype: { name: "Story" },
          components: [],
          attachment: [],
        },
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/rest/api/3/issue/VOS-42/transitions") {
      sendJson(res, 200, { transitions: statusName === "In Progress" ? [] : [{ id: "3", name: "Work started", to: { name: "In Progress" } }] });
      return;
    }
    if (req.method === "POST" && url.pathname === "/rest/api/3/issue/VOS-42/transitions") {
      const body = JSON.parse(await readRequestBody(req)) as unknown;
      assert(isRecord(body) && isRecord(body.transition) && body.transition.id === "3", "Jira transition should use expected transition id");
      statusName = "In Progress";
      sendJson(res, 204, {});
      return;
    }
    if (req.method === "GET" && url.pathname === "/rest/api/3/issue/VOS-42/comment") {
      sendJson(res, 200, { startAt: 0, maxResults: 100, total: comments.length, comments });
      return;
    }
    if (req.method === "POST" && url.pathname === "/rest/api/3/issue/VOS-42/comment") {
      const raw = await readRequestBody(req);
      const body = parseCommentBody(raw);
      comments.push({ id: String(20000 + comments.length + 1), body, created: "2026-05-13T12:10:00.000+0000", author: { displayName: "TaskSmith" } });
      writes.push({ method: "POST", path: url.pathname, text: adfToText(body) });
      sendJson(res, 201, { id: comments.at(-1)?.id ?? "unknown" });
      return;
    }
    const updateMatch = /^\/rest\/api\/3\/issue\/VOS-42\/comment\/(\d+)$/.exec(url.pathname);
    if (req.method === "PUT" && updateMatch) {
      const id = updateMatch[1] ?? "";
      const index = comments.findIndex((comment) => comment.id === id);
      if (index === -1) return sendJson(res, 404, { error: "comment not found" });
      const raw = await readRequestBody(req);
      const body = parseCommentBody(raw);
      comments[index] = { ...comments[index]!, body };
      writes.push({ method: "PUT", path: url.pathname, text: adfToText(body) });
      sendJson(res, 200, { id });
      return;
    }
    sendJson(res, 404, { error: `unexpected Jira route ${req.method ?? "GET"} ${url.pathname}` });
  });
}

function buildJiraWebhookPayload(): unknown {
  return {
    webhookEvent: "comment_created",
    issue: { key: "VOS-42" },
    comment: { id: "20001", body: adfDoc("@tasksmith implement this across both repositories. Prioritize alpha first.") },
  };
}

async function postJiraWebhook(baseUrl: string, secret: string, payload: unknown): Promise<WebhookResponse> {
  const response = await fetch(`${baseUrl}/api/webhooks/jira`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tasksmith-webhook-secret": secret },
    body: JSON.stringify(payload),
  });
  return parseResponse<WebhookResponse>(response);
}

function parseCommentBody(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  assert(isRecord(parsed) && isRecord(parsed.body), "Jira comment write should include ADF body");
  return parsed.body;
}

function adfDoc(text: string): Record<string, unknown> {
  return { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

function adfToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(adfToText).join("\n");
  if (!isRecord(value)) return "";
  return [typeof value.text === "string" ? value.text : "", Array.isArray(value.content) ? value.content.map(adfToText).join("\n") : ""].filter(Boolean).join("\n");
}

function adfHasLink(value: unknown, href: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => adfHasLink(entry, href));
  if (!isRecord(value)) return false;
  if (Array.isArray(value.marks) && value.marks.some((mark) => isRecord(mark) && isRecord(mark.attrs) && mark.attrs.href === href)) return true;
  return Array.isArray(value.content) && value.content.some((entry) => adfHasLink(entry, href));
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

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body = text ? JSON.parse(text) as T : {} as T;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
  return body;
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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
