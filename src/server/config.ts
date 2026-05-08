import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig, VerificationCommandConfig } from "../domain/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loadConfig(): AppConfig {
  const dataDir = path.resolve(process.env.TASKSMITH_DATA_DIR ?? ".data/tasksmith");
  return {
    port: parsePort(process.env.PORT ?? "3000"),
    host: process.env.HOST ?? "0.0.0.0",
    dataDir,
    runsDir: path.join(dataDir, "runs"),
    stateDir: path.join(dataDir, "state"),
    piAuthSourceDir: path.resolve(process.env.TASKSMITH_PI_AUTH_SOURCE ?? "/run/tasksmith/pi-auth"),
    publicDir: path.join(repoRoot, "src", "server", "public"),
    verificationCommands: parseVerificationCommands(),
  };
}

function parseVerificationCommands(): VerificationCommandConfig[] {
  const raw = process.env.TASKSMITH_VERIFICATION_COMMANDS;
  if (!raw?.trim()) return [defaultWorkspaceSmokeCommand()];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("TASKSMITH_VERIFICATION_COMMANDS must be a JSON array");
  return parsed.map((entry, index) => parseVerificationCommand(entry, index));
}

function parseVerificationCommand(value: unknown, index: number): VerificationCommandConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`verification command ${index} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const name = parseRequiredString(record.name, `verification command ${index} name`, 80);
  const command = parseRequiredString(record.command, `verification command ${index} command`, 4_000);
  const timeoutMs = record.timeoutMs === undefined ? 120_000 : parseTimeout(record.timeoutMs, `verification command ${index} timeoutMs`);
  return { name, command, timeoutMs };
}

function defaultWorkspaceSmokeCommand(): VerificationCommandConfig {
  const script = "const fs=require('fs'); if (!fs.existsSync('README.md')) { console.error('README.md missing'); process.exit(1); } console.log('workspace smoke ok');";
  return {
    name: "workspace-smoke",
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
    timeoutMs: 30_000,
  };
}

function parseRequiredString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  if (Buffer.byteLength(trimmed, "utf8") > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  return trimmed;
}

function parseTimeout(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 3_600_000) {
    throw new Error(`${label} must be an integer between 1 and 3600000`);
  }
  return value;
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`Invalid PORT: ${value}`);
  return port;
}
