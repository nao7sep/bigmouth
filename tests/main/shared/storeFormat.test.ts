import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewerFormatError, checkFormatVersion, openSqliteStore, readJsonStore } from "@main/core/shared/storeFormat.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-sqlite-admission-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("SQLite admission", () => {
  it("refuses a database a newer build wrote before setup, leaving it byte-identical", () => {
    const file = path.join(root, "store.sqlite3");
    const existing = new DatabaseSync(file);
    existing.exec("PRAGMA user_version = 2");
    existing.close();
    const before = fs.readFileSync(file);
    const setup = vi.fn();
    expect(() => openSqliteStore("records", file, setup)).toThrow(NewerFormatError);
    expect(setup).not.toHaveBeenCalled();
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("reads a database without its version as this build's format and stamps it", () => {
    const file = path.join(root, "store.sqlite3");
    const existing = new DatabaseSync(file);
    existing.exec("CREATE TABLE first (id INTEGER)");
    existing.close();
    const db = openSqliteStore("records", file, (opened) => opened.exec("CREATE TABLE IF NOT EXISTS first (id INTEGER)"));
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    db.close();
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
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(db.prepare("SELECT * FROM first").all()).toEqual([]);
    db.close();
  });
});

describe("JSON admission", () => {
  it("reads a store without its version as this build's format", () => {
    expect(checkFormatVersion("state", {})).toEqual({ kind: "read", version: 1 });
    expect(checkFormatVersion("state", { formatVersion: 2 })).toEqual({ kind: "newer", version: 2 });
    expect(checkFormatVersion("state", { formatVersion: "1" })).toMatchObject({ kind: "unreadable" });
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
