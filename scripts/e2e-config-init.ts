#!/usr/bin/env tsx

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

interface ConfigResponse {
  path?: string;
  writable: boolean;
  config: unknown;
}

interface RunResponse {
  run: { id: string; status: string; error?: string };
}

interface EventsResponse {
  events: Array<{ sequence: number; type: string; data: Record<string, unknown> }>;
}

const rootDir = process.cwd();
const tsxBin = path.join(rootDir, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const serverScript = path.join(rootDir, "src", "server", "index.ts");

async function main(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasksmith-config-init-e2e-"));
  const sourceRepoDir = path.join(tempDir, "source-repo");
  const configPath = path.join(tempDir, "tasksmith-config.json");
  const port = 37_210 + Math.floor(Math.random() * 1000);

  await createFixtureGitRepo(sourceRepoDir);
  await writeFile(configPath, JSON.stringify(buildInitialConfig(pathToFileURL(sourceRepoDir).href), null, 2), "utf8");

  const server = spawn(tsxBin, [serverScript], {
    cwd: rootDir,
    env: {
      ...process.env,
      TASKSMITH_DATA_DIR: tempDir,
      TASKSMITH_CONFIG_PATH: configPath,
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

    const editable = await getJson<ConfigResponse>(`${baseUrl}/api/admin/config`);
    assertEqual(editable.writable, true, "config should be writable with TASKSMITH_CONFIG_PATH");
    assertEqual(editable.path, configPath, "config path");

    const updatedConfig = buildUpdatedConfig(pathToFileURL(sourceRepoDir).href);
    await putJson<ConfigResponse>(`${baseUrl}/api/admin/config`, updatedConfig);
    const savedText = await readFile(configPath, "utf8");
    assert(savedText.includes("copy-env"), "config file should include saved init command");
    assert(savedText.includes("squash_merge_main"), "config file should include repo delivery mode setting");

    const created = await postJson<RunResponse>(`${baseUrl}/api/runs`, {
      title: "Config init e2e",
      repoKey: "config-init-e2e",
      adapter: "demo",
      prompt: "Run after config-defined workspace init commands.",
    });
    const completed = await waitForRunStatus(baseUrl, created.run.id, "completed", 25_000);
    assert(completed.run.error === undefined, "run should complete without error");

    const workspaceDir = path.join(tempDir, "runs", created.run.id, "workspace");
    const initMarker = await readFile(path.join(workspaceDir, "INIT_MARKER.txt"), "utf8");
    assert(initMarker.includes("INIT_OK"), "init command should create marker before runtime");
    const envLocal = await readFile(path.join(workspaceDir, ".env.local"), "utf8");
    assert(envLocal.includes("LOCAL_ONLY"), "init command should copy local env file");
    await assertGitIgnored(workspaceDir, ".env.local");

    const events = await getJson<EventsResponse>(`${baseUrl}/api/runs/${created.run.id}/events`);
    const eventText = JSON.stringify(events);
    assert(eventText.includes("init:copy-env"), "events should include init command");
    assert(eventText.includes("INIT_OK"), "events should include init command output");

    console.log("Config init e2e passed");
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

function buildInitialConfig(sourceRepoUrl: string): unknown {
  return {
    workflow: {
      type: "single_task_sandcastle",
      stages: ["plan", "implement", "deep_review", "fix", "deliver"],
      maxFixAttempts: 1,
      deliveryMode: "ready_pr",
    },
    repos: {
      "config-init-e2e": {
        displayName: "Config init E2E",
        gitUrl: sourceRepoUrl,
        defaultBranch: "main",
        verify: [
          {
            name: "init-marker-exists",
            command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("const fs=require('fs'); if (!fs.existsSync('INIT_MARKER.txt')) process.exit(2); console.log('INIT_MARKER_VERIFY_OK');")}`,
            timeoutMs: 30_000,
          },
        ],
      },
    },
  };
}

function buildUpdatedConfig(sourceRepoUrl: string): unknown {
  const config = buildInitialConfig(sourceRepoUrl) as {
    repos: Record<string, Record<string, unknown>>;
  };
  config.repos["config-init-e2e"] = {
    ...config.repos["config-init-e2e"],
    initCommands: [
      {
        name: "copy-env",
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("const fs=require('fs'); fs.writeFileSync('.env.local', 'LOCAL_ONLY=1\\n'); fs.writeFileSync('INIT_MARKER.txt', 'INIT_OK\\n'); console.log('INIT_OK');")}`,
        timeoutMs: 30_000,
      },
    ],
  };
  config.repos["unused-squash-e2e"] = {
    displayName: "Unused squash fixture",
    workflow: {
      type: "single_task_sandcastle",
      stages: ["plan", "implement", "deep_review", "fix", "deliver"],
      maxFixAttempts: 1,
      deliveryMode: "squash_merge_main",
      mergeTargetBranch: "main",
    },
  };
  return config;
}

async function createFixtureGitRepo(repoDir: string): Promise<void> {
  await mkdir(repoDir, { recursive: true });
  await runGit(["init", "-b", "main"], repoDir);
  await writeFile(path.join(repoDir, "README.md"), "# Config init fixture\n", "utf8");
  await runGit(["add", "README.md"], repoDir);
  await runGit(["-c", "user.name=TaskSmith E2E", "-c", "user.email=tasksmith@example.invalid", "commit", "-m", "Initial fixture"], repoDir);
}

async function assertGitIgnored(cwd: string, file: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["check-ignore", file], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`expected ${file} to be git-ignored: ${stderr}`));
    });
  });
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

async function putJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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
