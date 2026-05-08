export function redactForStorage<T>(value: T): T {
  return deepRedact(value) as T;
}

function deepRedact(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((entry) => deepRedact(entry));
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = isSecretKey(key) ? "[REDACTED]" : deepRedact(entry);
    }
    return result;
  }
  return value;
}

function redactString(value: string): string {
  return value
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[REDACTED:anthropic-key]")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED:api-key]")
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED:github-token]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]");
}

function isSecretKey(key: string): boolean {
  return /token|secret|password|api[_-]?key|authorization|refresh/i.test(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
