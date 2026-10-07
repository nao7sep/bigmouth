import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSqliteStore, UnreadableStoreError } from "@main/core/shared/storeFormat.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-sqlite-admission-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("SQLite initialization admission", () => {
  it.each([0, -1])("leaves an existing database with marker %s untouched before setup", (marker) => {
    const file = path.join(root, "store.sqlite3");
    const existing = new DatabaseSync(file);
    existing.exec(`PRAGMA user_version = ${marker}`);
    existing.close();
    const before = fs.readFileSync(file);
    const setup = vi.fn();
    expect(() => openSqliteStore("records", file, setup)).toThrow(UnreadableStoreError);
    expect(setup).not.toHaveBeenCalled();
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(root)).toEqual(["store.sqlite3"]);
  });

  it("removes all staged initialization files on schema failure", () => {
    const file = path.join(root, "store.sqlite3");
    expect(() => openSqliteStore("records", file, (db) => {
      db.exec("CREATE TABLE first (id INTEGER)");
      throw new Error("schema failed");
    })).toThrow("schema failed");
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("publishes the schema and marker together", () => {
    const file = path.join(root, "store.sqlite3");
    const db = openSqliteStore("records", file, (stage) => {
      expect(fs.existsSync(file)).toBe(false);
      stage.exec("CREATE TABLE first (id INTEGER)");
    });
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(db.prepare("SELECT * FROM first").all()).toEqual([]);
    db.close();
    expect(fs.readdirSync(root)).toEqual(["store.sqlite3"]);
  });
});
