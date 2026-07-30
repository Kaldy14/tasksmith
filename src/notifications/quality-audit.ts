import { createHmac, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import type { AppConfig, QualityAuditConfig } from "../domain/types.js";
import { rebuildQualityReportIndex } from "./quality-report-index.js";

const execFileAsync = promisify(execFile);
const SIGNATURE_MAX_SKEW_SECONDS = 10 * 60;
const ARTIFACT_NAME_PATTERN = /^quality-audit-([1-9][0-9]*)-([1-9][0-9]*)$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

interface TestFailure {
  title: string;
  file?: string;
}

interface QualityAuditSummary {
  schemaVersion: 1;
  generatedAt: string;
  functional: {
    status: "passed" | "failed" | "error";
    total: number;
    failed: number;
    failures: TestFailure[];
  };
  visual: {
    status: "unchanged" | "changed" | "error";
    total: number;
    changed: number;
    errors: number;
    changes: TestFailure[];
    failures: TestFailure[];
  };
}

interface QualityAuditPayload {
  schemaVersion: 1;
  repository: string;
  runId: number;
  runAttempt: number;
  artifactId: string;
  artifactName: string;
  eventName: "schedule" | "workflow_dispatch";
  ref: string;
  sha: string;
  workflowUrl: string;
  summary: QualityAuditSummary;
}

export interface QualityAuditResult {
  accepted: true;
  reportId: string;
  reportUrl: string;
  slack: { posted: boolean; channel?: string; ts?: string };
}

export async function handleQualityAuditNotification(
  config: AppConfig,
  headers: IncomingHttpHeaders,
  rawBody: Buffer,
): Promise<QualityAuditResult> {
  if (!config.qualityAudit.enabled) {
    throw statusError("Quality audits are disabled", 404);
  }
  verifySignature(config.qualityAudit.signingKey, headers, rawBody);
  const payload = parsePayload(config.qualityAudit, rawBody);
  const reportId = `run-${payload.runId}-${payload.runAttempt}`;
  await downloadReport(config.qualityAudit, payload, reportId);
  await rebuildQualityReportIndex(config.qualityAudit.reportsDir);
  const reportUrl = `${config.qualityAudit.reportsPublicUrl.replace(/\/+$/, "")}/${reportId}/`;
  const slack = await notifySlack(
    config.qualityAudit,
    payload,
    reportUrl,
  );
  return { accepted: true, reportId, reportUrl, slack };
}

function verifySignature(
  signingKey: string,
  headers: IncomingHttpHeaders,
  rawBody: Buffer,
): void {
  const timestampHeader = firstHeader(headers["x-tasksmith-timestamp"]);
  const signatureHeader = firstHeader(
    headers["x-tasksmith-signature-256"],
  );
  if (!timestampHeader || !signatureHeader) {
    throw statusError("Missing quality audit webhook signature", 401);
  }
  const timestamp = Number.parseInt(timestampHeader, 10);
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isInteger(timestamp) ||
    Math.abs(now - timestamp) > SIGNATURE_MAX_SKEW_SECONDS
  ) {
    throw statusError("Invalid or stale quality audit timestamp", 401);
  }
  const expected = `sha256=${createHmac("sha256", signingKey)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest("hex")}`;
  if (!constantTimeEquals(signatureHeader, expected)) {
    throw statusError("Invalid quality audit webhook signature", 401);
  }
}

