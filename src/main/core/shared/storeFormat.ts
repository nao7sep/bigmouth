/**
 * How every store says what it is (file-identity-conventions, store-recovery-conventions):
 * the `format` and `writer` header at the top of a JSON file or a post's front
 * matter, and `PRAGMA user_version` with a `file_header` table in SQLite. The
 * header is checked where a store is loaded or opened: a file of another owner
 * or kind, or without the header, is unreadable, and one a newer build wrote is
 * reported by name and never written by this one. `writer` is written on every
 * save and never read. The single-instance lock leaves no other writer to change
 * a store's format while it is open, so writes do not recheck it. What each
 * store does with an absent, newer, inaccessible or unreadable store is its own
 * load path's choice.
 */

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { message } from "@shared/i18n/translate";
import { carryingText } from "@shared/i18n/carriedMessage";
import { FORMAT_KINDS, FORMAT_OWNER, FORMAT_VERSIONS, WRITER_NAME, isNewerThanBuild, type FileWriter, type StoreFormat } from "./formatVersions.js";
import { checkSqliteHeader, writeSqliteHeader } from "./sqliteHeader.js";

/** The keys the header takes at the top of a file; content never uses them there. */
export const HEADER_KEYS: readonly string[] = ["format", "writer"];

/** What this build writes as `writer`. */
export const WRITER: FileWriter = { name: WRITER_NAME, version: __APP_VERSION__ };

/** The header a file of `format` starts with. */
export function fileHeader(format: StoreFormat): { format: { owner: string; kind: string; version: number }; writer: FileWriter } {
  return { format: { owner: FORMAT_OWNER, kind: FORMAT_KINDS[format], version: FORMAT_VERSIONS[format] }, writer: { ...WRITER } };
}

/** A parsed file's content without its header keys. */
export function withoutHeader<T extends Record<string, unknown>>(value: T): T {
  const content = { ...value };
  for (const key of HEADER_KEYS) delete content[key];
  return content;
}

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

/**
 * Checks the `format` header of a parsed JSON store or front matter. `writer`
 * is not looked at. Other keys inside `format` are ignored, so a later release
 * can add an optional one without a format change.
 */
export function checkHeader(format: StoreFormat, value: Record<string, unknown>): FormatCheck {
  const header = value.format;
  if (header === null || typeof header !== "object" || Array.isArray(header)) {
    return { kind: "unreadable", detail: "it has no format header" };
  }
  const { owner, kind, version } = header as Record<string, unknown>;
  if (typeof owner !== "string" || typeof kind !== "string" || typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return { kind: "unreadable", detail: "its format header is not an owner, a kind and a whole version from 1" };
  }
  if (owner !== FORMAT_OWNER || kind !== FORMAT_KINDS[format]) {
    return { kind: "unreadable", detail: `its format header names ${owner} ${kind}, not ${FORMAT_OWNER} ${FORMAT_KINDS[format]}` };
  }
  return isNewerThanBuild(format, version) ? { kind: "newer", version } : { kind: "read", version };
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

/** Reads a JSON store whose top level is an object starting with its header; `value` is the content without it. */
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
  const check = checkHeader(format, value);
  if (check.kind === "unreadable") return { ...check, error: null };
  if (check.kind === "newer") return check;
  return { kind: "read", version: check.version, value: withoutHeader(value) };
}

/** A JSON store's file text: the header, then the body's keys. */
export function jsonStoreText(format: StoreFormat, body: Record<string, unknown>): string {
  return JSON.stringify({ ...fileHeader(format), ...withoutHeader(body) }, null, 2) + "\n";
}

/**
 * Opens a SQLite store, refusing one a newer build wrote, or one without
 * BigMouth's header for `format`, before anything is written to it. `prepare`
 * sets the connection up and creates the schema with `IF NOT EXISTS`; the header
 * is written in the same transaction, so a new file gets it on creation and an
 * existing one has its writer rows rewritten. Throws NewerFormatError for a
 * newer store and UnreadableStoreError for one without the header, and closes
 * the connection on any failure.
 */
export function openSqliteStore(
  format: StoreFormat,
  filePath: string,
  prepare: (db: DatabaseSync) => void,
): DatabaseSync {
  const db = new DatabaseSync(filePath);
  try {
    const check = checkSqliteHeader(db, format);
    if (check.kind === "newer") throw new NewerFormatError(filePath, check.version);
    if (check.kind === "unreadable") throw new UnreadableStoreError(filePath, check.detail);
    db.exec("BEGIN IMMEDIATE");
    try {
      prepare(db);
      writeSqliteHeader(db, format, WRITER);
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
