// The records window's reads, against a database the app's own records store
// wrote, so the queries are checked against the schema they read.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

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

function call(startedAt: string, error: unknown, model = "claude-x", stopped = false): void {
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
    stopped,
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

  it("lists a call the user stopped as stopped, not among warnings and errors", () => {
    openRecords(dbPath, path.join(root, "logs"), LATER);
    call("2026-10-02T08:00:01.000Z", undefined, "stopped", true);
    call("2026-10-02T08:00:02.000Z", undefined, "finished");

    const all = readPage(reader(), query()).records;
    expect(all.map((record) => [record.text, record.level, record.stopped])).toEqual([
      ["finished", "info", false],
      ["stopped", "info", true],
    ]);
    expect(readPage(reader(), query({ level: "attention" })).records).toEqual([]);
    expect(readDetail(reader(), "provider-call", all[1]!.id)).toMatchObject({ stopped: true, error: null });
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

describe("bounded records page merge", () => {
  function everyPage(overrides: Partial<RecordsQuery> = {}) {
    const records: import("@shared/records").RecordSummary[] = [];
    let after: RecordsQuery["after"] = null;
    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const page = readPage(reader(), query({ ...overrides, after }));
      records.push(...page.records);
      if (!page.more) return records;
      const last = page.records.at(-1)!;
      after = { time: last.time, kind: last.kind, id: last.id };
    }
    throw new Error("Fixture pagination did not finish");
  }

  it("traverses equal-time mixed kinds without duplicates or omissions across both cursor kinds", () => {
    openRecords(dbPath, path.join(root, "logs"), LATER);
    const time = "2026-10-02T08:00:01.000Z";
    for (let i = 0; i < RECORDS_PAGE_SIZE + 5; i++) {
      line(time, "info", `line ${i}`);
      call(time, undefined, `model-${i}`);
    }
    const all = everyPage();
    const expected = reader().prepare(`SELECT 'log' AS kind, id, time FROM log_records
      UNION ALL SELECT 'provider-call' AS kind, id, started_at AS time FROM provider_calls
      ORDER BY time DESC, kind DESC, id DESC`).all();
    expect(all.map(({ kind, id, time }) => ({ kind, id, time }))).toEqual(expected);
    expect(new Set(all.map(({ kind, id }) => `${kind}:${id}`)).size).toBe(2 * (RECORDS_PAGE_SIZE + 5));
    for (const kind of ["log", "provider-call"] as const) {
      expect(everyPage({ kind }).map(({ id }) => id)).toEqual(all.filter((row) => row.kind === kind).map(({ id }) => id));
    }
  });

  it("applies session, level and escaped search before each branch limit", () => {
    openRecords(dbPath, path.join(root, "logs"), EARLIER);
    line("2026-10-01T08:00:01.000Z", "warn", "needle_50%");
    call("2026-10-01T08:00:01.000Z", { message: "needle_50%" });
    closeRecords();
    openRecords(dbPath, path.join(root, "logs"), LATER);
    for (let i = 0; i < RECORDS_PAGE_SIZE + 5; i++) {
      line("2026-10-02T08:00:01.000Z", "info", `other ${i}`);
      call("2026-10-02T08:00:01.000Z", undefined);
    }
    const page = readPage(reader(), query({ session: EARLIER.toISOString(), level: "attention", search: "needle_50%" }));
    expect(page.more).toBe(false);
    expect(page.records.map(({ kind, level }) => [kind, level])).toEqual([["provider-call", "error"], ["log", "warn"]]);
    expect(readPage(reader(), query({ search: "needleX50x" })).records).toEqual([]);
  });

  it.each([null, "log", "provider-call"] as const)("uses ordered table indexes before branch limits for a %s cursor", (kind) => {
    openRecords(dbPath, path.join(root, "logs"), LATER);
    line("2026-10-02T08:00:01.000Z", "info", "one");
    call("2026-10-02T08:00:01.000Z", undefined);
    let executed!: { sql: string; params: SQLInputValue[] };
    const database = reader();
    const traced = {
      prepare: (sql: string) => ({ all: (...params: SQLInputValue[]) => {
        executed = { sql, params };
        return database.prepare(sql).all(...params);
      } }),
    } as unknown as DatabaseSync;
    for (const session of [null, LATER.toISOString()]) {
      readPage(traced, query({ session, after: kind === null ? null : { kind, id: 2, time: "2026-10-02T08:00:01.000Z" } }));
      const plan = database.prepare(`EXPLAIN QUERY PLAN ${executed.sql}`).all(...executed.params) as { id: number; parent: number; detail: string }[];
      for (const table of ["log_records", "provider_calls"]) {
        const index = `idx_${table}_${session === null ? "time" : "session_time"}`;
        const access = plan.filter(({ detail }) => detail.includes(`${table} USING INDEX`));
        expect(access).toHaveLength(1);
        expect(access[0].detail).toContain(`USING INDEX ${index}`);
        expect(access[0].detail.startsWith(kind === null && session === null ? "SCAN " : "SEARCH ")).toBe(true);
      }
      // The sole temporary ordering step is outside both limited table
      // subqueries. It can sort their two 101-row candidates, not the tables.
      expect(plan.filter(({ detail }) => detail.includes("TEMP B-TREE"))).toEqual([
        expect.objectContaining({ parent: 0, detail: "USE TEMP B-TREE FOR ORDER BY" }),
      ]);
      expect(executed.sql.match(/ORDER BY (?:time|started_at) DESC, id DESC LIMIT \?/g)).toHaveLength(2);
      expect(executed.params.filter((value) => value === RECORDS_PAGE_SIZE + 1)).toHaveLength(3);
    }
  });
});
