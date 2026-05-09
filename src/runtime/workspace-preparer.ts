import { spawn } from "node:child_process";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NormalizedRunEvent, RepositoryConfig, RunPaths, RunRecord, VerificationCommandConfig } from "../domain/types.js";
import { redactForStorage } from "../domain/redaction.js";

type WorkspaceEmitter = (event: NormalizedRunEvent) => Promise<void>;

interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

const MAX_OUTPUT_BYTES = 80_000;

export class WorkspacePreparer {
  constructor(private readonly repositories: Readonly<Record<string, RepositoryConfig>>) {}

  async prepare(run: RunRecord, paths: RunPaths, emit: WorkspaceEmitter): Promise<void> {
    const repo = this.repositories[run.repoKey];
    if (!repo?.gitUrl) {
      await this.prepareGeneratedWorkspace(paths);
      await emit({ type: "run_status", status: "preparing", detail: "Using generated manual workspace" });
      await this.runInitCommands(run, paths, repo, emit);
      return;
    }

    await this.prepareGitWorkspace(run, paths, repo, repo.gitUrl, emit);
    await this.runInitCommands(run, paths, repo, emit);
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
    await excludeLocalSetupFiles(paths);
  }

  private async runInitCommands(
    run: RunRecord,
    paths: RunPaths,
    repo: RepositoryConfig | undefined,
    emit: WorkspaceEmitter,
  ): Promise<void> {
    const commands = repo?.initCommands ?? [];
    if (commands.length === 0) return;
    await emit({ type: "run_status", status: "preparing", detail: `Running ${commands.length} workspace init command(s)` });
    for (const command of commands) {
      await emit({ type: "command", command: `init:${command.name} $ ${command.command}` });
      const result = await runShellCommand(command, paths.workspaceDir, setupEnv(run, paths, repo));
      await emit({
        type: "command_output",
        command: `init:${command.name}`,
        output: formatSetupOutput(result),
        isError: result.exitCode !== 0 || result.timedOut === true,
      });
      if (result.exitCode !== 0 || result.timedOut === true) {
        throw new Error(`workspace init command '${command.name}' failed: ${summarizeFailure(result)}`);
      }
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

async function runShellCommand(command: VerificationCommandConfig, cwd: string, env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(command.command, {
      cwd,
      env,
      shell: true,
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
      resolve({ exitCode, signal, stdout, stderr, timedOut });
    });
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

function setupEnv(run: RunRecord, paths: RunPaths, repo: RepositoryConfig | undefined): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    PNPM_HOME: process.env.PNPM_HOME ?? "",
    HOME: paths.homeDir,
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
    TASKSMITH_RUN_ID: run.id,
    TASKSMITH_REPO_KEY: run.repoKey,
    TASKSMITH_WORKSPACE: paths.workspaceDir,
    ...(repo?.gitSshCommand ? { GIT_SSH_COMMAND: repo.gitSshCommand } : {}),
    ...(repo?.gitProvider?.ghConfigDir ? { GH_CONFIG_DIR: repo.gitProvider.ghConfigDir } : {}),
  };
}

function formatCloneOutput(result: CommandResult): string {
  const chunks = [result.stdout, result.stderr].filter((value) => value.trim().length > 0);
  const text = chunks.length > 0 ? chunks.join("\n") : `git exited with ${result.exitCode ?? result.signal ?? "unknown"}`;
  return redactForStorage(text);
}

function formatSetupOutput(result: CommandResult): string {
  const chunks = [result.stdout, result.stderr].filter((value) => value.trim().length > 0);
  const timeout = result.timedOut ? "\n[TaskSmith workspace init timed out]" : "";
  const text = chunks.length > 0 ? `${chunks.join("\n")}${timeout}` : `exited with ${result.exitCode ?? result.signal ?? "unknown"}${timeout}`;
  return redactForStorage(text);
}

function summarizeFailure(result: CommandResult): string {
  const suffix = result.timedOut ? " timed out" : "";
  const text = result.stderr.trim() || result.stdout.trim() || String(result.exitCode ?? result.signal ?? "unknown");
  return `${redactForStorage(text).split("\n").slice(0, 3).join(" ")}${suffix}`;
}

async function excludeLocalSetupFiles(paths: RunPaths): Promise<void> {
  await appendFile(
    path.join(paths.workspaceDir, ".git", "info", "exclude"),
    "\n# TaskSmith per-run local setup files\n.env\n.env.*\n!.env.example\n!.env.sample\nnode_modules/\n.pnpm-store/\n",
    "utf8",
  );
}

function appendCapped(current: string, next: string): string {
  const merged = current + next;
  if (Buffer.byteLength(merged, "utf8") <= MAX_OUTPUT_BYTES) return merged;
  return `${merged.slice(-MAX_OUTPUT_BYTES)}\n[TaskSmith truncated workspace command output]\n`;
}
