#!/usr/bin/env tsx

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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
  const verificationCommands = [
    {
      name: "intentional-failure",
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.error('VERIFIER_E2E_FAIL'); process.exit(7);")}`,
      timeoutMs: 30_000,
    },
  ];
  const server = spawn(tsxBin, [serverScript], {
    cwd: rootDir,
    env: {
      ...process.env,
      TASKSMITH_DATA_DIR: tempDir,
      TASKSMITH_VERIFICATION_COMMANDS: JSON.stringify(verificationCommands),
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
      title: "Verifier failure e2e",
      repoKey: "verifier-e2e",
      adapter: "demo",
      prompt: "Produce deterministic event stream before failing verification.",
    });

    const failedRun = await waitForRunStatus(baseUrl, created.run.id, "failed", 20_000);
    assert(failedRun.run.error?.includes("Verification failed") === true, "run error should mention verification failure");

    const events = await getJson<EventsResponse>(`${baseUrl}/api/runs/${created.run.id}/events`);
    const text = JSON.stringify(events);
    assert(text.includes("intentional-failure"), "events should include verifier command name");
    assert(text.includes("VERIFIER_E2E_FAIL"), "events should include verifier stderr");
    assert(text.includes('"status":"failed"'), "events should include failed verification status");
    assert(events.events.some((event) => event.type === "error"), "events should include error event");

    const stderrLog = await readFile(
      path.join(tempDir, "runs", created.run.id, "logs", "verification-intentional-failure-stderr.log"),
      "utf8",
    );
    assert(stderrLog.includes("VERIFIER_E2E_FAIL"), "stderr log should include verifier output");

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
