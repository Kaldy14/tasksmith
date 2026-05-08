import type { CreateRunInput, RuntimeAdapter, ControlKind } from "./types.js";

export function parseCreateRunInput(value: unknown): CreateRunInput {
  const record = expectRecord(value, "request body");
  const title = cleanString(record.title, "title", 160);
  const prompt = cleanString(record.prompt, "prompt", 20_000);
  const repoKey = cleanString(record.repoKey ?? "manual", "repoKey", 80);
  const adapter = parseAdapter(record.adapter ?? "pi");
  return { title, prompt, repoKey, adapter };
}

export function parseControlInput(value: unknown): { kind: ControlKind; message: string } {
  const record = expectRecord(value, "request body");
  const kind = parseControlKind(record.kind);
  const message = cleanString(record.message, "message", 20_000);
  return { kind, message };
}

function parseAdapter(value: unknown): RuntimeAdapter {
  if (value === "pi" || value === "demo") return value;
  throw new Error("adapter must be 'pi' or 'demo'");
}

function parseControlKind(value: unknown): ControlKind {
  if (value === "prompt" || value === "steer" || value === "follow_up") return value;
  throw new Error("kind must be 'prompt', 'steer', or 'follow_up'");
}

function cleanString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} is required`);
  if (Buffer.byteLength(trimmed, "utf8") > maxLength) throw new Error(`${field} exceeds ${maxLength} bytes`);
  return trimmed;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
