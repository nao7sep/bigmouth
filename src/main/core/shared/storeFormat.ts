/**
 * How every store reads and writes its format version (store-recovery-conventions):
 * `formatVersion` at the top of a JSON file or a post's front matter, and
 * `PRAGMA user_version` in SQLite. Every store has one format so far, so a
 * store without its marker is read as that format. The marker exists so a store
 * a newer build wrote is reported by name and never written by this one; it is
 * checked where a store is loaded or opened. The single-instance lock leaves no
 * other writer to change a store's format while it is open, so writes do not
 * recheck it. What each store does with an absent, newer, inaccessible or
 * unreadable store is its own load path's choice.
 */

import fs from "node:fs";
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
  if (recorded === undefined) return { kind: "read", version: 1 };
  if (typeof recorded !== "number" || !Number.isInteger(recorded) || recorded < 1) {
    return { kind: "unreadable", detail: `its ${FORMAT_VERSION_KEY} is not a whole number from 1` };
  }
  return isNewerThanBuild(format, recorded) ? { kind: "newer", version: recorded } : { kind: "read", version: recorded };
}

/**
 * A JSON store as its file holds it. Each store decides what absent, newer,
 * inaccessible and unreadable mean. `inaccessible` is a failed read, which says
 * nothing about the bytes, so no store may move or replace the file for it;
 * `unreadable` is content this build cannot use.
 */
export type JsonStoreRead =
  | { kind: "absent" }
  | { kind: "read"; version: number; value: Record<string, unknown> }
  | { kind: "newer"; version: number }
  | { kind: "inaccessible"; detail: string; error: unknown }
  | { kind: "unreadable"; detail: string; error: unknown };

/** Reads a JSON store whose top level is an object, optionally carrying its format version. */
export function readJsonStore(format: StoreFormat, filePath: string): JsonStoreRead {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "inaccessible", detail: `it could not be read (${(error as Error).message})`, error };
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
 * Opens a SQLite store, refusing one a newer build wrote before anything is
 * written to it. `prepare` sets the connection up and creates the schema with
 * `IF NOT EXISTS`, so it also completes a store whose creation was interrupted;
 * a store without its version (SQLite's 0) is stamped with this build's. Throws
 * NewerFormatError for a newer store, and closes the connection on any failure.
 */
export function openSqliteStore(
  format: StoreFormat,
  filePath: string,
  prepare: (db: DatabaseSync) => void,
): DatabaseSync {
  const db = new DatabaseSync(filePath);
  try {
    const recorded = sqliteUserVersion(db);
    if (isNewerThanBuild(format, recorded)) throw new NewerFormatError(filePath, recorded);
    db.exec("BEGIN IMMEDIATE");
    try {
      prepare(db);
      if (recorded === 0) db.exec(`PRAGMA user_version = ${FORMAT_VERSIONS[format]}`);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the original diagnostic. */ }
      throw error;
    }
    db.exec("PRAGMA journal_mode = WAL");
    return db;
  } catch (error) {
    try { db.close(); } catch { /* Preserve the original diagnostic. */ }
    throw error;
  }
}

/** A database's `user_version`; SQLite's 0 means none was set. */
export function sqliteUserVersion(db: DatabaseSync): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}
