import type { ServerResponse } from "node:http";
import { WebSocket } from "ws";
import type { StoredRunEvent } from "../domain/types.js";

export class EventHub {
  private readonly socketsByRun = new Map<string, Set<WebSocket>>();

  subscribe(runId: string, socket: WebSocket): void {
    const sockets = this.socketsByRun.get(runId) ?? new Set<WebSocket>();
    sockets.add(socket);
    this.socketsByRun.set(runId, sockets);
    socket.on("close", () => this.unsubscribe(runId, socket));
    socket.on("error", () => this.unsubscribe(runId, socket));
  }

  broadcast(event: StoredRunEvent): void {
    const sockets = this.socketsByRun.get(event.runId);
    if (!sockets) return;
    const payload = JSON.stringify({ type: "event", event });
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }

  private unsubscribe(runId: string, socket: WebSocket): void {
    const sockets = this.socketsByRun.get(runId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) this.socketsByRun.delete(runId);
  }
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}
