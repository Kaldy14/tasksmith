import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { AppConfig, RepositoryConfig } from "../domain/types.js";
import { parseControlInput, parseCreateRunInput } from "../domain/validation.js";
import type { FileStore } from "../storage/file-store.js";
import type { RuntimeManager } from "../runtime/runtime-manager.js";
import type { RunScheduler } from "../runtime/run-scheduler.js";
import type { SourcePoller } from "../sources/source-poller.js";
import type { SourceIntakeService } from "../sources/source-intake.js";
import { handleGitHubIssuesWebhook } from "../sources/github-webhook.js";
import type { TaskSmithAuthService } from "../auth/tasksmith-auth.js";
import { readEditableConfig, saveEditableConfig } from "./config.js";
import { EventHub, sendJson } from "./event-hub.js";

interface ServerDeps {
  config: AppConfig;
  store: FileStore;
  runtime: RuntimeManager;
  scheduler: RunScheduler;
  sourcePoller: SourcePoller;
  sourceIntake: SourceIntakeService;
  hub: EventHub;
  auth: TaskSmithAuthService | undefined;
}

export function createTaskSmithServer(deps: ServerDeps): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    void routeHttp(deps, req, res).catch((error: unknown) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = parseUrl(req);
    const match = /^\/api\/runs\/([^/]+)\/stream$/.exec(url.pathname);
    if (!match) {
      socket.destroy();
      return;
    }
    void ensureAuthenticated(deps, req).then((ok) => {
      if (!ok) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const runId = decodeURIComponent(match[1] ?? "");
      wss.handleUpgrade(req, socket, head, (ws) => {
        void handleRunSocket(deps, runId, url, ws).catch((error: unknown) => {
          ws.send(JSON.stringify({ type: "error", error: error instanceof Error ? error.message : String(error) }));
          ws.close();
        });
      });
    }).catch(() => {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
    });
  });

  return server;
}

