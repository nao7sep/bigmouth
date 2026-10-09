// The backup recorder's thread (data-backup-conventions): the one serial owner
// that applies backup writes to backups.sqlite3 in save order, so a slow or
// locked store never holds up a save or the storage requests behind it. It is
// started by backupStore on the storage worker and runs this file from source in
// tests, so it imports only Node and the dependency-free format table.

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";

import { FORMAT_VERSIONS } from "../shared/formatVersions.ts";

export type BackupWorkerRequest =
  | { kind: "record"; file: string; sessionId: string; path: string; bytes: Uint8Array; writtenAt: string; partSize: number }
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
// SQLite holds at most about 1 GB in one value, and an attachment's size is a user setting.
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

// One row per path per session: the session's first save of a path inserts it,
// unless it equals the path's latest row from an earlier session, and later
// saves replace its content, a large file's parts with it in one transaction.
function record(request: Extract<BackupWorkerRequest, { kind: "record" }>): void {
  const store = open(request.file);
  if (!store) return;
  try {
    const { bytes } = request;
    const hash = createHash("sha256").update(bytes).digest("hex");
    const own = store
      .prepare("SELECT id, content_sha256 AS h FROM backups WHERE path = ? AND session_id = ?")
      .get(request.path, request.sessionId) as { id: number; h: string } | undefined;
    if (own?.h === hash) return;
    if (!own) {
      const latest = store
        .prepare("SELECT content_sha256 AS h FROM backups WHERE path = ? ORDER BY id DESC LIMIT 1")
        .get(request.path) as { h: string } | undefined;
      if (latest?.h === hash) return;
    }
    const parted = bytes.byteLength > request.partSize;
    const content = parted ? new Uint8Array(0) : bytes;
    store.exec("BEGIN IMMEDIATE");
    try {
      let id: number;
      if (own) {
        store
          .prepare("UPDATE backups SET content = ?, content_sha256 = ?, byte_size = ?, written_at_utc = ? WHERE id = ?")
          .run(content, hash, bytes.byteLength, request.writtenAt, own.id);
        store.prepare("DELETE FROM backup_parts WHERE backup_id = ?").run(own.id);
        id = own.id;
      } else {
        const inserted = store
          .prepare("INSERT INTO backups (session_id, path, content, content_sha256, byte_size, written_at_utc) VALUES (?, ?, ?, ?, ?, ?)")
          .run(request.sessionId, request.path, content, hash, bytes.byteLength, request.writtenAt);
        id = Number(inserted.lastInsertRowid);
      }
      if (parted) {
        const insertPart = store.prepare("INSERT INTO backup_parts (backup_id, part, content) VALUES (?, ?, ?)");
        for (let part = 0, offset = 0; offset < bytes.byteLength; part += 1, offset += request.partSize) {
          insertPart.run(id, part, bytes.subarray(offset, offset + request.partSize));
        }
      }
      store.exec("COMMIT");
    } catch (error) {
      try { store.exec("ROLLBACK"); } catch { /* Preserve the original diagnostic. */ }
      throw error;
    }
  } catch (error) {
    warn("backup store: failed to record a write", { file: request.path, error: describe(error) });
  }
}

port.on("message", (request: BackupWorkerRequest) => {
  if (request.kind === "record") {
    record(request);
    return;
  }
  if (request.kind === "close") close();
  Atomics.store(request.signal, 0, 1);
  Atomics.notify(request.signal, 0);
});
