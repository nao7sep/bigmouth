// Proves the single storage-root resolution in storagePaths.ts:
//   - BIGMOUTH_DATA_DIR set   → the whole ~/.bigmouth root relocates under it
//   - BIGMOUTH_DATA_DIR unset → the root defaults to <home>/.bigmouth
//   - a relative BIGMOUTH_DATA_DIR resolves against the home directory, never the cwd
// Relocation is driven through the BIGMOUTH_DATA_DIR environment variable — the one
// supported relocation seam — never a private setter.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initAppDir, createWorkspace } from "@main/core/services/workspaceStore.js";
import { stopBackups } from "@main/core/services/backupStore.js";
import {
  getApiKeysPath,
  getAppRoot,
  getBackupsDbPath,
  getLogsDir,
  getStateJsonPath,
  getThumbnailsDir,
  getWorkspacesJsonPath,
  expandWorkspacePath,
  getDefaultWorkspaceDirectory,
  initStorageRoot,
  setDocumentsDirectory,
} from "@main/core/services/storagePaths.js";

const SAVED_DATA_DIR = process.env.BIGMOUTH_DATA_DIR;
const SAVED_TEST_BASE = process.env.BIGMOUTH_TEST_BASE;
const SAVED_TEST_UNSET = process.env.BIGMOUTH_TEST_UNSET;
let fakeHome: string;

function removeTestTree(tree: string): void {
  stopBackups(true);
  fs.rmSync(tree, { recursive: true, force: true });
}

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-fake-home-"));
  vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
  delete process.env.BIGMOUTH_DATA_DIR;
  delete process.env.BIGMOUTH_TEST_BASE;
  delete process.env.BIGMOUTH_TEST_UNSET;
});

afterEach(() => {
  if (SAVED_DATA_DIR === undefined) delete process.env.BIGMOUTH_DATA_DIR;
  else process.env.BIGMOUTH_DATA_DIR = SAVED_DATA_DIR;
  if (SAVED_TEST_BASE === undefined) delete process.env.BIGMOUTH_TEST_BASE;
  else process.env.BIGMOUTH_TEST_BASE = SAVED_TEST_BASE;
  if (SAVED_TEST_UNSET === undefined) delete process.env.BIGMOUTH_TEST_UNSET;
  else process.env.BIGMOUTH_TEST_UNSET = SAVED_TEST_UNSET;
  vi.restoreAllMocks();
  removeTestTree(fakeHome);
});

