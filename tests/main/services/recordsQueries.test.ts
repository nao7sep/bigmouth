// The records window's reads, against a database the app's own records store
// wrote, so the queries are checked against the schema they read.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  closeRecords,
  openRecords,
  writeLogRecord,
  writeProviderCall,
} from "@main/core/services/recordsStore.js";
import { RECORDS_PAGE_SIZE, readDetail, readPage, readSessions } from "@main/core/services/recordsQueries.js";
import type { RecordsQuery } from "@shared/records";

let root: string;
let dbPath: string;
let db: DatabaseSync | null = null;

const EARLIER = new Date("2026-10-01T08:00:00.000Z");
const LATER = new Date("2026-10-02T08:00:00.000Z");

const query = (overrides: Partial<RecordsQuery> = {}): RecordsQuery => ({
  session: null, kind: null, level: null, search: "", after: null, ...overrides,
});

function line(time: string, level: string, message: string, fields: Record<string, unknown> = {}): void {
  writeLogRecord({
    time,
    level,
    message,
    workspaceId: (fields.workspace as string | undefined) ?? null,
    postId: (fields.postId as string | undefined) ?? null,
    event: JSON.stringify({ time, level, message, ...fields }),
  });
}

function call(startedAt: string, error: unknown, model = "claude-x"): void {
  writeProviderCall({
    workspaceId: "ws-1",
    postId: "post-1",
    purpose: "metadata",
    provider: "anthropic",
    startedAt: new Date(startedAt),
    finishedAt: new Date(Date.parse(startedAt) + 2500),
    request: { method: "POST", url: "https://api.anthropic.com/v1/messages", headers: { "x-api-key": "sk-test" }, body: { model } },
    response: error === undefined ? { content: [] } : undefined,
    error,
  });
}

function reader(): DatabaseSync {
  db ??= new DatabaseSync(dbPath, { readOnly: true });
  return db;
}

const titles = (overrides: Partial<RecordsQuery> = {}) =>
  readPage(reader(), query(overrides)).records.map((record) => record.title);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-records-"));
  dbPath = path.join(root, "records.sqlite3");
});

afterEach(() => {
  db?.close();
  db = null;
  closeRecords();
  fs.rmSync(root, { recursive: true, force: true });
});

function seed(): void {
  openRecords(dbPath, path.join(root, "logs"), EARLIER);
  line("2026-10-01T08:00:01.000Z", "info", "app started");
  closeRecords();
  openRecords(dbPath, path.join(root, "logs"), LATER);
  line("2026-10-02T08:00:01.000Z", "warn", "careful with 50% of it", { workspace: "ws-1", postId: "post-1" });
  call("2026-10-02T08:00:02.000Z", { name: "Error", message: "quota" });
}

