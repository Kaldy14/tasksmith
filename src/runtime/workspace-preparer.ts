import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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

    if (repo.checkout?.mode === "worktree") {
      await this.prepareWorktreeWorkspace(run, paths, repo, repo.gitUrl, emit);
    } else {
      await this.prepareGitWorkspace(run, paths, repo, repo.gitUrl, emit);
    }
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

  private async prepareWorktreeWorkspace(
    run: RunRecord,
    paths: RunPaths,
    repo: RepositoryConfig,
    gitUrl: string,
    emit: WorkspaceEmitter,
  ): Promise<void> {
    await rm(paths.workspaceDir, { recursive: true, force: true });
    await mkdir(path.dirname(paths.workspaceDir), { recursive: true });

    const cacheDir = repo.checkout?.cacheDir ?? defaultRepoCacheDir(paths, run.repoKey);
    await ensureWorktreeCache(run, paths, repo, gitUrl, cacheDir, emit);

    const fetchRef = repo.defaultBranch ? `+refs/heads/${repo.defaultBranch}:refs/remotes/origin/${repo.defaultBranch}` : undefined;
    const fetchArgs = ["fetch", "--prune", "origin", ...(fetchRef ? [fetchRef] : [])];
    await emit({ type: "command", command: `git fetch --prune origin${repo.defaultBranch ? ` ${repo.defaultBranch}` : ""}` });
    const fetchResult = await runCommand("git", fetchArgs, cacheDir, gitEnv(repo));
    await emit({ type: "command_output", command: "git fetch", output: formatCloneOutput(fetchResult), isError: fetchResult.exitCode !== 0 });
    if (fetchResult.exitCode !== 0) throw new Error(`git fetch failed for ${run.repoKey}: ${summarizeFailure(fetchResult)}`);

    await emit({ type: "command", command: "git worktree prune" });
    const pruneResult = await runCommand("git", ["worktree", "prune"], cacheDir, gitEnv(repo));
    if (pruneResult.exitCode !== 0) {
      await emit({
        type: "command_output",
        command: "git worktree prune",
        output: `Warning: non-fatal git worktree prune failed for ${run.repoKey} cache ${cacheDir}: ${formatCloneOutput(pruneResult)}`,
        isError: true,
      });
    }

    const ref = repo.defaultBranch ? `refs/remotes/origin/${repo.defaultBranch}` : "HEAD";
    await emit({ type: "command", command: `git worktree add <workspace> ${repo.defaultBranch ?? "HEAD"}` });
    const addResult = await runCommand("git", ["worktree", "add", "--detach", paths.workspaceDir, ref], cacheDir, gitEnv(repo));
    await emit({ type: "command_output", command: "git worktree add", output: formatCloneOutput(addResult), isError: addResult.exitCode !== 0 });
    if (addResult.exitCode !== 0) throw new Error(`git worktree add failed for ${run.repoKey}: ${summarizeFailure(addResult)}`);

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

async function ensureWorktreeCache(
  run: RunRecord,
  paths: RunPaths,
  repo: RepositoryConfig,
  gitUrl: string,
  cacheDir: string,
  emit: WorkspaceEmitter,
): Promise<void> {
  await mkdir(path.dirname(cacheDir), { recursive: true });
  const releaseLock = await acquireCacheLock(cacheDir);
  try {
    if (await pathExists(path.join(cacheDir, "HEAD"))) return;
    await rm(cacheDir, { recursive: true, force: true });
    const branchArgs = repo.defaultBranch ? ["--branch", repo.defaultBranch] : [];
    const depthArgs = repo.cloneDepth === 0 ? [] : ["--depth", String(repo.cloneDepth ?? 1)];
    await emit({ type: "command", command: `git clone --bare ${repo.defaultBranch ? `--branch ${repo.defaultBranch} ` : ""}<configured ${run.repoKey}> <cache>` });
    const result = await runCommand("git", ["clone", "--bare", ...depthArgs, ...branchArgs, "--", gitUrl, cacheDir], paths.runDir, gitEnv(repo));
    await emit({ type: "command_output", command: "git clone --bare", output: formatCloneOutput(result), isError: result.exitCode !== 0 });
    if (result.exitCode !== 0) throw new Error(`git cache clone failed for ${run.repoKey}: ${summarizeFailure(result)}`);
  } finally {
    await releaseLock();
  }
}

async function acquireCacheLock(cacheDir: string): Promise<() => Promise<void>> {
  const lockDir = `${cacheDir}.lock`;
  const deadline = Date.now() + 120_000;
  while (true) {
    try {
      await mkdir(lockDir);
      return async () => {
        await rm(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() > deadline) throw new Error(`timed out waiting for git cache lock: ${lockDir}`);
      await delay(100);
    }
  }
}

const TASKSMITH_EXCLUDE_MARKER = "# TaskSmith per-run local setup files";
const TASKSMITH_EXCLUDE_BLOCK = `\n${TASKSMITH_EXCLUDE_MARKER}\n.env\n.env.*\n!.env.example\n!.env.sample\nnode_modules/\n.pnpm-store/\n`;

export async function excludeLocalSetupFiles(paths: RunPaths): Promise<void> {
  const excludePath = await gitExcludePath(paths);
  await mkdir(path.dirname(excludePath), { recursive: true });
  const existing = await readOptionalFile(excludePath);
  if (existing.includes(TASKSMITH_EXCLUDE_MARKER)) return;
  await appendFile(excludePath, TASKSMITH_EXCLUDE_BLOCK, "utf8");
}

async function readOptionalFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function gitExcludePath(paths: RunPaths): Promise<string> {
  const directoryGitPath = path.join(paths.workspaceDir, ".git", "info", "exclude");
  if (await pathExists(path.dirname(directoryGitPath))) return directoryGitPath;
  const result = await runCommand("git", ["rev-parse", "--git-path", "info/exclude"], paths.workspaceDir, {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    GIT_TERMINAL_PROMPT: "0",
  });
  if (result.exitCode !== 0) throw new Error(`failed to locate git exclude file: ${summarizeFailure(result)}`);
  return path.resolve(paths.workspaceDir, result.stdout.trim());
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return false;
    throw error;
  }
}

function defaultRepoCacheDir(paths: RunPaths, repoKey: string): string {
  return path.join(path.dirname(path.dirname(paths.runDir)), "repos", safeRepoCacheKey(repoKey));
}

function safeRepoCacheKey(repoKey: string): string {
  return repoKey.replace(/[^A-Za-z0-9._-]+/gu, "_") || "repo";
}

function appendCapped(current: string, next: string): string {
  const merged = current + next;
  if (Buffer.byteLength(merged, "utf8") <= MAX_OUTPUT_BYTES) return merged;
  return `${merged.slice(-MAX_OUTPUT_BYTES)}\n[TaskSmith truncated workspace command output]\n`;
}
