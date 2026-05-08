import path from "node:path";
import { writeFile } from "node:fs/promises";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import type { ControlKind, RunPaths, RunRecord, RuntimeHandle } from "../domain/types.js";
import { normalizePiEvent } from "./normalizer.js";
import { buildTaskPrompt } from "./prompt.js";
import type { RuntimeSink } from "./demo-adapter.js";
import type { FileStore } from "../storage/file-store.js";

export class PiRuntime implements RuntimeHandle {
  private session: AgentSession | undefined;
  private failed = false;

  constructor(
    private readonly run: RunRecord,
    private readonly paths: RunPaths,
    private readonly store: FileStore,
    private readonly sink: RuntimeSink,
  ) {}

  async start(): Promise<void> {
    try {
      await this.sink.emit({ type: "run_status", status: "preparing", detail: "Preparing Pi runtime" });
      const copiedFiles = await this.store.copyPiAuthMaterial(this.paths);
      await writeFile(path.join(this.paths.logsDir, "auth-files.json"), `${JSON.stringify({ copiedFiles }, null, 2)}\n`, "utf8");
      this.session = await this.createSession();
      const session = this.session;
      await this.sink.emit({
        type: "session_state",
        sessionId: session.sessionId,
        ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
        isStreaming: session.isStreaming,
        messageCount: session.messages.length,
        pendingMessageCount: session.pendingMessageCount,
      });
      session.subscribe((event) => {
        void this.store.appendRawEvent(this.run.id, event);
        for (const normalized of normalizePiEvent(event)) void this.sink.emit(normalized);
      });
      await session.prompt(buildTaskPrompt(this.run));
      if (!this.failed) {
        const summary = session.getLastAssistantText() ?? "Pi run completed.";
        await this.sink.setCompleted(summary);
      }
    } catch (error: unknown) {
      this.failed = true;
      await this.sink.setFailed(error instanceof Error ? error.message : String(error));
    }
  }

  async send(kind: ControlKind, message: string): Promise<void> {
    const session = this.requireSession();
    if (kind === "prompt") {
      await session.prompt(message, session.isStreaming ? { streamingBehavior: "steer" } : undefined);
      return;
    }
    if (kind === "steer") {
      await session.steer(message);
      return;
    }
    await session.followUp(message);
  }

  async abort(): Promise<void> {
    const session = this.session;
    if (session) await session.abort();
    await this.sink.setAborted("Pi runtime aborted by user.");
  }

  async abortBash(): Promise<void> {
    this.session?.abortBash();
  }

  async dispose(): Promise<void> {
    this.session?.dispose();
  }

  private async createSession(): Promise<AgentSession> {
    const authStorage = AuthStorage.create(this.paths.authPath);
    const modelRegistry = ModelRegistry.create(authStorage, this.paths.modelsPath);
    const settingsManager = SettingsManager.create(this.paths.workspaceDir, this.paths.agentDir);
    settingsManager.applyOverrides({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
      sessionDir: this.paths.sessionDir,
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.paths.workspaceDir,
      agentDir: this.paths.agentDir,
      settingsManager,
      noContextFiles: true,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPromptOverride: (base) => `${base ?? ""}\n\nTaskSmith runtime boundary:\n- You are controlled by TaskSmith, a wrapper around Pi.\n- Work only inside the provided workspace.\n- Do not access production secrets.\n- Do not create pull requests; TaskSmith will handle Git and PR creation.\n`,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: this.paths.workspaceDir,
      agentDir: this.paths.agentDir,
      authStorage,
      modelRegistry,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.create(this.paths.workspaceDir, this.paths.sessionDir),
      tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    });
    session.setSessionName(`TaskSmith ${this.run.id}`);
    return session;
  }

  private requireSession(): AgentSession {
    if (!this.session) throw new Error("Pi session is not ready yet");
    return this.session;
  }
}
