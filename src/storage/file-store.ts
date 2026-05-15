import { constants as fsConstants } from "node:fs";
import { access, appendFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig, CreatePullRequestRecordInput, CreateReviewRecordInput, CreateRunInput, CreateSourceClaimInput, NormalizedRunEvent, PullRequestRecord, ReviewRecord, RunClaimCapacity, RunPaths, RunRecord, RunStatus, SourceClaim, StoredRunEvent } from "../domain/types.js";
import { redactForStorage } from "../domain/redaction.js";
import { PostgresMetadataIndex } from "./postgres-metadata-index.js";

interface RunsStateFile {
  version: 1;
  runs: RunRecord[];
}

interface ClaimsStateFile {
  version: 1;
  claims: SourceClaim[];
}

interface ClaimsLockOwner {
  pid: number;
  createdAt: string;
}

interface PullRequestsStateFile {
  version: 1;
  pullRequests: PullRequestRecord[];
}

interface ReviewsStateFile {
  version: 1;
  reviews: ReviewRecord[];
}

const CAPACITY_QUEUE_ERROR_PREFIX = "Queued because run capacity is full:";

export class FileStore {
  private readonly runsStatePath: string;
  private readonly claimsStatePath: string;
  private readonly claimsLockPath: string;
  private readonly claimsLockOwnerPath: string;
  private readonly pullRequestsStatePath: string;
  private readonly reviewsStatePath: string;
  private readonly writeQueues = new Map<string, Promise<void>>();
  private metadataIndex: PostgresMetadataIndex | undefined;
  private lastTimestampMs = 0;

  constructor(private readonly config: AppConfig) {
    this.runsStatePath = path.join(config.stateDir, "runs.json");
    this.claimsStatePath = path.join(config.stateDir, "source-claims.json");
    this.claimsLockPath = path.join(config.stateDir, "source-claims.lock");
    this.claimsLockOwnerPath = path.join(this.claimsLockPath, "owner.json");
    this.pullRequestsStatePath = path.join(config.stateDir, "pull-requests.json");
    this.reviewsStatePath = path.join(config.stateDir, "reviews.json");
    this.metadataIndex = config.databaseUrl ? new PostgresMetadataIndex(config.databaseUrl) : undefined;
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
    if (!(await exists(this.pullRequestsStatePath))) {
      await this.writePullRequestsState({ version: 1, pullRequests: [] });
    }
    if (!(await exists(this.reviewsStatePath))) {
      await this.writeReviewsState({ version: 1, reviews: [] });
    }
    if (this.metadataIndex) {
      await this.metadataIndex.init();
      await this.syncLegacyFilesToPostgres();
    }
  }

  async close(): Promise<void> {
    await this.metadataIndex?.close();
  }

