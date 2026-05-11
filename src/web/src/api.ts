import type { ControlKind, CreateRunInput, EditableConfigResponse, PublicAppConfig, RunRecord, StoredRunEvent } from "./types";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const text = await response.text();
  const body = (text ? JSON.parse(text) : {}) as T & { error?: string };
  if (!response.ok) {
    if (response.status === 401 && location.pathname !== "/login") {
      window.location.href = "/login";
    }
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return body as T;
}

export async function getPublicConfig(): Promise<PublicAppConfig> {
  return fetchJson<PublicAppConfig>("/api/config");
}

export async function getEditableConfig(): Promise<EditableConfigResponse> {
  return fetchJson<EditableConfigResponse>("/api/admin/config");
}

export async function saveEditableConfig(config: unknown): Promise<EditableConfigResponse> {
  return fetchJson<EditableConfigResponse>("/api/admin/config", {
    method: "PUT",
    body: JSON.stringify(config),
  });
}

export async function listRuns(): Promise<RunRecord[]> {
  const { runs } = await fetchJson<{ runs: RunRecord[] }>("/api/runs");
  return runs;
}

export async function getRun(runId: string): Promise<RunRecord> {
  const { run } = await fetchJson<{ run: RunRecord }>(`/api/runs/${encodeURIComponent(runId)}`);
  return run;
}

export async function getRunEvents(runId: string, after = 0): Promise<StoredRunEvent[]> {
  const { events } = await fetchJson<{ events: StoredRunEvent[] }>(
    `/api/runs/${encodeURIComponent(runId)}/events?after=${after}`,
  );
  return events;
}

export async function createRun(input: CreateRunInput): Promise<RunRecord> {
  const { run } = await fetchJson<{ run: RunRecord }>("/api/runs", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return run;
}

export async function sendControl(
  runId: string,
  kind: ControlKind,
  message: string,
): Promise<void> {
  await fetchJson(`/api/runs/${encodeURIComponent(runId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ kind, message }),
  });
}

export async function abortRun(runId: string): Promise<void> {
  await fetchJson(`/api/runs/${encodeURIComponent(runId)}/abort`, {
    method: "POST",
    body: "{}",
  });
}

export function streamUrl(runId: string, after = 0): string {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${location.host}/api/runs/${encodeURIComponent(runId)}/stream?after=${after}`;
}
