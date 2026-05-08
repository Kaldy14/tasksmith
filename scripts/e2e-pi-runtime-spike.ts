#!/usr/bin/env tsx

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface RunCommandOptions {
  input?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  expectFailure?: boolean;
}

interface JsonEventLine {
  version: 1;
  id: string;
  runId: string;
  attemptId: string;
  sequence: number;
  type: string;
  createdAt: string;
  data: Record<string, unknown>;
}

const rootDir = process.cwd();
const tsxBin = path.join(rootDir, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const spikeScript = path.join(rootDir, "scripts", "pi-runtime-spike.ts");

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "tasksmith-pi-spike-e2e-"));
  const runRoot = path.join(tempRoot, "runs");
  const homeDir = path.join(tempRoot, "home");
  const emptyAgentDir = path.join(tempRoot, "empty-agent");
  await mkdir(emptyAgentDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });

  const scrubbedEnv = buildScrubbedEnv(homeDir);
  const results: string[] = [];

  try {
    await testHelp(results, scrubbedEnv);
    await testAuthCheck(results, runRoot, emptyAgentDir, scrubbedEnv);
    await testReplay(results, runRoot, scrubbedEnv);
    await testInspect(results, runRoot, scrubbedEnv);
    await testFailedRunIsolation(results, runRoot, emptyAgentDir, scrubbedEnv);

    if (process.env.TASKSMITH_REAL_PI_E2E === "1") {
      await testRealPiControl(results, runRoot);
      await testRealPiAbort(results, runRoot);
    } else {
      results.push("SKIP real Pi control/abort tests (set TASKSMITH_REAL_PI_E2E=1 to run against authenticated Pi)");
    }

    console.log("\nPi runtime spike e2e results:");
    for (const result of results) console.log(`- ${result}`);
  } finally {
    if (process.env.TASKSMITH_KEEP_E2E_ARTIFACTS === "1") {
      console.log(`Keeping e2e artifacts at ${tempRoot}`);
    } else {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

async function testHelp(results: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const result = await runSpike(["help"], { env });
  assertIncludes(result.stdout, "TaskSmith Pi runtime spike", "help output title");
  assertIncludes(result.stdout, "/steer <text>", "help output controls");
  results.push("help command prints runtime/control usage");
}

async function testAuthCheck(results: string[], runRoot: string, emptyAgentDir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const result = await runSpike(["auth-check", "--run-id", "auth-e2e", "--run-root", runRoot, "--source-agent-dir", emptyAgentDir], { env });
  const parsed = parseFirstJsonObject(result.stdout);
  const copiedFiles = getStringArray(parsed, "copiedFiles");
  assert(copiedFiles.includes("settings.json"), "auth-check should generate per-run settings.json");
  assert(!copiedFiles.includes("auth.json"), "auth-check should not claim auth.json was copied when source has none");
  assert(!result.stdout.includes("sk-"), "auth-check stdout must not print API-key-looking strings");
  results.push("auth-check uses per-run agent dir and does not print secrets");
}

async function testReplay(results: string[], runRoot: string, env: NodeJS.ProcessEnv): Promise<void> {
  const runId = "replay-e2e";
  const eventsDir = path.join(runRoot, runId, "events");
  await mkdir(eventsDir, { recursive: true });
  const events: JsonEventLine[] = [
    makeEvent(runId, 1, "run_status", { type: "run_status", status: "running", detail: "test" }),
    makeEvent(runId, 2, "user_message", { type: "user_message", control: "prompt", text: "hello replay", delivery: "accepted" }),
    makeEvent(runId, 3, "assistant_message", { type: "assistant_message", text: "assistant replay ok", stopReason: "stop" }),
    makeEvent(runId, 4, "attempt_done", { type: "attempt_done", status: "completed", summary: "done" }),
  ];
  await writeFile(path.join(eventsDir, "tasksmith-events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");

  const result = await runSpike(["replay", "--run-id", runId, "--run-root", runRoot], { env });
  assertIncludes(result.stdout, "hello replay", "replay user message");
  assertIncludes(result.stdout, "assistant replay ok", "replay assistant message");
  assertIncludes(result.stdout, "attempt_done", "replay attempt done");
  results.push("replay reconstructs persisted normalized events without Pi");
}

async function testInspect(results: string[], runRoot: string, env: NodeJS.ProcessEnv): Promise<void> {
  const runId = "inspect-e2e";
  const runDir = path.join(runRoot, runId);
  const workspaceDir = path.join(runDir, "workspace");
  const sessionDir = path.join(runDir, "pi-session");
  const sessionFile = path.join(sessionDir, "session.jsonl");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await writeFile(sessionFile, buildSessionJsonl(workspaceDir), "utf8");
  await writeFile(
    path.join(runDir, "metadata.json"),
    JSON.stringify(
      {
        runId,
        attemptId: "attempt-1",
        createdAt: new Date().toISOString(),
        runDir,
        workspaceDir,
        agentDir: path.join(runDir, "home", ".pi", "agent"),
        sessionDir,
        normalizedEventsPath: path.join(runDir, "events", "tasksmith-events.jsonl"),
        rawEventsPath: path.join(runDir, "events", "pi-raw.jsonl"),
        sessionFile,
        sessionId: "00000000-0000-4000-8000-000000000000",
        pi: { integration: "sdk", package: "@mariozechner/pi-coding-agent" },
        auth: { sourceAgentDir: "test", copiedFiles: [] },
      },
      null,
      2,
    ),
    "utf8",
  );

  const result = await runSpike(["inspect", "--run-id", runId, "--run-root", runRoot], { env });
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  assertEqual(parsed.runId, runId, "inspect runId");
  assertIncludes(result.stdout, "hello inspect", "inspect user message");
  assertIncludes(result.stdout, "assistant inspect ok", "inspect assistant message");
  results.push("inspect opens persisted Pi session JSONL and summarizes messages");
}

async function testFailedRunIsolation(results: string[], runRoot: string, emptyAgentDir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const sourceWorkspace = path.join(path.dirname(runRoot), "source-workspace");
  await mkdir(path.join(sourceWorkspace, ".git"), { recursive: true });
  await mkdir(path.join(sourceWorkspace, ".pi"), { recursive: true });
  await mkdir(path.join(sourceWorkspace, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(sourceWorkspace, "safe.txt"), "safe\n", "utf8");
  await writeFile(path.join(sourceWorkspace, ".env"), "SECRET=do-not-copy\n", "utf8");
  await writeFile(path.join(sourceWorkspace, ".pi", "auth.json"), "{\"anthropic\":{\"key\":\"sk-should-not-copy\"}}\n", "utf8");
  await writeFile(path.join(sourceWorkspace, ".git", "config"), "[remote]\n", "utf8");
  await writeFile(path.join(sourceWorkspace, "secret.pem"), "pem\n", "utf8");
  await writeFile(path.join(sourceWorkspace, "node_modules", "pkg", "index.js"), "module.exports = 1;\n", "utf8");

  const runId = "failed-run-e2e";
  const result = await runSpike(
    ["run", "--run-id", runId, "--run-root", runRoot, "--source-agent-dir", emptyAgentDir, "--workspace", sourceWorkspace, "--prompt", "This should fail before model use because auth is absent."],
    { env, input: "/quit\n", expectFailure: true, timeoutMs: 60_000 },
  );
  assert(result.code !== 0, "run without auth should fail after persisting failure events");

  const copiedSafe = await fileExists(path.join(runRoot, runId, "workspace", "safe.txt"));
  const copiedEnv = await fileExists(path.join(runRoot, runId, "workspace", ".env"));
  const copiedPiAuth = await fileExists(path.join(runRoot, runId, "workspace", ".pi", "auth.json"));
  const copiedGitConfig = await fileExists(path.join(runRoot, runId, "workspace", ".git", "config"));
  const copiedPem = await fileExists(path.join(runRoot, runId, "workspace", "secret.pem"));
  const copiedNodeModule = await fileExists(path.join(runRoot, runId, "workspace", "node_modules", "pkg", "index.js"));
  assert(copiedSafe, "safe workspace file should be copied");
  assert(!copiedEnv, ".env should not be copied into run workspace");
  assert(!copiedPiAuth, ".pi auth should not be copied from workspace");
  assert(!copiedGitConfig, ".git should not be copied into run workspace");
  assert(!copiedPem, "*.pem should not be copied into run workspace");
  assert(!copiedNodeModule, "node_modules should not be copied into run workspace");

  const normalizedEvents = await readFile(path.join(runRoot, runId, "events", "tasksmith-events.jsonl"), "utf8");
  assertIncludes(normalizedEvents, "\"type\":\"error\"", "failed run error event");
  assertIncludes(normalizedEvents, "\"status\":\"failed\"", "failed run status event");
  assert(!normalizedEvents.includes("sk-should-not-copy"), "normalized events must not contain workspace secret fixture");
  results.push("failed no-auth run still creates isolated workspace, filters secrets, and persists failure events");
}

async function testRealPiControl(results: string[], runRoot: string): Promise<void> {
  const runId = "real-pi-control-e2e";
  const child = spawn(tsxBin, [spikeScript, "run", "--run-id", runId, "--run-root", runRoot, "--prompt", "For this TaskSmith e2e test, run `sleep 6; echo TASKSMITH_E2E_SLEEP_DONE` with bash, then summarize the workspace in one short paragraph. Do not edit files."], {
    cwd: rootDir,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const normalizedEventsPath = path.join(runRoot, runId, "events", "tasksmith-events.jsonl");
  try {
    await waitForText(() => stdout, "Control loop ready", 20_000);
    child.stdin.write("/steer Include the exact marker TASKSMITH_STEER_OK in the final summary.\n");
    child.stdin.write("/follow-up Reply once more with exactly TASKSMITH_FOLLOWUP_OK.\n");
    await waitForFileIncludes(normalizedEventsPath, '"control":"steer"', 20_000);
    await waitForFileIncludes(normalizedEventsPath, '"control":"follow_up"', 20_000);
    child.stdin.write("/quit\n");
    child.stdin.end();
  } catch (error: unknown) {
    child.kill("SIGTERM");
    throw error;
  }

  const code = await waitForExit(child, 180_000);
  if (code !== 0) {
    throw new Error(`real Pi control e2e failed with code ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  }

  const normalizedEvents = await readFile(normalizedEventsPath, "utf8");
  assertIncludes(normalizedEvents, "\"control\":\"steer\"", "real steer control event");
  assertIncludes(normalizedEvents, "\"control\":\"follow_up\"", "real follow-up control event");
  assertIncludes(normalizedEvents, "\"delivery\":\"accepted\"", "real control accepted event");
  assertIncludes(normalizedEvents, "TASKSMITH", "real marker presence in normalized events");
  results.push("real authenticated Pi run accepts steer/follow-up and stores normalized events");
}

async function testRealPiAbort(results: string[], runRoot: string): Promise<void> {
  const runId = "real-pi-abort-e2e";
  const child = spawn(tsxBin, [spikeScript, "run", "--run-id", runId, "--run-root", runRoot, "--prompt", "For this TaskSmith abort e2e test, run `sleep 20; echo TASKSMITH_ABORT_SHOULD_NOT_FINISH` with bash before answering. Do not edit files."], {
    cwd: rootDir,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  await waitForText(() => stdout, "Control loop ready", 20_000);
  await delay(1_000);
  child.stdin.write("/abort\n");
  child.stdin.end();

  const code = await waitForExit(child, 90_000);
  if (code !== 0) {
    throw new Error(`real Pi abort e2e failed with code ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  }

  const normalizedEvents = await readFile(path.join(runRoot, runId, "events", "tasksmith-events.jsonl"), "utf8");
  assertIncludes(normalizedEvents, "\"status\":\"aborted\"", "real abort status event");
  assertIncludes(normalizedEvents, "\"type\":\"attempt_done\"", "real abort attempt_done event");
  assertIncludes(normalizedEvents, "\"status\":\"aborted\"", "real abort attempt status");
  results.push("real authenticated Pi run aborts active work and persists aborted status");
}

async function runSpike(args: string[], options: RunCommandOptions = {}): Promise<CommandResult> {
  const child = spawn(tsxBin, [spikeScript, ...args], {
    cwd: rootDir,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  if (options.input) child.stdin.end(options.input);
  else child.stdin.end();

  const code = await waitForExit(child, options.timeoutMs ?? 30_000);
  const result = { code, stdout, stderr };
  if (!options.expectFailure && code !== 0) {
    throw new Error(`Command failed: ${args.join(" ")}\nExit: ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  }
  return result;
}

async function waitForText(read: () => string, expected: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (read().includes(expected)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for text: ${expected}`);
}

async function waitForFileIncludes(filePath: string, expected: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const text = await readFile(filePath, "utf8");
      if (text.includes(expected)) return;
    } catch {
      // File may not exist yet.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${expected} in ${filePath}`);
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

function buildScrubbedEnv(homeDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, PI_CODING_AGENT_DIR: path.join(homeDir, ".pi", "agent") };
  const secretEnvKeys = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "GEMINI_API_KEY",
    "MISTRAL_API_KEY",
    "GROQ_API_KEY",
    "CEREBRAS_API_KEY",
    "CLOUDFLARE_API_KEY",
    "XAI_API_KEY",
    "OPENROUTER_API_KEY",
    "AI_GATEWAY_API_KEY",
    "ZAI_API_KEY",
    "OPENCODE_API_KEY",
    "HF_TOKEN",
    "FIREWORKS_API_KEY",
    "KIMI_API_KEY",
    "MINIMAX_API_KEY",
    "MINIMAX_CN_API_KEY",
    "XIAOMI_API_KEY",
    "XIAOMI_TOKEN_PLAN_CN_API_KEY",
    "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
    "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
    "GOOGLE_APPLICATION_CREDENTIALS",
  ];
  for (const key of secretEnvKeys) delete env[key];
  return env;
}

function makeEvent(runId: string, sequence: number, type: string, data: Record<string, unknown>): JsonEventLine {
  return {
    version: 1,
    id: `${runId}-${sequence}`,
    runId,
    attemptId: "attempt-1",
    sequence,
    type,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    data,
  };
}

function buildSessionJsonl(cwd: string): string {
  const now = Date.now();
  const usage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const lines = [
    { type: "session", version: 3, id: "00000000-0000-4000-8000-000000000000", timestamp: new Date(now).toISOString(), cwd },
    { type: "message", id: "a1b2c3d4", parentId: null, timestamp: new Date(now + 1).toISOString(), message: { role: "user", content: "hello inspect", timestamp: now + 1 } },
    {
      type: "message",
      id: "b2c3d4e5",
      parentId: "a1b2c3d4",
      timestamp: new Date(now + 2).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "assistant inspect ok" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "test-model",
        usage,
        stopReason: "stop",
        timestamp: now + 2,
      },
    },
  ];
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

function parseFirstJsonObject(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error(`No JSON object in stdout: ${stdout}`);
  return JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
}

function getStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`Expected ${key} to be string[]`);
  }
  return value;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function assert(value: boolean, message: string): asserts value {
  if (!value) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertIncludes(value: string, expected: string, message: string): void {
  if (!value.includes(expected)) throw new Error(`${message}: expected output to include ${JSON.stringify(expected)}\nOutput:\n${value}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
