import { randomUUID } from "node:crypto";
import type { RunClaimCapacity } from "../domain/types.js";
import type { FileStore } from "../storage/file-store.js";
import type { RuntimeManager } from "./runtime-manager.js";

export class RunScheduler {
  private wakeTimer: NodeJS.Timeout | undefined;
  private processing = false;
  private stopped = false;
  private readonly workerId = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;

  constructor(
    private readonly store: FileStore,
    private readonly runtime: RuntimeManager,
    private readonly pollIntervalMs = 1_000,
    private readonly capacity: RunClaimCapacity = {},
  ) {}

  start(): void {
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
  }

  wake(): void {
    this.schedule(0);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.wakeTimer) {
      if (delayMs > 0) return;
      clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
    }
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      void this.process().catch((error: unknown) => {
        console.error("TaskSmith scheduler failed", error);
        this.schedule(this.pollIntervalMs);
      });
    }, delayMs);
    this.wakeTimer.unref();
  }

  private async process(): Promise<void> {
    if (this.processing || this.stopped) return;
    this.processing = true;
    try {
      while (!this.stopped) {
        await this.store.recoverStaleLeases(this.runtime.leaseTimeoutMs);
        const run = await this.store.claimNextQueuedRun(this.workerId, this.runtime.leaseTimeoutMs, this.capacity);
        if (!run) break;
        try {
          await this.runtime.startRun(run, this.workerId);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          await this.store.updateRun(run.id, { status: "failed", error: `Scheduler failed to start run: ${message}`, finishedAt: new Date().toISOString() });
          console.error(`TaskSmith scheduler failed to start run ${run.id}`, error);
        }
      }
    } finally {
      this.processing = false;
      this.schedule(this.pollIntervalMs);
    }
  }
}
