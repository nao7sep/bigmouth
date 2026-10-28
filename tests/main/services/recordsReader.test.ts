// The records reader: reads run on one worker thread of their own, awaited
// without a bound.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import {
  closeRecordsReader,
  initRecordsReader,
  readRecords,
} from "@main/core/services/recordsReader.js";
import { closeRecords, openRecords, writeLogRecord } from "@main/core/services/recordsStore.js";
import type { RecordsQuery } from "@shared/records";

let root: string;
let dbPath: string;
const nativeTerminate = Worker.prototype.terminate;
let terminations: { worker: Worker; exit: Promise<number> }[];

const query: RecordsQuery = { session: null, kind: null, level: null, search: "", after: null };

function line(message: string): void {
  const time = new Date().toISOString();
  writeLogRecord({ time, level: "info", message, workspaceId: null, postId: null, event: JSON.stringify({ time, message }) });
}

beforeEach(() => {
  terminations = [];
  vi.spyOn(Worker.prototype, "terminate").mockImplementation(function (this: Worker) {
    const exit = nativeTerminate.call(this);
    terminations.push({ worker: this, exit });
    return exit;
  });
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-reader-"));
  dbPath = path.join(root, "records.sqlite3");
  openRecords(dbPath, path.join(root, "logs"), new Date());
  initRecordsReader(dbPath);
});

async function disposeReaderFixture(): Promise<void> {
  closeRecordsReader();
  // close is intentionally nonblocking in the app. The fixture owns actual
  // worker exit, including threads an earlier close let go.
  await Promise.all(terminations.map(({ exit }) => exit));
  closeRecords();
  fs.rmSync(root, { recursive: true, force: true });
}

afterEach(async () => {
  vi.useRealTimers();
  await disposeReaderFixture();
  vi.restoreAllMocks();
});

describe("records reader", () => {
  it("joins current and already-closed readers before disposing the database", async () => {
    await readRecords({ op: "sessions" });
    closeRecordsReader();
    initRecordsReader(dbPath);
    await readRecords({ op: "sessions" });
    await disposeReaderFixture();
    expect(terminations).toHaveLength(2);
    expect(terminations.every(({ worker }) => worker.threadId === -1)).toBe(true);
    expect(fs.existsSync(root)).toBe(false);
  });

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

  it("answers reads in order on the one thread it keeps", async () => {
    line("kept");
    const first = readRecords({ op: "sessions" });
    const second = readRecords({ op: "page", query });
    expect(await first).toHaveLength(1);
    expect((await second).records).toHaveLength(1);
    expect(terminations).toEqual([]);
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
