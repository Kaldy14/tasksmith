import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { AppConfig } from "../domain/types.js";
import { parseControlInput, parseCreateRunInput } from "../domain/validation.js";
import type { FileStore } from "../storage/file-store.js";
import type { RuntimeManager } from "../runtime/runtime-manager.js";
import { EventHub, sendJson } from "./event-hub.js";

interface ServerDeps {
  config: AppConfig;
  store: FileStore;
  runtime: RuntimeManager;
  hub: EventHub;
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
    const runId = decodeURIComponent(match[1] ?? "");
    wss.handleUpgrade(req, socket, head, (ws) => {
      void handleRunSocket(deps, runId, url, ws).catch((error: unknown) => {
        ws.send(JSON.stringify({ type: "error", error: error instanceof Error ? error.message : String(error) }));
        ws.close();
      });
    });
  });

  return server;
}

async function routeHttp(deps: ServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = parseUrl(req);
  const method = req.method ?? "GET";

  if (method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "GET" && url.pathname === "/api/runs") {
    sendJson(res, 200, { runs: await deps.store.listRuns() });
    return;
  }

  if (method === "POST" && url.pathname === "/api/runs") {
    const input = parseCreateRunInput(await readJson(req));
    const run = await deps.store.createRun(input);
    await deps.runtime.startRun(run);
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

  await serveStatic(deps.config, url.pathname, res);
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
  const relativePath = pathname === "/" || pathname.startsWith("/runs/") ? "index.html" : pathname.replace(/^\//, "");
  const filePath = path.resolve(config.publicDir, relativePath);
  if (!isPathInside(config.publicDir, filePath)) return sendJson(res, 403, { error: "Forbidden" });
  try {
    await readFile(filePath);
  } catch {
    return sendJson(res, 404, { error: "Not found" });
  }
  res.writeHead(200, { "content-type": contentType(filePath), "cache-control": "no-store" });
  createReadStream(filePath).pipe(res);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    const size = chunks.reduce((sum, item) => sum + item.byteLength, 0);
    if (size > 1_000_000) throw new Error("Request body too large");
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() ? JSON.parse(text) : {};
}

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
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
