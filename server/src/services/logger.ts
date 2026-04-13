/**
 * Logging module.
 *
 * Writes to both stdout and a log file at ~/.bigmouth/logs/.
 * One log file per server start, named yyyymmdd-hhmmss-utc.log.
 * Logs are shared across all workspaces (single server process).
 */

import fs from "node:fs";
import path from "node:path";
import { utcNow, formatForFilename, formatForFrontMatter } from "../shared/timestamps.js";

type LogLevel = "INFO" | "WARN" | "ERROR";

let logStream: fs.WriteStream | null = null;

/**
 * Initializes the logger by creating a log file in the given logs directory.
 * Must be called once at startup.
 */
export function initLogger(logsDir: string): void {
  fs.mkdirSync(logsDir, { recursive: true });

  const logFileName = `${formatForFilename(utcNow())}.log`;
  const logFilePath = path.join(logsDir, logFileName);

  logStream = fs.createWriteStream(logFilePath, { flags: "a" });
}

function log(level: LogLevel, message: string): void {
  const timestamp = formatForFrontMatter(utcNow());
  const line = `${timestamp} [${level}] ${message}`;

  console.log(line);

  if (logStream) {
    logStream.write(line + "\n");
  }
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
