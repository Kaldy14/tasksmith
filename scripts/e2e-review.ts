#!/usr/bin/env tsx

import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

interface RunResponse {
  run: {
    id: string;
    status: string;
    title: string;
    error?: string;
    pullRequest?: { url: string; number?: number; branch: string; status: string };
  };
}

interface ReviewResponse {
  review: {
    runId: string;
    status: "passed" | "failed";
    summary: string;
    findings: Array<{ severity: string; title: string; file?: string; line?: number }>;
  };
}

interface ReviewsResponse {
  reviews: ReviewResponse["review"][];
}

interface PullRequestsResponse {
  pullRequests: Array<{ runId: string; url: string; number?: number; body: string }>;
}

interface EventsResponse {
  events: Array<{ sequence: number; type: string; data: Record<string, unknown> }>;
}

const rootDir = process.cwd();
const tsxBin = path.join(rootDir, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const serverScript = path.join(rootDir, "src", "server", "index.ts");

async function main(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasksmith-review-e2e-"));
  const binDir = path.join(tempDir, "bin");
  const ghLogPath = path.join(tempDir, "gh-calls.jsonl");
  const remoteRepoDir = path.join(tempDir, "remote.git");
  const configPath = path.join(tempDir, "tasksmith-config.json");
  const port = 38_210 + Math.floor(Math.random() * 1000);

  await mkdir(binDir, { recursive: true });
  await writeFakeGh(path.join(binDir, "gh"), ghLogPath);
  await createBareFixtureRemote(tempDir, remoteRepoDir);
  await writeFile(configPath, JSON.stringify(buildConfig(pathToFileURL(remoteRepoDir).href), null, 2), "utf8");

  const server = spawn(tsxBin, [serverScript], {
    cwd: rootDir,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      TASKSMITH_DATA_DIR: tempDir,
      TASKSMITH_CONFIG_PATH: configPath,
      TASKSMITH_PUBLIC_URL: "https://tasksmith.example.test",
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
    await testReviewBlocksSecretFinding(baseUrl, ghLogPath);
    await testReviewPassesAndAppearsInPr(baseUrl, ghLogPath, tempDir);
    console.log("Review e2e passed");
  } finally {
    server.kill("SIGTERM");
    await delay(300);
    if (server.exitCode === null) server.kill("SIGKILL");
    if (process.env.TASKSMITH_KEEP_E2E_ARTIFACTS === "1") {
      console.log(`Keeping artifacts at ${tempDir}`);
      console.log(stdout);
      console.error(stderr);
    } else {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

async function testReviewBlocksSecretFinding(baseUrl: string, ghLogPath: string): Promise<void> {
  const created = await postJson<RunResponse>(`${baseUrl}/api/runs`, {
    title: "Review blocks secret e2e",
    repoKey: "review-block-e2e",
    adapter: "demo",
    prompt: "TASKSMITH_DEMO_WRITE_SECRET_CHANGE Produce a secret-looking change so review blocks delivery.",
  });

  const failed = await waitForRunStatus(baseUrl, created.run.id, "failed", 30_000);
  assert(failed.run.error?.includes("Review failed") === true, "run should fail because review blocks delivery");

  const review = await getJson<ReviewResponse>(`${baseUrl}/api/runs/${created.run.id}/review`);
  assertEqual(review.review.status, "failed", "review status");
  assert(review.review.findings.some((finding) => finding.severity === "critical" && finding.file === "src/leaked-secret.ts"), "review should include critical secret finding");

  const events = await getJson<EventsResponse>(`${baseUrl}/api/runs/${created.run.id}/events`);
  const eventText = JSON.stringify(events);
  assert(eventText.includes('"type":"review"'), "events should include review event");
  assert(eventText.includes("Review blocked delivery"), "events should mention review blocked delivery");

  try {
    const ghLog = await readFile(ghLogPath, "utf8");
    assert(!ghLog.includes('"pr","create"'), "review-blocked run must not create a PR");
  } catch {
    // No gh calls is also acceptable.
  }
}

async function testReviewPassesAndAppearsInPr(baseUrl: string, ghLogPath: string, tempDir: string): Promise<void> {
  const created = await postJson<RunResponse>(`${baseUrl}/api/runs`, {
    title: "Review pass e2e",
    repoKey: "review-pass-e2e",
    adapter: "demo",
    prompt: "TASKSMITH_DEMO_WRITE_CHANGE Produce a normal change so review passes and delivery creates a PR.",
  });

  const completed = await waitForRunStatus(baseUrl, created.run.id, "pr_created", 30_000);
  assert(completed.run.pullRequest !== undefined, "run should include PR after review passes");

  const review = await getJson<ReviewResponse>(`${baseUrl}/api/runs/${created.run.id}/review`);
  assertEqual(review.review.status, "passed", "review status");
  assert(review.review.summary.includes("Review passed"), "review summary should indicate pass");

  const reviews = await getJson<ReviewsResponse>(`${baseUrl}/api/reviews`);
  assert(reviews.reviews.some((candidate) => candidate.runId === created.run.id), "review should be listed");

  const pullRequests = await getJson<PullRequestsResponse>(`${baseUrl}/api/pull-requests`);
  const pr = pullRequests.pullRequests.find((candidate) => candidate.runId === created.run.id);
  assert(pr !== undefined, "PR should be persisted");
  assert(pr.body.includes("Review: Review passed"), "PR body should include review summary");

  const ghLog = await readFile(ghLogPath, "utf8");
  assert(ghLog.includes('"pr","create"'), "passing review should create a PR");
  assert(ghLog.includes("Review: Review passed"), "gh PR body should include review summary");

  const diffLog = await readFile(path.join(tempDir, "runs", created.run.id, "logs", "review-diff.patch"), "utf8");
  assert(diffLog.includes("TASKSMITH_DEMO_CHANGE.txt"), "review diff log should be persisted");
}

function buildConfig(remoteUrl: string): unknown {
  const repoBase = {
    gitUrl: remoteUrl,
    defaultBranch: "main",
    gitProvider: { type: "github", owner: "octo", repo: "review-fixture", ghConfigDir: "/tmp/fake-gh-config" },
    verify: [
      {
        name: "review-smoke",
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('REVIEW_VERIFY_OK');")}`,
        timeoutMs: 30_000,
      },
    ],
  };
  return {
    workflow: {
      type: "single_task_sandcastle",
      stages: ["plan", "implement", "deep_review", "fix", "deliver"],
      maxFixAttempts: 1,
      deliveryMode: "ready_pr",
    },
    repos: {
      "review-block-e2e": { ...repoBase, displayName: "Review block fixture" },
      "review-pass-e2e": { ...repoBase, displayName: "Review pass fixture" },
    },
  };
}

async function writeFakeGh(filePath: string, logPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + '\\n');
if (args.includes('--draft')) {
  console.error('ready PR expected, got --draft');
  process.exit(8);
}
if (args[0] === 'pr' && args[1] === 'create') {
  console.log('https://github.com/octo/review-fixture/pull/456');
  process.exit(0);
}
console.error('unexpected gh args: ' + args.join(' '));
process.exit(2);
`;
  await writeFile(filePath, script, "utf8");
  await chmod(filePath, 0o755);
}

async function createBareFixtureRemote(tempDir: string, remoteRepoDir: string): Promise<void> {
  const seedDir = path.join(tempDir, "seed");
  await runGit(["init", "--bare", remoteRepoDir], tempDir);
  await mkdir(seedDir, { recursive: true });
  await runGit(["init", "-b", "main"], seedDir);
  await writeFile(path.join(seedDir, "README.md"), "# Review fixture\n", "utf8");
  await runGit(["add", "README.md"], seedDir);
  await runGit(["-c", "user.name=TaskSmith E2E", "-c", "user.email=tasksmith@example.invalid", "commit", "-m", "Initial fixture"], seedDir);
  await runGit(["remote", "add", "origin", remoteRepoDir], seedDir);
  await runGit(["push", "-u", "origin", "main"], seedDir);
}

async function runGit(args: readonly string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(" ")} failed: ${stderr}`));
    });
  });
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

async function waitForRunStatus(baseUrl: string, runId: string, status: string, timeoutMs: number): Promise<RunResponse> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await getJson<RunResponse>(`${baseUrl}/api/runs/${runId}`);
    if (response.run.status === status) return response;
    if (response.run.status === "failed" && status !== "failed") throw new Error(`Run failed: ${response.run.error ?? "unknown"}`);
    await delay(250);
  }
  throw new Error(`Timed out waiting for run status ${status}`);
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
