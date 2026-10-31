/** The records database (data-lifecycle-conventions, Records; logging-conventions). */

import { RECORDS_SCHEMA, validateRecordsSchema } from "./recordsSchema.js";
import fs from "node:fs";
import path from "node:path";
import type { RecordDetail, RecordKind, RecordsHealth, RecordsPage, RecordsQuery } from "@shared/records";
import type { DatabaseSync } from "node:sqlite";
import { formatForFilename, formatUtcIso } from "../shared/timestamps.js";
import { NewerFormatError, openSqliteStore } from "../shared/storeFormat.js";
import { moveAsideInvalid } from "../shared/quarantine.js";
import { readDetail, readPage, readSessions } from "./recordsQueries.js";

/** A log line as emitted: its envelope, and the whole JSON object it serializes to. */
export type LogRecord = {
  time: string;
  level: string;
  message: string;
  workspaceId: string | null;
  postId: string | null;
  event: string;
};

/**
 * One request to an AI provider, recorded whole with its credentials masked: the request as sent,
 * the response or error received, and whether the user stopped it.
 */
export type ProviderCallRecord = {
  workspaceId: string;
  postId: string;
  purpose: string;
  operationId?: string;
  provider: string;
  startedAt: Date;
  finishedAt: Date;
  elapsedMs?: number;
  request: unknown;
  response: unknown;
  error: unknown;
  stopped: boolean;
};

type OpenRecords = {
  session: string;
  dbPath: string;
  db: DatabaseSync | null;
  fallbackPath: string;
};

let records: OpenRecords | null = null;
// The console hears about a failing sink once, not on every entry.
const failuresReported = new Set<string>();
let health: RecordsHealth = { databaseGap: false, fallbackFailed: false, fallbackPath: null };
let healthListener: ((value: RecordsHealth) => void) | null = null;

export function onRecordsHealth(listener: ((value: RecordsHealth) => void) | null): void {
  healthListener = listener;
  notifyHealth();
}

export function recordsHealth(): RecordsHealth { return { ...health }; }

function markGap(fallbackFailed = false): void {
  const next = { databaseGap: true, fallbackFailed: health.fallbackFailed || fallbackFailed, fallbackPath: records?.fallbackPath ?? health.fallbackPath };
  if (next.databaseGap === health.databaseGap && next.fallbackFailed === health.fallbackFailed && next.fallbackPath === health.fallbackPath) return;
  health = next;
  notifyHealth();
}
function notifyHealth(): void {
  try { healthListener?.({ ...health }); }
  catch (error) { reportFailure("records health notice could not be delivered", error); }
}

// Called after each entry the database stored; an entry that went to the
// fallback file is not in the database, so it calls nothing.
let storedListener: (() => void) | null = null;

export function onRecordStored(listener: (() => void) | null): void {
  storedListener = listener;
}

/** A records database this build cannot use: a mismatched shape, or not a database. */
class UnusableRecordsError extends Error {}

/** What opening the records database met that the caller logs once the session is open. */
export type RecordsOpening = {
  /** A database a newer version of BigMouth wrote, left exactly as it is. */
  newer: NewerFormatError | null;
  /** A database this build could not use, set aside so a new one could be created. */
  setAside: { path: string; movedTo: string; detail: string } | null;
  /** Why no database could be opened, when that was not a newer version's; entries go to the fallback file. */
  failed: Error | null;
};

/**
 * Opens the database for one session, a process launch named by its start time. A database this build
 * cannot use, whether a mismatched shape or a file that is not a database, is
 * set aside as `.invalid` and a new one created: records are optional diagnostics, and setting the file aside keeps its rows for inspection (store-recovery-conventions).
 * A database a newer version of BigMouth wrote is left exactly as it is. When no database can be
 * opened, every entry goes to the session's fallback file under `logsDir` instead.
 */
export function openRecords(dbPath: string, logsDir: string, sessionStart: Date): RecordsOpening {
  const opening: RecordsOpening = { newer: null, setAside: null, failed: null };
  let db: DatabaseSync | null = null;
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    try {
      db = openUsable(dbPath);
    } catch (err) {
      if (!(err instanceof UnusableRecordsError)) throw err;
      opening.setAside = { path: dbPath, movedTo: setAside(dbPath), detail: err.message };
      db = openUsable(dbPath);
    }
  } catch (err) {
    if (err instanceof NewerFormatError) opening.newer = err;
    else {
      opening.failed = err instanceof Error ? err : new Error(String(err));
      reportFailure("records database could not be opened", err);
    }
  }
  records = {
    session: formatUtcIso(sessionStart),
    dbPath,
    db,
    fallbackPath: path.join(logsDir, `${formatForFilename(sessionStart)}.log`),
  };
  if (!db) markGap();
  return opening;
}

