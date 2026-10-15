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

export type BackupWorkerRequest =
  | { kind: "record"; file: string; sessionId: string; path: string; bytes: Uint8Array; writtenAt: string; partSize: number }
  // A file the app installed without holding its bytes: `fd` is open on the installed copy and this
  // thread owns it, closing it once read. `sha256` and `size` are what the app copied.
  | { kind: "record-file"; file: string; sessionId: string; path: string; fd: number; sha256: string; size: number; writtenAt: string; partSize: number }
  // Answers through `signal` once every earlier request is applied; "close" also releases the store.
  | { kind: "drain" | "close"; signal: Int32Array };

export type BackupWorkerNotice = { kind: "warn"; text: string; fields: Record<string, unknown> };

if (parentPort === null) {
  throw new Error("The backup recorder requires a parent port.");
}
const port = parentPort;

// Rows recorded before sessions keep a NULL session_id as earlier history. A
// NULL never conflicts in the unique index, so each such row stays its own.
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
// A file larger than the part size is kept in parts: its row holds the path, session, size and
// hash of the whole file with empty content, and its parts joined in order are its exact bytes.
// SQLite holds at most about 1 GB in one value, and an attachment can be any size.
const PARTS = `
CREATE TABLE IF NOT EXISTS backup_parts (
  backup_id INTEGER NOT NULL,
  part      INTEGER NOT NULL,
  content   BLOB NOT NULL,
  PRIMARY KEY (backup_id, part)
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

// Opens the store, refusing one a newer build wrote before writing to it. A
// store from before sessions gains the session_id column; its rows stay as
// earlier history.
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
    opened.exec("PRAGMA busy_timeout = 2000");
    opened.exec("BEGIN IMMEDIATE");
    try {
      opened.exec(SCHEMA);
      const columns = opened.prepare("PRAGMA table_info(backups)").all() as { name: string }[];
      if (!columns.some((column) => column.name === "session_id")) opened.exec("ALTER TABLE backups ADD COLUMN session_id TEXT");
      opened.exec(INDEXES);
      opened.exec(PARTS);
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
// saves replace its content, a large file's parts with it in one transaction.
// Returns the row to write, or null when this content is already recorded.
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

// Writes the session's row for the path inside the caller's transaction, dropping any parts an
// earlier save in the session left, and returns its id.
function writeRow(store: DatabaseSync, request: Recorded, row: { id: number | null }, content: Uint8Array, hash: string, size: number): number {
  if (row.id !== null) {
    store
      .prepare("UPDATE backups SET content = ?, content_sha256 = ?, byte_size = ?, written_at_utc = ? WHERE id = ?")
      .run(content, hash, size, request.writtenAt, row.id);
    store.prepare("DELETE FROM backup_parts WHERE backup_id = ?").run(row.id);
    return row.id;
  }
  const inserted = store
    .prepare("INSERT INTO backups (session_id, path, content, content_sha256, byte_size, written_at_utc) VALUES (?, ?, ?, ?, ?, ?)")
    .run(request.sessionId, request.path, content, hash, size, request.writtenAt);
  return Number(inserted.lastInsertRowid);
}

function transaction(store: DatabaseSync, work: () => void): void {
  store.exec("BEGIN IMMEDIATE");
  try {
    work();
    store.exec("COMMIT");
  } catch (error) {
    try { store.exec("ROLLBACK"); } catch { /* Preserve the original diagnostic. */ }
    throw error;
  }
}

function record(request: Extract<BackupWorkerRequest, { kind: "record" }>): void {
  const store = open(request.file);
  if (!store) return;
  try {
    const { bytes } = request;
    const hash = createHash("sha256").update(bytes).digest("hex");
    const row = rowFor(store, request, hash);
    if (!row) return;
    const parted = bytes.byteLength > request.partSize;
    transaction(store, () => {
      const id = writeRow(store, request, row, parted ? new Uint8Array(0) : bytes, hash, bytes.byteLength);
      if (!parted) return;
      const insertPart = store.prepare("INSERT INTO backup_parts (backup_id, part, content) VALUES (?, ?, ?)");
      for (let part = 0, offset = 0; offset < bytes.byteLength; part += 1, offset += request.partSize) {
        insertPart.run(id, part, bytes.subarray(offset, offset + request.partSize));
      }
    });
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
// later replace or delete of the path cannot change what is read, in parts no larger than the
// part size, so a file of any size holds one part in memory. Its row and parts are written in one
// transaction that commits only when the bytes read hash to what the app copied; a copy edited in
// place meanwhile records nothing.
function recordFile(request: Extract<BackupWorkerRequest, { kind: "record-file" }>): void {
  try {
    const store = open(request.file);
    if (!store) return;
    const row = rowFor(store, request, request.sha256);
    if (!row) return;
    const parted = request.size > request.partSize;
    const buffer = Buffer.allocUnsafe(Math.min(request.size, request.partSize));
    const hash = createHash("sha256");
    transaction(store, () => {
      if (!parted) {
        const count = readAt(request.fd, buffer, request.size, 0);
        const bytes = buffer.subarray(0, count);
        if (count !== request.size || hash.update(bytes).digest("hex") !== request.sha256) throw new ChangedFileError();
        writeRow(store, request, row, bytes, request.sha256, request.size);
        return;
      }
      const id = writeRow(store, request, row, new Uint8Array(0), request.sha256, request.size);
      const insertPart = store.prepare("INSERT INTO backup_parts (backup_id, part, content) VALUES (?, ?, ?)");
      for (let part = 0, offset = 0; offset < request.size; part += 1, offset += request.partSize) {
        const length = Math.min(request.partSize, request.size - offset);
        const count = readAt(request.fd, buffer, length, offset);
        if (count !== length) throw new ChangedFileError();
        const bytes = buffer.subarray(0, count);
        hash.update(bytes);
        insertPart.run(id, part, bytes);
      }
      if (hash.digest("hex") !== request.sha256) throw new ChangedFileError();
    });
  } catch (error) {
    if (error instanceof ChangedFileError) warn("backup store: an attachment changed on disk before it was recorded; nothing recorded", { file: request.path });
    else warn("backup store: failed to record a write", { file: request.path, error: describe(error) });
  } finally {
    try { fs.closeSync(request.fd); } catch { /* The descriptor has nothing left to protect. */ }
  }
}

// A request that could not be read never reaches its record; it is reported, and a file's
// descriptor in it stays open until the process ends.
port.on("messageerror", (error) => warn("backup store: a write could not be handed to the recorder", { error: describe(error) }));
port.on("message", (request: BackupWorkerRequest) => {
  if (request.kind === "record") {
    record(request);
    return;
  }
  if (request.kind === "record-file") {
    recordFile(request);
    return;
  }
  if (request.kind === "close") close();
  Atomics.store(request.signal, 0, 1);
  Atomics.notify(request.signal, 0);
});
