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
    currentAttemptId: string;
    ciFixAttempts: number;
    pullRequest?: { url: string; number?: number; branch: string; status: string };
    error?: string;
  };
}

interface PullRequestsResponse {
  pullRequests: Array<{ runId: string; url: string; number?: number; branch: string; status: string; body: string }>;
}

interface EventsResponse {
  events: Array<{ sequence: number; type: string; data: Record<string, unknown> }>;
}

const rootDir = process.cwd();
const tsxBin = path.join(rootDir, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const serverScript = path.join(rootDir, "src", "server", "index.ts");

async function main(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasksmith-delivery-e2e-"));
  const binDir = path.join(tempDir, "bin");
  const ghLogPath = path.join(tempDir, "gh-calls.jsonl");
  const ghStatePath = path.join(tempDir, "gh-state.json");
  const remoteRepoDir = path.join(tempDir, "remote.git");
  const squashRemoteRepoDir = path.join(tempDir, "squash-remote.git");
  const configPath = path.join(tempDir, "tasksmith-config.json");
  const port = 36_210 + Math.floor(Math.random() * 1000);

  await mkdir(binDir, { recursive: true });
  await writeFakeGh(path.join(binDir, "gh"), ghLogPath, ghStatePath);
  await createBareFixtureRemote(tempDir, remoteRepoDir);
  await createBareFixtureRemote(tempDir, squashRemoteRepoDir);
  await writeFile(configPath, JSON.stringify(buildConfig(pathToFileURL(remoteRepoDir).href, pathToFileURL(squashRemoteRepoDir).href), null, 2), "utf8");

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

    const created = await postJson<RunResponse>(`${baseUrl}/api/runs`, {
      title: "Delivery ready PR e2e",
      repoKey: "delivery-e2e",
      adapter: "demo",
      prompt: "TASKSMITH_DEMO_WRITE_CHANGE TASKSMITH_DEMO_FIX_VERIFIER TASKSMITH_DEMO_FIX_CI Produce a deterministic change for PR creation, verification fixup, and CI fixup.",
    });

    const completed = await waitForRunStatus(baseUrl, created.run.id, "pr_created", 60_000);
    assert(completed.run.pullRequest !== undefined, "run should include pull request summary");
    assertEqual(completed.run.pullRequest.url, "https://github.com/octo/delivery-fixture/pull/123", "pull request url");
    assertEqual(completed.run.pullRequest.number, 123, "pull request number");
    assertEqual(completed.run.pullRequest.status, "open", "pull request status");
    assertEqual(completed.run.currentAttemptId, "attempt-3", "verifier and CI fix attempts should use separate runtime attempts");
    assertEqual(completed.run.ciFixAttempts, 1, "CI fix attempts should be tracked separately from verifier fix attempts");

    const pullRequests = await getJson<PullRequestsResponse>(`${baseUrl}/api/pull-requests`);
    const pr = pullRequests.pullRequests.find((candidate) => candidate.runId === created.run.id);
    assert(pr !== undefined, "pull request should be persisted");
    assert(pr.body.includes("ready-to-review"), "PR body should say ready-to-review");
    assert(pr.body.includes("Verification: passed"), "PR body should include verification summary");
    assert(pr.body.includes("Human review is required"), "PR body should require human review");

    await assertRemoteBranchContainsChange(remoteRepoDir, pr.branch, tempDir);
    await assertRemoteBranchContainsVerifierFix(remoteRepoDir, pr.branch, tempDir);
    await assertRemoteBranchContainsCiFix(remoteRepoDir, pr.branch, tempDir);

    const events = await getJson<EventsResponse>(`${baseUrl}/api/runs/${created.run.id}/events`);
    const eventText = JSON.stringify(events);
    assert(eventText.includes('"type":"delivery"'), "events should include delivery events");
    assert(eventText.includes('"status":"created"'), "events should include created delivery status");
    assert(eventText.includes("gh pr create"), "events should include gh pr create command");
    assert(eventText.includes('"type":"ci"'), "events should include CI polling events");
    assert(eventText.includes("CI fix attempt"), "events should include CI fix attempt status");
    assert(eventText.includes("Updated existing PR branch"), "events should include existing PR branch update");

    const squashCreated = await postJson<RunResponse>(`${baseUrl}/api/runs`, {
      title: "Delivery squash merge e2e",
      repoKey: "squash-e2e",
      adapter: "demo",
      prompt: "TASKSMITH_DEMO_WRITE_CHANGE Produce a deterministic change for direct merge.",
    });
    const squashCompleted = await waitForRunStatus(baseUrl, squashCreated.run.id, "completed", 30_000);
    assert(squashCompleted.run.pullRequest === undefined, "squash merge run should not record a pull request");
    await assertRemoteBranchContainsChange(squashRemoteRepoDir, "main", tempDir, "assert-squash-clone");

    const squashEvents = await getJson<EventsResponse>(`${baseUrl}/api/runs/${squashCreated.run.id}/events`);
    const squashEventText = JSON.stringify(squashEvents);
    assert(squashEventText.includes('"mode":"squash_merge_main"'), "events should include squash_merge_main delivery mode");
    assert(squashEventText.includes("Squash-merged to main"), "events should include squash merge summary");
    assert(squashEventText.includes("git push origin HEAD:refs/heads/main"), "events should include direct push command");

    const ghLog = await readFile(ghLogPath, "utf8");
    assert(countOccurrences(ghLog, '"pr","create"') === 1, "gh pr create should only be called for ready_pr delivery");
    assert(countOccurrences(ghLog, '"pr","checks"') >= 2, "gh pr checks should be polled before and after CI fix");
    assert(ghLog.includes('"run","view"'), "failed CI logs should be fetched");
    assert(!ghLog.includes('"--draft"'), "gh pr create must not use --draft");
    assert(ghLog.includes("ready-to-review"), "gh pr create body should say ready-to-review");

    console.log("Delivery e2e passed");
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

function buildConfig(remoteUrl: string, squashRemoteUrl: string): unknown {
  return {
    workflow: {
      type: "single_task_sandcastle",
      stages: ["plan", "implement", "deep_review", "fix", "deliver"],
      maxFixAttempts: 1,
      maxCiFixAttempts: 1,
      ciPollIntervalMs: 250,
      ciTimeoutMs: 20_000,
      deliveryMode: "ready_pr",
    },
    repos: {
      "delivery-e2e": {
        displayName: "Delivery E2E",
        gitUrl: remoteUrl,
        defaultBranch: "main",
        gitProvider: { type: "github", owner: "octo", repo: "delivery-fixture", ghConfigDir: "/tmp/fake-gh-config" },
        verify: [
          {
            name: "delivery-change-exists",
            command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("const fs=require('fs'); if (!fs.existsSync('TASKSMITH_DEMO_CHANGE.txt')) process.exit(2); if (!fs.existsSync('TASKSMITH_DEMO_VERIFIER_FIXED.txt')) process.exit(3); console.log('DELIVERY_CHANGE_OK');")}`,
            timeoutMs: 30_000,
          },
        ],
      },
      "squash-e2e": {
        displayName: "Squash Merge E2E",
        gitUrl: squashRemoteUrl,
        defaultBranch: "main",
        gitProvider: { type: "github", owner: "octo", repo: "squash-fixture", ghConfigDir: "/tmp/fake-gh-config" },
        workflow: {
          type: "single_task_sandcastle",
          stages: ["plan", "implement", "deep_review", "fix", "deliver"],
          maxFixAttempts: 1,
          deliveryMode: "squash_merge_main",
          mergeTargetBranch: "main",
        },
        verify: [
          {
            name: "squash-change-exists",
            command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("const fs=require('fs'); if (!fs.existsSync('TASKSMITH_DEMO_CHANGE.txt')) process.exit(2); console.log('SQUASH_CHANGE_OK');")}`,
            timeoutMs: 30_000,
          },
        ],
      },
    },
  };
}

async function writeFakeGh(filePath: string, logPath: string, statePath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
function readState() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return { checks: 0 }; }
}
function writeState(state) { fs.writeFileSync(statePath, JSON.stringify(state)); }
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + '\\n');
if (args.includes('--draft')) {
  console.error('ready PR expected, got --draft');
  process.exit(8);
}
if (args[0] === 'pr' && args[1] === 'create') {
  console.log('https://github.com/octo/delivery-fixture/pull/123');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'checks') {
  const state = readState();
  state.checks = (state.checks || 0) + 1;
  writeState(state);
  if (state.checks === 1) {
    console.log(JSON.stringify([{ name: 'ci / test', bucket: 'fail', state: 'completed', conclusion: 'failure', detailsUrl: 'https://github.com/octo/delivery-fixture/actions/runs/987' }]));
    process.exit(1);
  }
  console.log(JSON.stringify([{ name: 'ci / test', bucket: 'pass', state: 'completed', conclusion: 'success', detailsUrl: 'https://github.com/octo/delivery-fixture/actions/runs/988' }]));
  process.exit(0);
}
if (args[0] === 'run' && args[1] === 'view') {
  console.log('ci / test failed because TASKSMITH_DEMO_CI_FIXED.txt was missing');
  process.exit(0);
}
console.error('unexpected gh args: ' + args.join(' '));
process.exit(2);
`;
  await writeFile(filePath, script, "utf8");
  await chmod(filePath, 0o755);
}

async function createBareFixtureRemote(tempDir: string, remoteRepoDir: string): Promise<void> {
  const seedDir = path.join(tempDir, `seed-${path.basename(remoteRepoDir, ".git")}`);
  await runGit(["init", "--bare", remoteRepoDir], tempDir);
  await mkdir(seedDir, { recursive: true });
  await runGit(["init", "-b", "main"], seedDir);
  await writeFile(path.join(seedDir, "README.md"), "# Delivery fixture\n", "utf8");
  await runGit(["add", "README.md"], seedDir);
  await runGit(["-c", "user.name=TaskSmith E2E", "-c", "user.email=tasksmith@example.invalid", "commit", "-m", "Initial fixture"], seedDir);
  await runGit(["remote", "add", "origin", remoteRepoDir], seedDir);
  await runGit(["push", "-u", "origin", "main"], seedDir);
}

async function assertRemoteBranchContainsChange(remoteRepoDir: string, branch: string, tempDir: string, cloneName = "assert-clone"): Promise<void> {
  const cloneDir = path.join(tempDir, cloneName);
  await runGit(["clone", "--branch", branch, remoteRepoDir, cloneDir], tempDir);
  const change = await readFile(path.join(cloneDir, "TASKSMITH_DEMO_CHANGE.txt"), "utf8");
  assert(change.includes("Demo change created"), "remote PR branch should contain demo change");
}

async function assertRemoteBranchContainsVerifierFix(remoteRepoDir: string, branch: string, tempDir: string): Promise<void> {
  const cloneDir = path.join(tempDir, "assert-verifier-fix-clone");
  await runGit(["clone", "--branch", branch, remoteRepoDir, cloneDir], tempDir);
  const change = await readFile(path.join(cloneDir, "TASKSMITH_DEMO_VERIFIER_FIXED.txt"), "utf8");
  assert(change.includes("Demo verifier fix created"), "remote PR branch should contain verifier fix commit");
}

async function assertRemoteBranchContainsCiFix(remoteRepoDir: string, branch: string, tempDir: string): Promise<void> {
  const cloneDir = path.join(tempDir, "assert-ci-fix-clone");
  await runGit(["clone", "--branch", branch, remoteRepoDir, cloneDir], tempDir);
  const change = await readFile(path.join(cloneDir, "TASKSMITH_DEMO_CI_FIXED.txt"), "utf8");
  assert(change.includes("Demo CI fix created"), "remote PR branch should contain CI fix commit");
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
    if (response.run.status === "failed") throw new Error(`Run failed: ${response.run.error ?? "unknown"}`);
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

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
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
