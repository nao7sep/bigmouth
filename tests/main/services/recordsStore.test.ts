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
// BigMouth's records header, as a database this build wrote carries it.
const RECORDS_HEADER = `CREATE TABLE file_header (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO file_header VALUES ('format.owner', 'bigmouth'), ('format.kind', 'records'), ('writer.name', 'bigmouth'), ('writer.version', '1.0.0');
PRAGMA user_version = 1;`;

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
    expect(openRecords(file, path.join(root, "logs"), new Date())).toEqual({ newer: null, unusable: null, failed: null });
    closeRecords();
    expect(userVersion(file)).toBe(1);
    expect(openRecords(file, path.join(root, "logs"), new Date())).toEqual({ newer: null, unusable: null, failed: null });
    const stored = vi.fn();
    onRecordStored(stored);
    line();
    expect(stored).toHaveBeenCalledOnce();
  });

  // The records schema less one column, under BigMouth's records header: a
  // database whose header reads but whose shape this build cannot use.
  function schemaWithout(column: string): string {
    return RECORDS_SCHEMA.split("\n").filter((line) => !line.trim().startsWith(column + " ")).join("\n") + RECORDS_HEADER;
  }

  // A database this build cannot use stays byte-identical and off for the
  // session: nothing moves it, and the session's records go to its log file.
  function expectLeftOff(file: string, detail: RegExp) {
    const logs = path.join(root, "logs");
    const before = fs.readdirSync(root).map((name) => [name, fs.readFileSync(path.join(root, name))] as const);
    const opening = openRecords(file, logs, new Date());
    expect(opening).toMatchObject({ newer: null, failed: null, unusable: { path: file, detail: expect.stringMatching(detail) } });
    line();
    writeProviderCall(providerCall({ stopped: true }));
    closeRecords();
    for (const [name, bytes] of before) expect(fs.readFileSync(path.join(root, name)).equals(bytes)).toBe(true);
    expect(fs.readdirSync(root).sort()).toEqual([...before.map(([name]) => name), "logs"].sort());
    expect(fs.readdirSync(logs)).toHaveLength(1);
  }

  it.each(["operation_id", "elapsed_ms"])("leaves a database missing %s untouched and off", (column) => {
    const file = path.join(root, "records.sqlite3");
    const db = new DatabaseSync(file);
    db.exec(schemaWithout(column));
    db.exec(`INSERT INTO provider_calls (session, workspace_id, post_id, purpose, provider, started_at, finished_at, request)
      VALUES ('s', 'ws', 'p', 'analysis', 'anthropic', 't', 't', '{}')`);
    db.close();
    expectLeftOff(file, /columns/);
  });

  it.each([
    ["no format version", "CREATE TABLE earlier (id INTEGER)", /no format version/],
    ["no file_header table", RECORDS_SCHEMA + "PRAGMA user_version = 1;", /no file_header/],
    ["another kind", RECORDS_SCHEMA + RECORDS_HEADER.replace("'records'", "'backups'"), /backups/],
  ])("leaves a database with %s untouched and off", (_name, sql, detail) => {
    const file = path.join(root, "records.sqlite3");
    const db = new DatabaseSync(file);
    db.exec(sql);
    db.close();
    expectLeftOff(file, detail);
  });

  it("leaves a file that is not a database untouched and off", () => {
    const file = path.join(root, "records.sqlite3");
    fs.writeFileSync(file, Buffer.from("not a database ".repeat(20)));
    expectLeftOff(file, /not a database/);
  });

  // A crashed writer's newest rows can sit only in the write-ahead file. SQLite
  // folds that file back into the main one when its last connection closes, so
  // another connection is held open here, as a crash leaves it.
  it("leaves an unusable database's write-ahead file where it is", () => {
    const file = path.join(root, "records.sqlite3");
    const writer = new DatabaseSync(file);
    writer.exec(schemaWithout("elapsed_ms") + "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    writer.exec(`INSERT INTO provider_calls (session, workspace_id, post_id, purpose, provider, started_at, finished_at, request)
      VALUES ('s', 'ws', 'p', 'analysis', 'anthropic', 't', 't', '{"last":true}')`);
    const holder = new DatabaseSync(file);
    holder.prepare("SELECT COUNT(*) FROM provider_calls").get();
    writer.close();
    try {
      const wal = fs.readFileSync(file + "-wal");
      const opening = openRecords(file, path.join(root, "logs"), new Date());
      closeRecords();
      expect(opening.unusable).toMatchObject({ path: file });
      expect(fs.readFileSync(file + "-wal").equals(wal)).toBe(true);
      expect(fs.readdirSync(root).filter((name) => name.endsWith(".invalid"))).toEqual([]);
    } finally { holder.close(); }
  });

  it("writes to the fallback file over a database a newer version wrote, leaving it byte-identical", () => {
    const file = path.join(root, "records.sqlite3");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE future (id INTEGER); PRAGMA user_version = 2");
    db.close();
    const bytes = fs.readFileSync(file);

    const { newer: refused, unusable } = openRecords(file, path.join(root, "logs"), new Date());
    expect(unusable).toBeNull();
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
