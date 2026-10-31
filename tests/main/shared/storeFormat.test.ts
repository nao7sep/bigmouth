import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewerFormatError, UnreadableStoreError, WRITER, checkHeader, fileHeader, jsonStoreText, openSqliteStore, readJsonStore } from "@main/core/shared/storeFormat.js";
import { FORMAT_VERSIONS } from "@main/core/shared/formatVersions.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-sqlite-admission-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("SQLite admission", () => {
  it("refuses a database a newer build wrote before setup, leaving it byte-identical", () => {
    const file = path.join(root, "store.sqlite3");
    const existing = new DatabaseSync(file);
    existing.exec(`PRAGMA user_version = ${FORMAT_VERSIONS.records + 1}`);
    existing.close();
    const before = fs.readFileSync(file);
    const setup = vi.fn();
    expect(() => openSqliteStore("records", file, setup)).toThrow(NewerFormatError);
    expect(setup).not.toHaveBeenCalled();
    expect(fs.readFileSync(file)).toEqual(before);
  });

  function headerRows(db: DatabaseSync): Record<string, string> {
    const rows = db.prepare("SELECT key, value FROM file_header").all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  it("gives a new database the header on creation", () => {
    const file = path.join(root, "store.sqlite3");
    const db = openSqliteStore("records", file, (opened) => opened.exec("CREATE TABLE IF NOT EXISTS first (id INTEGER)"));
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(headerRows(db)).toEqual({
      "format.owner": "bigmouth",
      "format.kind": "records",
      "writer.name": "bigmouth",
      "writer.version": WRITER.version,
    });
    db.close();
  });

  it("rewrites the writer rows on every open and never reads them", () => {
    const file = path.join(root, "store.sqlite3");
    openSqliteStore("records", file, () => {}).close();
    const edit = new DatabaseSync(file);
    edit.exec("UPDATE file_header SET value = 'someone-else' WHERE key = 'writer.name'; INSERT INTO file_header VALUES ('writer.caller.name', 'x')");
    edit.close();
    const db = openSqliteStore("records", file, () => {});
    expect(headerRows(db)["writer.name"]).toBe("bigmouth");
    expect(headerRows(db)).not.toHaveProperty("writer.caller.name");
    db.close();
  });

  it.each([
    ["tables but no version", "CREATE TABLE first (id INTEGER)"],
    ["a version but no file_header table", "CREATE TABLE first (id INTEGER); PRAGMA user_version = 1"],
    ["another owner", "CREATE TABLE file_header (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO file_header VALUES ('format.owner', 'other'), ('format.kind', 'records'); PRAGMA user_version = 1"],
    ["another kind", "CREATE TABLE file_header (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO file_header VALUES ('format.owner', 'bigmouth'), ('format.kind', 'backups'); PRAGMA user_version = 1"],
  ])("refuses a database with %s as unreadable, leaving it byte-identical", (_name, sql) => {
    const file = path.join(root, "store.sqlite3");
    const existing = new DatabaseSync(file);
    existing.exec(sql);
    existing.close();
    const before = fs.readFileSync(file);
    const setup = vi.fn();
    expect(() => openSqliteStore("records", file, setup)).toThrow(UnreadableStoreError);
    expect(setup).not.toHaveBeenCalled();
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("commits the schema and the version together, so a failed setup leaves neither", () => {
    const file = path.join(root, "store.sqlite3");
    expect(() => openSqliteStore("records", file, (db) => {
      db.exec("CREATE TABLE first (id INTEGER)");
      throw new Error("schema failed");
    })).toThrow("schema failed");
    const reopened = new DatabaseSync(file);
    expect(reopened.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    expect(reopened.prepare("SELECT name FROM sqlite_master WHERE name = 'first'").all()).toEqual([]);
    reopened.close();

    // The next open completes the interrupted creation.
    const db = openSqliteStore("records", file, (opened) => opened.exec("CREATE TABLE IF NOT EXISTS first (id INTEGER)"));
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: FORMAT_VERSIONS.records });
    expect(db.prepare("SELECT * FROM first").all()).toEqual([]);
    db.close();
  });
});

describe("JSON admission", () => {
  const header = (format: Record<string, unknown>) => ({ format, writer: { name: "bigmouth", version: "1.0.0" } });

  it("reads exactly BigMouth's header for the kind, and refuses anything else", () => {
    expect(checkHeader("state", header({ owner: "bigmouth", kind: "state", version: 1 }))).toEqual({ kind: "read", version: 1 });
    expect(checkHeader("state", header({ owner: "bigmouth", kind: "state", version: 2 }))).toEqual({ kind: "newer", version: 2 });
    expect(checkHeader("state", header({ owner: "bigmouth", kind: "state", version: 1, later: true }))).toEqual({ kind: "read", version: 1 });
    for (const bad of [
      {},
      { formatVersion: 1 },
      { format: 1 },
      { format: "state" },
      header({ owner: "bigmouth", kind: "state" }),
      header({ owner: "bigmouth", kind: "state", version: "1" }),
      header({ owner: "bigmouth", kind: "state", version: 0 }),
      header({ owner: "bigmouth", kind: "state", version: 1.5 }),
      header({ owner: "other", kind: "state", version: 1 }),
      header({ owner: "bigmouth", kind: "apiKeys", version: 1 }),
    ]) {
      expect(checkHeader("state", bad)).toMatchObject({ kind: "unreadable" });
    }
  });

  it("never reads writer", () => {
    const format = { owner: "bigmouth", kind: "state", version: 1 };
    for (const writer of [undefined, null, "x", { name: "other", version: 99 }]) {
      expect(checkHeader("state", { format, writer })).toEqual({ kind: "read", version: 1 });
    }
  });

  it("writes the header first and gives readers the content without it", () => {
    const file = path.join(root, "state.json");
    fs.writeFileSync(file, jsonStoreText("state", { zoomLevel: 2, format: "content may not take it" }));
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(Object.keys(written)).toEqual(["format", "writer", "zoomLevel"]);
    expect(written.format).toEqual(fileHeader("state").format);
    expect(written.writer).toEqual(WRITER);
    expect(readJsonStore("state", file)).toEqual({ kind: "read", version: 1, value: { zoomLevel: 2 } });
  });

  it("tells a file that could not be read apart from content that cannot be used", () => {
    const missing = path.join(root, "absent.json");
    expect(readJsonStore("state", missing)).toEqual({ kind: "absent" });
    const broken = path.join(root, "broken.json");
    fs.writeFileSync(broken, "{ not json");
    expect(readJsonStore("state", broken)).toMatchObject({ kind: "unreadable" });
    // A directory where the file should be fails the read itself.
    const blocked = path.join(root, "blocked.json");
    fs.mkdirSync(blocked);
    expect(readJsonStore("state", blocked)).toMatchObject({ kind: "inaccessible" });
  });
});
