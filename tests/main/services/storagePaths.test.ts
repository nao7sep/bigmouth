// Proves the single storage-root resolution in workspaceStore.ts:
//   - BIGMOUTH_HOME set   → the whole ~/.bigmouth root relocates under it
//   - BIGMOUTH_HOME unset → the root defaults to <home>/.bigmouth
//   - a relative BIGMOUTH_HOME resolves against the home directory, never the cwd
// Relocation is driven through the BIGMOUTH_HOME environment variable — the one
// supported relocation seam — never a private setter.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initAppDir, getLogsDir, createWorkspace } from "@main/core/services/workspaceStore.js";

const SAVED_HOME = process.env.BIGMOUTH_HOME;
const SAVED_TEST_BASE = process.env.BIGMOUTH_TEST_BASE;
const SAVED_TEST_UNSET = process.env.BIGMOUTH_TEST_UNSET;

beforeEach(() => {
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
      fs.rmSync(root, { recursive: true, force: true });
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
      fs.rmSync(root, { recursive: true, force: true });
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
      fs.rmSync(expected, { recursive: true, force: true });
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
      fs.rmSync(expected, { recursive: true, force: true });
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
      fs.rmSync(base, { recursive: true, force: true });
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
      fs.rmSync(base, { recursive: true, force: true });
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
      fs.rmSync(file, { recursive: true, force: true });
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-ws-cwd-"));
    const rel = "my-relative-workspace";
    try {
      process.env.BIGMOUTH_HOME = root;
      initAppDir();
      // The home directory drives the expansion pipeline (os.homedir()), not the
      // storage root, so a relative workspace path lands under the user's home.
      const expected = path.join(os.homedir(), rel);
      const workspace = createWorkspace("Relative WS", rel);
      expect(path.isAbsolute(workspace.dataDirectory)).toBe(true);
      expect(workspace.dataDirectory).toBe(expected);
      expect(workspace.dataDirectory).not.toBe(path.join(process.cwd(), rel));
      expect(workspace.dataDirectory.startsWith(os.homedir())).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(path.join(os.homedir(), rel), { recursive: true, force: true });
    }
  });

  // The same expansion pipeline resolves a user-supplied workspace directory,
  // so it must reject the identical collapsed-to-empty hazard rather than
  // register a workspace rooted at the bare home directory.
  it("rejects a workspace directory that references an unset $VAR instead of collapsing onto the home directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-ws-unset-"));
    try {
      process.env.BIGMOUTH_HOME = root;
      initAppDir();
      delete process.env.BIGMOUTH_TEST_UNSET;
      expect(() => createWorkspace("Bad WS", "$BIGMOUTH_TEST_UNSET")).toThrow(/expands to an empty path/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a workspace directory that references a $VAR set to the empty string", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-ws-empty-"));
    try {
      process.env.BIGMOUTH_HOME = root;
      initAppDir();
      process.env.BIGMOUTH_TEST_BASE = "";
      expect(() => createWorkspace("Bad WS", "$BIGMOUTH_TEST_BASE")).toThrow(/expands to an empty path/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
