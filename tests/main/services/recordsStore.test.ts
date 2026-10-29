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
  readRecordSessions,
  readRecordsPage,
  writeLogRecord,
  writeProviderCall,
  type ProviderCallRecord,
} from "@main/core/services/recordsStore.js";
import { RECORDS_SCHEMA } from "@main/core/services/recordsSchema.js";
import { NewerFormatError } from "@main/core/shared/storeFormat.js";

let root: string;

function line(): void {
  const time = new Date().toISOString();
  writeLogRecord({ time, level: "info", message: "hello", workspaceId: null, postId: null, event: "{}" });
}

function providerCall(overrides: Partial<ProviderCallRecord> = {}): ProviderCallRecord {
  return {
    workspaceId: "ws", postId: "p", purpose: "analysis", provider: "anthropic",
    startedAt: new Date("2026-10-23T00:00:00.000Z"), finishedAt: new Date("2026-10-23T00:00:01.000Z"),
    request: {}, response: undefined, error: undefined, stopped: false,
    ...overrides,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-store-"));
});

afterEach(() => {
  onRecordStored(null);
  closeRecords();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("records window reads", () => {
  const query = { session: null, kind: null, level: null, search: "", after: null };

  it("reads on the connection the writes use, seeing every record stored before the read", () => {
    openRecords(path.join(root, "records.sqlite3"), path.join(root, "logs"), new Date());
    line();
    expect(readRecordsPage(query).records).toHaveLength(1);
    line();
    expect(readRecordsPage(query).records).toHaveLength(2);
    expect(readRecordSessions()).toEqual([currentRecordsSession()]);
  });

  it("refuses a read while the database is not open", () => {
    expect(() => readRecordsPage(query)).toThrow(/not open/);
  });
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

// records.sqlite3's format version, which tells a build whether it can read the database.
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

  it("refuses the old provider-call shape without changing its bytes or history and uses fallback", () => {
    const file = path.join(root, "records.sqlite3");
    const logs = path.join(root, "logs");
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE provider_calls (id INTEGER PRIMARY KEY, session TEXT NOT NULL, workspace_id TEXT NOT NULL,
      post_id TEXT NOT NULL, purpose TEXT NOT NULL, provider TEXT NOT NULL, started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL, request TEXT NOT NULL, response TEXT, error TEXT); PRAGMA user_version = 1`);
    db.exec(`INSERT INTO provider_calls (session, workspace_id, post_id, purpose, provider, started_at, finished_at, request)
      VALUES ('s', 'ws', 'p', 'analysis', 'anthropic', 't', 't', '{}')`);
    const history = db.prepare("SELECT * FROM provider_calls").all();
    const schema = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
    db.close();
    const bytes = fs.readFileSync(file);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      openRecords(file, logs, new Date());
      writeProviderCall(providerCall({ stopped: true }));
      closeRecords();
      expect(fs.readFileSync(file)).toEqual(bytes);
      const check = new DatabaseSync(file);
      try {
        expect(check.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
        expect(check.prepare("SELECT * FROM provider_calls").all()).toEqual(history);
        expect(check.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
      } finally { check.close(); }
      const [fallback] = fs.readdirSync(logs);
      expect(JSON.parse(fs.readFileSync(path.join(logs, fallback), "utf8"))).toMatchObject({ record: "provider-call", stopped: true });
    } finally { error.mockRestore(); }
  });

  it.each(["operation_id", "elapsed_ms"])("refuses a current-version database missing %s without changing it", (column) => {
    const file = path.join(root, "records.sqlite3");
    const logs = path.join(root, "logs");
    const db = new DatabaseSync(file);
    db.exec(RECORDS_SCHEMA.split("\n").filter((line) => !line.trim().startsWith(column + " ")).join("\n"));
    db.exec(`INSERT INTO provider_calls (session, workspace_id, post_id, purpose, provider, started_at, finished_at, request)
      VALUES ('s', 'ws', 'p', 'analysis', 'anthropic', 't', 't', '{}'); PRAGMA user_version = 1`);
    const history = db.prepare("SELECT * FROM provider_calls").all();
    const schema = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
    db.close();
    const bytes = fs.readFileSync(file);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      openRecords(file, logs, new Date());
      line();
      closeRecords();
      expect(fs.readFileSync(file)).toEqual(bytes);
      expect(fs.readdirSync(logs)).toHaveLength(1);
      const check = new DatabaseSync(file);
      try {
        expect(check.prepare("SELECT * FROM provider_calls").all()).toEqual(history);
        expect(check.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
        expect(check.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      } finally { check.close(); }
    } finally { error.mockRestore(); }
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

describe("provider-call optional facts", () => {
  it("stores absent elapsed time and operation as null while preserving known values", () => {
    const file = path.join(root, "records.sqlite3");
    openRecords(file, path.join(root, "logs"), new Date());
    writeProviderCall(providerCall());
    writeProviderCall(providerCall({ elapsedMs: 0, operationId: "operation-zero" }));
    writeProviderCall(providerCall({ elapsedMs: 123.5, operationId: "operation-known" }));
    closeRecords();
    const db = new DatabaseSync(file);
    try {
      expect(db.prepare("SELECT elapsed_ms, operation_id FROM provider_calls ORDER BY id").all()).toEqual([
        { elapsed_ms: null, operation_id: null },
        { elapsed_ms: 0, operation_id: "operation-zero" },
        { elapsed_ms: 123.5, operation_id: "operation-known" },
      ]);
    } finally { db.close(); }
  });

  it("keeps the same optional facts in fallback records", () => {
    const blocked = path.join(root, "records.sqlite3");
    const logs = path.join(root, "logs");
    fs.mkdirSync(blocked);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      openRecords(blocked, logs, new Date());
      writeProviderCall(providerCall());
      writeProviderCall(providerCall({ elapsedMs: 0, operationId: "operation-zero" }));
      writeProviderCall(providerCall({ elapsedMs: 123.5, operationId: "operation-known" }));
      const [fallback] = fs.readdirSync(logs);
      const entries = fs.readFileSync(path.join(logs, fallback), "utf8").trim().split("\n").map((entry) => JSON.parse(entry));
      expect(entries.map(({ elapsedMs, operationId }) => ({ elapsedMs, operationId }))).toEqual([
        { elapsedMs: null, operationId: null },
        { elapsedMs: 0, operationId: "operation-zero" },
        { elapsedMs: 123.5, operationId: "operation-known" },
      ]);
    } finally { error.mockRestore(); }
  });
});