describe("readPage", () => {
  it("lists log lines and provider calls together, newest first", () => {
    seed();
    const page = readPage(reader(), query());

    expect(page.more).toBe(false);
    expect(page.records.map((record) => [record.kind, record.level, record.title, record.text])).toEqual([
      ["provider-call", "error", "anthropic metadata", "claude-x"],
      ["log", "warn", "careful with 50% of it", null],
      ["log", "info", "app started", null],
    ]);
    expect(page.records[2]!.session).toBe(EARLIER.toISOString());
    expect(page.records[0]!.session).toBe(LATER.toISOString());
  });

  it("filters by launch, kind, level and search", () => {
    seed();
    expect(titles({ session: EARLIER.toISOString() })).toEqual(["app started"]);
    expect(titles({ kind: "log" })).toEqual(["careful with 50% of it", "app started"]);
    expect(titles({ kind: "provider-call" })).toEqual(["anthropic metadata"]);
    expect(titles({ level: "error" })).toEqual(["anthropic metadata"]);
    expect(titles({ level: "info" })).toEqual(["app started"]);
    // Search reaches the stored request, key included, and takes % and _ literally.
    expect(titles({ search: "SK-TEST" })).toEqual(["anthropic metadata"]);
    expect(titles({ search: "50%" })).toEqual(["careful with 50% of it"]);
    expect(titles({ search: "5_%" })).toEqual([]);
    expect(titles({ search: "post-1", kind: "log" })).toEqual(["careful with 50% of it"]);
  });

  it("filters for attention: warning and error lines and failed provider calls", () => {
    openRecords(dbPath, path.join(root, "logs"), LATER);
    line("2026-10-02T08:00:01.000Z", "info", "calm");
    line("2026-10-02T08:00:02.000Z", "warn", "careful");
    line("2026-10-02T08:00:03.000Z", "error", "broken");
    line("2026-10-02T08:00:04.000Z", "debug", "detail");
    call("2026-10-02T08:00:05.000Z", undefined, "succeeded");
    call("2026-10-02T08:00:06.000Z", { message: "quota" }, "failed");

    const page = readPage(reader(), query({ level: "attention" }));
    expect(page.records.map((record) => record.text ?? record.title)).toEqual(["failed", "broken", "careful"]);
    expect(titles({ level: "debug" })).toEqual(["detail"]);
  });

  it("continues a long list from the last record of the page before", () => {
    openRecords(dbPath, path.join(root, "logs"), LATER);
    // Records sharing one time are still paged in a stable order.
    for (let index = 0; index < RECORDS_PAGE_SIZE + 5; index++) {
      line("2026-10-02T08:00:01.000Z", "info", `tick ${index}`);
    }

    const first = readPage(reader(), query());
    expect(first.records).toHaveLength(RECORDS_PAGE_SIZE);
    expect(first.more).toBe(true);
    const last = first.records.at(-1)!;
    const second = readPage(reader(), query({ after: { time: last.time, kind: last.kind, id: last.id } }));

    expect(second.more).toBe(false);
    expect(second.records).toHaveLength(5);
    const ids = [...first.records, ...second.records].map((record) => record.id);
    expect(new Set(ids).size).toBe(RECORDS_PAGE_SIZE + 5);
    expect(second.records.at(-1)!.title).toBe("tick 0");
  });

  it("reads an empty database as no records", () => {
    openRecords(dbPath, path.join(root, "logs"), LATER);
    expect(readPage(reader(), query())).toEqual({ records: [], more: false });
  });
});

describe("readSessions", () => {
  it("names every launch that has records, newest first", () => {
    seed();
    expect(readSessions(reader())).toEqual([LATER.toISOString(), EARLIER.toISOString()]);
  });
});

describe("readDetail", () => {
  it("reads a log line whole, its emitted line included", () => {
    seed();
    const id = readPage(reader(), query({ kind: "log", level: "warn" })).records[0]!.id;
    const detail = readDetail(reader(), "log", id);

    expect(detail).toMatchObject({
      kind: "log",
      level: "warn",
      message: "careful with 50% of it",
      workspaceId: "ws-1",
      postId: "post-1",
      session: LATER.toISOString(),
    });
    expect(JSON.parse((detail as { event: string }).event)).toMatchObject({ postId: "post-1" });
  });

  it("reads a provider call whole", () => {
    seed();
    const id = readPage(reader(), query({ kind: "provider-call" })).records[0]!.id;
    const detail = readDetail(reader(), "provider-call", id);

    expect(detail).toMatchObject({
      kind: "provider-call",
      provider: "anthropic",
      purpose: "metadata",
      workspaceId: "ws-1",
      postId: "post-1",
      startedAt: "2026-10-02T08:00:02.000Z",
      finishedAt: "2026-10-02T08:00:04.500Z",
      response: null,
    });
    expect(JSON.parse((detail as { request: string }).request).headers["x-api-key"]).toBe("sk-test");
    expect(JSON.parse((detail as { error: string }).error)).toEqual({ name: "Error", message: "quota" });
  });

  it("answers null for a record that is not there", () => {
    seed();
    expect(readDetail(reader(), "log", 999)).toBeNull();
    expect(readDetail(reader(), "provider-call", 999)).toBeNull();
  });
});
