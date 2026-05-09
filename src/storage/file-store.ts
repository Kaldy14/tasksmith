import { constants as fsConstants } from "node:fs";
import { access, appendFile, cp, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig, CreateRunInput, CreateSourceClaimInput, NormalizedRunEvent, RunPaths, RunRecord, RunStatus, SourceClaim, StoredRunEvent } from "../domain/types.js";
import { redactForStorage } from "../domain/redaction.js";

interface RunsStateFile {
  version: 1;
  runs: RunRecord[];
}

interface ClaimsStateFile {
  version: 1;
  claims: SourceClaim[];
}

export class FileStore {
  private readonly runsStatePath: string;
  private readonly claimsStatePath: string;
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(private readonly config: AppConfig) {
    this.runsStatePath = path.join(config.stateDir, "runs.json");
    this.claimsStatePath = path.join(config.stateDir, "source-claims.json");
  }

  async init(): Promise<void> {
    await mkdir(this.config.runsDir, { recursive: true });
    await mkdir(this.config.stateDir, { recursive: true });
    if (!(await exists(this.runsStatePath))) {
      await this.writeRunsState({ version: 1, runs: [] });
    }
    if (!(await exists(this.claimsStatePath))) {
      await this.writeClaimsState({ version: 1, claims: [] });
    }
  }

  pathsForRun(runId: string): RunPaths {
    const runDir = path.join(this.config.runsDir, runId);
    const workspaceDir = path.join(runDir, "workspace");
    const homeDir = path.join(runDir, "home");
    const agentDir = path.join(homeDir, ".pi", "agent");
    const eventsDir = path.join(runDir, "events");
    return {
      runDir,
      workspaceDir,
      homeDir,
      agentDir,
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      settingsPath: path.join(agentDir, "settings.json"),
      sessionDir: path.join(runDir, "pi-session"),
      eventsDir,
      rawEventsPath: path.join(eventsDir, "pi-raw.jsonl"),
      normalizedEventsPath: path.join(eventsDir, "tasksmith-events.jsonl"),
      controlEventsPath: path.join(eventsDir, "controls.jsonl"),
      logsDir: path.join(runDir, "logs"),
      artifactsDir: path.join(runDir, "artifacts"),
      metadataPath: path.join(runDir, "metadata.json"),
    };
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const id = `run-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    const paths = this.pathsForRun(id);
    await this.prepareRunDirs(paths);
    const now = new Date().toISOString();
    const run: RunRecord = {
      id,
      sourceType: input.source?.type ?? "manual",
      title: input.title,
      prompt: input.prompt,
      repoKey: input.repoKey,
      adapter: input.adapter,
      ...(input.source ? { source: input.source } : {}),
      ...(input.claimKey ? { claimKey: input.claimKey } : {}),
      status: "queued",
      currentAttemptId: "attempt-1",
      runDir: paths.runDir,
      workspaceDir: paths.workspaceDir,
      createdAt: now,
      updatedAt: now,
    };
    await this.writeMetadata(run);
    await this.mutateRuns((runs) => [run, ...runs]);
    return run;
  }

  async listRuns(): Promise<RunRecord[]> {
    const state = await this.readRunsState();
    return [...state.runs].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async listSourceClaims(): Promise<SourceClaim[]> {
    const state = await this.readClaimsState();
    return [...state.claims].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async tryCreateSourceClaim(input: CreateSourceClaimInput): Promise<{ claim: SourceClaim; created: boolean }> {
    return this.enqueue("__claims__", async () => {
      const state = await this.readClaimsState();
      const existing = state.claims.find((claim) => claim.key === input.key);
      if (existing) return { claim: existing, created: false };
      const now = new Date().toISOString();
      const claim: SourceClaim = {
        key: input.key,
        provider: input.provider,
        sourceType: input.sourceType,
        sourceKey: input.sourceKey,
        ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
        repoKey: input.repoKey,
        status: "claimed",
        createdAt: now,
        updatedAt: now,
      };
      await this.writeClaimsState({ version: 1, claims: [claim, ...state.claims] });
      return { claim, created: true };
    });
  }

  async updateSourceClaim(claimKey: string, patch: Partial<Omit<SourceClaim, "key" | "createdAt">>): Promise<SourceClaim> {
    let updated: SourceClaim | undefined;
    await this.enqueue("__claims__", async () => {
      const state = await this.readClaimsState();
      const claims = state.claims.map((claim) => {
        if (claim.key !== claimKey) return claim;
        updated = { ...claim, ...patch, updatedAt: new Date().toISOString() };
        return updated;
      });
      await this.writeClaimsState({ version: 1, claims });
    });
    if (!updated) throw new Error(`Source claim not found: ${claimKey}`);
    return updated;
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    const state = await this.readRunsState();
    return state.runs.find((run) => run.id === runId);
  }

  async updateRun(runId: string, patch: Partial<Omit<RunRecord, "id" | "createdAt">>): Promise<RunRecord> {
    let updated: RunRecord | undefined;
    await this.mutateRuns((runs) => runs.map((run) => {
      if (run.id !== runId) return run;
      updated = { ...run, ...patch, updatedAt: new Date().toISOString() };
      return updated;
    }));
    if (!updated) throw new Error(`Run not found: ${runId}`);
    await this.writeMetadata(updated);
    return updated;
  }

  async appendRawEvent(runId: string, value: unknown): Promise<void> {
    const paths = this.pathsForRun(runId);
    await this.enqueue(runId, async () => {
      await appendJsonl(paths.rawEventsPath, { createdAt: new Date().toISOString(), event: redactForStorage(value) });
    });
  }

  async appendControlEvent(runId: string, value: unknown): Promise<void> {
    const paths = this.pathsForRun(runId);
    await this.enqueue(runId, async () => {
      await appendJsonl(paths.controlEventsPath, { createdAt: new Date().toISOString(), command: redactForStorage(value) });
    });
  }

  async appendEvent(run: RunRecord, data: NormalizedRunEvent): Promise<StoredRunEvent> {
    const paths = this.pathsForRun(run.id);
    return this.enqueue(run.id, async () => {
      const sequence = await this.nextSequence(paths.normalizedEventsPath);
      const stored: StoredRunEvent = {
        version: 1,
        id: `${run.id}-${sequence}`,
        runId: run.id,
        attemptId: run.currentAttemptId,
        sequence,
        type: data.type,
        createdAt: new Date().toISOString(),
        data: redactForStorage(data),
      };
      await appendJsonl(paths.normalizedEventsPath, stored);
      return stored;
    });
  }

  async readEvents(runId: string, afterSequence = 0): Promise<StoredRunEvent[]> {
    const paths = this.pathsForRun(runId);
    if (!(await exists(paths.normalizedEventsPath))) return [];
    const text = await readFile(paths.normalizedEventsPath, "utf8");
    return text.split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as StoredRunEvent)
      .filter((event) => event.sequence > afterSequence);
  }

  async markActiveRunsFailedOnBoot(): Promise<void> {
    const terminal = new Set<RunStatus>(["completed", "failed", "cancelled"]);
    await this.mutateRuns((runs) => runs.map((run) => {
      if (terminal.has(run.status)) return run;
      return {
        ...run,
        status: "failed",
        error: "TaskSmith process restarted before this run finished.",
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }));
  }

  async copyPiAuthMaterial(paths: RunPaths): Promise<string[]> {
    const copied: string[] = [];
    await maybeCopyFile(path.join(this.config.piAuthSourceDir, "auth.json"), paths.authPath, copied);
    await maybeCopyFile(path.join(this.config.piAuthSourceDir, "models.json"), paths.modelsPath, copied);
    await writeFile(
      paths.settingsPath,
      JSON.stringify({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2 }, sessionDir: paths.sessionDir, enableInstallTelemetry: false }, null, 2),
      { encoding: "utf8", mode: 0o600 },
    );
    copied.push("generated:settings.json");
    return copied;
  }

  private async prepareRunDirs(paths: RunPaths): Promise<void> {
    await mkdir(paths.workspaceDir, { recursive: true });
    await mkdir(paths.agentDir, { recursive: true });
    await mkdir(paths.sessionDir, { recursive: true });
    await mkdir(paths.eventsDir, { recursive: true });
    await mkdir(paths.logsDir, { recursive: true });
    await mkdir(paths.artifactsDir, { recursive: true });
    await writeFile(path.join(paths.workspaceDir, "README.md"), `# TaskSmith Manual Run Workspace\n\nRun workspace created by TaskSmith.\n`, "utf8");
  }

