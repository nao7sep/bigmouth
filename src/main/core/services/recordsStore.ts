/** The records database (data-lifecycle-conventions, Records; logging-conventions). */

import { RECORDS_SCHEMA, validateRecordsSchema } from "./recordsSchema.js";
import fs from "node:fs";
import path from "node:path";
import type { RecordDetail, RecordKind, RecordsHealth, RecordsPage, RecordsQuery } from "@shared/records";
import type { DatabaseSync } from "node:sqlite";
import { formatForFilename, formatUtcIso } from "../shared/timestamps.js";
import { NewerFormatError, openSqliteStore } from "../shared/storeFormat.js";
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

/**
 * Opens the database for one session, a process launch named by its start time. When it cannot be
 * opened, every entry goes to the session's fallback file under `logsDir` instead. A database a newer
 * version of BigMouth wrote is left exactly as it is, and returned as the refusal for the caller to log.
 */
export function openRecords(dbPath: string, logsDir: string, sessionStart: Date): NewerFormatError | null {
  let db: DatabaseSync | null = null;
  let newer: NewerFormatError | null = null;
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = openSqliteStore("records", dbPath, (opened) => {
      opened.exec(RECORDS_SCHEMA);
      // Experimental internal stores have no migration chain. A mismarked old
      // shape is refused inside the creation transaction, leaving its rows alone.
      validateRecordsSchema(opened);
    });
  } catch (err) {
    if (err instanceof NewerFormatError) newer = err;
    else reportFailure("records database could not be opened", err);
  }
  records = {
    session: formatUtcIso(sessionStart),
    dbPath,
    db,
    fallbackPath: path.join(logsDir, `${formatForFilename(sessionStart)}.log`),
  };
  if (!db) markGap();
  return newer;
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
