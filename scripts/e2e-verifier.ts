#!/usr/bin/env tsx

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

interface RunResponse {
  run: { id: string; status: string; adapter: string; title: string; error?: string };
}

interface EventsResponse {
  events: Array<{ sequence: number; type: string; data: Record<string, unknown> }>;
}

const rootDir = process.cwd();
const tsxBin = path.join(rootDir, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const serverScript = path.join(rootDir, "src", "server", "index.ts");

async function main(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasksmith-verifier-e2e-"));
  const port = 34_210 + Math.floor(Math.random() * 1000);
  const sourceRepoDir = path.join(tempDir, "source-repo");
  await createFixtureGitRepo(sourceRepoDir);
  const repoConfigPath = path.join(tempDir, "repo-config.json");
  await writeFile(repoConfigPath, JSON.stringify(buildRepoConfig(pathToFileURL(sourceRepoDir).href), null, 2), "utf8");

  const server = spawn(tsxBin, [serverScript], {
    cwd: rootDir,
    env: {
      ...process.env,
      TASKSMITH_DATA_DIR: tempDir,
      TASKSMITH_REPO_CONFIG_PATH: repoConfigPath,
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
    await testGitWorkspaceClone(baseUrl, tempDir);
    await testRepoSpecificVerifierPass(baseUrl, tempDir);
    await testRepoSpecificVerifierFail(baseUrl, tempDir);
    console.log("Verifier e2e passed");
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

async function testGitWorkspaceClone(baseUrl: string, tempDir: string): Promise<void> {
  const created = await postJson<RunResponse>(`${baseUrl}/api/runs`, {
    title: "Verifier clone e2e",
    repoKey: "clone-pass-e2e",
    adapter: "demo",
    prompt: "Produce deterministic event stream after TaskSmith clones a configured repository.",
  });

  await waitForRunStatus(baseUrl, created.run.id, "completed", 20_000);
  const events = await getJson<EventsResponse>(`${baseUrl}/api/runs/${created.run.id}/events`);
  const text = JSON.stringify(events);
  assert(text.includes("git clone"), "events should include workspace clone command");
  assert(text.includes("CLONE_MARKER_OK"), "events should include clone verifier output");
  const marker = await readFile(path.join(tempDir, "runs", created.run.id, "workspace", "CLONE_MARKER.txt"), "utf8");
  assert(marker.includes("cloned workspace fixture"), "workspace should contain cloned fixture file");
}

async function testRepoSpecificVerifierPass(baseUrl: string, tempDir: string): Promise<void> {
  const created = await postJson<RunResponse>(`${baseUrl}/api/runs`, {
    title: "Verifier repo pass e2e",
    repoKey: "verifier-pass-e2e",
    adapter: "demo",
    prompt: "Produce deterministic event stream before repository-specific verification passes.",
  });

  await waitForRunStatus(baseUrl, created.run.id, "completed", 20_000);
  const events = await getJson<EventsResponse>(`${baseUrl}/api/runs/${created.run.id}/events`);
  const text = JSON.stringify(events);
  assert(text.includes("repo-specific-pass"), "events should include repo-specific pass verifier name");
  assert(text.includes("REPO_CONFIG_OK"), "events should include repo-specific verifier output");
  assert(!text.includes("DEFAULT_VERIFY_SHOULD_NOT_RUN"), "repo-specific config should override default verifier");
  const stdoutLog = await readFile(
    path.join(tempDir, "runs", created.run.id, "logs", "verification-repo-specific-pass-stdout.log"),
    "utf8",
  );
  assert(stdoutLog.includes("REPO_CONFIG_OK"), "stdout log should include repo-specific verifier output");
}

async function testRepoSpecificVerifierFail(baseUrl: string, tempDir: string): Promise<void> {
  const created = await postJson<RunResponse>(`${baseUrl}/api/runs`, {
    title: "Verifier repo fail e2e",
    repoKey: "verifier-fail-e2e",
    adapter: "demo",
    prompt: "Produce deterministic event stream before repository-specific verification fails.",
  });

  const failedRun = await waitForRunStatus(baseUrl, created.run.id, "failed", 20_000);
  assert(failedRun.run.error?.includes("Verification failed") === true, "run error should mention verification failure");

  const events = await getJson<EventsResponse>(`${baseUrl}/api/runs/${created.run.id}/events`);
  const text = JSON.stringify(events);
  assert(text.includes("repo-specific-failure"), "events should include verifier command name");
  assert(text.includes("VERIFIER_E2E_FAIL"), "events should include verifier stderr");
  assert(text.includes('"status":"failed"'), "events should include failed verification status");
  assert(events.events.some((event) => event.type === "error"), "events should include error event");

  const stderrLog = await readFile(
    path.join(tempDir, "runs", created.run.id, "logs", "verification-repo-specific-failure-stderr.log"),
    "utf8",
  );
  assert(stderrLog.includes("VERIFIER_E2E_FAIL"), "stderr log should include verifier output");
}

function buildRepoConfig(sourceRepoUrl: string): unknown {
  return {
    defaultVerify: [
      {
        name: "default-should-not-run",
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.error('DEFAULT_VERIFY_SHOULD_NOT_RUN'); process.exit(9);")}`,
        timeoutMs: 30_000,
      },
    ],
    repos: {
      "clone-pass-e2e": {
        displayName: "Clone pass fixture",
        gitUrl: sourceRepoUrl,
        defaultBranch: "main",
        verify: [
          {
            name: "clone-marker",
            command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("const fs=require('fs'); if (!fs.existsSync('CLONE_MARKER.txt')) process.exit(2); console.log('CLONE_MARKER_OK');")}`,
            timeoutMs: 30_000,
          },
        ],
      },
      "verifier-pass-e2e": {
        verify: [
          {
            name: "repo-specific-pass",
            command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('REPO_CONFIG_OK');")}`,
            timeoutMs: 30_000,
          },
        ],
      },
      "verifier-fail-e2e": {
        verify: [
          {
            name: "repo-specific-failure",
            command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.error('VERIFIER_E2E_FAIL'); process.exit(7);")}`,
            timeoutMs: 30_000,
          },
        ],
      },
    },
  };
}

async function createFixtureGitRepo(repoDir: string): Promise<void> {
  await mkdir(repoDir, { recursive: true });
  await runGit(["init", "-b", "main"], repoDir);
  await writeFile(path.join(repoDir, "CLONE_MARKER.txt"), "cloned workspace fixture\n", "utf8");
  await runGit(["add", "CLONE_MARKER.txt"], repoDir);
  await runGit(["-c", "user.name=TaskSmith E2E", "-c", "user.email=tasksmith@example.invalid", "commit", "-m", "Add clone marker"], repoDir);
}

async function runGit(args: readonly string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
