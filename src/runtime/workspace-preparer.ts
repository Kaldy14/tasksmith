import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NormalizedRunEvent, RepositoryConfig, RunPaths, RunRecord } from "../domain/types.js";
import { redactForStorage } from "../domain/redaction.js";

type WorkspaceEmitter = (event: NormalizedRunEvent) => Promise<void>;

interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const MAX_OUTPUT_BYTES = 80_000;

export class WorkspacePreparer {
  constructor(private readonly repositories: Readonly<Record<string, RepositoryConfig>>) {}

  async prepare(run: RunRecord, paths: RunPaths, emit: WorkspaceEmitter): Promise<void> {
    const repo = this.repositories[run.repoKey];
    if (!repo?.gitUrl) {
      await this.prepareGeneratedWorkspace(paths);
      await emit({ type: "run_status", status: "preparing", detail: "Using generated manual workspace" });
      return;
    }

    await this.prepareGitWorkspace(run, paths, repo, repo.gitUrl, emit);
  }

  private async prepareGeneratedWorkspace(paths: RunPaths): Promise<void> {
    await mkdir(paths.workspaceDir, { recursive: true });
    await writeFile(
      path.join(paths.workspaceDir, "README.md"),
      "# TaskSmith Manual Run Workspace\n\nRun workspace created by TaskSmith.\n",
      "utf8",
    );
  }

  private async prepareGitWorkspace(
    run: RunRecord,
    paths: RunPaths,
    repo: RepositoryConfig,
    gitUrl: string,
    emit: WorkspaceEmitter,
  ): Promise<void> {
    await rm(paths.workspaceDir, { recursive: true, force: true });
    await mkdir(path.dirname(paths.workspaceDir), { recursive: true });

    const branchArgs = repo.defaultBranch ? ["--branch", repo.defaultBranch] : [];
    const depthArgs = repo.cloneDepth === 0 ? [] : ["--depth", String(repo.cloneDepth ?? 1)];
    const args = ["clone", ...depthArgs, ...branchArgs, "--", gitUrl, paths.workspaceDir];
    await emit({
      type: "command",
      command: `git clone ${repo.defaultBranch ? `--branch ${repo.defaultBranch} ` : ""}<configured ${run.repoKey}>`,
    });
    const result = await runCommand("git", args, paths.runDir, gitEnv(repo));
    await emit({
      type: "command_output",
      command: "git clone",
      output: formatCloneOutput(result),
      isError: result.exitCode !== 0,
    });
    if (result.exitCode !== 0) {
      throw new Error(`git clone failed for ${run.repoKey}: ${summarizeFailure(result)}`);
    }
  }
}

async function runCommand(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      stderr = appendCapped(stderr, `${error.message}\n`);
    });
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
  });
}

function gitEnv(repo: RepositoryConfig): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    GIT_TERMINAL_PROMPT: "0",
    ...(repo.gitSshCommand ? { GIT_SSH_COMMAND: repo.gitSshCommand } : {}),
    ...(repo.gitProvider?.ghConfigDir ? { GH_CONFIG_DIR: repo.gitProvider.ghConfigDir } : {}),
  };
}

function formatCloneOutput(result: CommandResult): string {
  const chunks = [result.stdout, result.stderr].filter((value) => value.trim().length > 0);
  const text = chunks.length > 0 ? chunks.join("\n") : `git exited with ${result.exitCode ?? result.signal ?? "unknown"}`;
  return redactForStorage(text);
}

function summarizeFailure(result: CommandResult): string {
  const text = result.stderr.trim() || result.stdout.trim() || String(result.exitCode ?? result.signal ?? "unknown");
  return redactForStorage(text).split("\n").slice(0, 3).join(" ");
}

function appendCapped(current: string, next: string): string {
  const merged = current + next;
  if (Buffer.byteLength(merged, "utf8") <= MAX_OUTPUT_BYTES) return merged;
  return `${merged.slice(-MAX_OUTPUT_BYTES)}\n[TaskSmith truncated workspace command output]\n`;
}
