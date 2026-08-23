// Proves the single storage-root resolution in storagePaths.ts:
//   - BIGMOUTH_HOME set   → the whole ~/.bigmouth root relocates under it
//   - BIGMOUTH_HOME unset → the root defaults to <home>/.bigmouth
//   - a relative BIGMOUTH_HOME resolves against the home directory, never the cwd
// Relocation is driven through the BIGMOUTH_HOME environment variable — the one
// supported relocation seam — never a private setter.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initAppDir, createWorkspace } from "@main/core/services/workspaceStore.js";
import { closeBackupStore } from "@main/core/services/backupStore.js";
import {
  getApiKeysPath,
  getAppRoot,
  getBackupsDbPath,
  getLogsDir,
  getStateJsonPath,
  getWorkspacesJsonPath,
  expandWorkspacePath,
  initStorageRoot,
} from "@main/core/services/storagePaths.js";

const SAVED_HOME = process.env.BIGMOUTH_HOME;
const SAVED_TEST_BASE = process.env.BIGMOUTH_TEST_BASE;
const SAVED_TEST_UNSET = process.env.BIGMOUTH_TEST_UNSET;
let fakeHome: string;

function removeTestTree(tree: string): void {
  closeBackupStore();
  fs.rmSync(tree, { recursive: true, force: true });
}

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-fake-home-"));
  vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
  delete process.env.BIGMOUTH_HOME;
  delete process.env.BIGMOUTH_TEST_BASE;
  delete process.env.BIGMOUTH_TEST_UNSET;
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_HOME;
  else process.env.BIGMOUTH_HOME = SAVED_HOME;
  if (SAVED_TEST_BASE === undefined) delete process.env.BIGMOUTH_TEST_BASE;
  else process.env.BIGMOUTH_TEST_BASE = SAVED_TEST_BASE;
  if (SAVED_TEST_UNSET === undefined) delete process.env.BIGMOUTH_TEST_UNSET;
  else process.env.BIGMOUTH_TEST_UNSET = SAVED_TEST_UNSET;
  vi.restoreAllMocks();
  removeTestTree(fakeHome);
});

