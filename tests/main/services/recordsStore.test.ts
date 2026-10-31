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
import { QuarantineError } from "@main/core/shared/quarantine.js";

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
    expect(openRecords(file, path.join(root, "logs"), new Date())).toEqual({ newer: null, setAside: null, failed: null });
    closeRecords();
    expect(userVersion(file)).toBe(1);
    expect(openRecords(file, path.join(root, "logs"), new Date())).toEqual({ newer: null, setAside: null, failed: null });
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
    expect(userVersion(file)).toBe(1);
    const check = new DatabaseSync(movedTo);
    try {
      expect(check.prepare("PRAGMA user_version").get()).toEqual({ user_version: version });
      expect(check.prepare("SELECT * FROM provider_calls").all()).toEqual(history);
      expect(check.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
    } finally { check.close(); }
  }

  // The records schema less one column, under BigMouth's records header: a
  // database whose header reads but whose shape this build cannot use.
  function schemaWithout(column: string): string {
    return RECORDS_SCHEMA.split("\n").filter((line) => !line.trim().startsWith(column + " ")).join("\n") + RECORDS_HEADER;
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

  it.each(["operation_id", "elapsed_ms"])("sets aside a database missing %s and starts a new one", (column) => {
    const file = path.join(root, "records.sqlite3");
    const db = new DatabaseSync(file);
    db.exec(schemaWithout(column));
    db.exec(`INSERT INTO provider_calls (session, workspace_id, post_id, purpose, provider, started_at, finished_at, request)
      VALUES ('s', 'ws', 'p', 'analysis', 'anthropic', 't', 't', '{}'); PRAGMA user_version = 1`);
    db.close();
    const { history, schema } = snapshot(file);
    expectSetAside(file, history, schema, 1, /columns/);
  });

  // A crashed writer's newest rows can sit only in the write-ahead file. SQLite
  // folds that file back into the main one when its last connection closes, so
  // another connection is held open here, as a crash leaves it, to keep the
  // write-ahead file apart through the set-aside.
  function crashedWithWal(): { file: string; holder: DatabaseSync } {
    const file = path.join(root, "records.sqlite3");
    const writer = new DatabaseSync(file);
    writer.exec(schemaWithout("elapsed_ms") + "PRAGMA user_version = 1; PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    writer.exec(`INSERT INTO provider_calls (session, workspace_id, post_id, purpose, provider, started_at, finished_at, request)
      VALUES ('s', 'ws', 'p', 'analysis', 'anthropic', 't', 't', '{"last":true}')`);
    const holder = new DatabaseSync(file);
    holder.prepare("SELECT COUNT(*) FROM provider_calls").get();
    writer.close();
    expect(fs.statSync(file + "-wal").size).toBeGreaterThan(0);
    return { file, holder };
  }

  it("carries a set-aside database's write-ahead files with it, so its last rows are kept", () => {
    const { file, holder } = crashedWithWal();
    try {
      const opening = openRecords(file, path.join(root, "logs"), new Date());
      closeRecords();
      const movedTo = opening.setAside!.movedTo;
      expect(fs.existsSync(movedTo + "-wal")).toBe(true);
      const check = new DatabaseSync(movedTo);
      try {
        expect(check.prepare("SELECT request FROM provider_calls").all()).toEqual([{ request: '{"last":true}' }]);
      } finally { check.close(); }
    } finally { holder.close(); }
  });

  it("names where the database went when its write-ahead file cannot follow, and creates nothing over it", () => {
    const { file, holder } = crashedWithWal();
    const rename = fs.renameSync;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from).endsWith("-wal")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      rename(from, to);
    });
    const console = vi.spyOn(globalThis.console, "error").mockImplementation(() => {});
    try {
      const logs = path.join(root, "logs");
      const opening = openRecords(file, logs, new Date());
      expect(opening.setAside).toBeNull();
      const movedTo = fs.readdirSync(root).find((name) => name.endsWith(".invalid"));
      expect(movedTo).toBeDefined();
      expect(opening.failed?.message).toContain(path.join(root, movedTo!));
      expect(opening.failed?.message).toContain(file + "-wal");
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.existsSync(file + "-wal")).toBe(true);
      line();
      closeRecords();
      expect(fs.readdirSync(logs)).toHaveLength(1);
    } finally {
      spy.mockRestore();
      console.mockRestore();
      holder.close();
    }
  });

  it("falls back to the log file when the database cannot be set aside, leaving it in place", () => {
    const file = path.join(root, "records.sqlite3");
    const db = new DatabaseSync(file);
    db.exec(schemaWithout("elapsed_ms") + "PRAGMA user_version = 1;");
    db.close();
    const bytes = fs.readFileSync(file);
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
    const console = vi.spyOn(globalThis.console, "error").mockImplementation(() => {});
    try {
      const logs = path.join(root, "logs");
      const opening = openRecords(file, logs, new Date());
      expect(opening.setAside).toBeNull();
      expect(opening.failed).toBeInstanceOf(QuarantineError);
      line();
      closeRecords();
      expect(fs.readFileSync(file).equals(bytes)).toBe(true);
      expect(fs.readdirSync(root).sort()).toEqual(["logs", "records.sqlite3"]);
      expect(fs.readdirSync(logs)).toHaveLength(1);
    } finally {
      spy.mockRestore();
      console.mockRestore();
    }
  });

  it("falls back to the log file when the database opened after the set-aside is unusable too", () => {
    const file = path.join(root, "records.sqlite3");
    const db = new DatabaseSync(file);
    db.exec(schemaWithout("elapsed_ms") + "PRAGMA user_version = 1;");
    db.close();
    // The move leaves a copy behind, so the second open meets the same database.
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { fs.copyFileSync(from, to); });
    const console = vi.spyOn(globalThis.console, "error").mockImplementation(() => {});
    try {
      const logs = path.join(root, "logs");
      const opening = openRecords(file, logs, new Date());
      expect(opening.setAside).toMatchObject({ path: file });
      expect(fs.existsSync(opening.setAside!.movedTo)).toBe(true);
      expect(opening.failed?.message).toMatch(/columns/);
      line();
      closeRecords();
      expect(userVersion(file)).toBe(1);
      expect(fs.readdirSync(logs)).toHaveLength(1);
    } finally {
      spy.mockRestore();
      console.mockRestore();
    }
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
    expect(userVersion(file)).toBe(1);
    expect(fs.existsSync(path.join(root, "logs"))).toBe(false);
  });

  it.each([
    ["no format version", "CREATE TABLE earlier (id INTEGER)", /no format version/],
    ["no file_header table", RECORDS_SCHEMA + "PRAGMA user_version = 1;", /no file_header/],
    ["another kind", RECORDS_SCHEMA + RECORDS_HEADER.replace("'records'", "'backups'"), /backups/],
  ])("sets aside a database with %s and starts a new one", (_name, sql, detail) => {
    const file = path.join(root, "records.sqlite3");
    const db = new DatabaseSync(file);
    db.exec(sql);
    db.close();
    const opening = openRecords(file, path.join(root, "logs"), new Date());
    expect(opening.setAside).toMatchObject({ path: file, detail: expect.stringMatching(detail) });
    line();
    closeRecords();
    expect(userVersion(file)).toBe(1);
    expect(fs.existsSync(path.join(root, "logs"))).toBe(false);
  });

  it("writes to the fallback file over a database a newer version wrote, leaving it byte-identical", () => {
    const file = path.join(root, "records.sqlite3");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE future (id INTEGER); PRAGMA user_version = 2");
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
