#!/usr/bin/env tsx

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";

interface RunResponse {
  run: { id: string; status: string; adapter: string; title: string };
}

interface EventsResponse {
  events: Array<{ sequence: number; type: string; data: Record<string, unknown> }>;
}

const rootDir = process.cwd();
const tsxBin = path.join(rootDir, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const serverScript = path.join(rootDir, "src", "server", "index.ts");

async function main(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasksmith-manual-run-e2e-"));
  const port = 33_210 + Math.floor(Math.random() * 1000);
  const server = spawn(tsxBin, [serverScript], {
    cwd: rootDir,
    env: { ...process.env, TASKSMITH_DATA_DIR: tempDir, PORT: String(port), HOST: "127.0.0.1" },
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
      title: "Manual run API e2e",
      repoKey: "manual-e2e",
      adapter: "demo",
      prompt: "Produce deterministic event stream for API e2e.",
    });
    assertEqual(created.run.adapter, "demo", "created adapter");

    const socketEvents: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/runs/${created.run.id}/stream`);
    ws.on("message", (raw) => {
      const payload = JSON.parse(raw.toString("utf8")) as { type: string; event?: { type: string } };
      if (payload.type === "event" && payload.event) socketEvents.push(payload.event.type);
    });
    await waitForSocketOpen(ws);

    await delay(500);
    await postJson(`${baseUrl}/api/runs/${created.run.id}/messages`, { kind: "steer", message: "API_E2E_STEER" });
    await postJson(`${baseUrl}/api/runs/${created.run.id}/messages`, { kind: "follow_up", message: "API_E2E_FOLLOW_UP" });
    await waitForRunStatus(baseUrl, created.run.id, "completed", 20_000);

    const events = await getJson<EventsResponse>(`${baseUrl}/api/runs/${created.run.id}/events`);
    const text = JSON.stringify(events);
    assert(text.includes("API_E2E_STEER"), "events should include steer text");
    assert(text.includes("API_E2E_FOLLOW_UP"), "events should include follow-up text");
    assert(events.events.some((event) => event.type === "assistant_delta"), "events should include assistant deltas");
    assert(events.events.some((event) => event.type === "tool_call"), "events should include tool calls");
    assert(events.events.some((event) => event.type === "attempt_done"), "events should include attempt_done");
    assert(events.events.some((event) => event.type === "verification"), "events should include verification");
    assert(text.includes("workspace smoke ok"), "events should include verifier output");
    assert(socketEvents.includes("assistant_delta"), "websocket should stream assistant_delta");

    ws.close();
    console.log("Manual run API e2e passed");
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

async function waitForRunStatus(baseUrl: string, runId: string, status: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { run } = await getJson<RunResponse>(`${baseUrl}/api/runs/${runId}`);
    if (run.status === status) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for run status ${status}`);
}

async function waitForSocketOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (error) => reject(error));
  });
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  return parseResponse<T>(response);
}

async function postJson<T = { ok: boolean }>(url: string, body: unknown): Promise<T> {
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
