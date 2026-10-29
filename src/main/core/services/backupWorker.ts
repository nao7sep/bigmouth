// The backup recorder's thread (data-backup-conventions): the one serial owner
// that applies backup writes to backups.sqlite3 in save order, so a slow or
// locked store never holds up a save or the storage requests behind it. It is
// started by backupStore on the storage worker and runs this file from source in
// tests, so it imports only Node and the dependency-free format table.

import { createHash } from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";

import { FORMAT_VERSIONS } from "../shared/formatVersions.ts";

export type BackupWrite =
  | { kind: "record"; file: string; sessionId: string; path: string; bytes: Uint8Array; writtenAt: string }
  // A file the app installed without holding its bytes: `fd` is open on the installed copy, and the
  // thread that opened it closes it once this thread has read it. `sha256` and `size` are what the app copied.
  | { kind: "record-file"; file: string; sessionId: string; path: string; fd: number; sha256: string; size: number; writtenAt: string };

export type BackupWorkerRequest =
  | BackupWrite
  // Answered through `signal` once every earlier write is applied and the store file released.
  | { kind: "close"; signal: Int32Array };

export type BackupWorkerNotice = { kind: "warn"; text: string; fields: Record<string, unknown> } | { kind: "settled" };

if (parentPort === null) {
  throw new Error("The backup recorder requires a parent port.");
}
const port = parentPort;

// The unique index below keeps one saved version per path and session.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS backups (
  id             INTEGER PRIMARY KEY,
  session_id     TEXT,
  path           TEXT NOT NULL,
  content        BLOB NOT NULL,
  content_sha256 TEXT NOT NULL,
  byte_size      INTEGER NOT NULL,
  written_at_utc TEXT NOT NULL
);
`;
const INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_backups_path_session ON backups (path, session_id);
CREATE INDEX IF NOT EXISTS idx_backups_path_id ON backups (path, id);
`;

let db: DatabaseSync | null = null;
let openFile: string | null = null;
// A store that could not be opened stays off for the session; it is reported once.
let disabledFile: string | null = null;

function warn(text: string, fields: Record<string, unknown>): void {
  port.postMessage({ kind: "warn", text, fields } satisfies BackupWorkerNotice);
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function close(): void {
  try { db?.close(); } catch { /* Closing has nothing left to protect. */ }
  db = null;
  openFile = null;
}

// Refuse newer or incompatible existing stores without altering their history.
// Schema creation and validation share one transaction so a rejected store
// keeps its original tables, indexes and version.
function open(file: string): DatabaseSync | null {
  if (openFile === file) return db;
  close();
  if (disabledFile === file) return null;
  let opened: DatabaseSync | null = null;
  try {
    opened = new DatabaseSync(file);
    const { user_version: version } = opened.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version > FORMAT_VERSIONS.backups) {
      opened.close();
      disabledFile = file;
      warn("backup store was written by a newer version of BigMouth; left unchanged, recording disabled for this session", { file, formatVersion: version });
      return null;
    }
    opened.exec("BEGIN IMMEDIATE");
    try {
      opened.exec(SCHEMA);
      opened.prepare("SELECT id, session_id, path, content, content_sha256, byte_size, written_at_utc FROM backups LIMIT 0").all();
      opened.exec(INDEXES);
      opened.exec(`PRAGMA user_version = ${FORMAT_VERSIONS.backups}`);
      opened.exec("COMMIT");
    } catch (error) {
      try { opened.exec("ROLLBACK"); } catch { /* Preserve the original diagnostic. */ }
      throw error;
    }
    opened.exec("PRAGMA journal_mode = WAL");
  } catch (error) {
    try { opened?.close(); } catch { /* Preserve the original diagnostic. */ }
    disabledFile = file;
    warn("backup store could not be opened; recording disabled for this session", { file, error: describe(error) });
    return null;
  }
  db = opened;
  openFile = file;
  return db;
}

type Recorded = { path: string; sessionId: string; writtenAt: string };

