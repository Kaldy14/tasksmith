import { createHmac } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/domain/types.js";
import { handleQualityAuditNotification } from "../src/notifications/quality-audit.js";
import { handleQualityBaselineApproval } from "../src/notifications/quality-baseline.js";
import { rebuildQualityReportIndex } from "../src/notifications/quality-report-index.js";

const tempDir = await mkdtemp(path.join(tmpdir(), "tasksmith-quality-audit-"));
const reportsDir = path.join(tempDir, "reports");
const fixtureDir = path.join(tempDir, "fixture");
const fakeGhPath = path.join(tempDir, "gh");
const signingKey = "quality-audit-e2e-signing-key";
let slackPayload: unknown;

const slackServer = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    slackPayload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, channel: "CQUALITY", ts: "123.456" }));
  });
});

try {
  await mkdir(fixtureDir, { recursive: true });
  const summary = {
    schemaVersion: 1,
    generatedAt: "2026-07-29T12:00:00.000Z",
    functional: {
      status: "failed",
      total: 10,
      failed: 1,
      failures: [{ title: "branch form saves" }],
    },
    visual: {
      status: "changed",
      total: 8,
      changed: 1,
      errors: 0,
      changes: [{ title: "branch create form" }],
      failures: [],
    },
  };
  await writeFile(path.join(fixtureDir, "index.html"), "<h1>Quality report</h1>", "utf8");
  await writeFile(path.join(fixtureDir, "summary.json"), JSON.stringify(summary), "utf8");
  await mkdir(path.join(fixtureDir, "screenshots"), { recursive: true });
  await writeFile(
    path.join(fixtureDir, "screenshots", "branch-create-visual-chromium.png"),
    "fake png",
    "utf8",
  );
  await writeFile(
    path.join(fixtureDir, "screenshots", "branch-create-visual-chromium.json"),
    JSON.stringify({ schemaVersion: 1, captures: [] }),
    "utf8",
  );
  await writeFile(
    fakeGhPath,
    `#!/bin/sh
set -eu
destination=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--dir" ]; then
    shift
    destination=$1
  fi
  shift
done
test -n "$destination"
cp -R ${shellQuote(`${fixtureDir}/.`)} "$destination/"
`,
    "utf8",
  );
  await chmod(fakeGhPath, 0o755);

  await new Promise<void>((resolve) => {
    slackServer.listen(0, "127.0.0.1", resolve);
  });
  const address = slackServer.address();
  if (!address || typeof address === "string") throw new Error("Slack test server did not bind");
  const config = buildConfig(
    reportsDir,
    fakeGhPath,
    signingKey,
    `http://127.0.0.1:${address.port}`,
  );
  const payload = JSON.stringify({
    schemaVersion: 1,
    repository: "VosoBrands/hive-e2e",
    runId: 123,
    runAttempt: 1,
    artifactId: "456",
    artifactName: "quality-audit-123-1",
    eventName: "schedule",
    ref: "refs/heads/main",
    sha: "a".repeat(40),
    workflowUrl: "https://github.com/VosoBrands/hive-e2e/actions/runs/123",
    summary,
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = `sha256=${createHmac("sha256", signingKey).update(`${timestamp}.${payload}`).digest("hex")}`;
  const result = await handleQualityAuditNotification(
    config,
    {
      "x-tasksmith-timestamp": timestamp,
      "x-tasksmith-signature-256": signature,
    },
    Buffer.from(payload),
  );

  assertEqual(result.reportId, "run-123-1", "report id");
  assertEqual(result.slack.posted, true, "Slack delivery");
  assertEqual(
    await readFile(path.join(reportsDir, "run-123-1", "index.html"), "utf8"),
    "<h1>Quality report</h1>",
    "hosted report",
  );
  const approval = await handleQualityBaselineApproval(
    config,
    { "x-tasksmith-quality-proxy": "verified" },
    Buffer.from(JSON.stringify({ reportId: "run-123-1" })),
  );
  assertEqual(approval.approved, true, "baseline approval");
  assertEqual(
    approval.baseline.sourceSha,
    "a".repeat(40),
    "baseline source SHA",
  );
  assertEqual(
    await readFile(
      path.join(
        reportsDir,
        "approved-baseline",
        "screenshots",
        "branch-create-visual-chromium.png",
      ),
      "utf8",
    ),
    "fake png",
    "approved screenshot",
  );
  const baseline = JSON.parse(
    await readFile(
      path.join(reportsDir, "approved-baseline", "baseline.json"),
      "utf8",
    ),
  ) as unknown;
  assert(isRecord(baseline), "baseline metadata should be an object");
  assertEqual(baseline.sourceReportId, "run-123-1", "baseline source report");

  let untrustedApprovalRejected = false;
  try {
    await handleQualityBaselineApproval(
      config,
      {},
      Buffer.from(JSON.stringify({ reportId: "run-123-1" })),
    );
  } catch (error: unknown) {
    untrustedApprovalRejected =
      error instanceof Error &&
      "statusCode" in error &&
      error.statusCode === 403;
  }
  assert(
    untrustedApprovalRejected,
    "baseline approval outside the trusted proxy should be rejected",
  );
  const legacyReportDir = path.join(reportsDir, "run-122-1");
  await mkdir(legacyReportDir, { recursive: true });
  await writeFile(
    path.join(legacyReportDir, "summary.json"),
    JSON.stringify({ ...summary, generatedAt: "2026-07-28T12:00:00.000Z" }),
    "utf8",
  );
  await writeFile(
    path.join(legacyReportDir, "index.html"),
    "<h1>Legacy report</h1>",
    "utf8",
  );
  await rebuildQualityReportIndex(reportsDir);
  const reportIndex = await readFile(path.join(reportsDir, "index.html"), "utf8");
  assert(
    reportIndex.includes("Hive Admin quality historie"),
    "weekly report index should be generated",
  );
  assert(
    reportIndex.includes("run-123-1/screenshots/branch-create-visual-chromium.png"),
    "weekly report index should include screenshot previews",
  );
  assert(
    !reportIndex.includes("run-122-1/screenshots/index.html"),
    "legacy reports without screenshots should not show a screenshot link",
  );
  assert(isRecord(slackPayload), "Slack payload should be an object");
  assertEqual(slackPayload.channel, "CQUALITY", "Slack channel");

  let rejected = false;
  try {
    await handleQualityAuditNotification(
      config,
      {
        "x-tasksmith-timestamp": timestamp,
        "x-tasksmith-signature-256": "sha256=invalid",
      },
      Buffer.from(payload),
    );
  } catch (error: unknown) {
    rejected =
      error instanceof Error &&
      "statusCode" in error &&
      error.statusCode === 401;
  }
  assert(rejected, "invalid signature should be rejected");
  console.log("quality audit e2e passed");
} finally {
  await new Promise<void>((resolve) => slackServer.close(() => resolve()));
  await rm(tempDir, { recursive: true, force: true });
}

function buildConfig(
  reportsDir: string,
  ghCommand: string,
  webhookSecret: string,
  slackApiUrl: string,
): AppConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: reportsDir,
    runsDir: path.join(reportsDir, "runs"),
    stateDir: path.join(reportsDir, "state"),
    piAuthSourceDir: path.join(reportsDir, "pi-auth"),
    publicDir: path.join(reportsDir, "public"),
    publicBaseUrl: "https://tasksmith.example.test",
    auth: {
      enabled: false,
      baseUrl: "https://tasksmith.example.test",
      trustedOrigins: [],
    },
    repositories: {},
    sourceFlow: {
      readinessLabel: "tasksmith",
      pollIntervalSeconds: 60,
      jiraRepoRouting: { strategy: "label", labels: {} },
    },
    githubWebhooks: { enabled: false },
    jiraWebhooks: { enabled: false },
    qualityAudit: {
      enabled: true,
      signingKey: webhookSecret,
      repository: "VosoBrands/hive-e2e",
      allowedRef: "refs/heads/main",
      ghCommand,
      ghConfigDir: reportsDir,
      reportsDir,
      reportsPublicUrl: "https://reports.example.test",
      slackBotToken: "test-token",
      slackChannelId: "CQUALITY",
      slackApiUrl,
      notifyOnClean: false,
    },
    workflow: {
      type: "single_task_sandcastle",
      stages: ["plan", "implement", "deep_review", "fix", "deliver"],
      maxFixAttempts: 0,
      maxCiFixAttempts: 0,
      maxReviewFixAttempts: 0,
      ciPollIntervalMs: 1_000,
      ciTimeoutMs: 1_000,
      deliveryMode: "ready_pr",
    },
    verification: { defaultCommands: [] },
    queue: { leaseTimeoutMs: 120_000, heartbeatIntervalMs: 30_000 },
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assert(value: boolean, message: string): asserts value {
  if (!value) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}
