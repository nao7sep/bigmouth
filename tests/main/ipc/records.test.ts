// The records window's IPC handlers: renderer-supplied arguments are checked
// before a read, a successful read logs nothing (each record stored would
// otherwise start the next read), and a failed one is logged and rethrown.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "@shared/ipc";
import type { RecordsQuery } from "@shared/records";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const state = vi.hoisted(() => ({
  reads: [] as unknown[],
  readFailure: null as Error | null,
  opened: 0,
  logged: [] as unknown[][],
}));

vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
}));
vi.mock("@main/core/services/recordsReader.js", () => ({
  readRecords: async (read: { op: string }) => {
    state.reads.push(read);
    if (state.readFailure) throw state.readFailure;
    return read.op === "sessions" ? ["2026-10-02T08:00:00.000Z"] : { records: [], more: false };
  },
}));
vi.mock("@main/core/services/recordsStore.js", () => ({ currentRecordsSession: () => "2026-10-02T08:00:00.000Z" }));
vi.mock("@main/core/services/workspaceStore.js", () => ({
  listWorkspaces: () => [{ id: "ws-1", name: "Blog", dataDirectory: "/blog" }],
}));
vi.mock("@main/records-window.js", () => ({ openRecordsWindow: async () => { state.opened++; } }));
vi.mock("@main/core/services/logger.js", () => ({
  error: (...args: unknown[]) => state.logged.push(args),
  serializeError: (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
}));

import { registerRecordsHandlers } from "@main/ipc/records.js";

const query: RecordsQuery = { session: null, kind: null, level: null, search: "", after: null };
const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args) as Promise<unknown>;

beforeEach(() => {
  handlers.clear();
  state.reads.length = 0;
  state.readFailure = null;
  state.opened = 0;
  state.logged.length = 0;
  registerRecordsHandlers();
});

describe("records IPC", () => {
  it("opens the records window", async () => {
    await invoke(CHANNELS.openRecordsWindow);
    expect(state.opened).toBe(1);
  });

  it("reads a page for a valid query and logs nothing", async () => {
    const after = { time: "2026-10-02T08:00:00.000Z", kind: "log", id: 3 };
    await expect(invoke(CHANNELS.readRecordsPage, { ...query, level: "attention", after })).resolves.toEqual({
      records: [],
      more: false,
    });
    expect(state.reads).toEqual([{ op: "page", query: { ...query, level: "attention", after } }]);
    expect(state.logged).toEqual([]);
  });

  it.each([
    ["not an object", null],
    ["an unknown kind", { ...query, kind: "notice" }],
    ["an unknown level", { ...query, level: "fatal" }],
    ["a search that is not text", { ...query, search: 3 }],
    ["a cursor without an id", { ...query, after: { time: "t", kind: "log" } }],
  ])("refuses a query that is %s, without reading", async (_name, bad) => {
    await expect(invoke(CHANNELS.readRecordsPage, bad)).rejects.toThrow(/Invalid IPC parameter/);
    expect(state.reads).toEqual([]);
  });

  it("reads one record by kind and id, refusing anything else", async () => {
    await invoke(CHANNELS.readRecordDetail, "provider-call", 4);
    expect(state.reads).toEqual([{ op: "detail", kind: "provider-call", id: 4 }]);
    await expect(invoke(CHANNELS.readRecordDetail, "log", 1.5)).rejects.toThrow(/id must be an integer/);
    await expect(invoke(CHANNELS.readRecordDetail, "other", 1)).rejects.toThrow(/kind/);
  });

  it("names this launch, every launch with records, and the workspaces by name", async () => {
    await expect(invoke(CHANNELS.readRecordSources)).resolves.toEqual({
      currentSession: "2026-10-02T08:00:00.000Z",
      sessions: ["2026-10-02T08:00:00.000Z"],
      workspaces: [{ id: "ws-1", name: "Blog" }],
    });
  });

  it("logs a failed read and passes the failure on", async () => {
    state.readFailure = new Error("SQLITE_BUSY");
    await expect(invoke(CHANNELS.readRecordsPage, query)).rejects.toThrow("SQLITE_BUSY");
    expect(state.logged).toEqual([
      ["records read failed", { channel: CHANNELS.readRecordsPage, error: { message: "SQLITE_BUSY" } }],
    ]);
  });
});