async function routeHttp(deps: ServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = parseUrl(req);
  const method = req.method ?? "GET";

  if (method === "GET" && url.pathname === "/healthz") {
    const storage = deps.store.hasMetadataIndex() ? "postgres" : "file-only";
    sendJson(res, 200, { ok: true, storage, metadataIndex: storage, auth: deps.auth ? "enabled" : "disabled" });
    return;
  }

  if (deps.auth && url.pathname.startsWith("/api/auth/")) {
    await deps.auth.handleNode(req, res);
    return;
  }

  if (method === "POST" && url.pathname === "/api/webhooks/github/issues") {
    try {
      const rawBody = await readRawBody(req);
      const result = await handleGitHubIssuesWebhook(deps.config, deps.sourceIntake, req.headers, rawBody);
      if (result.createdRuns > 0) deps.scheduler.wake();
      sendJson(res, 202, result);
    } catch (error: unknown) {
      const statusCode = isStatusError(error) ? error.statusCode : 500;
      sendJson(res, statusCode, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname.startsWith("/api/") && !(await ensureAuthenticated(deps, req))) {
    sendJson(res, 401, { error: "Authentication required" });
    return;
  }

  if (method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, {
      auth: { enabled: deps.config.auth.enabled },
      repositories: publicRepositories(deps.config.repositories),
      sourceFlow: deps.config.sourceFlow,
      workflow: deps.config.workflow,
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/admin/config") {
    sendJson(res, 200, await readEditableConfig(deps.config));
    return;
  }

  if (method === "PUT" && url.pathname === "/api/admin/config") {
    sendJson(res, 200, await saveEditableConfig(deps.config, await readJson(req)));
    return;
  }

  if (method === "POST" && url.pathname === "/api/sources/poll") {
    const result = await deps.sourcePoller.pollOnce();
    deps.scheduler.wake();
    sendJson(res, 202, result);
    return;
  }

  if (method === "GET" && url.pathname === "/api/source-claims") {
    sendJson(res, 200, { claims: await deps.store.listSourceClaims() });
    return;
  }

  if (method === "GET" && url.pathname === "/api/pull-requests") {
    sendJson(res, 200, { pullRequests: await deps.store.listPullRequests() });
    return;
  }

  if (method === "GET" && url.pathname === "/api/reviews") {
    sendJson(res, 200, { reviews: await deps.store.listReviews() });
    return;
  }

  if (method === "GET" && url.pathname === "/api/runs") {
    sendJson(res, 200, { runs: await deps.store.listRuns() });
    return;
  }

  if (method === "POST" && url.pathname === "/api/runs") {
    const input = parseCreateRunInput(await readJson(req));
    const run = await deps.store.createRun(input);
    deps.scheduler.wake();
    sendJson(res, 201, { run });
    return;
  }

  const runMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
  if (method === "GET" && runMatch) {
    const run = await deps.store.getRun(decodeURIComponent(runMatch[1] ?? ""));
    if (!run) return sendJson(res, 404, { error: "Run not found" });
    sendJson(res, 200, { run });
    return;
  }

  const reviewMatch = /^\/api\/runs\/([^/]+)\/review$/.exec(url.pathname);
  if (method === "GET" && reviewMatch) {
    const runId = decodeURIComponent(reviewMatch[1] ?? "");
    const review = await deps.store.getReviewForRun(runId);
    if (!review) return sendJson(res, 404, { error: "Review not found" });
    sendJson(res, 200, { review });
    return;
  }

  const eventsMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(url.pathname);
  if (method === "GET" && eventsMatch) {
    const runId = decodeURIComponent(eventsMatch[1] ?? "");
    const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
    sendJson(res, 200, { events: await deps.store.readEvents(runId, Number.isFinite(after) ? after : 0) });
    return;
  }

  const messagesMatch = /^\/api\/runs\/([^/]+)\/messages$/.exec(url.pathname);
  if (method === "POST" && messagesMatch) {
    const runId = decodeURIComponent(messagesMatch[1] ?? "");
    const input = parseControlInput(await readJson(req));
    await deps.runtime.sendControl(runId, input.kind, input.message);
    sendJson(res, 202, { ok: true });
    return;
  }

  const abortMatch = /^\/api\/runs\/([^/]+)\/abort$/.exec(url.pathname);
  if (method === "POST" && abortMatch) {
    const runId = decodeURIComponent(abortMatch[1] ?? "");
    await deps.runtime.abortRun(runId);
    sendJson(res, 202, { ok: true });
    return;
  }

  const abortBashMatch = /^\/api\/runs\/([^/]+)\/abort-bash$/.exec(url.pathname);
  if (method === "POST" && abortBashMatch) {
    const runId = decodeURIComponent(abortBashMatch[1] ?? "");
    await deps.runtime.abortBash(runId);
    sendJson(res, 202, { ok: true });
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  if (requiresAuthenticatedPage(deps, url.pathname) && !(await ensureAuthenticated(deps, req))) {
    redirect(res, `/login?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
    return;
  }

  await serveStatic(deps.config, url.pathname, res);
}

async function ensureAuthenticated(deps: ServerDeps, req: IncomingMessage): Promise<boolean> {
  if (!deps.auth) return true;
  return (await deps.auth.getSession(req.headers)) !== null;
}

function requiresAuthenticatedPage(deps: ServerDeps, pathname: string): boolean {
  if (!deps.auth) return false;
  if (pathname === "/login") return false;
  return !path.extname(pathname);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, "cache-control": "no-store" });
  res.end();
}

async function handleRunSocket(deps: ServerDeps, runId: string, url: URL, ws: WebSocket): Promise<void> {
  const run = await deps.store.getRun(runId);
  if (!run) throw new Error("Run not found");
  deps.hub.subscribe(runId, ws);
  const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
  for (const event of await deps.store.readEvents(runId, Number.isFinite(after) ? after : 0)) {
    ws.send(JSON.stringify({ type: "event", event }));
  }
  ws.on("message", (raw) => {
    void handleSocketMessage(deps, runId, raw).catch((error: unknown) => {
      ws.send(JSON.stringify({ type: "error", error: error instanceof Error ? error.message : String(error) }));
    });
  });
}

async function handleSocketMessage(deps: ServerDeps, runId: string, raw: Buffer | ArrayBuffer | Buffer[]): Promise<void> {
  const text = rawToText(raw);
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed) || parsed.type !== "control") throw new Error("Expected websocket control message");
  const input = parseControlInput(parsed);
  await deps.runtime.sendControl(runId, input.kind, input.message);
}

async function serveStatic(config: AppConfig, pathname: string, res: ServerResponse): Promise<void> {
  const requestedPath = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const filePath = path.resolve(config.publicDir, requestedPath);
  if (!isPathInside(config.publicDir, filePath)) return sendJson(res, 403, { error: "Forbidden" });
  if (await serveFile(filePath, res)) return;

  if (path.extname(pathname)) return sendJson(res, 404, { error: "Not found" });
  const indexPath = path.resolve(config.publicDir, "index.html");
  if (!isPathInside(config.publicDir, indexPath)) return sendJson(res, 403, { error: "Forbidden" });
  if (await serveFile(indexPath, res)) return;
  sendJson(res, 404, { error: "Not found" });
}

async function serveFile(filePath: string, res: ServerResponse): Promise<boolean> {
  try {
    await readFile(filePath);
  } catch {
    return false;
  }
  res.writeHead(200, { "content-type": contentType(filePath), "cache-control": "no-store" });
  createReadStream(filePath).pipe(res);
  return true;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const text = (await readRawBody(req)).toString("utf8");
  return text.trim() ? JSON.parse(text) : {};
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    chunks.push(buffer);
    size += buffer.byteLength;
    if (size > 1_000_000) throw new Error("Request body too large");
  }
  return Buffer.concat(chunks);
}

function isStatusError(error: unknown): error is Error & { statusCode: number } {
  return error instanceof Error && "statusCode" in error && typeof (error as { statusCode?: unknown }).statusCode === "number";
}

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
}

function publicRepositories(repositories: Readonly<Record<string, RepositoryConfig>>): Array<Record<string, unknown>> {
  return Object.entries(repositories)
    .map(([key, repo]) => ({
      key,
      displayName: repo.displayName ?? key,
      defaultBranch: repo.defaultBranch ?? "main",
      hasGitUrl: Boolean(repo.gitUrl),
      gitProvider: repo.gitProvider ? { type: repo.gitProvider.type, owner: repo.gitProvider.owner, repo: repo.gitProvider.repo } : undefined,
      issueProvider: repo.issueProvider ? { type: repo.issueProvider.type } : undefined,
      workflow: repo.workflow ? { deliveryMode: repo.workflow.deliveryMode, maxFixAttempts: repo.workflow.maxFixAttempts, maxCiFixAttempts: repo.workflow.maxCiFixAttempts, maxReviewFixAttempts: repo.workflow.maxReviewFixAttempts } : undefined,
      codeRabbit: repo.codeRabbit ? { enabled: repo.codeRabbit.enabled, cliEnabled: repo.codeRabbit.cli.enabled } : undefined,
      initCommandCount: repo.initCommands?.length ?? 0,
      hasVerificationProfile: repo.verify !== undefined,
    }))
    .sort((left, right) => String(left.displayName).localeCompare(String(right.displayName)));
}

function isPathInside(basePath: string, candidatePath: string): boolean {
  const relative = path.relative(basePath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function rawToText(raw: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  return Buffer.from(new Uint8Array(raw)).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
