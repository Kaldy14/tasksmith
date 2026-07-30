import { randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import path from "node:path";
import type { AppConfig, QualityAuditConfig } from "../domain/types.js";

const REPORT_ID_PATTERN = /^run-([1-9][0-9]*)-([1-9][0-9]*)$/;
const TRUSTED_PROXY_HEADER = "verified";

interface QualityReportMetadata {
  schemaVersion: 1;
  reportId: string;
  repository: string;
  runId: number;
  runAttempt: number;
  sha: string;
  workflowUrl: string;
  receivedAt: string;
}

interface QualitySummary {
  visual: {
    status: "unchanged" | "changed" | "error";
    errors: number;
  };
}

export interface ApprovedBaselineMetadata {
  schemaVersion: 1;
  approvedAt: string;
  sourceReportId: string;
  sourceRepository: string;
  sourceRunId: number;
  sourceRunAttempt: number;
  sourceSha: string;
  sourceWorkflowUrl: string;
  files: string[];
  manifests: string[];
}

export interface QualityBaselineApprovalResult {
  approved: true;
  baseline: ApprovedBaselineMetadata;
}

export async function handleQualityBaselineApproval(
  config: AppConfig,
  headers: IncomingHttpHeaders,
  rawBody: Buffer,
): Promise<QualityBaselineApprovalResult> {
  if (!config.qualityAudit.enabled) {
    throw statusError("Quality audits are disabled", 404);
  }
  if (firstHeader(headers["x-tasksmith-quality-proxy"]) !== TRUSTED_PROXY_HEADER) {
    throw statusError("Quality baseline approval requires the report proxy", 403);
  }

  const input = parseApprovalInput(rawBody);
  const baseline = await approveQualityBaseline(config.qualityAudit, input.reportId);
  return { approved: true, baseline };
}

export async function approveQualityBaseline(
  config: Extract<QualityAuditConfig, { enabled: true }>,
  reportId: string,
): Promise<ApprovedBaselineMetadata> {
  if (!REPORT_ID_PATTERN.test(reportId)) {
    throw statusError("Invalid quality report ID", 400);
  }

  const reportDir = path.join(config.reportsDir, reportId);
  if (!isPathInside(config.reportsDir, reportDir)) {
    throw statusError("Invalid quality report path", 400);
  }
  const metadata = parseReportMetadata(
    JSON.parse(
      await readRequiredFile(
        path.join(reportDir, "tasksmith-report.json"),
        "Quality report metadata was not found",
      ),
    ) as unknown,
    reportId,
  );
  const summary = parseSummary(
    JSON.parse(
      await readRequiredFile(
        path.join(reportDir, "summary.json"),
        "Quality report summary was not found",
      ),
    ) as unknown,
  );
  if (summary.visual.status === "error" || summary.visual.errors > 0) {
    throw statusError(
      "A report with visual runner errors cannot become the approved baseline",
      409,
    );
  }

  const screenshotsDir = path.join(reportDir, "screenshots");
  const entries = await readdir(screenshotsDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".png"))
    .map((entry) => entry.name)
    .sort();
  const manifests = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) {
    throw statusError("The quality report contains no screenshots", 409);
  }
  if (manifests.length === 0) {
    throw statusError("The quality report contains no screenshot manifests", 409);
  }

  const baseline: ApprovedBaselineMetadata = {
    schemaVersion: 1,
    approvedAt: new Date().toISOString(),
    sourceReportId: metadata.reportId,
    sourceRepository: metadata.repository,
    sourceRunId: metadata.runId,
    sourceRunAttempt: metadata.runAttempt,
    sourceSha: metadata.sha,
    sourceWorkflowUrl: metadata.workflowUrl,
    files,
    manifests,
  };
  await replaceBaselineDirectory(
    config.reportsDir,
    screenshotsDir,
    baseline,
    [...files, ...manifests],
  );
  return baseline;
}

