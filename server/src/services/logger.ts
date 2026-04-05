/**
 * Logging module.
 *
 * Writes to both stdout and a log file at {dataDirectory}/logs/.
 * One log file per server start, named yyyymmdd-hhmmss-utc.log.
 *
 * What to log:
 *   - Startup: port, data directory, post count
 *   - Errors: file I/O failures, malformed front matter, asset issues
 *   - AI API calls: provider, model, operation, success/failure, duration
 *   - Warnings: EXIF detected, missing target, slug collision
 *
 * What NOT to log:
 *   - Request/response bodies
 *   - Post content or metadata values
 *   - API keys (even partially)
 *   - Routine successful reads/lists
 */

import fs from "node:fs";
import path from "node:path";
import { utcNow, formatForFilename, formatForFrontMatter } from "../shared/timestamps.js";

type LogLevel = "INFO" | "WARN" | "ERROR";

let logStream: fs.WriteStream | null = null;

/**
 * Initializes the logger by creating a log file in {dataDirectory}/logs/.
 * Must be called once at startup after the data directory is resolved.
 */
export function initLogger(dataDirectory: string): void {
  const logsDir = path.join(dataDirectory, "logs");
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