function parsePayload(
  config: Extract<QualityAuditConfig, { enabled: true }>,
  rawBody: Buffer,
): QualityAuditPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8")) as unknown;
  } catch {
    throw statusError("Quality audit payload must be valid JSON", 400);
  }
  const record = expectRecord(parsed, "quality audit payload");
  if (record.schemaVersion !== 1) {
    throw statusError("Unsupported quality audit schemaVersion", 400);
  }
  const repository = requiredString(record.repository, "repository", 200);
  if (repository !== config.repository) {
    throw statusError("Quality audit repository is not allowed", 403);
  }
  const runId = positiveInteger(record.runId, "runId");
  const runAttempt = positiveInteger(record.runAttempt, "runAttempt");
  const artifactId = requiredString(record.artifactId, "artifactId", 40);
  if (!/^[1-9][0-9]*$/.test(artifactId)) {
    throw statusError("artifactId must be a positive integer string", 400);
  }
  const artifactName = requiredString(
    record.artifactName,
    "artifactName",
    120,
  );
  const artifactMatch = ARTIFACT_NAME_PATTERN.exec(artifactName);
  if (
    !artifactMatch ||
    Number.parseInt(artifactMatch[1] ?? "", 10) !== runId ||
    Number.parseInt(artifactMatch[2] ?? "", 10) !== runAttempt
  ) {
    throw statusError("artifactName does not match the workflow run", 400);
  }
  const eventName = requiredString(record.eventName, "eventName", 40);
  if (eventName !== "schedule" && eventName !== "workflow_dispatch") {
    throw statusError("Quality audits only accept scheduled or manual runs", 400);
  }
  const ref = requiredString(record.ref, "ref", 240);
  if (ref !== config.allowedRef) {
    throw statusError("Quality audit ref is not allowed", 403);
  }
  const sha = requiredString(record.sha, "sha", 40);
  if (!SHA_PATTERN.test(sha)) throw statusError("Invalid commit SHA", 400);
  const workflowUrl = parseGitHubUrl(record.workflowUrl, "workflowUrl");
  const summary = parseSummary(record.summary);
  return {
    schemaVersion: 1,
    repository,
    runId,
    runAttempt,
    artifactId,
    artifactName,
    eventName,
    ref,
    sha,
    workflowUrl,
    summary,
  };
}

