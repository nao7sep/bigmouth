import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  initLogger,
  closeLogger,
  getRecordsPath,
  debug,
  info,
  warn,
  error,
  isDebugLoggingEnabled,
  serializeError,
} from "@main/core/services/logger.js";
import { writeProviderCall } from "@main/core/services/recordsStore.js";

let rootDir: string;
let dbPath: string;
let logsDir: string;

function query<T>(sql: string): T[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

// Every log line recorded this session, as the JSON object it was emitted as.
function readLogLines(): Record<string, unknown>[] {
  return query<{ event: string }>("SELECT event FROM log_records ORDER BY id").map(
    (row) => JSON.parse(row.event) as Record<string, unknown>,
  );
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-log-"));
  dbPath = path.join(rootDir, "records.sqlite3");
  logsDir = path.join(rootDir, "logs");
  initLogger(dbPath, logsDir);
  delete process.env.BIGMOUTH_DEBUG;
});

afterEach(() => {
  closeLogger();
  vi.useRealTimers();
  delete process.env.BIGMOUTH_DEBUG;
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe("records", () => {
  it("keeps each line as a record in the records database", () => {
    expect(getRecordsPath()).toBe(dbPath);
    info("hello", { workspace: "ws-1", postId: "p-1", count: 2 });
    warn("no ids");
    const rows = query<Record<string, unknown>>(
      "SELECT session, time, level, message, workspace_id, post_id FROM log_records ORDER BY id",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ level: "info", message: "hello", workspace_id: "ws-1", post_id: "p-1" });
    expect(rows[1]).toMatchObject({ level: "warn", message: "no ids", workspace_id: null, post_id: null });
    expect(rows[0]!.session).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(rows[1]!.session).toBe(rows[0]!.session);
    expect(fs.existsSync(logsDir)).toBe(false);
  });

  it("names a new session at each launch", () => {
    // Each launch is named by its start instant; two explicit instants stand in
    // for two launches instead of waiting on the real clock.
    closeLogger();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T01:00:00.000Z"));
    initLogger(dbPath, logsDir);
    info("first");
    closeLogger();
    vi.setSystemTime(new Date("2026-10-09T01:00:00.001Z"));
    initLogger(dbPath, logsDir);
    info("second");
    const sessions = query<{ session: string }>("SELECT session FROM log_records ORDER BY id");
    expect(sessions.map((row) => row.session)).toEqual(["2026-10-09T01:00:00.000Z", "2026-10-09T01:00:00.001Z"]);
  });

  it("records a provider call whole", () => {
    writeProviderCall({
      workspaceId: "ws-1",
      postId: "p-1",
      purpose: "analysis",
      provider: "anthropic",
      startedAt: new Date("2026-10-02T00:00:00.000Z"),
      finishedAt: new Date("2026-10-02T00:00:01.500Z"),
      request: { model: "m", system: "s", messages: [{ role: "user", content: "u" }] },
      response: { content: [{ type: "text", text: "r" }], usage: { input_tokens: 1 } },
      stopped: false,
      error: undefined,
    });
    const [row] = query<Record<string, string | null>>("SELECT * FROM provider_calls");
    expect(row).toMatchObject({
      workspace_id: "ws-1",
      post_id: "p-1",
      purpose: "analysis",
      started_at: "2026-10-02T00:00:00.000Z",
      finished_at: "2026-10-02T00:00:01.500Z",
      error: null,
    });
    expect(JSON.parse(row!.request!)).toEqual({ model: "m", system: "s", messages: [{ role: "user", content: "u" }] });
    expect(JSON.parse(row!.response!)).toEqual({ content: [{ type: "text", text: "r" }], usage: { input_tokens: 1 } });
  });

  it("falls back to a plain text file under logs/ when the database cannot be opened", () => {
    closeLogger();
    fs.rmSync(dbPath, { force: true });
    fs.mkdirSync(dbPath);
    initLogger(dbPath, logsDir);
    info("kept anyway", { count: 1 });
    const fallback = getRecordsPath()!;
    expect(path.dirname(fallback)).toBe(logsDir);
    expect(path.basename(fallback)).toMatch(/^\d{8}-\d{6}-utc\.log$/);
    const [line] = fs.readFileSync(fallback, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(line).toMatchObject({ level: "info", message: "kept anyway", count: 1 });
  });
});

describe("envelope", () => {
  it("writes one JSON object per line with time / level / message", () => {
    info("hello world");
    const [line] = readLogLines();
    expect(line.level).toBe("info");
    expect(line.message).toBe("hello world");
    expect(line.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("uses lowercase level names for each level", () => {
    process.env.BIGMOUTH_DEBUG = "1";
    debug("d");
    info("i");
    warn("w");
    error("e");
    expect(readLogLines().map((l) => l.level)).toEqual(["debug", "info", "warn", "error"]);
  });

  it("merges extra fields alongside the envelope", () => {
    info("did a thing", { count: 3, ok: true, items: ["a", "b"] });
    const [line] = readLogLines();
    expect(line.count).toBe(3);
    expect(line.ok).toBe(true);
    expect(line.items).toEqual(["a", "b"]);
  });

  it("never lets a field overwrite the envelope time / level / message", () => {
    info("real message", { message: "spoofed", level: "error", time: "nope" });
    const [line] = readLogLines();
    expect(line.message).toBe("real message");
    expect(line.level).toBe("info");
    expect(line.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("debug gating", () => {
  it("is silent unless debug logging is enabled", () => {
    debug("should not appear");
    info("marker");
    const lines = readLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].message).toBe("marker");
  });

  it("emits when BIGMOUTH_DEBUG=1", () => {
    process.env.BIGMOUTH_DEBUG = "1";
    debug("now visible");
    const [line] = readLogLines();
    expect(line.level).toBe("debug");
    expect(line.message).toBe("now visible");
  });

  it("emits when --debug-logs is present in process arguments", () => {
    const originalArgv = process.argv;
    try {
      process.argv = [...originalArgv, "--debug-logs"];
      debug("cli visible");
    } finally {
      process.argv = originalArgv;
    }
    const [line] = readLogLines();
    expect(line.level).toBe("debug");
    expect(line.message).toBe("cli visible");
  });

  it("enables debug logging only for explicit switches", () => {
    expect(isDebugLoggingEnabled({ env: {}, argv: ["node", "index.js"] })).toBe(false);
    expect(isDebugLoggingEnabled({ env: { BIGMOUTH_DEBUG: "1" }, argv: ["node", "index.js"] })).toBe(
      true
    );
    expect(isDebugLoggingEnabled({ env: {}, argv: ["node", "index.js", "--debug-logs"] })).toBe(true);
    expect(isDebugLoggingEnabled({ env: {}, argv: ["node", "index.js", "--debug-logs=false"] })).toBe(
      false
    );
  });
});

describe("serializeError", () => {
  it("preserves nested recovery failures and a reused cause through JSON", () => {
    const original = Object.assign(new Error("primary query failed"), {
      operation: "ReadPrimaryIndex", nativeCode: 6,
    });
    const fallback = Object.assign(new Error("fallback query failed"), {
      operation: "ReadBackupIndex", nativeCode: 5,
    });
    const aggregate = new AggregateError([original, fallback], "store recovery failed", { cause: original });
    const serialized = JSON.parse(JSON.stringify(serializeError(aggregate)));
    expect(serialized).toMatchObject({
      name: "AggregateError",
      cause: { message: original.message, stack: original.stack, operation: "ReadPrimaryIndex", nativeCode: 6 },
      errors: [
        { message: original.message, stack: original.stack, operation: "ReadPrimaryIndex", nativeCode: 6 },
        { message: fallback.message, stack: fallback.stack, operation: "ReadBackupIndex", nativeCode: 5 },
      ],
    });
  });

  it("contains a self-referential aggregate", () => {
    const aggregate = new AggregateError([], "cycle");
    aggregate.errors.push(aggregate);
    expect(() => JSON.stringify(serializeError(aggregate))).not.toThrow();
  });
  it("captures name, message, and stack", () => {
    const out = serializeError(new TypeError("boom")) as Record<string, unknown>;
    expect(out.name).toBe("TypeError");
    expect(out.message).toBe("boom");
    expect(typeof out.stack).toBe("string");
  });

  it("recurses the cause chain", () => {
    const root = new Error("root");
    const wrapped = new Error("wrapped", { cause: root });
    const out = serializeError(wrapped) as Record<string, unknown>;
    expect(out.message).toBe("wrapped");
    expect((out.cause as Record<string, unknown>).message).toBe("root");
  });

  it("handles a non-Error thrown value", () => {
    expect(serializeError("just a string")).toEqual({ message: "just a string" });
    expect(serializeError(7)).toEqual({ message: "7" });
  });

  it("does not loop on a self-referential cause", () => {
    const err = new Error("loop") as Error & { cause?: unknown };
    err.cause = err;
    const out = serializeError(err) as Record<string, unknown>;
    expect(out.cause).toBe("[circular]");
  });
});

describe("durability", () => {
  it("does not throw when no session is open", () => {
    closeLogger();
    expect(() => info("after close")).not.toThrow();
  });
});
