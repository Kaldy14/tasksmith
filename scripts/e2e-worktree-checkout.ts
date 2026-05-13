#!/usr/bin/env tsx

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RunPaths, RunRecord } from "../src/domain/types.js";
import { WorkspacePreparer } from "../src/runtime/workspace-preparer.js";

async function main(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasksmith-worktree-e2e-"));
  try {
    const remoteDir = path.join(tempDir, "remote.git");
    await createBareFixtureRemote(tempDir, remoteDir);

    const preparer = new WorkspacePreparer({
      fixture: {
        gitUrl: pathToFileURL(remoteDir).href,
        defaultBranch: "main",
        checkout: { mode: "worktree" },
        initCommands: [
          {
            name: "write-delivery-visible-change",
            command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("require('fs').writeFileSync('WORKTREE_CHANGE.txt', 'changed\\n')")}`,
            timeoutMs: 30_000,
          },
        ],
      },
    });

    const run1 = makeRun(tempDir, "run-1");
    const events1: unknown[] = [];
    await preparer.prepare(run1.run, run1.paths, async (event) => { events1.push(event); });

    const run2 = makeRun(tempDir, "run-2");
    const events2: unknown[] = [];
    await preparer.prepare(run2.run, run2.paths, async (event) => { events2.push(event); });

    assert(run1.paths.workspaceDir !== run2.paths.workspaceDir, "runs should use distinct workspaces");
    assert(await gitOutput(["rev-parse", "--is-inside-work-tree"], run1.paths.workspaceDir) === "true", "run 1 should be a git worktree");
    assert(await gitOutput(["rev-parse", "--is-inside-work-tree"], run2.paths.workspaceDir) === "true", "run 2 should be a git worktree");
    assert((await gitOutput(["worktree", "list"], path.join(tempDir, "repos", "fixture"))).includes(run1.paths.workspaceDir), "cache should list run 1 worktree");
    assert((await gitOutput(["worktree", "list"], path.join(tempDir, "repos", "fixture"))).includes(run2.paths.workspaceDir), "cache should list run 2 worktree");

    const excludePath = path.resolve(run1.paths.workspaceDir, await gitOutput(["rev-parse", "--git-path", "info/exclude"], run1.paths.workspaceDir));
    const exclude = await readFile(excludePath, "utf8");
    assert(exclude.includes(".env.*") && exclude.includes("node_modules/"), "per-run exclude should protect local setup files");

    const status = await gitOutput(["status", "--porcelain=v1", "--untracked-files=all"], run1.paths.workspaceDir);
    assert(status.includes("WORKTREE_CHANGE.txt"), "delivery git status should see workspace changes");
    assert(JSON.stringify(events2).includes("git fetch"), "repeated run should fetch from the existing cache");

    console.log("Worktree checkout e2e passed");
  } finally {
    if (process.env.TASKSMITH_KEEP_E2E_ARTIFACTS === "1") console.log(`Keeping artifacts at ${tempDir}`);
    else await rm(tempDir, { recursive: true, force: true });
  }
}

function makeRun(dataDir: string, id: string): { run: RunRecord; paths: RunPaths } {
  const runDir = path.join(dataDir, "runs", id);
  const workspaceDir = path.join(runDir, "workspace");
  const now = new Date().toISOString();
  const run: RunRecord = {
    id,
    sourceType: "manual",
    title: id,
    prompt: "",
    repoKey: "fixture",
    adapter: "demo",
    status: "preparing",
    currentAttemptId: "attempt-1",
    ciFixAttempts: 0,
    reviewFixAttempts: 0,
    runDir,
    workspaceDir,
    createdAt: now,
    updatedAt: now,
  };
  const paths: RunPaths = {
    runDir,
    workspaceDir,
    homeDir: path.join(runDir, "home"),
    agentDir: path.join(runDir, "agent"),
    authPath: path.join(runDir, "agent", "auth.json"),
    modelsPath: path.join(runDir, "agent", "models.json"),
    settingsPath: path.join(runDir, "agent", "settings.json"),
    sessionDir: path.join(runDir, "session"),
    eventsDir: path.join(runDir, "events"),
    rawEventsPath: path.join(runDir, "events", "raw.jsonl"),
    normalizedEventsPath: path.join(runDir, "events", "normalized.jsonl"),
    controlEventsPath: path.join(runDir, "events", "control.jsonl"),
    logsDir: path.join(runDir, "logs"),
    artifactsDir: path.join(runDir, "artifacts"),
    metadataPath: path.join(runDir, "metadata.json"),
  };
  return { run, paths };
}

async function createBareFixtureRemote(tempDir: string, remoteDir: string): Promise<void> {
  const workDir = path.join(tempDir, "seed");
  await mkdir(workDir, { recursive: true });
  await git(["init", "-b", "main"], workDir);
  await writeFile(path.join(workDir, "README.md"), "fixture\n", "utf8");
  await git(["add", "README.md"], workDir);
  await git(["-c", "user.name=TaskSmith", "-c", "user.email=tasksmith@example.invalid", "commit", "-m", "initial"], workDir);
  await git(["init", "--bare", remoteDir], tempDir);
  await git(["remote", "add", "origin", remoteDir], workDir);
  await git(["push", "origin", "main"], workDir);
}

async function gitOutput(args: string[], cwd: string): Promise<string> {
  const result = await git(args, cwd);
  return result.stdout.trim();
}

async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`git ${args.join(" ")} failed (${code}): ${stderr || stdout}`));
    });
    child.on("error", reject);
  });
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