async function downloadReport(
  config: Extract<QualityAuditConfig, { enabled: true }>,
  payload: QualityAuditPayload,
  reportId: string,
): Promise<void> {
  await mkdir(config.reportsDir, { recursive: true });
  const incomingDir = await mkdtemp(path.join(config.reportsDir, ".incoming-"));
  const destination = path.join(config.reportsDir, reportId);
  if (!isPathInside(config.reportsDir, destination)) {
    throw statusError("Invalid quality report destination", 400);
  }
  try {
    await execFileAsync(
      config.ghCommand,
      [
        "run",
        "download",
        String(payload.runId),
        "--repo",
        payload.repository,
        "--name",
        payload.artifactName,
        "--dir",
        incomingDir,
      ],
      {
        env: {
          PATH: process.env.PATH ?? "",
          GH_CONFIG_DIR: config.ghConfigDir,
        },
        timeout: 120_000,
        maxBuffer: 1_000_000,
      },
    );
    await access(path.join(incomingDir, "index.html"));
    const storedSummary = parseSummary(
      JSON.parse(
        await readFile(path.join(incomingDir, "summary.json"), "utf8"),
      ) as unknown,
    );
    if (JSON.stringify(storedSummary) !== JSON.stringify(payload.summary)) {
      throw statusError("Hosted report summary does not match webhook", 400);
    }
    await rm(destination, { recursive: true, force: true });
    await rename(incomingDir, destination);
    await writeFile(
      path.join(destination, "tasksmith-report.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          reportId,
          repository: payload.repository,
          runId: payload.runId,
          runAttempt: payload.runAttempt,
          sha: payload.sha,
          workflowUrl: payload.workflowUrl,
          receivedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await chmod(destination, 0o755);
  } catch (error: unknown) {
    await rm(incomingDir, { recursive: true, force: true });
    if (isStatusError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw statusError(`Could not download quality report: ${message}`, 502);
  }
}

async function notifySlack(
  config: Extract<QualityAuditConfig, { enabled: true }>,
  payload: QualityAuditPayload,
  reportUrl: string,
): Promise<QualityAuditResult["slack"]> {
  const attention =
    payload.summary.functional.status !== "passed" ||
    payload.summary.visual.status !== "unchanged";
  if (!attention && !config.notifyOnClean) return { posted: false };

  const functional = payload.summary.functional;
  const visual = payload.summary.visual;
  const emoji =
    functional.status !== "passed"
      ? ":red_circle:"
      : visual.status === "changed"
        ? ":large_yellow_circle:"
        : visual.status === "error"
          ? ":black_circle:"
          : ":white_check_mark:";
  const title =
    functional.status !== "passed"
      ? "E2E testy vyžadují kontrolu"
      : visual.status === "changed"
        ? "Vizuální změny vyžadují kontrolu"
        : visual.status === "error"
          ? "Vizuální audit nedoběhl čistě"
          : "Audit je čistý";
  const details = [
    ...functional.failures,
    ...visual.changes,
    ...visual.failures,
  ]
    .slice(0, 8)
    .map((failure) => `• ${truncateSlackText(failure.title, 140)}`)
    .join("\n");
  const slackPayload = {
    channel: config.slackChannelId,
    text: `Hive Admin quality audit: ${title}`,
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Hive Admin quality audit", emoji: true },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${emoji} *${title}*\nAudit je pouze informativní a nic neblokuje.`,
        },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Funkční E2E*\n${functional.status} · ${functional.failed}/${functional.total} selhalo`,
          },
          {
            type: "mrkdwn",
            text: `*Vizuální kontrola*\n${visual.status} · ${visual.changed} změn`,
          },
        ],
      },
      ...(details
        ? [
            {
              type: "section",
              text: { type: "mrkdwn", text: `*Co prověřit*\n${details}` },
            },
          ]
        : []),
      {
        type: "actions",
        elements: [
          {
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: "Otevřít report", emoji: true },
            url: reportUrl,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Otevřít workflow", emoji: true },
            url: payload.workflowUrl,
          },
        ],
      },
    ],
  };
  const response = await fetch(config.slackApiUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.slackBotToken}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(slackPayload),
  });
  const responseBody = await response.json() as unknown;
  const result = expectRecord(responseBody, "Slack API response");
  if (!response.ok || result.ok !== true) {
    const error =
      typeof result.error === "string" ? result.error : `HTTP ${response.status}`;
    throw statusError(`Slack API returned an error: ${error}`, 502);
  }
  return {
    posted: true,
    ...(typeof result.channel === "string" ? { channel: result.channel } : {}),
    ...(typeof result.ts === "string" ? { ts: result.ts } : {}),
  };
}

function parseSummary(value: unknown): QualityAuditSummary {
  const record = expectRecord(value, "summary");
  if (record.schemaVersion !== 1) {
    throw statusError("Unsupported quality audit summary schema", 400);
  }
  const functional = expectRecord(record.functional, "summary.functional");
  const visual = expectRecord(record.visual, "summary.visual");
  return {
    schemaVersion: 1,
    generatedAt: requiredString(record.generatedAt, "generatedAt", 80),
    functional: {
      status: enumValue(
        functional.status,
        ["passed", "failed", "error"],
        "summary.functional.status",
      ),
      total: nonNegativeInteger(functional.total, "summary.functional.total"),
      failed: nonNegativeInteger(
        functional.failed,
        "summary.functional.failed",
      ),
      failures: parseFailures(
        functional.failures,
        "summary.functional.failures",
      ),
    },
    visual: {
      status: enumValue(
        visual.status,
        ["unchanged", "changed", "error"],
        "summary.visual.status",
      ),
      total: nonNegativeInteger(visual.total, "summary.visual.total"),
      changed: nonNegativeInteger(visual.changed, "summary.visual.changed"),
      errors: nonNegativeInteger(visual.errors, "summary.visual.errors"),
      changes: parseFailures(visual.changes, "summary.visual.changes"),
      failures: parseFailures(visual.failures, "summary.visual.failures"),
    },
  };
}

function parseFailures(value: unknown, label: string): TestFailure[] {
  if (!Array.isArray(value) || value.length > 50) {
    throw statusError(`${label} must be an array with at most 50 items`, 400);
  }
  return value.map((item, index) => {
    const record = expectRecord(item, `${label}[${index}]`);
    const file =
      record.file === undefined
        ? undefined
        : requiredString(record.file, `${label}[${index}].file`, 500);
    return {
      title: requiredString(record.title, `${label}[${index}].title`, 500),
      ...(file ? { file } : {}),
    };
  });
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw statusError(`${label} has an unsupported value`, 400);
  }
  return value;
}

function requiredString(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maxLength
  ) {
    throw statusError(`${label} must be a non-empty string`, 400);
  }
  return value.trim();
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw statusError(`${label} must be a positive integer`, 400);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw statusError(`${label} must be a non-negative integer`, 400);
  }
  return value;
}

function parseGitHubUrl(value: unknown, label: string): string {
  const raw = requiredString(value, label, 2_000);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw statusError(`${label} must be a valid URL`, 400);
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw statusError(`${label} must be an https://github.com URL`, 400);
  }
  return url.toString();
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw statusError(`${label} must be an object`, 400);
  }
  return value as Record<string, unknown>;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function isPathInside(basePath: string, candidatePath: string): boolean {
  const relative = path.relative(basePath, candidatePath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function truncateSlackText(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 1)}…`;
}

function statusError(
  message: string,
  statusCode: number,
): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function isStatusError(
  error: unknown,
): error is Error & { statusCode: number } {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  );
}
