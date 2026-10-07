// Pins the write-through data-backup store (data-backup conventions), exercised through the real
// managed-text choke point writeManagedText — the one path that records. The store is a module-level
// singleton keyed to the storage root (getAppRoot() → BIGMOUTH_DATA_DIR), so each test relocates BIGMOUTH_DATA_DIR
// to a throwaway root, calls initAppDir() to resolve it, and the shared teardown (tests/main/setup.ts)
// closes the singleton so the next test re-opens against its own root.
//
// What is pinned:
//   - content is a BLOB of the EXACT bytes written — a CR/LF pair and a non-UTF-8 byte round-trip
//     byte-identically (the whole point of a backup; a string round-trip would normalize/corrupt these).
//   - content_sha256 is the SHA-256 over those raw bytes; byte_size is their length.
//   - written_at_utc is the serialized ISO-8601-ms form (2026-...Z), NOT the yyyymmdd-hhmmss filename stamp.
//   - dedup: an unchanged re-save writes NO new row; a changed save and a revert each insert a row.
//   - best-effort: a store failure injected into record() never throws, logs one warn, and leaves the
//     already-succeeded save untouched.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { initAppDir } from "@main/core/services/workspaceStore.js";
import { getAppRoot } from "@main/core/services/storagePaths.js";
import { writeManagedText } from "@main/core/shared/atomicWrite.js";
import * as backupStore from "@main/core/services/backupStore.js";
import * as logger from "@main/core/services/logger.js";
import { getStateJsonPath } from "@main/core/services/storagePaths.js";
import { initStateStore, updateUiState } from "@main/core/services/stateStore.js";

const SAVED_HOME = process.env.BIGMOUTH_DATA_DIR;
let root: string;

interface Row {
  id: number;
  path: string;
  content: Uint8Array;
  content_sha256: string;
  byte_size: number;
  written_at_utc: string;
}

/** Reads every row for a path, oldest first, by opening the store file directly (a separate handle from
 *  the singleton the code writes through). */
function rows(forPath: string): Row[] {
  const db = new DatabaseSync(path.join(getAppRoot(), "backups.sqlite3"));
  try {
    return db
      .prepare("SELECT * FROM backups WHERE path = ? ORDER BY id ASC")
      .all(forPath) as unknown as Row[];
  } finally {
    db.close();
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-backupstore-"));
  process.env.BIGMOUTH_DATA_DIR = root;
  initAppDir();
});

afterEach(() => {
  // closeBackupStore() runs in the shared teardown (tests/main/setup.ts); here just restore env + clean up.
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_DATA_DIR;
  else process.env.BIGMOUTH_DATA_DIR = SAVED_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});

it("refuses a cached backup connection whose marker was upgraded externally", () => {
  const file = path.join(root, "document.md");
  backupStore.record(file, Buffer.from("before"));
  const other = new DatabaseSync(path.join(root, "backups.sqlite3"));
  other.exec("PRAGMA user_version = 99");
  const count = other.prepare("SELECT COUNT(*) AS n FROM backups").get();
  backupStore.record(file, Buffer.from("after"));
  expect(other.prepare("SELECT COUNT(*) AS n FROM backups").get()).toEqual(count);
  expect(other.prepare("PRAGMA user_version").get()).toEqual({ user_version: 99 });
  other.close();
});