describe("storage root (BIGMOUTH_HOME)", () => {
  it("relocates the whole root under BIGMOUTH_HOME when set", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-home-"));
    try {
      process.env.BIGMOUTH_HOME = root;
      initAppDir();
      expect(getLogsDir()).toBe(path.join(root, "logs"));
      expect(fs.existsSync(path.join(root, "logs"))).toBe(true);
      expect(fs.existsSync(path.join(root, "workspaces.json"))).toBe(true);
    } finally {
      removeTestTree(root);
    }
  });

  it("names the workspace registry workspaces.json, never the old app.json", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-registry-"));
    try {
      process.env.BIGMOUTH_HOME = root;
      initAppDir();
      // The registry is created on first init and must land at workspaces.json.
      expect(fs.existsSync(path.join(root, "workspaces.json"))).toBe(true);
      expect(fs.existsSync(path.join(root, "app.json"))).toBe(false);

      // A write (adding a workspace) must persist to the same workspaces.json,
      // and must not resurrect an app.json under any code path.
      createWorkspace("Registry WS");
      expect(fs.existsSync(path.join(root, "workspaces.json"))).toBe(true);
      expect(fs.existsSync(path.join(root, "app.json"))).toBe(false);

      const parsed = JSON.parse(fs.readFileSync(path.join(root, "workspaces.json"), "utf-8"));
      expect(Array.isArray(parsed.workspaces)).toBe(true);
      expect(parsed.workspaces).toHaveLength(1);
    } finally {
      removeTestTree(root);
    }
  });

  it("defaults the root to <home>/.bigmouth when BIGMOUTH_HOME is unset", () => {
    initAppDir();
    expect(getLogsDir()).toBe(path.join(os.homedir(), ".bigmouth", "logs"));
  });

  it("resolves a relative BIGMOUTH_HOME against the home directory, never the cwd", () => {
    const rel = ".bigmouth-test-relative";
    const expected = path.join(os.homedir(), rel);
    try {
      process.env.BIGMOUTH_HOME = rel;
      initAppDir();
      expect(getLogsDir()).toBe(path.join(expected, "logs"));
      expect(getLogsDir()).not.toBe(path.join(process.cwd(), rel, "logs"));
    } finally {
      removeTestTree(expected);
    }
  });

  it("expands a leading ~ in BIGMOUTH_HOME against the home directory", () => {
    const expected = path.join(os.homedir(), ".bigmouth-test-tilde");
    try {
      process.env.BIGMOUTH_HOME = "~/.bigmouth-test-tilde";
      initAppDir();
      expect(getLogsDir()).toBe(path.join(expected, "logs"));
      expect(fs.existsSync(path.join(expected, "logs"))).toBe(true);
    } finally {
      removeTestTree(expected);
    }
  });

  it("expands a $VAR reference in BIGMOUTH_HOME", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-var-"));
    const expected = path.join(base, "root");
    try {
      process.env.BIGMOUTH_TEST_BASE = base;
      process.env.BIGMOUTH_HOME = "$BIGMOUTH_TEST_BASE/root";
      initAppDir();
      expect(getLogsDir()).toBe(path.join(expected, "logs"));
      expect(fs.existsSync(path.join(expected, "logs"))).toBe(true);
    } finally {
      removeTestTree(base);
    }
  });

  it("expands a %VAR% reference in BIGMOUTH_HOME", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-pctvar-"));
    const expected = path.join(base, "root");
    try {
      process.env.BIGMOUTH_TEST_BASE = base;
      process.env.BIGMOUTH_HOME = "%BIGMOUTH_TEST_BASE%/root";
      initAppDir();
      expect(getLogsDir()).toBe(path.join(expected, "logs"));
      expect(fs.existsSync(path.join(expected, "logs"))).toBe(true);
    } finally {
      removeTestTree(base);
    }
  });

  it("throws the startup error when BIGMOUTH_HOME resolves to an unusable root", () => {
    // Point the root at a regular file: mkdirSync over an existing file fails,
    // and the resolver must surface that loudly rather than fall back to the
    // default ~/.bigmouth.
    const file = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-badroot-"));
    const filePath = path.join(file, "not-a-dir");
    fs.writeFileSync(filePath, "i am a file, not a directory");
    try {
      process.env.BIGMOUTH_HOME = filePath;
      expect(() => initAppDir()).toThrow(/Cannot use the bigmouth storage root/);
    } finally {
      removeTestTree(file);
    }
  });

  // Both of these guard the same hazard: an env reference that leaves
  // BIGMOUTH_HOME expanding to nothing must be a hard startup error, never a
  // silent path.resolve(home, "") collapse onto the bare home directory —
  // which would otherwise materialize config.json/logs/backups/ directly in
  // $HOME and walk $HOME as the backup root.
  it("throws a startup error naming BIGMOUTH_HOME when it references an unset $VAR", () => {
    delete process.env.BIGMOUTH_TEST_UNSET;
    process.env.BIGMOUTH_HOME = "$BIGMOUTH_TEST_UNSET";
    expect(() => initAppDir()).toThrow(/BIGMOUTH_HOME/);
    expect(() => initAppDir()).toThrow(/expands to an empty path/);
  });

  it("throws a startup error naming BIGMOUTH_HOME when it references a %VAR% set to the empty string", () => {
    process.env.BIGMOUTH_TEST_BASE = "";
    process.env.BIGMOUTH_HOME = "%BIGMOUTH_TEST_BASE%";
    expect(() => initAppDir()).toThrow(/BIGMOUTH_HOME/);
    expect(() => initAppDir()).toThrow(/expands to an empty path/);
  });

  it("does not create anything under the bare home directory when BIGMOUTH_HOME collapses to empty", () => {
    // Guards the exact regression: before the fix, this combination resolved
    // to os.homedir() itself rather than throwing.
    process.env.BIGMOUTH_TEST_BASE = "";
    process.env.BIGMOUTH_HOME = "$BIGMOUTH_TEST_BASE";
    const before = fs.existsSync(path.join(os.homedir(), "workspaces.json"));
    expect(() => initAppDir()).toThrow();
    expect(fs.existsSync(path.join(os.homedir(), "workspaces.json"))).toBe(before);
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
      process.env.BIGMOUTH_HOME = root;
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
      process.env.BIGMOUTH_HOME = root;
      initAppDir();

      const workspace = createWorkspace("Literal spaces", literal);

      expect(workspace.dataDirectory).toBe(literal);
      expect(fs.existsSync(path.join(literal, "config.json"))).toBe(true);
      expect(fs.existsSync(trimmedSibling)).toBe(false);
    } finally {
      removeTestTree(root);
      removeTestTree(parent);
    }
  });
});

// The module owns every standard subpath name, so two derivations of one file
// cannot drift. state.json and backups.sqlite3 used to be joined onto the root
// at their own call sites instead.
describe("standard subpaths", () => {
  it("names every store under the resolved root", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-paths-"));
    process.env.BIGMOUTH_HOME = home;

    initStorageRoot();

    expect(getAppRoot()).toBe(home);
    expect(getWorkspacesJsonPath()).toBe(path.join(home, "workspaces.json"));
    expect(getLogsDir()).toBe(path.join(home, "logs"));
    expect(getApiKeysPath()).toBe(path.join(home, "api-keys.json"));
    expect(getStateJsonPath()).toBe(path.join(home, "state.json"));
    expect(getBackupsDbPath()).toBe(path.join(home, "backups.sqlite3"));

    removeTestTree(home);
  });

  it("resolves without the workspace registry, which is what broke the import cycle", () => {
    // core/shared/atomicWrite reaches into backupStore, which used to reach into
    // the REGISTRY for the root, which reached back into atomicWrite. The cycle
    // survived only because ESM hoists function declarations. initStorageRoot
    // standing alone — no initAppDir, no workspaces.json — is that cycle's
    // absence, stated as a behaviour.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-paths-"));
    process.env.BIGMOUTH_HOME = home;

    initStorageRoot();

    expect(getBackupsDbPath()).toBe(path.join(home, "backups.sqlite3"));
    expect(fs.existsSync(path.join(home, "workspaces.json"))).toBe(false);

    removeTestTree(home);
  });
});
