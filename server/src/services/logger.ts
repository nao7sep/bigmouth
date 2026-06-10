/**
 * Logging module.
 *
 * Writes to both stdout and a log file at ~/.bigmouth/logs/.
 * One log file per server start, named yyyymmdd-hhmmss-utc.log.
 * Logs are shared across all workspaces (single server process).
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { utcNow, formatForFilename, formatUtcIso } from "../shared/timestamps.js";

type LogLevel = "INFO" | "WARN" | "ERROR";

let logStream: fs.WriteStream | null = null;
let currentLogFilePath: string | null = null;
const REDACTED_KEYS = new Set([
  "apiKey",
  "authorization",
  "token",
  "password",
  "secret",
]);

/**
 * Initializes the logger by creating a log file in the given logs directory.
 * Must be called once at startup.
 */
export function initLogger(logsDir: string): void {
  fs.mkdirSync(logsDir, { recursive: true });

  const logFileName = `${formatForFilename(utcNow())}.log`;
  const logFilePath = path.join(logsDir, logFileName);

  currentLogFilePath = logFilePath;
  logStream = fs.createWriteStream(logFilePath, { flags: "a" });
}

export function getCurrentLogFilePath(): string | null {
  return currentLogFilePath;
}

export async function revealCurrentLogFile(): Promise<string> {
  if (!currentLogFilePath) {
    throw new Error("Current log file is not available");
  }

  const filePath = currentLogFilePath;
  let command: string;
  let args: string[];

  if (process.platform === "darwin") {
    command = "open";
    args = ["-R", filePath];
  } else if (process.platform === "win32") {
    command = "explorer.exe";
    args = [`/select,${filePath.replace(/\//g, "\\")}`];
  } else {
    command = "xdg-open";
    args = [path.dirname(filePath)];
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Reveal command failed with exit code ${code ?? "unknown"}`));
    });
  });

  return filePath;
}

function log(level: LogLevel, message: string): void {
  const timestamp = formatUtcIso(utcNow());
  const line = `${timestamp} [${level}] ${message}`;

  console.log(line);

  if (logStream) {
    logStream.write(line + "\n");
  }
}

function summarizeForLog(value: unknown, depth = 0): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length <= 160) return normalized;
    return `${normalized.slice(0, 160)}… [${normalized.length} chars]`;
  }

  if (Array.isArray(value)) {
    if (depth >= 2) return `[array(${value.length})]`;
    const items = value.slice(0, 10).map((item) => summarizeForLog(item, depth + 1));
    if (value.length > 10) {
      items.push(`… [${value.length - 10} more]`);
    }
    return items;
  }

  if (typeof value === "object") {
    if (depth >= 2) return "[object]";
    const record = value as Record<string, unknown>;
    const entries = Object.entries(record);
    const summarized: Record<string, unknown> = {};
    for (const [index, [key, entryValue]] of entries.entries()) {
      if (index >= 20) {
        summarized.__truncated = `${entries.length - 20} more keys`;
        break;
      }
      summarized[key] = REDACTED_KEYS.has(key)
        ? "[REDACTED]"
        : summarizeForLog(entryValue, depth + 1);
    }
    return summarized;
  }

  return String(value);
}

export function formatLogValue(value: unknown): string {
  try {
    return JSON.stringify(summarizeForLog(value));
  } catch (err) {
    return `[unserializable: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

export function formatRequestShape(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length > 0 ? keys.join(",") : "[empty-object]";
  }
  return typeof value;
}

export function logBlock(level: LogLevel, title: string, content: string): void {
  log(level, `${title} >>>`);
  const lines = content.length > 0 ? content.split(/\r?\n/) : ["[empty]"];
  for (const line of lines) {
    log(level, `| ${line}`);
  }
  log(level, "<<<");
}

export function info(message: string): void {
  log("INFO", message);
}

export function warn(message: string): void {
  log("WARN", message);
}

export function error(message: string): void {
  log("ERROR", message);
}
