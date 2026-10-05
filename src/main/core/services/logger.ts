/** The app's logger (logging-conventions). */

import { utcNow, formatUtcIso } from "../shared/timestamps.js";
import { closeRecords, currentRecordsPath, openRecords, writeLogRecord } from "./recordsStore.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const DEBUG_LOG_FLAG = "--debug-logs";

type DebugLogEnv = Readonly<Record<string, string | undefined>>;

// Reserved envelope keys: a caller's field of the same name must never overwrite
// the real envelope value.
const ENVELOPE_KEYS = new Set(["time", "level", "message"]);

/** Starts this launch's session in the records database. Must be called once at startup. */
export function initLogger(recordsDbPath: string, logsDir: string): void {
  const newer = openRecords(recordsDbPath, logsDir, utcNow());
  if (newer) {
    warn("records database was written by a newer version of BigMouth; left unchanged, this session's records go to its log file", {
      path: newer.filePath,
      formatVersion: newer.version,
    });
  }
}

/** Closes the records database. Called on a clean shutdown. */
export function closeLogger(): void {
  closeRecords();
}

export function getRecordsPath(): string | null {
  return currentRecordsPath();
}

/**
 * Canonical error serialization for full fidelity: type, message, stack, and the
 * recursive cause chain. Used everywhere an error is logged so the record is the
 * same shape regardless of where the error surfaced. Non-Error throws are
 * captured as best as their shape allows.
 */
export function serializeError(err: unknown): unknown {
  return serializeErrorInner(err, new WeakSet());
}

function serializeErrorInner(err: unknown, seen: WeakSet<object>): unknown {
  if (err instanceof Error) {
    if (seen.has(err)) return "[circular]";
    seen.add(err);
    const out: Record<string, unknown> = {
      ...err,
      name: err.name,
      message: err.message,
    };
    if (err.stack) out.stack = err.stack;
    if (err.cause !== undefined) out.cause = serializeErrorInner(err.cause, seen);
    if (err instanceof AggregateError) {
      out.errors = err.errors.map((error: unknown) => serializeErrorInner(error, seen));
    }
    seen.delete(err);
    return out;
  }
  if (err !== null && typeof err === "object") {
    // A non-Error object was thrown; surface its own fields rather than a
    // useless "[object Object]".
    return err;
  }
  return { message: String(err) };
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  const record: Record<string, unknown> = {
    time: formatUtcIso(utcNow()),
    level,
    message,
  };

  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (ENVELOPE_KEYS.has(key)) continue; // envelope always wins
      record[key] = value;
    }
  }

  let line: string;
  try {
    line = JSON.stringify(record);
  } catch (err) {
    // A field that cannot be serialized (e.g. a BigInt) must not lose the event.
    line = JSON.stringify({
      time: record.time,
      level,
      message,
      logSerializationError: err instanceof Error ? err.message : String(err),
    });
  }

  // Echo to the console (also the best-effort fallback when file writes fail):
  // warnings and errors to stderr, everything else to stdout.
  if (level === "warn" || level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }

  writeLogRecord({
    time: record.time as string,
    level,
    message,
    workspaceId: domainId(fields?.workspace ?? fields?.workspaceId),
    postId: domainId(fields?.postId),
    event: line,
  });
}

function domainId(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export function isDebugLoggingEnabled({
  env = process.env,
  argv = process.argv,
}: {
  env?: DebugLogEnv;
  argv?: readonly string[];
} = {}): boolean {
  return env.BIGMOUTH_DEBUG === "1" || argv.includes(DEBUG_LOG_FLAG);
}

/**
 * Developer-only detail. Emitted only when debug logging is explicitly enabled.
 * The switch is read per call so it remains trivially controllable in tests.
 */
export function debug(message: string, fields?: LogFields): void {
  if (!isDebugLoggingEnabled()) return;
  emit("debug", message, fields);
}

export function info(message: string, fields?: LogFields): void {
  emit("info", message, fields);
}

export function warn(message: string, fields?: LogFields): void {
  emit("warn", message, fields);
}

export function error(message: string, fields?: LogFields): void {
  emit("error", message, fields);
}