  hasMetadataIndex(): boolean {
    return this.metadataIndex !== undefined;
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
    const now = this.now();
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
      ciFixAttempts: 0,
      reviewFixAttempts: 0,
      runDir: paths.runDir,
      workspaceDir: paths.workspaceDir,
      createdAt: now,
      updatedAt: now,
    };
    await this.writeMetadata(run);
    if (this.metadataIndex) {
      await this.metadataIndex.upsertRun(run, paths);
      await this.metadataIndex.indexEventCheckpoint(run.id, paths, undefined, 0, now);
      return run;
    }
    await this.mutateRuns((runs) => [run, ...runs]);
    return run;
  }

  async listRuns(): Promise<RunRecord[]> {
    if (this.metadataIndex) return this.metadataIndex.listRuns();
    const state = await this.readRunsState();
    return [...state.runs].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async claimNextQueuedRun(workerId: string, leaseTimeoutMs: number, capacity: RunClaimCapacity = {}): Promise<RunRecord | undefined> {
    if (this.metadataIndex) {
      const claimed = await this.metadataIndex.claimNextQueuedRun(this.now(), workerId, leaseTimeoutMs, capacity);
      if (claimed) await this.writeMetadata(claimed);
      return claimed;
    }
    let claimed: RunRecord | undefined;
    await this.mutateRuns((runs) => {
      const queued = runs
        .map((run, runIndex) => ({ run, runIndex }))
        .filter(({ run }) => run.status === "queued")
        .sort((left, right) => left.run.createdAt.localeCompare(right.run.createdAt));
      const now = this.now();
      const blocked = new Map<number, string>();
      let index: number | undefined;
      for (const item of queued) {
        const capacityReason = getCapacityBlockReason(runs, item.run, capacity);
        if (capacityReason) {
          blocked.set(item.runIndex, capacityReason);
          continue;
        }
        index = item.runIndex;
        break;
      }
      if (index === undefined) {
        if (blocked.size === 0) return runs;
        return runs.map((run, runIndex) => blocked.has(runIndex) ? annotateCapacityBlock(run, blocked.get(runIndex)!, now) : run);
      }
      const { error, ...candidate } = runs[index]!;
      const nextError = error?.startsWith(CAPACITY_QUEUE_ERROR_PREFIX) ? undefined : error;
      claimed = {
        ...candidate,
        ...(nextError === undefined ? {} : { error: nextError }),
        status: "claimed",
        startedAt: now,
        updatedAt: now,
        lease: {
          workerId,
          expiresAt: addMs(now, leaseTimeoutMs),
          lastHeartbeatAt: now,
          attempt: (runs[index]!.lease?.attempt ?? 0) + 1,
        },
      };
      return runs.map((run, runIndex) => {
        if (runIndex === index) return claimed!;
        return blocked.has(runIndex) ? annotateCapacityBlock(run, blocked.get(runIndex)!, now) : run;
      });
    });
    if (claimed) await this.writeMetadata(claimed);
    return claimed;
  }

  async listSourceClaims(): Promise<SourceClaim[]> {
    if (this.metadataIndex) return this.metadataIndex.listSourceClaims();
    const state = await this.readClaimsState();
    return [...state.claims].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async tryCreateSourceClaim(input: CreateSourceClaimInput): Promise<{ claim: SourceClaim; created: boolean }> {
    if (this.metadataIndex) return this.metadataIndex.tryCreateSourceClaim(input, this.now());
    return this.enqueue("__claims__", () => this.withClaimsLock(async () => {
      const state = await this.readClaimsState();
      const existing = state.claims.find((claim) => claim.key === input.key);
      if (existing) return { claim: existing, created: false };
      const now = this.now();
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
    }));
  }

  async updateSourceClaim(claimKey: string, patch: Partial<Omit<SourceClaim, "key" | "createdAt">>): Promise<SourceClaim> {
    if (this.metadataIndex) return this.metadataIndex.updateSourceClaim(claimKey, patch, this.now());
    let updated: SourceClaim | undefined;
    await this.enqueue("__claims__", () => this.withClaimsLock(async () => {
      const state = await this.readClaimsState();
      const claims = state.claims.map((claim) => {
        if (claim.key !== claimKey) return claim;
        updated = { ...claim, ...patch, updatedAt: this.now() };
        return updated;
      });
      await this.writeClaimsState({ version: 1, claims });
    }));
    if (!updated) throw new Error(`Source claim not found: ${claimKey}`);
    return updated;
  }

  async listPullRequests(): Promise<PullRequestRecord[]> {
    if (this.metadataIndex) return this.metadataIndex.listPullRequests();
    const state = await this.readPullRequestsState();
    return [...state.pullRequests].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async listReviews(): Promise<ReviewRecord[]> {
    if (this.metadataIndex) return this.metadataIndex.listReviews();
    const state = await this.readReviewsState();
    return [...state.reviews].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getReviewForRun(runId: string): Promise<ReviewRecord | undefined> {
    if (this.metadataIndex) return this.metadataIndex.getReviewForRun(runId);
    const state = await this.readReviewsState();
    return state.reviews.find((review) => review.runId === runId);
  }

  async recordReview(input: CreateReviewRecordInput): Promise<ReviewRecord> {
    if (this.metadataIndex) {
      const existing = await this.metadataIndex.getReviewForRun(input.runId);
      const now = this.now();
      return this.metadataIndex.recordReview({
        id: existing?.id ?? `review-${randomUUID().slice(0, 12)}`,
        runId: input.runId,
        status: input.status,
        summary: input.summary,
        findings: input.findings,
        ...(input.diffStat ? { diffStat: input.diffStat } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    }
    let record: ReviewRecord;
    await this.enqueue("__reviews__", async () => {
      const state = await this.readReviewsState();
      const existing = state.reviews.find((review) => review.runId === input.runId);
      const now = this.now();
      record = {
        id: existing?.id ?? `review-${randomUUID().slice(0, 12)}`,
        runId: input.runId,
        status: input.status,
        summary: input.summary,
        findings: input.findings,
        ...(input.diffStat ? { diffStat: input.diffStat } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const reviews = existing
        ? state.reviews.map((review) => review.runId === input.runId ? record : review)
        : [record, ...state.reviews];
      await this.writeReviewsState({ version: 1, reviews });
    });
    return record!;
  }

  async getPullRequestForRun(runId: string): Promise<PullRequestRecord | undefined> {
    if (this.metadataIndex) return this.metadataIndex.getPullRequestForRun(runId);
    const state = await this.readPullRequestsState();
    return state.pullRequests.find((pullRequest) => pullRequest.runId === runId);
  }

  async recordPullRequest(input: CreatePullRequestRecordInput): Promise<PullRequestRecord> {
    if (this.metadataIndex) {
      const existing = await this.metadataIndex.getPullRequestForRun(input.runId);
      const now = this.now();
      const saved = existing ?? await this.metadataIndex.recordPullRequest({
        id: `pr-${randomUUID().slice(0, 12)}`,
        runId: input.runId,
        provider: input.provider,
        url: input.url,
        ...(input.number === undefined ? {} : { number: input.number }),
        branch: input.branch,
        baseBranch: input.baseBranch,
        title: input.title,
        body: input.body,
        status: "open",
        createdAt: now,
        updatedAt: now,
      });
      await this.updateRun(input.runId, {
        pullRequest: {
          provider: saved.provider,
          url: saved.url,
          ...(saved.number === undefined ? {} : { number: saved.number }),
          branch: saved.branch,
          status: saved.status,
        },
      });
      return saved;
    }
    let record: PullRequestRecord;
    await this.enqueue("__pull_requests__", async () => {
      const state = await this.readPullRequestsState();
      const existing = state.pullRequests.find((pullRequest) => pullRequest.runId === input.runId);
      if (existing) {
        record = existing;
        return;
      }
      const now = this.now();
      record = {
        id: `pr-${randomUUID().slice(0, 12)}`,
        runId: input.runId,
        provider: input.provider,
        url: input.url,
        ...(input.number === undefined ? {} : { number: input.number }),
        branch: input.branch,
        baseBranch: input.baseBranch,
        title: input.title,
        body: input.body,
        status: "open",
        createdAt: now,
        updatedAt: now,
      };
      await this.writePullRequestsState({ version: 1, pullRequests: [record, ...state.pullRequests] });
    });
    const saved = record!;
    await this.updateRun(input.runId, {
      pullRequest: {
        provider: saved.provider,
        url: saved.url,
        ...(saved.number === undefined ? {} : { number: saved.number }),
        branch: saved.branch,
        status: saved.status,
      },
    });
    return saved;
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    if (this.metadataIndex) return this.metadataIndex.getRun(runId);
    const state = await this.readRunsState();
    return state.runs.find((run) => run.id === runId);
  }

  async updateRun(runId: string, patch: Partial<Omit<RunRecord, "id" | "createdAt">>): Promise<RunRecord> {
    if (this.metadataIndex) {
      const run = await this.metadataIndex.getRun(runId);
      if (!run) throw new Error(`Run not found: ${runId}`);
      const updated = normalizeLeaseForStatus({ ...run, ...patch, updatedAt: this.now() });
      await this.writeMetadata(updated);
      await this.metadataIndex.upsertRun(updated, this.pathsForRun(updated.id));
      return updated;
    }
    let updated: RunRecord | undefined;
    await this.mutateRuns((runs) => runs.map((run) => {
      if (run.id !== runId) return run;
      updated = normalizeLeaseForStatus({ ...run, ...patch, updatedAt: this.now() });
      return updated;
    }));
    if (!updated) throw new Error(`Run not found: ${runId}`);
    await this.writeMetadata(updated);
    return updated;
  }

  async rewriteRun(runId: string, updater: (run: RunRecord) => RunRecord): Promise<RunRecord> {
    if (this.metadataIndex) {
      const run = await this.metadataIndex.getRun(runId);
      if (!run) throw new Error(`Run not found: ${runId}`);
      const updated = normalizeLeaseForStatus({ ...updater(run), id: run.id, createdAt: run.createdAt, updatedAt: this.now() });
      await this.writeMetadata(updated);
      await this.metadataIndex.upsertRun(updated, this.pathsForRun(updated.id));
      return updated;
    }
    let updated: RunRecord | undefined;
    const updatedAt = this.now();
    await this.mutateRuns((runs) => runs.map((run) => {
      if (run.id !== runId) return run;
      updated = normalizeLeaseForStatus({ ...updater(run), id: run.id, createdAt: run.createdAt, updatedAt });
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
    if (this.metadataIndex) {
      const run = await this.metadataIndex.getRun(runId);
      await this.metadataIndex.appendControlMessage(runId, run?.currentAttemptId, controlKind(value), toRecord(redactForStorage(value)), this.now());
      return;
    }
    const paths = this.pathsForRun(runId);
    await this.enqueue(runId, async () => {
      await appendJsonl(paths.controlEventsPath, { createdAt: new Date().toISOString(), command: redactForStorage(value) });
    });
  }

  async appendEvent(run: RunRecord, data: NormalizedRunEvent): Promise<StoredRunEvent> {
    const paths = this.pathsForRun(run.id);
    if (this.metadataIndex) {
      const payload = compactEventPayload(redactForStorage(data));
      return this.enqueue(run.id, async () => this.metadataIndex!.appendEvent(run, payload, this.now(), paths));
    }
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
    if (this.metadataIndex) return this.metadataIndex.readEvents(runId, afterSequence);
    return this.readLegacyEvents(runId, afterSequence);
  }

  async heartbeatRunLease(runId: string, workerId: string, leaseTimeoutMs: number): Promise<RunRecord | undefined> {
    if (this.metadataIndex) {
      const updated = await this.metadataIndex.heartbeatRunLease(runId, workerId, this.now(), leaseTimeoutMs);
      if (updated) await this.writeMetadata(updated);
      return updated;
    }
    let updated: RunRecord | undefined;
    await this.mutateRuns((runs) => runs.map((run) => {
      if (run.id !== runId || run.lease?.workerId !== workerId || isTerminalStatus(run.status)) return run;
      const now = this.now();
      updated = { ...run, lease: { ...run.lease, lastHeartbeatAt: now, expiresAt: addMs(now, leaseTimeoutMs) }, updatedAt: now };
      return updated;
    }));
    if (updated) await this.writeMetadata(updated);
    return updated;
  }

  async recoverStaleLeases(leaseTimeoutMs: number): Promise<RunRecord[]> {
    if (this.metadataIndex) {
      const changed = await this.metadataIndex.recoverStaleLeases(this.now(), leaseTimeoutMs);
      for (const run of changed) await this.writeMetadata(run);
      for (const run of changed) await this.appendEvent(run, staleLeaseEvent(run));
      return changed;
    }
    const changed: RunRecord[] = [];
    await this.mutateRuns((runs) => runs.map((run) => {
      if (isTerminalStatus(run.status) || run.status === "queued") return run;
      if (!isLeaseExpired(run, this.now(), leaseTimeoutMs)) return run;
      const now = this.now();
      const recoverable = run.status === "claimed" || run.status === "preparing";
      const updated: RunRecord = recoverable
        ? clearLease({ ...run, status: "queued", error: "Recovered stale worker lease; requeued before runtime became non-resumable.", updatedAt: now })
        : clearLease({ ...run, status: "failed", error: `Stale worker lease expired while run was ${run.status}; runtime/session resume is not supported for this status.`, finishedAt: now, updatedAt: now });
      changed.push(updated);
      return updated;
    }));
    for (const run of changed) await this.writeMetadata(run);
    for (const run of changed) await this.appendEvent(run, staleLeaseEvent(run));
    return changed;
  }

  async markActiveRunsFailedOnBoot(): Promise<void> {
    await this.recoverStaleLeases(this.config.queue.leaseTimeoutMs);
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
    const state = JSON.parse(text) as RunsStateFile;
    return { ...state, runs: state.runs.map(normalizeRunLeaseShape) };
  }

  private async readClaimsState(): Promise<ClaimsStateFile> {
    const text = await readFile(this.claimsStatePath, "utf8");
    return JSON.parse(text) as ClaimsStateFile;
  }

  private async readPullRequestsState(): Promise<PullRequestsStateFile> {
    const text = await readFile(this.pullRequestsStatePath, "utf8");
    return JSON.parse(text) as PullRequestsStateFile;
  }

  private async readReviewsState(): Promise<ReviewsStateFile> {
    const text = await readFile(this.reviewsStatePath, "utf8");
    return JSON.parse(text) as ReviewsStateFile;
  }

  private async writeRunsState(state: RunsStateFile): Promise<void> {
    await mkdir(path.dirname(this.runsStatePath), { recursive: true });
    const tmp = `${this.runsStatePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tmp, this.runsStatePath);
  }

  private async writeClaimsState(state: ClaimsStateFile): Promise<void> {
    await mkdir(path.dirname(this.claimsStatePath), { recursive: true });
    const tmp = `${this.claimsStatePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tmp, this.claimsStatePath);
  }

  private async writePullRequestsState(state: PullRequestsStateFile): Promise<void> {
    await mkdir(path.dirname(this.pullRequestsStatePath), { recursive: true });
    const tmp = `${this.pullRequestsStatePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tmp, this.pullRequestsStatePath);
  }

  private async writeReviewsState(state: ReviewsStateFile): Promise<void> {
    await mkdir(path.dirname(this.reviewsStatePath), { recursive: true });
    const tmp = `${this.reviewsStatePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tmp, this.reviewsStatePath);
  }

  private async mutateRuns(mutator: (runs: RunRecord[]) => RunRecord[]): Promise<void> {
    await this.enqueue("__runs__", async () => {
      const state = await this.readRunsState();
      await this.writeRunsState({ version: 1, runs: mutator(state.runs) });
    });
  }

  private async withClaimsLock<T>(operation: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 30_000;
    while (true) {
      try {
        await mkdir(this.claimsLockPath);
        try {
          await writeFile(this.claimsLockOwnerPath, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() } satisfies ClaimsLockOwner)}\n`, "utf8");
        } catch (error: unknown) {
          await rm(this.claimsLockPath, { recursive: true, force: true });
          throw error;
        }
        break;
      } catch (error: unknown) {
        const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
        if (code !== "EEXIST") throw error;
        if (await this.removeStaleClaimsLock()) continue;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for source claim lock: ${this.claimsLockPath}`);
        await sleep(50);
      }
    }

    try {
      return await operation();
    } finally {
      await rm(this.claimsLockPath, { recursive: true, force: true });
    }
  }

  private async removeStaleClaimsLock(): Promise<boolean> {
    const owner = await this.readClaimsLockOwner();
    if (!owner || isProcessRunning(owner.pid)) return false;
    const currentOwner = await this.readClaimsLockOwner();
    if (currentOwner && (currentOwner.pid !== owner.pid || isProcessRunning(currentOwner.pid))) return false;
    await rm(this.claimsLockPath, { recursive: true, force: true });
    return true;
  }

  private async readClaimsLockOwner(): Promise<ClaimsLockOwner | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.claimsLockOwnerPath, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
      const record = parsed as Record<string, unknown>;
      if (typeof record.pid !== "number" || !Number.isInteger(record.pid)) return undefined;
      if (typeof record.createdAt !== "string") return undefined;
      return { pid: record.pid, createdAt: record.createdAt };
    } catch {
      return undefined;
    }
  }

  private async writeMetadata(run: RunRecord): Promise<void> {
    const paths = this.pathsForRun(run.id);
    await writeFile(paths.metadataPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  }

  private async syncLegacyFilesToPostgres(): Promise<void> {
    if (!this.metadataIndex) return;
    const [runsState, claimsState, pullRequestsState, reviewsState] = await Promise.all([
      this.readRunsState(),
      this.readClaimsState(),
      this.readPullRequestsState(),
      this.readReviewsState(),
    ]);
    for (const run of runsState.runs) {
      const paths = this.pathsForRun(run.id);
      await this.metadataIndex.upsertRun(run, paths);
      let lastEvent: StoredRunEvent | undefined;
      for (const event of await this.readLegacyEvents(run.id)) {
        await this.metadataIndex.importLegacyEvent(event, paths);
        lastEvent = event;
      }
      await this.metadataIndex.indexEventCheckpoint(run.id, paths, lastEvent, lastEvent?.sequence ?? 0, run.updatedAt);
    }
    for (const claim of claimsState.claims) {
      const created = await this.metadataIndex.tryCreateSourceClaim(claim, claim.createdAt);
      if (claim.runId || claim.status !== created.claim.status || claim.error) {
        await this.metadataIndex.updateSourceClaim(claim.key, claim, claim.updatedAt);
      }
    }
    for (const pullRequest of pullRequestsState.pullRequests) await this.metadataIndex.recordPullRequest(pullRequest);
    for (const review of reviewsState.reviews) await this.metadataIndex.recordReview(review);
  }

  private async readLegacyEvents(runId: string, afterSequence = 0): Promise<StoredRunEvent[]> {
    const paths = this.pathsForRun(runId);
    if (!(await exists(paths.normalizedEventsPath))) return [];
    const text = await readFile(paths.normalizedEventsPath, "utf8");
    const events: StoredRunEvent[] = [];
    let lineNumber = 0;
    for (const line of text.split("\n")) {
      lineNumber += 1;
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as StoredRunEvent;
        if (event.sequence > afterSequence) events.push(event);
      } catch (error: unknown) {
        console.error(`Skipping malformed legacy event line ${lineNumber} for ${runId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return events;
  }

  private now(): string {
    const current = Date.now();
    this.lastTimestampMs = Math.max(current, this.lastTimestampMs + 1);
    return new Date(this.lastTimestampMs).toISOString();
  }

  private enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    this.writeQueues.set(key, result.then(() => undefined, () => undefined));
    return result;
  }
}

const DB_EVENT_TEXT_LIMIT = 50_000;

function compactEventPayload(event: NormalizedRunEvent): NormalizedRunEvent {
  switch (event.type) {
    case "assistant_delta":
    case "assistant_message":
      return { ...event, text: truncateForDbEvent(event.text) };
    case "tool_result":
      return { ...event, output: truncateForDbEvent(event.output) };
    case "command_output":
      return { ...event, output: truncateForDbEvent(event.output) };
    case "verification":
      return {
        ...event,
        ...(event.stdout === undefined ? {} : { stdout: truncateForDbEvent(event.stdout) }),
        ...(event.stderr === undefined ? {} : { stderr: truncateForDbEvent(event.stderr) }),
      };
    case "error":
      return { ...event, ...(event.detail === undefined ? {} : { detail: truncateForDbEvent(event.detail) }) };
    default:
      return event;
  }
}

function truncateForDbEvent(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= DB_EVENT_TEXT_LIMIT) return value;
  return `${value.slice(0, DB_EVENT_TEXT_LIMIT)}\n[TaskSmith truncated this database event payload; inspect run artifacts for full raw/log output.]`;
}

function controlKind(value: unknown): string {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.kind === "string") return record.kind;
    if (typeof record.type === "string") return record.type;
  }
  return "unknown";
}

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}

function isProcessRunning(pid: number): boolean {
  if (pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    return code !== "ESRCH";
  }
}

function addMs(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

function isTerminalStatus(status: RunStatus): boolean {
  return status === "completed" || status === "pr_created" || status === "failed" || status === "cancelled";
}

function annotateCapacityBlock(run: RunRecord, capacityReason: string, now: string): RunRecord {
  if (run.error === capacityReason) return run;
  if (run.error && !run.error.startsWith(CAPACITY_QUEUE_ERROR_PREFIX)) return run;
  return { ...run, error: capacityReason, updatedAt: now };
}

function getCapacityBlockReason(runs: RunRecord[], candidate: RunRecord, capacity: RunClaimCapacity): string | undefined {
  const activeRuns = runs.filter((run) => run.status !== "queued" && !isTerminalStatus(run.status) && !!run.lease);
  if (capacity.maxActiveRuns !== undefined && activeRuns.length >= capacity.maxActiveRuns) {
    return `${CAPACITY_QUEUE_ERROR_PREFIX} global limit ${capacity.maxActiveRuns} reached.`;
  }
  if (capacity.maxActiveRunsPerRepo !== undefined) {
    const activeForRepo = activeRuns.filter((run) => run.repoKey === candidate.repoKey).length;
    if (activeForRepo >= capacity.maxActiveRunsPerRepo) {
      return `${CAPACITY_QUEUE_ERROR_PREFIX} repository limit ${capacity.maxActiveRunsPerRepo} reached for ${candidate.repoKey}.`;
    }
  }
  return undefined;
}

function normalizeRunLeaseShape(run: RunRecord & { workerId?: string; leaseExpiresAt?: string; lastHeartbeatAt?: string; leaseAttempt?: number }): RunRecord {
  const { workerId, leaseExpiresAt, lastHeartbeatAt, leaseAttempt, ...rest } = run;
  if (rest.lease || !workerId || !leaseExpiresAt) return rest;
  return {
    ...rest,
    lease: {
      workerId,
      expiresAt: leaseExpiresAt,
      ...(lastHeartbeatAt ? { lastHeartbeatAt } : {}),
      attempt: leaseAttempt ?? 0,
    },
  };
}

function isLeaseExpired(run: RunRecord, now: string, leaseTimeoutMs: number): boolean {
  if (!run.lease) return false;
  const expiresAt = run.lease.expiresAt ?? (run.lease.lastHeartbeatAt ? addMs(run.lease.lastHeartbeatAt, leaseTimeoutMs) : undefined);
  if (!expiresAt) return false;
  const expiresAtMs = Date.parse(expiresAt);
  const nowMs = Date.parse(now);
  return Number.isFinite(expiresAtMs) && Number.isFinite(nowMs) ? expiresAtMs <= nowMs : false;
}

function normalizeLeaseForStatus(run: RunRecord): RunRecord {
  return isTerminalStatus(run.status) ? clearLease(run) : run;
}

function clearLease(run: RunRecord): RunRecord {
  const { lease: _lease, ...rest } = run;
  return rest;
}

function staleLeaseEvent(run: RunRecord): NormalizedRunEvent {
  return {
    type: "run_status",
    status: run.status,
    detail: run.status === "queued"
      ? "Stale worker lease expired; run was safely requeued from claimed/preparing."
      : `Stale worker lease expired; ${run.status === "failed" ? "run failed because runtime/session resume is not supported for this status." : "run recovered."}`,
  };
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
