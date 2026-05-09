import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ControlKind, NormalizedRunEvent, RunPaths, RunRecord, RuntimeHandle } from "../domain/types.js";

export interface RuntimeSink {
  emit(event: NormalizedRunEvent): Promise<void>;
  setCompleted(summary: string): Promise<void>;
  setFailed(error: string): Promise<void>;
  setAborted(summary: string): Promise<void>;
}

export class DemoRuntime implements RuntimeHandle {
  private aborted = false;
  private steering: string[] = [];
  private followUp: string[] = [];

  constructor(
    private readonly run: RunRecord,
    private readonly sink: RuntimeSink,
    private readonly paths?: RunPaths,
  ) {}

  async start(): Promise<void> {
    try {
      await this.sink.emit({ type: "run_status", status: "running", detail: "Demo runtime started" });
      await this.sink.emit({ type: "tool_call", name: "ls", toolCallId: "demo-ls", input: { path: "." } });
      await delay(250);
      if (await this.stopIfAborted()) return;
      await this.sink.emit({ type: "tool_result", name: "ls", toolCallId: "demo-ls", output: "README.md\n" });
      await this.stream(`TaskSmith demo run ${this.run.id} is inspecting ${this.run.repoKey}. `);
      await this.flushSteering();
      await this.stream("The runtime is producing live assistant deltas, tool events, and persisted replayable messages. ");
      await this.sink.emit({ type: "command", command: "printf demo-verifier-placeholder", toolCallId: "demo-command" });
      await delay(200);
      if (await this.stopIfAborted()) return;
      await this.sink.emit({ type: "command_output", command: "printf demo-verifier-placeholder", output: "demo-verifier-placeholder\n", toolCallId: "demo-command" });
      await this.maybeWriteDemoChange();
      await this.flushSteering();
      await this.flushFollowUps();
      const finalText = "Demo run complete. The UI can replay this session, steer active work, queue follow-ups, and abort safely.";
      await this.sink.emit({ type: "assistant_message", text: finalText, stopReason: "stop" });
      await this.sink.setCompleted(finalText);
    } catch (error: unknown) {
      await this.sink.setFailed(error instanceof Error ? error.message : String(error));
    }
  }

  async send(kind: ControlKind, message: string): Promise<void> {
    if (kind === "steer" || kind === "prompt") this.steering.push(message);
    if (kind === "follow_up") this.followUp.push(message);
    await this.sink.emit({ type: "queue_update", steering: this.steering, followUp: this.followUp });
  }

  async abort(): Promise<void> {
    this.aborted = true;
    await this.sink.setAborted("Demo runtime aborted by user.");
  }

  async abortBash(): Promise<void> {
    await this.sink.emit({ type: "run_status", status: "running", detail: "Demo abort_bash acknowledged" });
  }

  async dispose(): Promise<void> {
    this.aborted = true;
  }

  private async stream(text: string): Promise<void> {
    for (const token of text.split(/(\s+)/).filter(Boolean)) {
      if (await this.stopIfAborted()) return;
      await this.sink.emit({ type: "assistant_delta", text: token });
      await delay(55);
    }
  }

  private async maybeWriteDemoChange(): Promise<void> {
    if (!this.paths || !this.run.prompt.includes("TASKSMITH_DEMO_WRITE_CHANGE")) return;
    const filePath = path.join(this.paths.workspaceDir, "TASKSMITH_DEMO_CHANGE.txt");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `Demo change created for ${this.run.id}\n`, "utf8");
    await this.sink.emit({ type: "command", command: "write TASKSMITH_DEMO_CHANGE.txt", toolCallId: "demo-write-change" });
    await this.sink.emit({ type: "command_output", command: "write TASKSMITH_DEMO_CHANGE.txt", output: "TASKSMITH_DEMO_CHANGE.txt\n", toolCallId: "demo-write-change" });
  }

  private async flushSteering(): Promise<void> {
    while (this.steering.length > 0) {
      const message = this.steering.shift();
      if (!message) continue;
      await this.sink.emit({ type: "queue_update", steering: this.steering, followUp: this.followUp });
      await this.stream(`Steering received: ${message}. `);
    }
  }

  private async flushFollowUps(): Promise<void> {
    while (this.followUp.length > 0) {
      const message = this.followUp.shift();
      if (!message) continue;
      await this.sink.emit({ type: "queue_update", steering: this.steering, followUp: this.followUp });
      await this.stream(`Follow-up received: ${message}. `);
    }
  }

  private async stopIfAborted(): Promise<boolean> {
    if (!this.aborted) return false;
    await this.sink.setAborted("Demo runtime aborted by user.");
    return true;
  }
}