  private async nextSequence(eventsPath: string): Promise<number> {
    if (!(await exists(eventsPath))) return 1;
    const text = await readFile(eventsPath, "utf8");
    let last = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as StoredRunEvent;
      if (parsed.sequence > last) last = parsed.sequence;
    }
    return last + 1;
  }

  private async readRunsState(): Promise<RunsStateFile> {
    const text = await readFile(this.runsStatePath, "utf8");
    return JSON.parse(text) as RunsStateFile;
  }

  private async readClaimsState(): Promise<ClaimsStateFile> {
    const text = await readFile(this.claimsStatePath, "utf8");
    return JSON.parse(text) as ClaimsStateFile;
  }

  private async writeRunsState(state: RunsStateFile): Promise<void> {
    await mkdir(path.dirname(this.runsStatePath), { recursive: true });
    const tmp = `${this.runsStatePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tmp, this.runsStatePath);
  }

  private async writeClaimsState(state: ClaimsStateFile): Promise<void> {
    await mkdir(path.dirname(this.claimsStatePath), { recursive: true });
    const tmp = `${this.claimsStatePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tmp, this.claimsStatePath);
  }

  private async mutateRuns(mutator: (runs: RunRecord[]) => RunRecord[]): Promise<void> {
    await this.enqueue("__runs__", async () => {
      const state = await this.readRunsState();
      await this.writeRunsState({ version: 1, runs: mutator(state.runs) });
    });
  }

  private async writeMetadata(run: RunRecord): Promise<void> {
    const paths = this.pathsForRun(run.id);
    await writeFile(paths.metadataPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  }

  private enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    this.writeQueues.set(key, result.then(() => undefined, () => undefined));
    return result;
  }
}

async function appendJsonl(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

async function maybeCopyFile(source: string, target: string, copied: string[]): Promise<void> {
  if (!(await exists(source))) return;
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { force: true, mode: fsConstants.COPYFILE_FICLONE });
  copied.push(path.basename(source));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function fileInfo(filePath: string): Promise<{ exists: boolean; size?: number }> {
  try {
    const info = await stat(filePath);
    return { exists: true, size: info.size };
  } catch {
    return { exists: false };
  }
}