describe("storage root (BIGMOUTH_DATA_DIR)", () => {
  it("relocates the whole root under BIGMOUTH_DATA_DIR when set", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-home-"));
    try {
      process.env.BIGMOUTH_DATA_DIR = root;
      initAppDir();
      expect(getLogsDir()).toBe(path.join(root, "logs"));
      expect(fs.existsSync(path.join(root, "logs"))).toBe(true);
      expect(fs.existsSync(path.join(root, "workspaces.json"))).toBe(true);
    } finally {
      removeTestTree(root);
    }
  });

  it("keeps the workspace registry in workspaces.json under the storage root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-registry-"));
    try {
      process.env.BIGMOUTH_DATA_DIR = root;
      initAppDir();
      // The registry is created on first init, and a write (adding a workspace)
      // persists to the same file.
      expect(fs.existsSync(path.join(root, "workspaces.json"))).toBe(true);
      createWorkspace("Registry WS");

      const parsed = JSON.parse(fs.readFileSync(path.join(root, "workspaces.json"), "utf-8"));
      expect(Array.isArray(parsed.workspaces)).toBe(true);
      expect(parsed.workspaces).toHaveLength(1);
    } finally {
      removeTestTree(root);
    }
  });

  it("defaults the root to <home>/.bigmouth when BIGMOUTH_DATA_DIR is unset", () => {
    initAppDir();
    expect(getLogsDir()).toBe(path.join(os.homedir(), ".bigmouth", "logs"));
  });

  it("resolves a relative BIGMOUTH_DATA_DIR against the home directory, never the cwd", () => {
    const rel = ".bigmouth-test-relative";
    const expected = path.join(os.homedir(), rel);
    try {
      process.env.BIGMOUTH_DATA_DIR = rel;
      initAppDir();
      expect(getLogsDir()).toBe(path.join(expected, "logs"));
      expect(getLogsDir()).not.toBe(path.join(process.cwd(), rel, "logs"));
    } finally {
      removeTestTree(expected);
    }
  });

  // A Windows user types ~\ as readily as ~/; either expands on every OS.
  it.each(["~/", "~\\"])("expands a leading %s in BIGMOUTH_DATA_DIR against the home directory", (prefix) => {
    const expected = path.join(os.homedir(), ".bigmouth-test-tilde");
    try {
      process.env.BIGMOUTH_DATA_DIR = `${prefix}.bigmouth-test-tilde`;
      initAppDir();
      expect(getLogsDir()).toBe(path.join(expected, "logs"));
      expect(fs.existsSync(path.join(expected, "logs"))).toBe(true);
    } finally {
      removeTestTree(expected);
    }
  });

  it("expands a $VAR reference in BIGMOUTH_DATA_DIR", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-var-"));
    const expected = path.join(base, "root");
    try {
      process.env.BIGMOUTH_TEST_BASE = base;
      process.env.BIGMOUTH_DATA_DIR = "$BIGMOUTH_TEST_BASE/root";
      initAppDir();
      expect(getLogsDir()).toBe(path.join(expected, "logs"));
      expect(fs.existsSync(path.join(expected, "logs"))).toBe(true);
    } finally {
      removeTestTree(base);
    }
  });

  it("expands a %VAR% reference in BIGMOUTH_DATA_DIR", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-pctvar-"));
    const expected = path.join(base, "root");
    try {
      process.env.BIGMOUTH_TEST_BASE = base;
      process.env.BIGMOUTH_DATA_DIR = "%BIGMOUTH_TEST_BASE%/root";
      initAppDir();
      expect(getLogsDir()).toBe(path.join(expected, "logs"));
      expect(fs.existsSync(path.join(expected, "logs"))).toBe(true);
    } finally {
      removeTestTree(base);
    }
  });

  it("throws the startup error when BIGMOUTH_DATA_DIR resolves to an unusable root", () => {
    // Point the root at a regular file: mkdirSync over an existing file fails,
    // and the resolver must surface that loudly rather than fall back to the
    // default ~/.bigmouth.
    const file = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-badroot-"));
    const filePath = path.join(file, "not-a-dir");
    fs.writeFileSync(filePath, "i am a file, not a directory");
    try {
      process.env.BIGMOUTH_DATA_DIR = filePath;
      expect(() => initAppDir()).toThrow(/Cannot use the bigmouth storage root/);
    } finally {
      removeTestTree(file);
    }
  });

  // Both of these guard the same hazard: an env reference that leaves
  // BIGMOUTH_DATA_DIR expanding to nothing must be a hard startup error, never a
  // silent path.resolve(home, "") collapse onto the bare home directory —
  // which would otherwise materialize config.json/logs/backups/ directly in
  // $HOME and walk $HOME as the backup root.
  it("throws a startup error naming BIGMOUTH_DATA_DIR when it references an unset $VAR", () => {
    delete process.env.BIGMOUTH_TEST_UNSET;
    process.env.BIGMOUTH_DATA_DIR = "$BIGMOUTH_TEST_UNSET";
    expect(() => initAppDir()).toThrow(/BIGMOUTH_DATA_DIR/);
    expect(() => initAppDir()).toThrow(/expands to an empty path/);
  });

  it("throws a startup error naming BIGMOUTH_DATA_DIR when it references a %VAR% set to the empty string", () => {
    process.env.BIGMOUTH_TEST_BASE = "";
    process.env.BIGMOUTH_DATA_DIR = "%BIGMOUTH_TEST_BASE%";
    expect(() => initAppDir()).toThrow(/BIGMOUTH_DATA_DIR/);
    expect(() => initAppDir()).toThrow(/expands to an empty path/);
  });

  it("does not create anything under the bare home directory when BIGMOUTH_DATA_DIR collapses to empty", () => {
    // This combination must throw rather than resolve to os.homedir() itself.
    process.env.BIGMOUTH_TEST_BASE = "";
    process.env.BIGMOUTH_DATA_DIR = "$BIGMOUTH_TEST_BASE";
    const before = fs.existsSync(path.join(os.homedir(), "workspaces.json"));
    expect(() => initAppDir()).toThrow();
    expect(fs.existsSync(path.join(os.homedir(), "workspaces.json"))).toBe(before);
  });
});

describe("the default workspace folder", () => {
  it("is Documents/BigMouth in the home directory, whichever root BIGMOUTH_DATA_DIR picks", () => {
    // A workspace is the user's document: the storage-root override moves the
    // app's own files, never where new workspaces are kept.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-default-ws-"));
    try {
      process.env.BIGMOUTH_DATA_DIR = root;
      initAppDir();
      expect(getDefaultWorkspaceDirectory()).toBe(path.join(fakeHome, "Documents", "BigMouth"));
      const workspace = createWorkspace("Default WS");
      expect(workspace.dataDirectory).toBe(path.join(fakeHome, "Documents", "BigMouth"));
      expect(fs.readdirSync(root)).not.toContain("workspaces");
    } finally {
      removeTestTree(root);
    }
  });

  it("follows the Documents folder the OS reports, even one moved out of the home directory", () => {
    // Windows lets the user, or OneDrive, move Documents; Electron's
    // app.getPath("documents") reports where it is now.
    const moved = path.join(os.tmpdir(), "OneDrive", "Documents");
    setDocumentsDirectory(moved);
    try {
      expect(getDefaultWorkspaceDirectory()).toBe(path.join(moved, "BigMouth"));
    } finally {
      setDocumentsDirectory(null);
    }
    expect(getDefaultWorkspaceDirectory()).toBe(path.join(fakeHome, "Documents", "BigMouth"));
  });
});

