// The records reader: reads run on a worker thread of their own, and a read
// that does not answer in time is rejected and its thread abandoned.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  RECORDS_READ_TIMEOUT_MS,
  closeRecordsReader,
  initRecordsReader,
  readRecords,
} from "@main/core/services/recordsReader.js";
import { closeRecords, openRecords, writeLogRecord } from "@main/core/services/recordsStore.js";
import type { RecordsQuery } from "@shared/records";

let root: string;
let dbPath: string;

const query: RecordsQuery = { session: null, kind: null, level: null, search: "", after: null };

function line(message: string): void {
  const time = new Date().toISOString();
  writeLogRecord({ time, level: "info", message, workspaceId: null, postId: null, event: JSON.stringify({ time, message }) });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-reader-"));
  dbPath = path.join(root, "records.sqlite3");
  openRecords(dbPath, path.join(root, "logs"), new Date());
  initRecordsReader(dbPath);
});

afterEach(() => {
  vi.useRealTimers();
  closeRecordsReader();
  closeRecords();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("records reader", () => {
  it("reads beside the writer, seeing every record stored before the read", async () => {
    line("first");
    expect((await readRecords({ op: "page", query })).records.map((record) => record.title)).toEqual(["first"]);
    line("second");
    expect((await readRecords({ op: "page", query })).records.map((record) => record.title)).toEqual([
      "second",
      "first",
    ]);
    expect(await readRecords({ op: "sessions" })).toHaveLength(1);
  });

  it("rejects a read the database cannot answer, and reads again once it can", async () => {
    closeRecordsReader();
    initRecordsReader(path.join(root, "missing.sqlite3"));
    await expect(readRecords({ op: "page", query })).rejects.toThrow();

    closeRecordsReader();
    initRecordsReader(dbPath);
    line("kept");
    expect((await readRecords({ op: "page", query })).records).toHaveLength(1);
  });

  it("gives up on a read that does not answer in time, and the next read starts afresh", async () => {
    line("kept");
    vi.useFakeTimers();
    const waiting = readRecords({ op: "page", query });
    vi.advanceTimersByTime(RECORDS_READ_TIMEOUT_MS);
    await expect(waiting).rejects.toThrow(/did not answer/);

    vi.useRealTimers();
    expect((await readRecords({ op: "page", query })).records).toHaveLength(1);
  });

  it("rejects what is still waiting when it closes, and reads nothing after", async () => {
    const waiting = readRecords({ op: "page", query });
    closeRecordsReader();
    await expect(waiting).rejects.toThrow(/closed/);
    await expect(readRecords({ op: "page", query })).rejects.toThrow(/not open/);
  });
});

describe("records reader format version", () => {
  it("refuses a database a newer version wrote, leaving it byte-identical", async () => {
    const newer = path.join(root, "newer.sqlite3");
    const db = new DatabaseSync(newer);
    db.exec("CREATE TABLE future (id INTEGER); PRAGMA user_version = 2");
    db.close();
    const bytes = fs.readFileSync(newer);

    closeRecordsReader();
    initRecordsReader(newer);
    await expect(readRecords({ op: "sessions" })).rejects.toThrow(/in format 2, which this build cannot read/);
    expect(fs.readFileSync(newer).equals(bytes)).toBe(true);
  });
});