async function replaceBaselineDirectory(
  reportsDir: string,
  screenshotsDir: string,
  baseline: ApprovedBaselineMetadata,
  entries: string[],
): Promise<void> {
  await mkdir(reportsDir, { recursive: true });
  const incomingDir = await mkdtemp(path.join(reportsDir, ".baseline-"));
  const incomingScreenshots = path.join(incomingDir, "screenshots");
  const baselineDir = path.join(reportsDir, "approved-baseline");
  const previousDir = path.join(
    reportsDir,
    `.approved-baseline-previous-${randomUUID()}`,
  );
  let previousMoved = false;

  try {
    await mkdir(incomingScreenshots, { recursive: true });
    for (const entry of entries) {
      await cp(
        path.join(screenshotsDir, entry),
        path.join(incomingScreenshots, entry),
      );
    }
    await writeFile(
      path.join(incomingDir, "baseline.json"),
      `${JSON.stringify(baseline, null, 2)}\n`,
      "utf8",
    );
    try {
      await rename(baselineDir, previousDir);
      previousMoved = true;
    } catch (error: unknown) {
      if (!isMissingFileError(error)) throw error;
    }
    await rename(incomingDir, baselineDir);
    await chmod(baselineDir, 0o755);
    if (previousMoved) {
      await rm(previousDir, { recursive: true, force: true });
    }
  } catch (error: unknown) {
    await rm(incomingDir, { recursive: true, force: true });
    if (previousMoved) {
      await rm(baselineDir, { recursive: true, force: true });
      await rename(previousDir, baselineDir);
    }
    throw error;
  }
}

function parseApprovalInput(rawBody: Buffer): { reportId: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8")) as unknown;
  } catch {
    throw statusError("Approval request must be valid JSON", 400);
  }
  const record = expectRecord(parsed, "approval request");
  if (typeof record.reportId !== "string" || !REPORT_ID_PATTERN.test(record.reportId)) {
    throw statusError("Approval request must contain a valid reportId", 400);
  }
  return { reportId: record.reportId };
}

function parseReportMetadata(
  value: unknown,
  reportId: string,
): QualityReportMetadata {
  const record = expectRecord(value, "quality report metadata");
  if (
    record.schemaVersion !== 1 ||
    record.reportId !== reportId ||
    typeof record.repository !== "string" ||
    typeof record.runId !== "number" ||
    typeof record.runAttempt !== "number" ||
    typeof record.sha !== "string" ||
    !/^[0-9a-f]{40}$/.test(record.sha) ||
    typeof record.workflowUrl !== "string" ||
    typeof record.receivedAt !== "string"
  ) {
    throw statusError("Quality report metadata is invalid", 409);
  }
  return {
    schemaVersion: 1,
    reportId,
    repository: record.repository,
    runId: record.runId,
    runAttempt: record.runAttempt,
    sha: record.sha,
    workflowUrl: record.workflowUrl,
    receivedAt: record.receivedAt,
  };
}

function parseSummary(value: unknown): QualitySummary {
  const record = expectRecord(value, "quality report summary");
  const visual = expectRecord(record.visual, "quality report visual summary");
  if (
    visual.status !== "unchanged" &&
    visual.status !== "changed" &&
    visual.status !== "error"
  ) {
    throw statusError("Quality report visual status is invalid", 409);
  }
  if (
    typeof visual.errors !== "number" ||
    !Number.isInteger(visual.errors) ||
    visual.errors < 0
  ) {
    throw statusError("Quality report visual error count is invalid", 409);
  }
  return { visual: { status: visual.status, errors: visual.errors } };
}

async function readRequiredFile(filePath: string, message: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (isMissingFileError(error)) throw statusError(message, 404);
    throw error;
  }
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

function isPathInside(basePath: string, candidatePath: string): boolean {
  const relative = path.relative(basePath, candidatePath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function statusError(
  message: string,
  statusCode: number,
): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
