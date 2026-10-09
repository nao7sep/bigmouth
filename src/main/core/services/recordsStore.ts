/** The records database (data-lifecycle-conventions, Records; logging-conventions). */

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { formatForFilenameMs, formatUtcIso } from "../shared/timestamps.js";
import { NewerFormatError, openSqliteStore } from "../shared/storeFormat.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS log_records (
  id           INTEGER PRIMARY KEY,
  session      TEXT NOT NULL,
  time         TEXT NOT NULL,
  level        TEXT NOT NULL,
  message      TEXT NOT NULL,
  workspace_id TEXT,
  post_id      TEXT,
  event        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_records_session ON log_records (session);
CREATE TABLE IF NOT EXISTS provider_calls (
  id           INTEGER PRIMARY KEY,
  session      TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  post_id      TEXT NOT NULL,
  purpose      TEXT NOT NULL,
  provider     TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT NOT NULL,
  request      TEXT NOT NULL,
  response     TEXT,
  error        TEXT,
  stopped      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_provider_calls_session ON provider_calls (session);
`;

// A store from before stopped calls were told apart gains the column; its rows read as not stopped.
// Older builds name their columns, so the added one leaves the format readable by them.
function addStoppedColumn(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(provider_calls)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "stopped")) {
    db.exec("ALTER TABLE provider_calls ADD COLUMN stopped INTEGER NOT NULL DEFAULT 0");
  }
}

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
  provider: string;
  startedAt: Date;
  finishedAt: Date;
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
let failureReported = false;
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
      opened.exec(SCHEMA);
      addStoppedColumn(opened);
    });
  } catch (err) {
    if (err instanceof NewerFormatError) newer = err;
    else reportFailure("records database could not be opened", err);
  }
  records = {
    session: formatUtcIso(sessionStart),
    dbPath,
    db,
    fallbackPath: path.join(logsDir, `${formatForFilenameMs(sessionStart)}.log`),
  };
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

/** Where this session's records are: the database, or the fallback file once the database failed. */
export function currentRecordsPath(): string | null {
  if (!records) return null;
  return records.db ? records.dbPath : records.fallbackPath;
}

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
    "INSERT INTO provider_calls (session, workspace_id, post_id, purpose, provider, started_at, finished_at, request, response, error, stopped) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [session, call.workspaceId, call.postId, call.purpose, call.provider, startedAt, finishedAt, request, response, error, call.stopped ? 1 : 0],
    () => JSON.stringify({
      record: "provider-call",
      session,
      workspaceId: call.workspaceId,
      postId: call.postId,
      purpose: call.purpose,
      provider: call.provider,
      startedAt,
      finishedAt,
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
  try {
    fs.mkdirSync(path.dirname(open.fallbackPath), { recursive: true });
    fs.appendFileSync(open.fallbackPath, line() + "\n");
  } catch (err) {
    reportFailure("records fallback file write failed", err);
    console.error(line());
  }
}

function reportFailure(what: string, err: unknown): void {
  if (failureReported) return;
  failureReported = true;
  console.error(`[records] ${what}: ${err instanceof Error ? err.message : String(err)}`);
}
