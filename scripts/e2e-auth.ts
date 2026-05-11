#!/usr/bin/env tsx

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { createTaskSmithAuthService } from "../src/auth/tasksmith-auth.js";
import { loadConfig } from "../src/server/config.js";
import { PostgresMetadataIndex } from "../src/storage/postgres-metadata-index.js";

const baseDatabaseUrl = process.env.TASKSMITH_TEST_DATABASE_URL;
const rootDir = process.cwd();
const tsxBin = path.join(rootDir, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const serverScript = path.join(rootDir, "src", "server", "index.ts");

async function main(): Promise<void> {
  if (!baseDatabaseUrl) {
    console.log("Better Auth e2e skipped; set TASKSMITH_TEST_DATABASE_URL to run it.");
    return;
  }

  const schema = `tasksmith_auth_e2e_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  assertSafeIdentifier(schema);
  const adminPool = new Pool({ connectionString: baseDatabaseUrl, application_name: "tasksmith-auth-e2e-admin" });
  const databaseUrl = withSearchPath(baseDatabaseUrl, schema);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasksmith-auth-e2e-"));
  const port = 34_200 + Math.floor(Math.random() * 1000);
  const secret = "tasksmith-auth-e2e-secret-with-more-than-32-bytes";
  const email = `admin-${Date.now()}@example.test`;
  const password = "tasksmith-auth-e2e-password";

  const previousEnv = snapshotEnv([
    "TASKSMITH_DATA_DIR",
    "TASKSMITH_DATABASE_URL",
    "TASKSMITH_AUTH_ENABLED",
    "TASKSMITH_AUTH_SECRET",
    "TASKSMITH_PUBLIC_URL",
    "BETTER_AUTH_URL",
    "PORT",
    "HOST",
  ]);

  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    process.env.TASKSMITH_DATA_DIR = tempDir;
    process.env.TASKSMITH_DATABASE_URL = databaseUrl;
    process.env.TASKSMITH_AUTH_ENABLED = "1";
    process.env.TASKSMITH_AUTH_SECRET = secret;
    process.env.TASKSMITH_PUBLIC_URL = `http://127.0.0.1:${port}`;
    process.env.BETTER_AUTH_URL = `http://127.0.0.1:${port}`;
    process.env.PORT = String(port);
    process.env.HOST = "127.0.0.1";

    const migrated = new PostgresMetadataIndex(databaseUrl);
    await migrated.init();
    await migrated.close();

    const bootstrapAuth = createTaskSmithAuthService(loadConfig(), { allowSignUp: true });
    if (!bootstrapAuth) throw new Error("Expected auth service");
    try {
      await bootstrapAuth.auth.api.signUpEmail({ body: { name: "Auth E2E", email, password, rememberMe: false } });
    } finally {
      await bootstrapAuth.close();
    }

    const server = spawn(tsxBin, [serverScript], {
      cwd: rootDir,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    server.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    server.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

    try {
      const baseUrl = `http://127.0.0.1:${port}`;
      await waitForHealth(baseUrl, 20_000);

      const anonymousRuns = await fetch(`${baseUrl}/api/runs`);
      assertEqual(anonymousRuns.status, 401, "anonymous API should be rejected");

      const anonymousPage = await fetch(`${baseUrl}/config`, { redirect: "manual" });
      assertEqual(anonymousPage.status, 302, "anonymous UI page should redirect");
      assertEqual(anonymousPage.headers.get("location"), "/login", "anonymous UI redirect location");

      const ok = await getJson<{ status?: string; ok?: boolean }>(`${baseUrl}/api/auth/ok`);
      assert(ok.status === "ok" || ok.ok === true, "Better Auth ok endpoint should respond successfully");

      const signIn = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseUrl },
        body: JSON.stringify({ email, password, rememberMe: true }),
      });
      const cookie = extractCookie(signIn.headers);
      assert(signIn.ok, `sign-in failed: ${await signIn.text()}`);
      assert(cookie.length > 0, "sign-in should set cookies");

      const runs = await fetch(`${baseUrl}/api/runs`, { headers: { cookie } });
      assertEqual(runs.status, 200, "authenticated API should pass");

      const config = await fetch(`${baseUrl}/config`, { headers: { cookie }, redirect: "manual" });
      assertEqual(config.status, 200, "authenticated UI page should load");

      console.log("Better Auth e2e passed");
    } finally {
      server.kill("SIGTERM");
      await delay(300);
      if (server.exitCode === null) server.kill("SIGKILL");
      if (process.env.TASKSMITH_KEEP_E2E_ARTIFACTS === "1") {
        console.log(`Keeping artifacts at ${tempDir}`);
        console.log(stdout);
        console.error(stderr);
      }
    }
  } finally {
    restoreEnv(previousEnv);
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
    if (process.env.TASKSMITH_KEEP_E2E_ARTIFACTS !== "1") await rm(tempDir, { recursive: true, force: true });
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

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

function extractCookie(headers: Headers): string {
  const getSetCookie = headers.getSetCookie?.() ?? [];
  const raw = getSetCookie.length > 0 ? getSetCookie : [headers.get("set-cookie") ?? ""];
  return raw
    .filter((value) => value.length > 0)
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

function withSearchPath(databaseUrl: string, schema: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

function assertSafeIdentifier(value: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
}

function snapshotEnv(keys: string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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
