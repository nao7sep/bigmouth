// Pins the data-backup history (data-backup-conventions), recorded on its own thread. Each test
// relocates BIGMOUTH_DATA_DIR to a throwaway root; `rows` first waits for the recorder to apply every
// write already handed to it, then reads the store through a separate handle.
//
// What is pinned:
//   - content is a BLOB of the exact bytes written, so a CR/LF pair and a non-UTF-8 byte round-trip.
//   - one row per path per session: later saves in the session replace it, and a first save equal to
//     the path's latest row from an earlier session writes nothing.
//   - recording never holds up the save: record returns while the store is locked, and quit can skip
//     pending writes or give them a bound.
//   - which writes are protected: posts, the registry, settings, attachments and their meta.json; not
//     the post index or view state.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { initAppDir } from "@main/core/services/workspaceStore.js";
import { getAppRoot, getStateJsonPath } from "@main/core/services/storagePaths.js";
import { writeManagedText } from "@main/core/shared/atomicWrite.js";
import { closeBackupStore, drainBackups, record, stopBackups, useBackupPartSize } from "@main/core/services/backupStore.js";
import * as logger from "@main/core/services/logger.js";
import { initStateStore, updateUiState } from "@main/core/services/stateStore.js";

const SAVED_HOME = process.env.BIGMOUTH_DATA_DIR;
let root: string;

interface Row {
  id: number;
  session_id: string | null;
  path: string;
  content: Uint8Array;
  content_sha256: string;
  byte_size: number;
  written_at_utc: string;
}

function storeFile(): string {
  return path.join(getAppRoot(), "backups.sqlite3");
}

/** Every row for a path, oldest first, once the recorder has applied what it was handed. */
function rows(forPath: string): Row[] {
  expect(drainBackups(5000)).toBe(true);
  if (!fs.existsSync(storeFile())) return [];
  const db = new DatabaseSync(storeFile());
  try {
    return db.prepare("SELECT * FROM backups WHERE path = ? ORDER BY id ASC").all(forPath) as unknown as Row[];
  } finally {
    db.close();
  }
}

function text(row: Row): string {
  return Buffer.from(row.content).toString("utf8");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-backupstore-"));
  process.env.BIGMOUTH_DATA_DIR = root;
  initAppDir();
  // initAppDir records the new registry; each test starts from an empty store.
  closeBackupStore();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(storeFile() + suffix, { force: true });
});

