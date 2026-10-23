import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RecordsHealth } from "@shared/records";

let root: string;
let store: typeof import("@main/core/services/recordsStore.js");
let consoleError: MockInstance<typeof console.error>;
const start = new Date("2026-10-23T00:00:00.000Z");

beforeEach(async () => {
  vi.resetModules();
  store = await import("@main/core/services/recordsStore.js");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-records-health-"));
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  store.onRecordsHealth(null);
  store.closeRecords();
  consoleError.mockRestore();
  fs.rmSync(root, { recursive: true, force: true });
});

function write(message: string): void {
  store.writeLogRecord({
    time: start.toISOString(), level: "info", message, workspaceId: null, postId: null,
    event: JSON.stringify({ message }),
  });
}

function openWithRejectedInserts(): { dbPath: string; control: DatabaseSync } {
  const dbPath = path.join(root, "records.sqlite3");
  store.openRecords(dbPath, path.join(root, "logs"), start);
  const control = new DatabaseSync(dbPath);
  control.exec(`CREATE TRIGGER reject_log BEFORE INSERT ON log_records
    BEGIN SELECT RAISE(ABORT, 'injected records write failure'); END`);
  return { dbPath, control };
}

describe("records health", () => {
  it("keeps a database gap after a failed insert even when later inserts recover", () => {
    const { control } = openWithRejectedInserts();
    const changed = vi.fn<(value: RecordsHealth) => void>();
    store.onRecordsHealth(changed);
    expect(changed).toHaveBeenLastCalledWith({ databaseGap: false, fallbackFailed: false, fallbackPath: null });
    try {
      write("fallback");
      const gap = store.recordsHealth();
      expect(gap).toEqual({ databaseGap: true, fallbackFailed: false, fallbackPath: expect.any(String) });
      expect(fs.readFileSync(gap.fallbackPath!, "utf8")).toBe(JSON.stringify({ message: "fallback" }) + "\n");
      control.exec("DROP TRIGGER reject_log");
      write("recovered");
      expect(control.prepare("SELECT message FROM log_records").all()).toEqual([{ message: "recovered" }]);
      expect(store.recordsHealth()).toEqual(gap);
      expect(changed).toHaveBeenCalledTimes(2);
      expect(changed).toHaveBeenLastCalledWith(gap);
    } finally { control.close(); }
  });

  it("reports fallback append failure distinctly after the database failure was already reported", () => {
    const { control } = openWithRejectedInserts();
    try {
      write("first fallback succeeds");
      expect(store.recordsHealth()).toMatchObject({ databaseGap: true, fallbackFailed: false });
      const append = vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
        throw Object.assign(new Error("injected fallback append failure"), { code: "EIO" });
      });
      try {
        write("both sinks failed");
        write("still failed");
        expect(store.recordsHealth()).toEqual({ databaseGap: true, fallbackFailed: true, fallbackPath: expect.any(String) });
        const diagnostics = consoleError.mock.calls.map(([message]) => String(message));
        expect(diagnostics.filter((message) => message.includes("[records] records database write failed:"))).toHaveLength(1);
        expect(diagnostics.filter((message) => message.includes("[records] records fallback file write failed:"))).toHaveLength(1);
        expect(diagnostics).toContain(JSON.stringify({ message: "both sinks failed" }));
        expect(diagnostics).toContain(JSON.stringify({ message: "still failed" }));
      } finally { append.mockRestore(); }
      control.exec("DROP TRIGGER reject_log");
      write("recovered");
      expect(store.recordsHealth().fallbackFailed).toBe(true);
    } finally { control.close(); }
  });

  it("gives subscribers the retained snapshot and keeps returned copies from changing health authority", () => {
    const { control } = openWithRejectedInserts();
    try {
      write("gap before subscription");
      const expected = store.recordsHealth();
      const snapshots: RecordsHealth[] = [];
      store.onRecordsHealth((value) => { snapshots.push(value); });
      expect(snapshots).toEqual([expected]);
      snapshots[0].databaseGap = false;
      snapshots[0].fallbackPath = "changed by subscriber";
      const returned = store.recordsHealth();
      returned.databaseGap = false;
      returned.fallbackFailed = true;
      returned.fallbackPath = null;
      expect(store.recordsHealth()).toEqual(expected);

      const append = vi.spyOn(fs, "appendFileSync").mockImplementationOnce(() => { throw new Error("fallback unavailable"); });
      try { write("fallback now fails"); }
      finally { append.mockRestore(); }
      expect(snapshots).toHaveLength(2);
      expect(snapshots[1]).toEqual({ ...expected, fallbackFailed: true });
      snapshots[1].fallbackFailed = false;
      expect(store.recordsHealth()).toEqual({ ...expected, fallbackFailed: true });
      store.closeRecords();
      expect(store.recordsHealth()).toEqual({ ...expected, fallbackFailed: true });
    } finally { control.close(); }
  });
});
