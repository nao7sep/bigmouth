// The file identity header of a SQLite store (file-identity-conventions):
// `PRAGMA user_version` holds `format.version` and the `file_header` table the
// rest. The backup recorder's worker runs this file from source, so it imports
// only Node types and the dependency-free format table.

import type { DatabaseSync } from "node:sqlite";

import { FORMAT_OWNER, FORMAT_VERSIONS, isNewerThanBuild, type FileWriter, type StoreFormat } from "./formatVersions.ts";

/** What a database's header says before anything is written to it. */
export type SqliteHeaderCheck =
  | { kind: "fresh" }
  | { kind: "read" }
  | { kind: "newer"; version: number }
  | { kind: "unreadable"; detail: string };

/** A database's `user_version`; SQLite's 0 means none was set. */
export function sqliteUserVersion(db: DatabaseSync): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

/**
 * Checks a database against `format`. One with no version and no tables is a
 * new file the caller creates; any other without the header, or whose owner or
 * kind differs, is unreadable. The writer rows are never read.
 */
export function checkSqliteHeader(db: DatabaseSync, format: StoreFormat): SqliteHeaderCheck {
  const version = sqliteUserVersion(db);
  if (isNewerThanBuild(format, version)) return { kind: "newer", version };
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  if (version === 0) {
    return tables.length === 0 ? { kind: "fresh" } : { kind: "unreadable", detail: "it has no format version" };
  }
  if (!tables.some((table) => table.name === "file_header")) return { kind: "unreadable", detail: "it has no file_header table" };
  const rows = db.prepare("SELECT key, value FROM file_header WHERE key IN ('format.owner', 'format.kind')").all() as { key: string; value: string }[];
  const owner = rows.find((row) => row.key === "format.owner")?.value;
  const kind = rows.find((row) => row.key === "format.kind")?.value;
  if (owner !== FORMAT_OWNER || kind !== format) {
    return { kind: "unreadable", detail: `its file_header names ${owner ?? "no owner"} ${kind ?? "no kind"}, not ${FORMAT_OWNER} ${format}` };
  }
  return { kind: "read" };
}

/**
 * Writes the header: the version, the identity rows, and the writer rows that
 * every open for writing replaces. Runs inside the caller's transaction.
 */
export function writeSqliteHeader(db: DatabaseSync, format: StoreFormat, writer: FileWriter): void {
  db.exec("CREATE TABLE IF NOT EXISTS file_header (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.exec("DELETE FROM file_header WHERE key LIKE 'writer.%'");
  const put = db.prepare("INSERT OR REPLACE INTO file_header (key, value) VALUES (?, ?)");
  put.run("format.owner", FORMAT_OWNER);
  put.run("format.kind", format);
  put.run("writer.name", writer.name);
  put.run("writer.version", writer.version);
  db.exec(`PRAGMA user_version = ${FORMAT_VERSIONS[format]}`);
}