function openUsable(dbPath: string): DatabaseSync {
  try {
    return openSqliteStore("records", dbPath, (opened) => {
      // A database with no version yet, a fresh file or one that never held
      // records, is completed here.
      opened.exec(RECORDS_SCHEMA);
      try {
        validateRecordsSchema(opened);
      } catch (cause) {
        throw new UnusableRecordsError("its tables do not have the columns this version records", { cause });
      }
    });
  } catch (err) {
    if ((err as { errcode?: unknown }).errcode === SQLITE_NOTADB) {
      throw new UnusableRecordsError("it is not a database", { cause: err });
    }
    throw err;
  }
}

const SQLITE_NOTADB = 26;

/**
 * Moves an unusable database aside with its write-ahead files, which SQLite
 * finds by the main file's name, so the set-aside copy still opens whole. A
 * write-ahead file that cannot follow stays where it is and nothing is created
 * over it; the error names where the main file went, so the two can be rejoined.
 */
function setAside(dbPath: string): string {
  const movedTo = moveAsideInvalid(dbPath);
  for (const suffix of ["-wal", "-shm"]) {
    if (!fs.existsSync(dbPath + suffix)) continue;
    try {
      fs.renameSync(dbPath + suffix, movedTo + suffix);
    } catch (cause) {
      throw new Error(`The records database was set aside as ${movedTo}, but ${dbPath + suffix} could not be moved with it.`, { cause });
    }
  }
  return movedTo;
}

export function closeRecords(): void {
  try {
    records?.db?.close();
  } catch {
    // Closing at exit has nothing left to protect.
  }
  records = null;
}

/** This launch's session, as every record of it carries; null before the database is opened. */
export function currentRecordsSession(): string | null {
  return records?.session ?? null;
}

/** The primary destination; recordsHealth names any per-entry fallback and retained gap. */
export function currentRecordsPath(): string | null {
  if (!records) return null;
  return records.db ? records.dbPath : records.fallbackPath;
}

// The records window's reads, on the one connection the writes use, so a read
// sees every record stored before it.
function openDb(): DatabaseSync {
  const db = records?.db;
  if (!db) throw new Error("The records database is not open.");
  return db;
}
export function readRecordsPage(query: RecordsQuery): RecordsPage { return readPage(openDb(), query); }
export function readRecordDetail(kind: RecordKind, id: number): RecordDetail | null { return readDetail(openDb(), kind, id); }
export function readRecordSessions(): string[] { return readSessions(openDb()); }

export function writeLogRecord(entry: LogRecord): void {
  if (!records) return;
  const { session } = records;
  insertOrFallBack(
    "INSERT INTO log_records (session, time, level, message, workspace_id, post_id, event) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [session, entry.time, entry.level, entry.message, entry.workspaceId, entry.postId, entry.event],
    () => entry.event,
  );
}

export function writeProviderCall(call: ProviderCallRecord): void {
  if (!records) return;
  const { session } = records;
  const startedAt = formatUtcIso(call.startedAt);
  const finishedAt = formatUtcIso(call.finishedAt);
  const request = JSON.stringify(call.request);
  const response = call.response === undefined ? null : JSON.stringify(call.response);
  const error = call.error === undefined ? null : JSON.stringify(call.error);
  insertOrFallBack(
    "INSERT INTO provider_calls (session, workspace_id, post_id, purpose, operation_id, provider, started_at, finished_at, elapsed_ms, request, response, error, stopped) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [session, call.workspaceId, call.postId, call.purpose, call.operationId ?? null, call.provider, startedAt, finishedAt, call.elapsedMs ?? null, request, response, error, call.stopped ? 1 : 0],
    () => JSON.stringify({
      record: "provider-call",
      session,
      workspaceId: call.workspaceId,
      postId: call.postId,
      purpose: call.purpose,
      operationId: call.operationId ?? null,
      provider: call.provider,
      startedAt,
      finishedAt,
      elapsedMs: call.elapsedMs ?? null,
      request: call.request,
      response: call.response ?? null,
      error: call.error ?? null,
      stopped: call.stopped,
    }),
  );
}

function insertOrFallBack(sql: string, values: (string | number | null)[], line: () => string): void {
  const open = records!;
  if (open.db) {
    let stored = false;
    try {
      open.db.prepare(sql).run(...values);
      stored = true;
    } catch (err) {
      reportFailure("records database write failed", err);
    }
    if (stored) {
      storedListener?.();
      return;
    }
  }
  markGap();
  try {
    fs.mkdirSync(path.dirname(open.fallbackPath), { recursive: true });
    fs.appendFileSync(open.fallbackPath, line() + "\n");
  } catch (err) {
    markGap(true);
    reportFailure("records fallback file write failed", err);
    console.error(line());
  }
}

function reportFailure(what: string, err: unknown): void {
  if (failuresReported.has(what)) return;
  failuresReported.add(what);
  console.error(`[records] ${what}: ${err instanceof Error ? err.message : String(err)}`);
}
