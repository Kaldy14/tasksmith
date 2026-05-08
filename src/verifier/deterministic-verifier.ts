import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NormalizedRunEvent, RunPaths, RunRecord, VerificationCommandConfig } from "../domain/types.js";
import { redactForStorage } from "../domain/redaction.js";

interface CommandExecutionResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

interface VerifierResult {
  status: "passed" | "failed" | "skipped";
  summary: string;
}

type VerifierEmitter = (event: NormalizedRunEvent) => Promise<void>;

const MAX_CAPTURE_BYTES = 200_000;

export class DeterministicVerifier {
  constructor(private readonly commands: readonly VerificationCommandConfig[]) {}

  async verify(run: RunRecord, paths: RunPaths, emit: VerifierEmitter): Promise<VerifierResult> {
    if (this.commands.length === 0) {
      await emit({
        type: "verification",
        name: "none",
        command: "",
        status: "skipped",
      });
      return { status: "skipped", summary: "No verification commands configured." };
    }

    for (const command of this.commands) {
      await emit({
        type: "verification",
        name: command.name,
        command: command.command,
        status: "running",
      });
      const result = await runVerificationCommand(command, run, paths);
      const stdoutPath = path.join(paths.logsDir, `verification-${safeFilePart(command.name)}-stdout.log`);
      const stderrPath = path.join(paths.logsDir, `verification-${safeFilePart(command.name)}-stderr.log`);
      await mkdir(paths.logsDir, { recursive: true });
      await writeFile(stdoutPath, redactForStorage(result.stdout), "utf8");
      await writeFile(stderrPath, redactForStorage(result.stderr), "utf8");

      const status = result.exitCode === 0 && !result.timedOut ? "passed" : "failed";
      await emit({
        type: "verification",
        name: command.name,
        command: command.command,
        status,
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        durationMs: result.durationMs,
        stdout: truncateForEvent(result.stdout),
        stderr: truncateForEvent(formatStderr(result)),
        stdoutPath,
        stderrPath,
        ...(result.signal ? { error: `terminated by ${result.signal}` } : {}),
      });

      if (status === "failed") {
        const reason = result.timedOut
          ? `${command.name} timed out after ${command.timeoutMs}ms`
          : `${command.name} exited with ${result.exitCode ?? result.signal ?? "unknown"}`;
        return { status: "failed", summary: reason };
      }
    }

    return { status: "passed", summary: `${this.commands.length} verification command(s) passed.` };
  }
}

async function runVerificationCommand(
  command: VerificationCommandConfig,
  run: RunRecord,
  paths: RunPaths,
): Promise<CommandExecutionResult> {
  const started = Date.now();
  return new Promise<CommandExecutionResult>((resolve) => {
    const child = spawn(command.command, {
      cwd: paths.workspaceDir,
      shell: true,
      env: verifierEnv(run, paths),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 2_000).unref();
    }, command.timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      stderr = appendCapped(stderr, `${error.message}\n`);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
      });
    });
  });
}

function verifierEnv(run: RunRecord, paths: RunPaths): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    PNPM_HOME: process.env.PNPM_HOME ?? "",
    HOME: paths.homeDir,
    CI: "1",
    TASKSMITH_RUN_ID: run.id,
    TASKSMITH_REPO_KEY: run.repoKey,
    TASKSMITH_WORKSPACE: paths.workspaceDir,
  };
}

function appendCapped(current: string, next: string): string {
  const merged = current + next;
  if (Buffer.byteLength(merged, "utf8") <= MAX_CAPTURE_BYTES) return merged;
  return `${merged.slice(-MAX_CAPTURE_BYTES)}\n[TaskSmith truncated verifier output to ${MAX_CAPTURE_BYTES} bytes]\n`;
}

function truncateForEvent(value: string): string {
  const redacted = redactForStorage(value);
  if (redacted.length <= 8_000) return redacted;
  return `${redacted.slice(0, 8_000)}\n[TaskSmith truncated verifier event output]\n`;
}

function formatStderr(result: CommandExecutionResult): string {
  if (!result.timedOut) return result.stderr;
  return `${result.stderr}\n[TaskSmith verifier timed out]\n`;
}

function safeFilePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "command";
}
