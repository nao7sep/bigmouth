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
    expect(openRecords(file, path.join(root, "logs"), new Date())).toEqual({ newer: null, setAside: null });
    closeRecords();
    expect(userVersion(file)).toBe(2);
    expect(openRecords(file, path.join(root, "logs"), new Date())).toEqual({ newer: null, setAside: null });
    const stored = vi.fn();
    onRecordStored(stored);
    line();
    expect(stored).toHaveBeenCalledOnce();
  });

  // A database this build cannot use is set aside whole, rows and shape, and a
  // new one takes this session's records, so a launch never falls back to log
  // files for that reason.
  function expectSetAside(file: string, history: unknown[], schema: unknown[], version: number, detail: RegExp) {
    const logs = path.join(root, "logs");
    const opening = openRecords(file, logs, new Date());
    expect(opening.newer).toBeNull();
    expect(opening.setAside).toMatchObject({ path: file, detail: expect.stringMatching(detail) });
    const movedTo = opening.setAside!.movedTo;
    expect(path.basename(movedTo)).toMatch(/^records-\d{8}-\d{6}-utc\.invalid$/);
    const stored = vi.fn();
    onRecordStored(stored);
    writeProviderCall(providerCall({ stopped: true, operationId: "op", elapsedMs: 5 }));
    closeRecords();
    expect(stored).toHaveBeenCalledOnce();
    expect(fs.existsSync(logs)).toBe(false);
    expect(userVersion(file)).toBe(2);
    const check = new DatabaseSync(movedTo);
    try {
      expect(check.prepare("PRAGMA user_version").get()).toEqual({ user_version: version });
      expect(check.prepare("SELECT * FROM provider_calls").all()).toEqual(history);
      expect(check.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
    } finally { check.close(); }
  }

  function snapshot(file: string): { history: unknown[]; schema: unknown[] } {
    const db = new DatabaseSync(file);
    try {
      return {
        history: db.prepare("SELECT * FROM provider_calls").all(),
        schema: db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all(),
      };
    } finally { db.close(); }
  }

  it("sets aside a version 1 database without the provider-call facts and starts a new one", () => {
    const file = path.join(root, "records.sqlite3");
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE provider_calls (id INTEGER PRIMARY KEY, session TEXT NOT NULL, workspace_id TEXT NOT NULL,
      post_id TEXT NOT NULL, purpose TEXT NOT NULL, provider TEXT NOT NULL, started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL, request TEXT NOT NULL, response TEXT, error TEXT); PRAGMA user_version = 1`);
    db.exec(`INSERT INTO provider_calls (session, workspace_id, post_id, purpose, provider, started_at, finished_at, request)
      VALUES ('s', 'ws', 'p', 'analysis', 'anthropic', 't', 't', '{}')`);
    db.close();
    const { history, schema } = snapshot(file);
    expectSetAside(file, history, schema, 1, /format version 1/);
  });

  it("sets aside a version 1 database even when its shape matches, rather than altering it", () => {
    const file = path.join(root, "records.sqlite3");
    const db = new DatabaseSync(file);
    db.exec(RECORDS_SCHEMA + "PRAGMA user_version = 1;");
    db.close();
    const { history, schema } = snapshot(file);
    expectSetAside(file, history, schema, 1, /format version 1/);
  });

  it.each(["operation_id", "elapsed_ms"])("sets aside a current-version database missing %s", (column) => {
    const file = path.join(root, "records.sqlite3");
    const db = new DatabaseSync(file);
    db.exec(RECORDS_SCHEMA.split("\n").filter((line) => !line.trim().startsWith(column + " ")).join("\n"));
    db.exec(`INSERT INTO provider_calls (session, workspace_id, post_id, purpose, provider, started_at, finished_at, request)
      VALUES ('s', 'ws', 'p', 'analysis', 'anthropic', 't', 't', '{}'); PRAGMA user_version = 2`);
    db.close();
    const { history, schema } = snapshot(file);
    expectSetAside(file, history, schema, 2, /columns/);
  });

  it("carries a set-aside database's write-ahead files with it, so its last rows are kept", () => {
    const file = path.join(root, "records.sqlite3");
    const writer = new DatabaseSync(file);
    writer.exec(RECORDS_SCHEMA + "PRAGMA user_version = 1; PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    writer.exec(`INSERT INTO provider_calls (session, workspace_id, post_id, purpose, provider, started_at, finished_at, request)
      VALUES ('s', 'ws', 'p', 'analysis', 'anthropic', 't', 't', '{"last":true}')`);
    // A copy taken while the writer is open leaves its newest row only in the
    // write-ahead file, as a crash would.
    const crashed = path.join(root, "crashed");
    fs.mkdirSync(crashed);
    for (const suffix of ["", "-wal", "-shm"]) fs.copyFileSync(file + suffix, path.join(crashed, "records.sqlite3" + suffix));
    writer.close();
    const copy = path.join(crashed, "records.sqlite3");
    const opening = openRecords(copy, path.join(crashed, "logs"), new Date());
    closeRecords();
    const check = new DatabaseSync(opening.setAside!.movedTo);
    try {
      expect(check.prepare("SELECT request FROM provider_calls").all()).toEqual([{ request: '{"last":true}' }]);
    } finally { check.close(); }
  });

  it("sets aside a file that is not a database", () => {
    const file = path.join(root, "records.sqlite3");
    const bytes = Buffer.from("not a database ".repeat(20));
    fs.writeFileSync(file, bytes);
    const opening = openRecords(file, path.join(root, "logs"), new Date());
    line();
    closeRecords();
    expect(opening.setAside?.detail).toMatch(/not a database/);
    expect(fs.readFileSync(opening.setAside!.movedTo)).toEqual(bytes);
    expect(userVersion(file)).toBe(2);
    expect(fs.existsSync(path.join(root, "logs"))).toBe(false);
  });

  it("reads a database without its format version as this build's, completing its schema", () => {
    const file = path.join(root, "records.sqlite3");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE earlier (id INTEGER)");
    db.close();
    expect(openRecords(file, path.join(root, "logs"), new Date())).toEqual({ newer: null, setAside: null });
    const stored = vi.fn();
    onRecordStored(stored);
    line();
    closeRecords();
    expect(stored).toHaveBeenCalledOnce();
    expect(userVersion(file)).toBe(2);
    expect(fs.existsSync(path.join(root, "logs"))).toBe(false);
  });

  it("writes to the fallback file over a database a newer version wrote, leaving it byte-identical", () => {
    const file = path.join(root, "records.sqlite3");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE future (id INTEGER); PRAGMA user_version = 3");
    db.close();
    const bytes = fs.readFileSync(file);

    const { newer: refused, setAside } = openRecords(file, path.join(root, "logs"), new Date());
    expect(setAside).toBeNull();
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
