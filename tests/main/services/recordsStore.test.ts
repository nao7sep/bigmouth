// The stored-record signal the records window's live updates hang on.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  closeRecords,
  currentRecordsSession,
  onRecordStored,
  openRecords,
  writeLogRecord,
  writeProviderCall,
} from "@main/core/services/recordsStore.js";
import { NewerFormatError } from "@main/core/shared/storeFormat.js";

let root: string;

function line(): void {
  const time = new Date().toISOString();
  writeLogRecord({ time, level: "info", message: "hello", workspaceId: null, postId: null, event: "{}" });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-store-"));
});

afterEach(() => {
  onRecordStored(null);
  closeRecords();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("stored-record signal", () => {
  it("calls the listener after each record the database stored", () => {
    openRecords(path.join(root, "records.sqlite3"), path.join(root, "logs"), new Date());
    const stored = vi.fn();
    onRecordStored(stored);

    line();
    expect(stored).toHaveBeenCalledOnce();
    writeProviderCall({
      workspaceId: "ws", postId: "p", purpose: "analysis", provider: "anthropic",
      startedAt: new Date(), finishedAt: new Date(), request: {}, response: {}, error: undefined, stopped: false,
    });
    expect(stored).toHaveBeenCalledTimes(2);
  });

  it("stays quiet for a record that went to the fallback file", () => {
    // A directory where the database file should be cannot be opened as one.
    const blocked = path.join(root, "records.sqlite3");
    fs.mkdirSync(blocked);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      openRecords(blocked, path.join(root, "logs"), new Date());
      const stored = vi.fn();
      onRecordStored(stored);

      line();
      expect(stored).not.toHaveBeenCalled();
      expect(fs.readdirSync(path.join(root, "logs"))).toHaveLength(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("names this launch's session by its start", () => {
    const start = new Date("2026-10-02T08:00:00.000Z");
    expect(currentRecordsSession()).toBeNull();
    openRecords(path.join(root, "records.sqlite3"), path.join(root, "logs"), start);
    expect(currentRecordsSession()).toBe(start.toISOString());
  });
});

// store-recovery-conventions: records.sqlite3's format version.
describe("records database format version", () => {
  function userVersion(file: string): number {
    const db = new DatabaseSync(file);
    try {
      return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    } finally {
      db.close();
    }
  }

  it("stamps this build's format version and opens it again", () => {
    const file = path.join(root, "records.sqlite3");
    expect(openRecords(file, path.join(root, "logs"), new Date())).toBeNull();
    closeRecords();
    expect(userVersion(file)).toBe(1);
    expect(openRecords(file, path.join(root, "logs"), new Date())).toBeNull();
    const stored = vi.fn();
    onRecordStored(stored);
    line();
    expect(stored).toHaveBeenCalledOnce();
  });

  it("gives provider calls in an older database the stopped column, its rows read as not stopped", () => {
    const file = path.join(root, "records.sqlite3");
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE provider_calls (id INTEGER PRIMARY KEY, session TEXT NOT NULL, workspace_id TEXT NOT NULL,
      post_id TEXT NOT NULL, purpose TEXT NOT NULL, provider TEXT NOT NULL, started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL, request TEXT NOT NULL, response TEXT, error TEXT); PRAGMA user_version = 1`);
    db.exec(`INSERT INTO provider_calls (session, workspace_id, post_id, purpose, provider, started_at, finished_at, request)
      VALUES ('s', 'ws', 'p', 'analysis', 'anthropic', 't', 't', '{}')`);
    db.close();

    expect(openRecords(file, path.join(root, "logs"), new Date())).toBeNull();
    writeProviderCall({
      workspaceId: "ws", postId: "p", purpose: "analysis", provider: "anthropic",
      startedAt: new Date(), finishedAt: new Date(), request: {}, response: undefined, error: undefined, stopped: true,
    });
    closeRecords();
    const check = new DatabaseSync(file);
    expect(check.prepare("SELECT stopped FROM provider_calls ORDER BY id").all()).toEqual([{ stopped: 0 }, { stopped: 1 }]);
    check.close();
  });

  it("reads a database without its format version as this build's, completing its schema", () => {
    const file = path.join(root, "records.sqlite3");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE earlier (id INTEGER)");
    db.close();
    expect(openRecords(file, path.join(root, "logs"), new Date())).toBeNull();
    const stored = vi.fn();
    onRecordStored(stored);
    line();
    closeRecords();
    expect(stored).toHaveBeenCalledOnce();
    expect(userVersion(file)).toBe(1);
    expect(fs.existsSync(path.join(root, "logs"))).toBe(false);
  });

  it("writes to the fallback file over a database a newer version wrote, leaving it byte-identical", () => {
    const file = path.join(root, "records.sqlite3");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE future (id INTEGER); PRAGMA user_version = 2");
    db.close();
    const bytes = fs.readFileSync(file);

    const refused = openRecords(file, path.join(root, "logs"), new Date());
    expect(refused).toBeInstanceOf(NewerFormatError);
    expect(refused?.filePath).toBe(file);
    line();
    closeRecords();

    expect(fs.readdirSync(path.join(root, "logs"))).toHaveLength(1);
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(fs.readdirSync(root).sort()).toEqual(["logs", "records.sqlite3"]);
  });
});
