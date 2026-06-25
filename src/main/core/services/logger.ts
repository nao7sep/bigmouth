/**
 * Logging module.
 *
 * Writes one JSON object per line (JSON Lines) to a per-launch session file at
 * ~/.bigmouth/logs/yyyymmdd-hhmmss-utc.log, and echoes each line to the console.
 * Logs are shared across all workspaces (the app is a single process).
 *
 * Contract (see conventions/20260610-030818-utc-logging-conventions.md):
 *   - The logging call takes a STRUCTURED object, never a rendered string. Every
 *     line carries the envelope { time, level, message } plus any extra fields.
 *   - Four levels: debug / info / warn / error. `debug` is developer-only — it is
 *     emitted only when explicitly enabled by BIGMOUTH_DEBUG=1 or --debug-logs.
 *   - A mandatory, non-destructive redactor replaces the VALUE of any field whose
 *     name matches a denied key (exact, case-insensitive). It never edits the
 *     message, never scans string contents, and cannot drop fields or throw.
 *   - Writes are synchronous, so the last lines before a crash reach disk; if the
 *     file cannot be written the logger degrades to the console and never throws.
 */

import fs from "node:fs";
import path from "node:path";
import { utcNow, formatForFilename, formatUtcIso } from "../shared/timestamps.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const DEBUG_LOG_FLAG = "--debug-logs";

type DebugLogEnv = Readonly<Record<string, string | undefined>>;

// Field names whose values are replaced with the redaction marker. Matched by
// exact, case-insensitive name (stored lower-cased) — never as a substring, so
// `token` never matches `tokenCount` or `broken`. This app owns and extends this
// set; there is no shared cross-app taxonomy.
const DENIED_KEYS = new Set(["apikey", "authorization", "token", "password", "secret"]);
const REDACTION_MARKER = "[redacted]";

// Reserved envelope keys: a caller's field of the same name must never overwrite
// the real envelope value.
const ENVELOPE_KEYS = new Set(["time", "level", "message"]);

let logFd: number | null = null;
let currentLogFilePath: string | null = null;
// Once a file write fails we keep going on the console alone, but only announce
// the degradation once so a full disk does not spam stderr on every line.
let fileWriteDegraded = false;

/**
 * Opens the per-launch session log file in the given logs directory. Must be
 * called once at startup. If the file cannot be opened the logger stays on the
 * console (best-effort) rather than failing the launch.
 */
export function initLogger(logsDir: string): void {
  fs.mkdirSync(logsDir, { recursive: true });

  const logFilePath = path.join(logsDir, `${formatForFilename(utcNow())}.log`);
  currentLogFilePath = logFilePath;

  try {
    // Exclusive create ("wx"): a fresh file per session, never appended across
    // launches. On the rare same-second filename clash the create fails and the
    // logger degrades to the console fallback below (logging-conventions).
    logFd = fs.openSync(logFilePath, "wx");
  } catch (err) {
    logFd = null;
    reportFileFailure(err);
  }
}

/** Closes the session log file. Called on a clean shutdown. */
export function closeLogger(): void {
  if (logFd === null) return;
  try {
    fs.closeSync(logFd);
  } catch {
    // Best-effort: nothing useful to do if the log file fails to close on exit.
  }
  logFd = null;
}

export function getCurrentLogFilePath(): string | null {
  return currentLogFilePath;
}

/**
 * Non-destructive, pure, total, cycle-safe redactor. Replaces the value of any
 * field whose name is a denied key (exact, case-insensitive) with the marker;
 * recurses through plain objects and arrays; passes every other value through
 * byte-identical. Never inspects string contents and never drops a field.
 */
export function redact(value: unknown): unknown {
  return redactInner(value, new WeakSet());
}

function redactInner(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactInner(item, seen));
  }

  // Only recurse into plain objects. Exotic objects (Date, etc.) are passed
  // through so the serializer renders them faithfully instead of flattening
  // them to `{}`.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const out: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    out[key] = DENIED_KEYS.has(key.toLowerCase())
      ? REDACTION_MARKER
      : redactInner(entryValue, seen);
  }
  return out;
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
      name: err.name,
      message: err.message,
    };
    if (err.stack) out.stack = err.stack;
    if (err.cause !== undefined) out.cause = serializeErrorInner(err.cause, seen);
    return out;
  }
  if (err !== null && typeof err === "object") {
    // A non-Error object was thrown; surface its own fields (redaction still
    // applies to the final record) rather than a useless "[object Object]".
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
    const redacted = redact(fields) as Record<string, unknown>;
    for (const [key, value] of Object.entries(redacted)) {
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

  if (logFd !== null) {
    try {
      fs.writeSync(logFd, line + "\n");
    } catch (err) {
      reportFileFailure(err);
    }
  }
}

function reportFileFailure(err: unknown): void {
  if (fileWriteDegraded) return; // announce once; the console still has every line
  fileWriteDegraded = true;
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`[logger] File logging degraded — continuing on console only: ${detail}`);
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