describe("backup store — BLOB byte-fidelity", () => {
  it("stores the exact bytes written, preserving a CR/LF pair and a non-UTF-8 byte", () => {
    // A CR/LF (0x0D 0x0A) that a text round-trip would risk normalizing, plus a lone 0xFF that is not
    // valid UTF-8 at all — proving content is stored as raw bytes, never decoded text. Written as latin1
    // so the string's char codes map 1:1 to bytes, then compared against those exact bytes.
    const file = path.join(root, "sample.md");
    const bytes = Buffer.from([0x41, 0x0d, 0x0a, 0x42, 0xff, 0x43]); // "A\r\nB<0xFF>C"
    // writeManagedText serializes UTF-8, so drive the byte-exact path via latin1 -> the same bytes back.
    const text = bytes.toString("latin1");
    fs.writeFileSync(file, bytes); // put the raw bytes on disk...
    // ...then record through the choke point using the identical byte content it holds in hand.
    // (writeManagedText re-encodes text as UTF-8; latin1 <=0xFF chars are the case where that would
    // differ, so record the raw bytes directly to assert BLOB fidelity without the UTF-8 re-encode.)
    backupStore.record(file, bytes);

    const stored = rows(file);
    expect(stored).toHaveLength(1);
    // Byte-identical: same length and every byte equal, including the CR, the LF, and the 0xFF.
    expect(Buffer.from(stored[0].content)).toEqual(bytes);
    expect(stored[0].byte_size).toBe(bytes.byteLength);
    expect(stored[0].content_sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    // Guard against a silent UTF-8 decode: the stored bytes must NOT equal the UTF-8 encoding of the
    // latin1 string (0xFF would become the 2-byte 0xC3 0xBF), which is exactly the corruption to catch.
    expect(Buffer.from(stored[0].content)).not.toEqual(Buffer.from(text, "utf8"));
  });

  it("round-trips a CR/LF-bearing managed text write through writeManagedText byte-identically", () => {
    const file = path.join(root, "sample.md");
    const text = "line one\r\nline two\r\n"; // CRLF line ends, valid UTF-8
    writeManagedText(file, text);

    const stored = rows(file);
    expect(stored).toHaveLength(1);
    // The stored bytes equal the UTF-8 encoding of the text, with CR/LF intact (not stripped to LF).
    expect(Buffer.from(stored[0].content)).toEqual(Buffer.from(text, "utf8"));
    expect(Buffer.from(stored[0].content).toString("utf8")).toBe(text);
  });
});

describe("backup store — written_at_utc shape", () => {
  it("is the serialized ISO-8601-ms form, never the yyyymmdd-hhmmss filename stamp", () => {
    const file = path.join(root, "sample.md");
    writeManagedText(file, "{}\n");

    const stored = rows(file);
    expect(stored).toHaveLength(1);
    const stamp = stored[0].written_at_utc;
    // Exactly the toISOString() shape: 2026-07-06T04:05:12.345Z.
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // Parseable back to an instant, and re-serializes to itself.
    expect(new Date(stamp).toISOString()).toBe(stamp);
    // NOT the filename stamp form (yyyymmdd-hhmmss(-fff)-utc): no bare 8-digit date run, no -utc suffix.
    expect(stamp).not.toMatch(/^\d{8}-\d{6}/);
    expect(stamp).not.toContain("-utc");
  });
});

describe("backup store — dedup, change, revert", () => {
  it("skips an unchanged re-save (same content writes no new row)", () => {
    const file = path.join(root, "sample.md");
    writeManagedText(file, "A");
    writeManagedText(file, "A"); // identical — dedup skip
    expect(rows(file)).toHaveLength(1);
  });

  it("inserts a row for a changed save", () => {
    const file = path.join(root, "sample.md");
    writeManagedText(file, "A");
    writeManagedText(file, "B"); // different content — new version
    const stored = rows(file);
    expect(stored).toHaveLength(2);
    expect(Buffer.from(stored[0].content).toString("utf8")).toBe("A");
    expect(Buffer.from(stored[1].content).toString("utf8")).toBe("B");
  });

  it("inserts a row for a revert (content returning to an earlier value differs from the latest row)", () => {
    const file = path.join(root, "sample.md");
    writeManagedText(file, "A"); // v1
    writeManagedText(file, "B"); // v2
    writeManagedText(file, "A"); // revert to v1's content — still a new row (differs from v2, the latest)
    const stored = rows(file);
    expect(stored).toHaveLength(3);
    expect(stored.map((r) => Buffer.from(r.content).toString("utf8"))).toEqual(["A", "B", "A"]);
  });

  it("dedups per path — two different files each keep their own latest-row comparison", () => {
    const a = path.join(root, "sample.md");
    const b = path.join(root, "other.md");
    writeManagedText(a, "same");
    writeManagedText(b, "same"); // same content, different path — a separate first row, not a dedup skip
    writeManagedText(a, "same"); // unchanged for a — skipped
    expect(rows(a)).toHaveLength(1);
    expect(rows(b)).toHaveLength(1);
  });

  it("locks before the latest-row read so another process cannot insert the same successor", () => {
    const file = path.join(root, "sample.md");
    writeManagedText(file, "A");

    const competitor = new DatabaseSync(path.join(getAppRoot(), "backups.sqlite3"));
    competitor.exec("PRAGMA busy_timeout = 1");
    const nextBytes = Buffer.from("B");
    const nextHash = createHash("sha256").update(nextBytes).digest("hex");
    let competitorWasBlocked = false;

    const proto = DatabaseSync.prototype as unknown as {
      prepare: (this: DatabaseSync, sql: string) => {
        get: (...args: unknown[]) => unknown;
        run: (...args: unknown[]) => unknown;
      };
    };
    const realPrepare = proto.prepare;
    proto.prepare = function (sql: string) {
      const statement = realPrepare.call(this, sql);
      if (!sql.startsWith("SELECT content_sha256")) return statement;
      return {
        ...statement,
        get: (...args: unknown[]) => {
          const latest = statement.get(...args);
          try {
            realPrepare
              .call(
                competitor,
                "INSERT INTO backups (path, content, content_sha256, byte_size, written_at_utc) VALUES (?, ?, ?, ?, ?)",
              )
              .run(file, nextBytes, nextHash, nextBytes.byteLength, new Date().toISOString());
          } catch (err) {
            competitorWasBlocked = (err as { code?: string }).code === "ERR_SQLITE_ERROR";
          }
          return latest;
        },
      };
    };

    try {
      writeManagedText(file, "B");
    } finally {
      proto.prepare = realPrepare;
      competitor.close();
    }

    expect(competitorWasBlocked).toBe(true);
    expect(rows(file).map((row) => Buffer.from(row.content).toString("utf8"))).toEqual(["A", "B"]);
  });
});

describe("backup store — best-effort", () => {
  it("never throws, logs one warn, and leaves the save intact when the store insert fails", () => {
    const file = path.join(root, "sample.md");
    // Prime the store so it is open (first record on a fresh root creates the table), then break the very
    // next insert by pointing prepare() at a throw. This injects a store failure at record time.
    writeManagedText(file, "first"); // opens the store, records v1

    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    // Inject a failure into DatabaseSync.prototype.prepare so the SELECT/INSERT inside record() throws,
    // and the best-effort wrapper must catch it. Restored in the finally before rows() reads again.
    const proto = DatabaseSync.prototype as unknown as { prepare: (sql: string) => unknown };
    const realPrepare = proto.prepare;
    proto.prepare = () => {
      throw new Error("injected store failure");
    };

    let threw = false;
    try {
      // A changed save: the file write must still succeed; only the record() must fail internally.
      expect(() => writeManagedText(file, "second")).not.toThrow();
    } catch {
      threw = true;
    } finally {
      proto.prepare = realPrepare;
    }

    expect(threw).toBe(false);
    // The save itself landed on disk despite the record failure.
    expect(fs.readFileSync(file, "utf8")).toBe("second");
    // Exactly one warn was logged for the failed record.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/backup store: failed to record/);
    warnSpy.mockRestore();

    // And the store still holds v1 (the failed insert added nothing); a later good save self-heals.
    expect(rows(file).map((r) => Buffer.from(r.content).toString("utf8"))).toEqual(["first"]);
    writeManagedText(file, "third");
    expect(rows(file).map((r) => Buffer.from(r.content).toString("utf8"))).toEqual(["first", "third"]);
  });

  it("disables recording for the session with one warn when the store cannot open", () => {
    // Force open to fail by making the store path uncreatable: replace the root dir with a file so
    // mkdirSync(dirname) / DatabaseSync both fail. Reset the singleton first so this test drives a fresh open.
    backupStore.closeBackupStore();
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const openSpy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(() => {
      throw new Error("injected open failure");
    });

    const file = path.join(root, "sample.md");
    // record must swallow the open failure — no throw, and the save (done by the caller) is unaffected.
    expect(() => backupStore.record(file, Buffer.from("x"))).not.toThrow();
    // A second record in the same session does NOT re-log (open is attempted once, then disabled).
    expect(() => backupStore.record(file, Buffer.from("y"))).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/could not open; recording disabled/);

    openSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe("backup store — the choke point is wired to the real record sites", () => {
  it("records the workspace registry on create and config only on its first edit", async () => {
    const { createWorkspace } = await import("@main/core/services/workspaceStore.js");
    // A workspace starts with no saved config sets.
    const ws = createWorkspace("Recorded WS");

    const registry = rows(path.join(root, "workspaces.json"));
    // Two registry versions: the empty default from initAppDir, then the one-entry version from create.
    expect(registry.length).toBeGreaterThanOrEqual(2);
    expect(Buffer.from(registry.at(-1)!.content).toString("utf8")).toContain("Recorded WS");

    expect(rows(path.join(ws.dataDirectory, "config.json"))).toHaveLength(0);
    const { saveSettings, getSettings } = await import("@main/core/services/configStore.js");
    saveSettings(ws.dataDirectory, { ...getSettings(ws.dataDirectory), uiFontFamily: "Inter" });
    expect(rows(path.join(ws.dataDirectory, "config.json"))).toHaveLength(1);
  });

  it("records a post .md through writePost's managed-text choke point", async () => {
    const { createWorkspace } = await import("@main/core/services/workspaceStore.js");
    const { createPost, updatePost, clearCache } = await import("@main/core/services/postStore.js");
    const ws = createWorkspace("Post WS");
    const post = createPost(ws.dataDirectory, "blogger", "en");
    // The .md file exists and its first version is recorded.
    const first = rows(post.filePath);
    expect(first).toHaveLength(1);
    // A real content edit adds a second version.
    updatePost(ws.dataDirectory, post.frontMatter.id, { content: "a genuinely new body" });
    expect(rows(post.filePath).length).toBeGreaterThanOrEqual(2);
    clearCache(ws.dataDirectory);
  });
});

// state.json is volatile state and nothing else (pane widths, zoom, last selections), so the
// data-backup conventions keep it out of the history. It is still written atomically.
describe("state.json is not recorded", () => {
  it("writes a view-state save to disk without recording it", () => {
    const statePath = getStateJsonPath();
    initStateStore();

    updateUiState({ paneLeftWidth: 401 });
    updateUiState({ paneLeftWidth: 402 });

    expect(JSON.parse(fs.readFileSync(statePath, "utf-8")).paneLeftWidth).toBe(402);
    expect(rows(statePath)).toHaveLength(0);
  });
});

describe("posts/index.json is not recorded", () => {
  it("writes the index to disk without recording it", async () => {
    const { createWorkspace } = await import("@main/core/services/workspaceStore.js");
    const { createPost, clearCache } = await import("@main/core/services/postStore.js");
    const ws = createWorkspace("Index WS");
    const post = createPost(ws.dataDirectory, "blogger", "en");
    const indexPath = path.join(ws.dataDirectory, "posts", "index.json");

    expect(fs.readFileSync(indexPath, "utf-8")).toContain(post.frontMatter.id);
    expect(rows(indexPath)).toHaveLength(0);
    clearCache(ws.dataDirectory);
  });
});

// store-recovery-conventions: backups.sqlite3's format version.
describe("backup store — format version", () => {
  const storeFile = () => path.join(getAppRoot(), "backups.sqlite3");

  function userVersion(): number {
    const db = new DatabaseSync(storeFile());
    try {
      return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    } finally {
      db.close();
    }
  }

  /** Replaces the store with a fresh file built by `setup`, the singleton closed first. */
  function replaceStore(setup: string): void {
    backupStore.closeBackupStore();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(storeFile() + suffix, { force: true });
    const db = new DatabaseSync(storeFile());
    db.exec(setup);
    db.close();
  }

  it("stamps this build's format version and records into it", () => {
    const file = path.join(root, "sample.md");
    backupStore.record(file, Buffer.from("x"));
    expect(userVersion()).toBe(1);
    expect(rows(file)).toHaveLength(1);
  });

  it("disables recording over a store with tables but no format version, leaving it byte-identical", () => {
    replaceStore("CREATE TABLE earlier (id INTEGER)");
    const bytes = fs.readFileSync(storeFile());
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      backupStore.record(path.join(root, "sample.md"), Buffer.from("x"));
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/could not open; recording disabled/);
    } finally {
      warnSpy.mockRestore();
    }
    backupStore.closeBackupStore();
    expect(fs.readFileSync(storeFile()).equals(bytes)).toBe(true);
    expect(userVersion()).toBe(0);
  });

  it("disables recording over a store a newer version wrote, leaving it byte-identical", () => {
    replaceStore("CREATE TABLE future (id INTEGER); PRAGMA user_version = 2");
    const bytes = fs.readFileSync(storeFile());
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      backupStore.record(path.join(root, "sample.md"), Buffer.from("x"));
      backupStore.record(path.join(root, "sample.md"), Buffer.from("y"));
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/newer version of BigMouth/);
    } finally {
      warnSpy.mockRestore();
    }
    backupStore.closeBackupStore();
    expect(fs.readFileSync(storeFile()).equals(bytes)).toBe(true);
  });
});
