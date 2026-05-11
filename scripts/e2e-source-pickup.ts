#!/usr/bin/env tsx

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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

const rootDir = process.cwd();
const tsxBin = path.join(rootDir, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const serverScript = path.join(rootDir, "src", "server", "index.ts");

async function main(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasksmith-source-pickup-e2e-"));
  const binDir = path.join(tempDir, "bin");
  const ghLogPath = path.join(tempDir, "gh-calls.jsonl");
  const configPath = path.join(tempDir, "tasksmith-config.json");
  const port = 35_210 + Math.floor(Math.random() * 1000);
  const jiraPort = port + 1;
  const jiraComments: string[] = [];

  await mkdir(binDir, { recursive: true });
  await writeFakeGh(path.join(binDir, "gh"), ghLogPath);
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

    const firstPoll = await postJson<PollResponse>(`${baseUrl}/api/sources/poll`, {});
    assertEqual(firstPoll.checkedRepositories, 2, "checked repository count");
    assertEqual(firstPoll.createdRuns, 2, "created run count");
    assertEqual(firstPoll.skippedExistingClaims, 0, "initial skipped claims");
    assertEqual(firstPoll.errors.length, 0, "initial poll errors");

    await waitForRunCount(baseUrl, 2, 20_000);
    const runs = await getJson<RunsResponse>(`${baseUrl}/api/runs`);
    const githubRun = runs.runs.find((candidate) => candidate.sourceType === "github_issue");
    const jiraRun = runs.runs.find((candidate) => candidate.sourceType === "jira");
    assert(githubRun !== undefined, "source pickup should create a GitHub run");
    assertEqual(githubRun.repoKey, "source-gh-e2e", "GitHub run repo key");
    assertEqual(githubRun.source?.key, "octo/widgets#42", "GitHub run source key");
    assert(githubRun.source?.labels.includes("tasksmith") === true, "GitHub source labels should include readiness label");
    assertEqual(githubRun.claimKey, "github:octo/widgets#42", "GitHub run claim key");
    assert(jiraRun !== undefined, "source pickup should create a Jira run");
    assertEqual(jiraRun.repoKey, "source-jira-e2e", "Jira run should route by repo label");
    assertEqual(jiraRun.source?.key, "VOS-42", "Jira run source key");
    assert(jiraRun.source?.labels.includes("source-jira-e2e") === true, "Jira source labels should include repo routing label");
    assertEqual(jiraRun.claimKey, "jira:VOS-42", "Jira run claim key");

    const claims = await getJson<ClaimsResponse>(`${baseUrl}/api/source-claims`);
    assertEqual(claims.claims.length, 2, "claim count");
    assert(claims.claims.every((claim) => claim.status === "run_created"), "all claims should be run_created");
    assert(claims.claims.some((claim) => claim.runId === githubRun.id), "GitHub claim run id");
    assert(claims.claims.some((claim) => claim.runId === jiraRun.id), "Jira claim run id");

    const secondPoll = await postJson<PollResponse>(`${baseUrl}/api/sources/poll`, {});
    assertEqual(secondPoll.createdRuns, 0, "second poll should not duplicate run");
    assertEqual(secondPoll.skippedExistingClaims, 2, "second poll should skip existing claims");

    const ghLog = await readFile(ghLogPath, "utf8");
    assert(ghLog.includes('"issue","list"'), "gh issue list should be called");
    assert(ghLog.includes('"issue","comment"'), "gh issue comment should be called");
    assert(ghLog.includes("https://tasksmith.example.test/runs/"), "GitHub claim comment should include public run URL");
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
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + '\\n');
if (args[0] === 'issue' && args[1] === 'list') {
  console.log(JSON.stringify([{ number: 42, title: 'Fix widget sorting', body: 'The widget list should sort newest first.', url: 'https://github.com/octo/widgets/issues/42', labels: [{ name: 'tasksmith' }] }]));
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'comment') {
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

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body = text ? JSON.parse(text) as T : {} as T;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
  return body;
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