afterEach(() => {
  // closeBackupStore() runs in the shared teardown (tests/main/setup.ts) before this.
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_DATA_DIR;
  else process.env.BIGMOUTH_DATA_DIR = SAVED_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("byte fidelity", () => {
  it("stores the exact bytes written, preserving a CR/LF pair and a non-UTF-8 byte", () => {
    const file = path.join(root, "doc.md");
    const bytes = Buffer.from([0x61, 0x0d, 0x0a, 0xff, 0x62]);
    record(file, bytes);
    const [row] = rows(file);
    expect(Buffer.from(row!.content).equals(bytes)).toBe(true);
    expect(row!.content_sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(row!.byte_size).toBe(5);
    expect(row!.written_at_utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("records a managed text write byte-identically after it lands", () => {
    const file = path.join(root, "doc.md");
    writeManagedText(file, "line one\r\nline two\n");
    expect(text(rows(file)[0]!)).toBe("line one\r\nline two\n");
  });

  it("keeps its own copy, so the caller may reuse its buffer", () => {
    const file = path.join(root, "doc.md");
    const bytes = Buffer.from("first");
    record(file, bytes);
    bytes.write("XXXXX");
    expect(text(rows(file)[0]!)).toBe("first");
  });
});

describe("one row per path per session", () => {
  it("replaces the session's row on a later save and skips an unchanged one", () => {
    const file = path.join(root, "doc.md");
    record(file, Buffer.from("one"));
    record(file, Buffer.from("two"));
    record(file, Buffer.from("two"));
    const all = rows(file);
    expect(all).toHaveLength(1);
    expect(text(all[0]!)).toBe("two");
    expect(all[0]!.session_id).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("keeps each path's row separately", () => {
    const a = path.join(root, "a.md");
    const b = path.join(root, "b.md");
    record(a, Buffer.from("a"));
    record(b, Buffer.from("b"));
    expect(rows(a).map(text)).toEqual(["a"]);
    expect(rows(b).map(text)).toEqual(["b"]);
  });

  it("writes nothing for a first save equal to an earlier session's latest row, and a new row otherwise", () => {
    const same = path.join(root, "same.md");
    const changed = path.join(root, "changed.md");
    record(same, Buffer.from("seed"));
    rows(same);
    // Turn this session's rows into an earlier session's.
    closeBackupStore();
    const db = new DatabaseSync(storeFile());
    db.exec("UPDATE backups SET session_id = 'earlier'");
    db.prepare("INSERT INTO backups (session_id, path, content, content_sha256, byte_size, written_at_utc) VALUES ('earlier', ?, ?, ?, 4, '2026-01-01T00:00:00.000Z')")
      .run(changed, Buffer.from("old!"), createHash("sha256").update("old!").digest("hex"));
    db.close();

    record(same, Buffer.from("seed"));
    record(changed, Buffer.from("new!"));
    expect(rows(same).map((row) => row.session_id)).toEqual(["earlier"]);
    expect(rows(changed).map(text)).toEqual(["old!", "new!"]);
  });

  it("gives a store from before sessions the session column and keeps its rows as earlier history", () => {
    const file = path.join(root, "doc.md");
    const db = new DatabaseSync(storeFile());
    db.exec(`CREATE TABLE backups (id INTEGER PRIMARY KEY, path TEXT NOT NULL, content BLOB NOT NULL,
      content_sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, written_at_utc TEXT NOT NULL); PRAGMA user_version = 1`);
    db.prepare("INSERT INTO backups (path, content, content_sha256, byte_size, written_at_utc) VALUES (?, ?, 'x', 3, '2026-01-01T00:00:00.000Z')")
      .run(file, Buffer.from("old"));
    db.close();

    record(file, Buffer.from("new"));
    const all = rows(file);
    expect(all.map((row) => [row.session_id, text(row)])).toEqual([[null, "old"], [all[1]!.session_id, "new"]]);
    const check = new DatabaseSync(storeFile());
    expect(check.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    check.close();
  });
});

describe("files larger than one value", () => {
  afterEach(() => useBackupPartSize(256 * 1024 * 1024));

  it("keeps a large file in parts that join to its exact bytes, and replaces them on a later save", () => {
    useBackupPartSize(4);
    const file = path.join(root, "big.bin");
    const first = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    record(file, first);
    const [row] = rows(file);
    expect(Buffer.from(row!.content).byteLength).toBe(0);
    expect(row!.byte_size).toBe(10);
    expect(row!.content_sha256).toBe(createHash("sha256").update(first).digest("hex"));
    const parts = () => {
      const db = new DatabaseSync(storeFile());
      try {
        return db.prepare("SELECT part, content FROM backup_parts WHERE backup_id = ? ORDER BY part").all(row!.id) as { part: number; content: Uint8Array }[];
      } finally { db.close(); }
    };
    expect(Buffer.concat(parts().map((part) => Buffer.from(part.content))).equals(first)).toBe(true);
    expect(parts().map((part) => part.part)).toEqual([0, 1, 2]);

    // A later save in the session that fits one value drops the parts.
    record(file, Buffer.from("tiny"));
    const [after] = rows(file);
    expect(Buffer.from(after!.content).toString()).toBe("tiny");
    expect(parts()).toEqual([]);
  });
});

describe("never holds up the save", () => {
  it("returns while the store is locked, and applies the write once it is free", () => {
    const file = path.join(root, "doc.md");
    record(file, Buffer.from("opens the store"));
    rows(file);
    const locker = new DatabaseSync(storeFile());
    locker.exec("BEGIN EXCLUSIVE");
    try {
      const started = Date.now();
      record(file, Buffer.from("while locked"));
      expect(Date.now() - started).toBeLessThan(100);
      expect(drainBackups(100)).toBe(false);
    } finally {
      locker.exec("COMMIT");
      locker.close();
    }
    expect(rows(file).map(text)).toEqual(["while locked"]);
  });

  it("gives pending writes a bound at quit", () => {
    const file = path.join(root, "doc.md");
    record(file, Buffer.from("drained at quit"));
    stopBackups(5000);
    expect(rows(file).map(text)).toEqual(["drained at quit"]);
  });

  it("does not wait for pending writes at OS session end", () => {
    record(path.join(root, "doc.md"), Buffer.from("pending"));
    expect(drainBackups(5000)).toBe(true);
    const wait = vi.spyOn(Atomics, "wait");
    try {
      stopBackups(0);
      expect(wait).not.toHaveBeenCalled();
    } finally {
      wait.mockRestore();
    }
  });
});

describe("best effort", () => {
  it("disables recording for the session with one warn when the store cannot open, and never throws", async () => {
    fs.mkdirSync(storeFile());
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const file = path.join(root, "doc.md");
      writeManagedText(file, "saved anyway");
      writeManagedText(file, "saved again");
      expect(drainBackups(5000)).toBe(true);
      expect(fs.readFileSync(file, "utf8")).toBe("saved again");
      // The warning reaches this thread as a message once the wait above ends.
      await vi.waitFor(() => {
        expect(warn.mock.calls.filter(([message]) => /could not be opened/.test(message))).toHaveLength(1);
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("leaves a store a newer version wrote byte-identical and records nothing", () => {
    const db = new DatabaseSync(storeFile());
    db.exec("CREATE TABLE future (id INTEGER); PRAGMA user_version = 3");
    db.close();
    const before = fs.readFileSync(storeFile());
    record(path.join(root, "doc.md"), Buffer.from("not recorded"));
    expect(drainBackups(5000)).toBe(true);
    closeBackupStore();
    expect(fs.readFileSync(storeFile()).equals(before)).toBe(true);
  });
});

describe("protected writes", () => {
  it("records the workspace registry on create and config only on its first edit", async () => {
    const { createWorkspace } = await import("@main/core/services/workspaceStore.js");
    const ws = createWorkspace("Recorded WS");
    const registry = rows(path.join(root, "workspaces.json"));
    // One row for the session, holding its latest version.
    expect(registry).toHaveLength(1);
    expect(text(registry[0]!)).toContain("Recorded WS");

    expect(rows(path.join(ws.dataDirectory, "config.json"))).toHaveLength(0);
    const { saveSettings, getSettings } = await import("@main/core/services/configStore.js");
    saveSettings(ws.dataDirectory, { ...getSettings(ws.dataDirectory), uiFontFamily: "Inter" });
    expect(rows(path.join(ws.dataDirectory, "config.json"))).toHaveLength(1);
  });

  it("records a post file, keeping its latest version for the session", async () => {
    const { createWorkspace } = await import("@main/core/services/workspaceStore.js");
    const { createPost, updatePost, clearCache } = await import("@main/core/services/postStore.js");
    const ws = createWorkspace("Post WS");
    const post = createPost(ws.dataDirectory, "blogger", "en");
    expect(rows(post.filePath)).toHaveLength(1);
    updatePost(ws.dataDirectory, post.frontMatter.id, { content: "a genuinely new body" });
    const all = rows(post.filePath);
    expect(all).toHaveLength(1);
    expect(text(all[0]!)).toContain("a genuinely new body");
    clearCache(ws.dataDirectory);
  });

  it("records an attachment's bytes and its meta.json, so a deleted post's attachments can be restored", async () => {
    const { createWorkspace } = await import("@main/core/services/workspaceStore.js");
    const { saveAssetFile, assetDir } = await import("@main/core/services/assetStore.js");
    const ws = createWorkspace("Asset WS");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    saveAssetFile(ws.dataDirectory, "post-1", "a.png", bytes, { filename: "a.png", size: 6, uploadedAt: "2026-10-09T00:00:00.000Z" });
    const dir = assetDir(ws.dataDirectory, "post-1");
    expect(Buffer.from(rows(path.join(dir, "a.png"))[0]!.content).equals(bytes)).toBe(true);
    expect(text(rows(path.join(dir, "meta.json"))[0]!)).toContain("2026-10-09T00:00:00.000Z");
  });

  it("does not record view state", () => {
    initStateStore();
    updateUiState({ paneLeftWidth: 401 });
    expect(JSON.parse(fs.readFileSync(getStateJsonPath(), "utf-8")).paneLeftWidth).toBe(401);
    expect(rows(getStateJsonPath())).toHaveLength(0);
  });

  it("does not record the post index", async () => {
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