// One row per path per session: the session's first save of a path inserts it,
// unless it equals the path's latest row from an earlier session, and later
// saves replace its content. Returns the row to write, or null when this content is already recorded.
function rowFor(store: DatabaseSync, request: Recorded, hash: string): { id: number | null } | null {
  const own = store
    .prepare("SELECT id, content_sha256 AS h FROM backups WHERE path = ? AND session_id = ?")
    .get(request.path, request.sessionId) as { id: number; h: string } | undefined;
  if (own?.h === hash) return null;
  if (!own) {
    const latest = store
      .prepare("SELECT content_sha256 AS h FROM backups WHERE path = ? ORDER BY id DESC LIMIT 1")
      .get(request.path) as { h: string } | undefined;
    if (latest?.h === hash) return null;
  }
  return { id: own?.id ?? null };
}

// Writes the session's row for the path: one value holds the whole file.
function writeRow(store: DatabaseSync, request: Recorded, row: { id: number | null }, content: Uint8Array, hash: string): void {
  if (row.id !== null) {
    store
      .prepare("UPDATE backups SET content = ?, content_sha256 = ?, byte_size = ?, written_at_utc = ? WHERE id = ?")
      .run(content, hash, content.byteLength, request.writtenAt, row.id);
    return;
  }
  store
    .prepare("INSERT INTO backups (session_id, path, content, content_sha256, byte_size, written_at_utc) VALUES (?, ?, ?, ?, ?, ?)")
    .run(request.sessionId, request.path, content, hash, content.byteLength, request.writtenAt);
}

function record(request: Extract<BackupWorkerRequest, { kind: "record" }>): void {
  const store = open(request.file);
  if (!store) return;
  try {
    const { bytes } = request;
    const hash = createHash("sha256").update(bytes).digest("hex");
    const row = rowFor(store, request, hash);
    if (!row) return;
    writeRow(store, request, row, bytes, hash);
  } catch (error) {
    warn("backup store: failed to record a write", { file: request.path, error: describe(error) });
  }
}

/** The file changed on disk after the app installed it; nothing of it is recorded. */
class ChangedFileError extends Error {}

// Reads `length` bytes at `position`, or fewer only at the end of the file.
function readAt(fd: number, buffer: Buffer, length: number, position: number): number {
  let total = 0;
  while (total < length) {
    const count = fs.readSync(fd, buffer, total, length - total, position + total);
    if (count === 0) break;
    total += count;
  }
  return total;
}

// A file recorded from disk rather than from bytes in hand (data-backup-conventions): the
// installed copy is read through the descriptor the app opened before handing it over, so a
// later replace or delete of the path cannot change what is read. It is recorded only when the
// bytes read hash to what the app copied; a copy edited in place meanwhile records nothing.
function recordFile(request: Extract<BackupWorkerRequest, { kind: "record-file" }>): void {
  try {
    const store = open(request.file);
    if (!store) return;
    const row = rowFor(store, request, request.sha256);
    if (!row) return;
    const buffer = Buffer.allocUnsafe(request.size);
    const count = readAt(request.fd, buffer, request.size, 0);
    const bytes = buffer.subarray(0, count);
    if (count !== request.size || createHash("sha256").update(bytes).digest("hex") !== request.sha256) throw new ChangedFileError();
    writeRow(store, request, row, bytes, request.sha256);
  } catch (error) {
    if (error instanceof ChangedFileError) warn("backup store: an attachment changed on disk before it was recorded; nothing recorded", { file: request.path });
    else warn("backup store: failed to record a write", { file: request.path, error: describe(error) });
  }
}

// A request that could not be read never reaches its record; it is reported, and a file's
// descriptor in it stays open until the process ends.
port.on("messageerror", (error) => {
  warn("backup store: a write could not be handed to the recorder", { error: describe(error) });
  port.postMessage({ kind: "settled" } satisfies BackupWorkerNotice);
});
port.on("message", (request: BackupWorkerRequest) => {
  if (request.kind === "close") {
    close();
    Atomics.store(request.signal, 0, 1);
    Atomics.notify(request.signal, 0);
    return;
  }
  if (request.kind === "record") record(request);
  else recordFile(request);
  port.postMessage({ kind: "settled" } satisfies BackupWorkerNotice);
});