describe("workspace paths are cwd-independent", () => {
  it("resolves a relative workspace dataDirectory under the home root, not the cwd", () => {
    const rel = "my-relative-workspace";
    // Exercise the resolver directly: a regression test must never create and
    // recursively delete a fixed name under the user's real home directory.
    const resolved = expandWorkspacePath(rel);
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved).toBe(path.join(os.homedir(), rel));
    expect(resolved).not.toBe(path.join(process.cwd(), rel));
  });

  it("keeps an unset $VAR literal in a workspace directory", () => {
    delete process.env.BIGMOUTH_TEST_UNSET;
    expect(expandWorkspacePath("$BIGMOUTH_TEST_UNSET")).toBe(
      path.join(os.homedir(), "$BIGMOUTH_TEST_UNSET"),
    );
  });

  it("does not expand environment syntax inside an absolute native-picker path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-ws-empty-"));
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-ws-literal-"));
    const literal = path.join(parent, "$BIGMOUTH_TEST_BASE", "%BIGMOUTH_TEST_BASE%");
    try {
      process.env.BIGMOUTH_DATA_DIR = root;
      initAppDir();
      process.env.BIGMOUTH_TEST_BASE = "secret-main-process-value";
      const workspace = createWorkspace("Literal WS", literal);
      expect(workspace.dataDirectory).toBe(literal);
      expect(workspace.dataDirectory).not.toContain("secret-main-process-value");
    } finally {
      removeTestTree(root);
      removeTestTree(parent);
    }
  });

  it.skipIf(process.platform === "win32")("preserves leading and trailing spaces in a native-picker directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-ws-space-home-"));
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-ws-space-parent-"));
    const literal = path.join(parent, " Workspace ");
    const trimmedSibling = path.join(parent, "Workspace");
    try {
      fs.mkdirSync(literal);
      process.env.BIGMOUTH_DATA_DIR = root;
      initAppDir();

      const workspace = createWorkspace("Literal spaces", literal);

      expect(workspace.dataDirectory).toBe(literal);
      expect(fs.existsSync(path.join(literal, "config.json"))).toBe(false);
      expect(fs.existsSync(trimmedSibling)).toBe(false);
    } finally {
      removeTestTree(root);
      removeTestTree(parent);
    }
  });
});

// The module owns every standard subpath name, so two derivations of one file
// cannot drift.
describe("standard subpaths", () => {
  it("names every store under the resolved root", () => {
    const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-paths-"));
    process.env.BIGMOUTH_DATA_DIR = storageRoot;

    initStorageRoot();

    expect(getAppRoot()).toBe(storageRoot);
    expect(getWorkspacesJsonPath()).toBe(path.join(storageRoot, "workspaces.json"));
    expect(getLogsDir()).toBe(path.join(storageRoot, "logs"));
    expect(getApiKeysPath()).toBe(path.join(storageRoot, "api-keys.json"));
    expect(getStateJsonPath()).toBe(path.join(storageRoot, "state.json"));
    expect(getBackupsDbPath()).toBe(path.join(storageRoot, "backups.sqlite3"));
    expect(getThumbnailsDir()).toBe(path.join(storageRoot, "thumbnails"));

    removeTestTree(storageRoot);
  });

  it.skipIf(process.platform === "win32")(
    "creates a fresh root as owner-only (0700)",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-perm-fresh-"));
      const root = path.join(home, ".bigmouth");
      process.env.BIGMOUTH_DATA_DIR = root;

      initStorageRoot();

      expect(fs.statSync(root).mode & 0o777).toBe(0o700);
      removeTestTree(home);
    },
  );

  it.skipIf(process.platform === "win32")(
    "tightens an existing broader root (0755) to 0700 at launch",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-perm-existing-"));
      const root = path.join(home, ".bigmouth");
      fs.mkdirSync(root, { mode: 0o755 });
      expect(fs.statSync(root).mode & 0o777).toBe(0o755);
      process.env.BIGMOUTH_DATA_DIR = root;

      initStorageRoot();

      expect(fs.statSync(root).mode & 0o777).toBe(0o700);
      removeTestTree(home);
    },
  );

  it("resolves without the workspace registry, which is what broke the import cycle", () => {
    // core/shared/atomicWrite reaches into backupStore; were backupStore to reach
    // into the REGISTRY for the root, the registry would reach back into
    // atomicWrite, a cycle that survives only because ESM hoists function
    // declarations. initStorageRoot standing alone — no initAppDir, no
    // workspaces.json — is that cycle's absence, stated as a behaviour.
    const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-paths-"));
    process.env.BIGMOUTH_DATA_DIR = storageRoot;

    initStorageRoot();

    expect(getBackupsDbPath()).toBe(path.join(storageRoot, "backups.sqlite3"));
    expect(fs.existsSync(path.join(storageRoot, "workspaces.json"))).toBe(false);

    removeTestTree(storageRoot);
  });
});
