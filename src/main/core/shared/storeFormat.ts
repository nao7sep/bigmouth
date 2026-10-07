/**
 * How every store reads and writes its format version (store-recovery-conventions):
 * `formatVersion` at the top of a JSON file or a post's front matter, and
 * `PRAGMA user_version` in SQLite. A store without its marker is unreadable,
 * and a store newer than this build is reported by name and never written; what
 * each store does then is its own load path's choice.
 */

import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { DatabaseSync } from "node:sqlite";
import { message } from "@shared/i18n/translate";
import { carryingText } from "@shared/i18n/carriedMessage";
import { FORMAT_VERSIONS, isNewerThanBuild, type StoreFormat } from "./formatVersions.js";

export const FORMAT_VERSION_KEY = "formatVersion";

/** A store this build cannot read because a newer version of BigMouth wrote it. */
export class NewerFormatError extends Error {
  readonly filePath: string;
  readonly version: number;

  constructor(filePath: string, version: number) {
    super(carryingText(message("store.newerFormat", { path: filePath })));
    this.name = "NewerFormatError";
    this.filePath = filePath;
    this.version = version;
  }
}

/**
 * A store this build cannot read that is left exactly as it is. The user is
 * told its path and how to recover; `detail` says what was wrong, for the log.
 */
export class UnreadableStoreError extends Error {
  readonly filePath: string;
  readonly detail: string;

  constructor(filePath: string, detail: string, cause?: unknown) {
    super(carryingText(message("store.unreadable", { path: filePath })), cause === undefined || cause === null ? undefined : { cause });
    this.name = "UnreadableStoreError";
    this.filePath = filePath;
    this.detail = detail;
  }
}

/** What a store's marker says about a parsed store. */
export type FormatCheck =
  | { kind: "read"; version: number }
  | { kind: "newer"; version: number }
  | { kind: "unreadable"; detail: string };

/** Checks the `formatVersion` of a parsed JSON store or front matter. */
export function checkFormatVersion(format: StoreFormat, value: Record<string, unknown>): FormatCheck {
  const recorded = value[FORMAT_VERSION_KEY];
  if (recorded === undefined) return { kind: "unreadable", detail: `it has no ${FORMAT_VERSION_KEY}` };
  if (typeof recorded !== "number" || !Number.isInteger(recorded) || recorded < 1) {
    return { kind: "unreadable", detail: `its ${FORMAT_VERSION_KEY} is not a whole number from 1` };
  }
  return isNewerThanBuild(format, recorded) ? { kind: "newer", version: recorded } : { kind: "read", version: recorded };
}

/** A JSON store as its file holds it. Each store decides what absent, newer and unreadable mean. */
export type JsonStoreRead =
  | { kind: "absent" }
  | { kind: "read"; version: number; value: Record<string, unknown> }
  | { kind: "newer"; version: number }
  | { kind: "unreadable"; detail: string; error: unknown };

/** Reads a JSON store whose top level is an object carrying its format version. */
export function readJsonStore(format: StoreFormat, filePath: string): JsonStoreRead {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", detail: `it could not be read (${(error as Error).message})`, error };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { kind: "unreadable", detail: "it is not valid JSON", error };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unreadable", detail: "it does not contain a JSON object", error: null };
  }
  const value = parsed as Record<string, unknown>;
  const check = checkFormatVersion(format, value);
  if (check.kind === "unreadable") return { ...check, error: null };
  if (check.kind === "newer") return check;
  return { kind: "read", version: check.version, value };
}

/** A JSON store's file text: this build's format version, then the body's keys. */
export function jsonStoreText(format: StoreFormat, body: Record<string, unknown>): string {
  return JSON.stringify({ [FORMAT_VERSION_KEY]: FORMAT_VERSIONS[format], ...body }, null, 2) + "\n";
}

/**
 * Opens a SQLite store, refusing one a newer build wrote or one without its
 * version before anything is written to it. `prepare` sets the connection up and
 * creates the schema; a new, empty database is stamped with this build's
 * version. Throws NewerFormatError for a newer store, and closes the connection
 * on any failure.
 */
export function openSqliteStore(
  format: StoreFormat,
  filePath: string,
  prepare: (db: DatabaseSync) => void,
): DatabaseSync {
  // Only absence authorizes creation. An existing empty database has no marker.
  const absent = !fs.existsSync(filePath);
  const stage = absent
    ? path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}-${nanoid()}.tmp`)
    : filePath;
  let db: DatabaseSync | undefined;
  let created = false;
  try {
    if (absent) {
      fs.closeSync(fs.openSync(stage, "wx"));
      created = true;
    } else {
      // Admission uses a read-only handle before connection setup can mutate bytes.
      const probe = new DatabaseSync(filePath, { readOnly: true });
      try { assertSqliteWritable(format, filePath, probe); } finally { probe.close(); }
    }
    db = new DatabaseSync(stage);
    db.exec("BEGIN IMMEDIATE");
    if (!absent) assertSqliteWritable(format, filePath, db);
    prepare(db);
    if (absent) db.exec(`PRAGMA user_version = ${FORMAT_VERSIONS[format]}`);
    db.exec("COMMIT");
    db.exec("PRAGMA journal_mode = WAL");
    if (absent) {
      db.close();
      db = undefined;
      // Exclusive publication cannot overwrite a store created by another process.
      fs.linkSync(stage, filePath);
      fs.unlinkSync(stage);
      created = false;
      db = new DatabaseSync(filePath);
      assertSqliteWritable(format, filePath, db);
    }
    return db;
  } catch (error) {
    try { db?.close(); } catch { /* Preserve the original diagnostic. */ }
    if (created) {
      for (const suffix of ["", "-journal", "-wal", "-shm"]) {
        try { fs.rmSync(stage + suffix, { force: true }); } catch { /* Best-effort stage cleanup. */ }
      }
    }
    throw error;
  }
}

/** Rechecks the current marker under the caller's write transaction. */
export function assertSqliteWritable(format: StoreFormat, filePath: string, db: DatabaseSync): void {
  const recorded = sqliteUserVersion(db);
  if (isNewerThanBuild(format, recorded)) throw new NewerFormatError(filePath, recorded);
  if (!Number.isInteger(recorded) || recorded < 1) {
    throw new UnreadableStoreError(filePath, `its user_version ${recorded} is not a whole number from 1`);
  }
}

/** Checks the current JSON marker before a cached store can overwrite it. */
export function assertJsonWritable(format: StoreFormat, filePath: string): void {
  const read = readJsonStore(format, filePath);
  if (read.kind === "newer") throw new NewerFormatError(filePath, read.version);
  if (read.kind === "unreadable") throw new UnreadableStoreError(filePath, read.detail, read.error);
}

/** A database's `user_version`; SQLite's 0 means none was set. */
export function sqliteUserVersion(db: DatabaseSync): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}
