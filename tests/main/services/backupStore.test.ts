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
import { closeBackupStore, drainBackups, record, recordFile, stopBackups } from "@main/core/services/backupStore.js";
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

  it("refuses a store from before sessions without changing its bytes, columns or earlier history", async () => {
    const file = path.join(root, "doc.md");
    const db = new DatabaseSync(storeFile());
    db.exec(`CREATE TABLE backups (id INTEGER PRIMARY KEY, path TEXT NOT NULL, content BLOB NOT NULL,
      content_sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, written_at_utc TEXT NOT NULL); PRAGMA user_version = 1`);
    db.prepare("INSERT INTO backups (path, content, content_sha256, byte_size, written_at_utc) VALUES (?, ?, 'x', 3, '2026-01-01T00:00:00.000Z')")
      .run(file, Buffer.from("old"));
    const columnsBefore = db.prepare("PRAGMA table_info(backups)").all();
    const schemaBefore = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
    db.close();
    const bytesBefore = fs.readFileSync(storeFile());
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      record(file, Buffer.from("new"));
      expect(drainBackups(5000)).toBe(true);
      record(file, Buffer.from("still not recorded"));
      expect(drainBackups(5000)).toBe(true);
      closeBackupStore();
      await vi.waitFor(() => expect(warn.mock.calls.filter(([message]) => /could not be opened/.test(message))).toHaveLength(1));
      expect(fs.readFileSync(storeFile())).toEqual(bytesBefore);
      const check = new DatabaseSync(storeFile());
      try {
        expect(check.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
        expect(check.prepare("PRAGMA table_info(backups)").all()).toEqual(columnsBefore);
        expect(check.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all()).toEqual(schemaBefore);
        const kept = check.prepare("SELECT path, content FROM backups").all() as Array<{ path: string; content: Uint8Array }>;
        expect(kept.map((row) => [row.path, Buffer.from(row.content).toString("utf8")])).toEqual([[file, "old"]]);
      } finally { check.close(); }
    } finally { warn.mockRestore(); }
  });
});

// An installed attachment the app never held whole is read from disk by the recorder.
describe("a file recorded from disk", () => {
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  /** Holds the store's write lock, so a hand-off waits until `release` while the test acts. */
  const holdStore = () => {
    record(path.join(root, "opens-the-store.md"), Buffer.from("opens the store"));
    expect(drainBackups(5000)).toBe(true);
    const locker = new DatabaseSync(storeFile());
    locker.exec("BEGIN EXCLUSIVE");
    return () => { locker.exec("COMMIT"); locker.close(); };
  };

  it("keeps the file's exact bytes in one value", () => {
    const file = path.join(root, "photo.bin");
    const bytes = Buffer.from("an attachment");
    fs.writeFileSync(file, bytes);
    recordFile(file, fs.openSync(file, "r"), sha(bytes), bytes.length);
    const [row] = rows(file);
    expect(row!.byte_size).toBe(bytes.length);
    expect(row!.content_sha256).toBe(sha(bytes));
    expect(Buffer.from(row!.content).equals(bytes)).toBe(true);
  });

  it("records the bytes installed even when the file is replaced and deleted before the recorder reads it", () => {
    const file = path.join(root, "photo.bin");
    const original = Buffer.from("the installed bytes");
    fs.writeFileSync(file, original);
    const release = holdStore();
    try {
      recordFile(file, fs.openSync(file, "r"), sha(original), original.length);
      const replacement = path.join(root, "replacement.bin");
      fs.writeFileSync(replacement, "a different file put in its place");
      fs.renameSync(replacement, file);
      fs.rmSync(file);
    } finally { release(); }
    const [row] = rows(file);
    expect(row!.content_sha256).toBe(sha(original));
    expect(Buffer.from(row!.content).equals(original)).toBe(true);
  });

  it("records nothing when the installed file is rewritten in place before the recorder reads it", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const file = path.join(root, "photo.bin");
    const original = Buffer.from("the installed bytes");
    fs.writeFileSync(file, original);
    const release = holdStore();
    try {
      recordFile(file, fs.openSync(file, "r"), sha(original), original.length);
      fs.writeFileSync(file, "the same inode, other bytes");
    } finally { release(); }
    try {
      expect(rows(file)).toEqual([]);
      // The warning reaches this thread as a message once the wait above ends.
      await vi.waitFor(() => {
        expect(warn.mock.calls.filter(([message]) => /changed on disk before it was recorded/.test(message))).toHaveLength(1);
      });
    } finally { warn.mockRestore(); }
  });

  it("writes nothing for a file equal to the path's row from this session", () => {
    const file = path.join(root, "photo.bin");
    const bytes = Buffer.from("once");
    fs.writeFileSync(file, bytes);
    recordFile(file, fs.openSync(file, "r"), sha(bytes), bytes.length);
    const [first] = rows(file);
    recordFile(file, fs.openSync(file, "r"), sha(bytes), bytes.length);
    expect(rows(file)).toEqual([first]);
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
      const wait = vi.spyOn(Atomics, "wait");
      try {
        record(file, Buffer.from("while locked"));
        expect(wait).not.toHaveBeenCalled();
      } finally { wait.mockRestore(); }
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

  it("refuses a current-version backups table with a missing required column without changing history", async () => {
    const db = new DatabaseSync(storeFile());
    db.exec(`CREATE TABLE backups (id INTEGER PRIMARY KEY, session_id TEXT, path TEXT NOT NULL, content BLOB NOT NULL,
      content_sha256 TEXT NOT NULL, written_at_utc TEXT NOT NULL);
      PRAGMA user_version = 2`);
    db.prepare(`INSERT INTO backups (session_id, path, content, content_sha256, written_at_utc)
      VALUES ('earlier', 'kept.md', ?, 'x', '2026-01-01T00:00:00.000Z')`).run(Buffer.from("old"));
    const schemaBefore = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
    const historyBefore = db.prepare("SELECT * FROM backups").all();
    db.close();
    const bytesBefore = fs.readFileSync(storeFile());
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      record(path.join(root, "doc.md"), Buffer.from("not recorded"));
      expect(drainBackups(5000)).toBe(true);
      closeBackupStore();
      await vi.waitFor(() => expect(warn.mock.calls.filter(([message]) => /could not be opened/.test(message))).toHaveLength(1));
      expect(fs.readFileSync(storeFile())).toEqual(bytesBefore);
      const check = new DatabaseSync(storeFile());
      try {
        expect(check.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
        expect(check.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all()).toEqual(schemaBefore);
        expect(check.prepare("SELECT * FROM backups").all()).toEqual(historyBefore);
      } finally { check.close(); }
    } finally { warn.mockRestore(); }
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
    const { installAsset, assetDir, stagingDir } = await import("@main/core/services/assetStore.js");
    const ws = createWorkspace("Asset WS");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    fs.mkdirSync(stagingDir(ws.dataDirectory), { recursive: true });
    fs.writeFileSync(path.join(stagingDir(ws.dataDirectory), "upload.part"), bytes);
    const staged = { name: "upload.part", sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
    installAsset(ws.dataDirectory, "post-1", "a.png", staged, { filename: "a.png", size: 6, uploadedAt: "2026-10-09T00:00:00.000Z" });
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
