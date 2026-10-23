// The workspace registry is the gate for where workspace data lands. These
// tests cover the create/open/reject decisions and the rule that a rejected
// updateWorkspace leaves the in-memory registry untouched (no partial mutation).
// Path expansion / cwd-independence is covered separately in storagePaths.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initAppDir, createWorkspace, openWorkspace, prepareWorkspace, prepareExistingWorkspace, registerPreparedWorkspace, suggestWorkspaceLocation, updateWorkspace, deleteWorkspace, getWorkspace, listWorkspaces } from "@main/core/services/workspaceStore.js";
import { getApiKeysPath } from "@main/core/services/storagePaths.js";
import { initializeWorkspaceData } from "@main/core/services/dataDir.js";
import { writeApiKey, hasStoredApiKey } from "@main/core/services/apiKeys.js";
import { NewerFormatError, UnreadableStoreError } from "@main/core/shared/storeFormat.js";
import { carriedMessage } from "@shared/i18n/carriedMessage";

/** The unreadable-store failure `fn` throws: what the user is told, and the detail for the log. */
function unreadable(fn: () => unknown): UnreadableStoreError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(UnreadableStoreError);
    return err as UnreadableStoreError;
  }
  throw new Error("expected an unreadable-store failure");
}

const SAVED_HOME = process.env.BIGMOUTH_DATA_DIR;
const tempDirs: string[] = [];
const DIRECTORY_LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

// Whether the volume holding the temp folders folds case, probed once while the
// tests are collected so a case-only test is skipped visibly where it cannot apply.
const CASE_INSENSITIVE_TMP = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-CaseProbe-"));
  try {
    return fs.existsSync(path.join(path.dirname(probe), path.basename(probe).toLowerCase()));
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bigmouth-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  // A fresh storage root per test gives a clean, empty registry.
  process.env.BIGMOUTH_DATA_DIR = tempDir("wsroot");
  initAppDir();
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_DATA_DIR;
  else process.env.BIGMOUTH_DATA_DIR = SAVED_HOME;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// One folder must never register as two workspaces. Two registrations mean two
// ids, two in-memory indexes keyed by different strings writing over a single
// posts/index.json, and two separate API-key sets for one folder.
// A halt only makes sense when the user can act on it, and BIGMOUTH_DATA_DIR can put
// the registry anywhere — so every rejection names the file's full path and says
// it was left in place, rather than a bare JSON.parse SyntaxError reaching the
// user as "Unexpected end of JSON input".
describe("an unreadable registry names itself", () => {
  function withRegistry(contents: string): () => void {
    const home = tempDir("halt");
    process.env.BIGMOUTH_DATA_DIR = home;
    initAppDir();
    const registry = path.join(home, "workspaces.json");
    fs.writeFileSync(registry, contents, "utf-8");
    return () => initAppDir();
  }

  it.each([
    ["truncated JSON", "{ \"workspaces\": ["],
    ["a JSON value that is not an object", "[]"],
    ["a workspaces key that is not an array", '{ "workspaces": {} }'],
    ["a workspace entry missing its fields", '{ "workspaces": [{ "id": "a" }] }'],
  ])("names the path and says it was left alone for %s", (_name, contents) => {
    const reload = withRegistry(contents);
    const registryPath = path.join(process.env.BIGMOUTH_DATA_DIR!, "workspaces.json");

    expect(carriedMessage(unreadable(reload))).toEqual({ key: "store.unreadable", values: { path: registryPath } });
    expect(fs.readFileSync(registryPath, "utf8")).toBe(contents);
  });

  it("rejects duplicate workspace ids without rewriting the registry", () => {
    const first = tempDir("identity-a");
    const second = tempDir("identity-b");
    const raw = JSON.stringify({
      formatVersion: 1,
      workspaces: [
        { id: "same", name: "A", dataDirectory: first },
        { id: "same", name: "B", dataDirectory: second },
      ],
    });
    const reload = withRegistry(raw);

    expect(unreadable(reload).detail).toMatch(/workspace id.*appears more than once/);
    expect(fs.readFileSync(path.join(process.env.BIGMOUTH_DATA_DIR!, "workspaces.json"), "utf8")).toBe(raw);
  });

  it("rejects duplicate normalized absolute paths without rewriting the registry", () => {
    const dir = tempDir("identity-real");
    const raw = JSON.stringify({
      formatVersion: 1,
      workspaces: [
        { id: "one", name: "A", dataDirectory: dir },
        { id: "two", name: "B", dataDirectory: path.join(dir, "child", "..") + path.sep },
      ],
    });
    const reload = withRegistry(raw);

    expect(unreadable(reload).detail).toMatch(/name the same folder/);
    expect(fs.readFileSync(path.join(process.env.BIGMOUTH_DATA_DIR!, "workspaces.json"), "utf8")).toBe(raw);
  });

  it("loads registered physical aliases without probing either external root", () => {
    const real = tempDir("identity-real");
    const linkParent = tempDir("identity-link");
    const link = path.join(linkParent, "same-folder");
    fs.symlinkSync(real, link, DIRECTORY_LINK_TYPE);
    const raw = JSON.stringify({
      formatVersion: 1,
      workspaces: [
        { id: "one", name: "A", dataDirectory: real },
        { id: "two", name: "B", dataDirectory: link },
      ],
    });
    const reload = withRegistry(raw);
    const probes = [vi.spyOn(fs, "existsSync"), vi.spyOn(fs, "statSync"), vi.spyOn(fs, "readFileSync"), vi.spyOn(fs.realpathSync, "native")];
    try {
      expect(reload()).toMatchObject({ workspaces: [{ id: "one" }, { id: "two" }] });
      for (const probe of probes) {
        expect(probe.mock.calls.filter(([input]) => [real, link].some((root) => String(input) === root || String(input).startsWith(root + path.sep)))).toEqual([]);
      }
    } finally { for (const probe of probes) probe.mockRestore(); }
  });
});

describe("where a workspace may be created", () => {
  it("refuses a folder inside another workspace", () => {
    // Nesting made the outer workspace's own tree contain a second one, so it saw
    // a post-id directory it did not create, and deleting the outer folder took
    // the inner one with it.
    const outer = tempDir("outer");
    createWorkspace("Outer", outer);
    const inner = path.join(outer, "assets", "inner");
    fs.mkdirSync(inner, { recursive: true });

    expect(() => createWorkspace("Inner", inner)).toThrow(/inside workspace "Outer"/);
    expect(listWorkspaces()).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")("says the folder is not writable, rather than surfacing a raw errno", () => {
    const parent = tempDir("readonly");
    const dir = path.join(parent, "locked");
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o500);

    try {
      expect(() => createWorkspace("Locked", dir)).toThrow(/is not writable/);
      // And nothing was half-registered.
      expect(listWorkspaces()).toHaveLength(0);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  // The chmod case above needs POSIX modes; the message itself does not depend
  // on the OS or on which refusal the folder raised.
  it("says the folder is not writable when creating its folders is refused, on any OS", () => {
    const dir = tempDir("refused");
    const mkdir = fs.mkdirSync;
    const refuse = vi.spyOn(fs, "mkdirSync").mockImplementation((target, options) => {
      if (String(target).startsWith(dir)) {
        throw Object.assign(new Error(`EPERM: operation not permitted, mkdir '${String(target)}'`), { code: "EPERM" });
      }
      return mkdir(target, options);
    });
    try {
      expect(() => createWorkspace("Refused", dir)).toThrow(`Cannot create a workspace in ${dir}: the folder is not writable.`);
      expect(listWorkspaces()).toHaveLength(0);
    } finally {
      refuse.mockRestore();
    }
  });

  it("says only that creation failed when its folders cannot be made for another reason", () => {
    const dir = tempDir("full");
    const mkdir = fs.mkdirSync;
    const fail = vi.spyOn(fs, "mkdirSync").mockImplementation((target, options) => {
      if (String(target).startsWith(dir)) {
        throw Object.assign(new Error(`ENOSPC: no space left on device, mkdir '${String(target)}'`), { code: "ENOSPC" });
      }
      return mkdir(target, options);
    });
    try {
      expect(() => createWorkspace("Full", dir)).toThrow(`Cannot create a workspace in ${dir}: its folders could not be created.`);
      expect(listWorkspaces()).toHaveLength(0);
    } finally {
      fail.mockRestore();
    }
  });

  it("still allows a sibling folder next to a workspace", () => {
    const parent = tempDir("siblings");
    const a = path.join(parent, "a");
    const b = path.join(parent, "b");
    fs.mkdirSync(a);
    fs.mkdirSync(b);

    createWorkspace("A", a);
    expect(() => createWorkspace("B", b)).not.toThrow();
    expect(listWorkspaces()).toHaveLength(2);
  });
});

describe("workspace identity", () => {
  it("rejects the same folder reached with a trailing separator", () => {
    const dir = tempDir("dupe");
    createWorkspace("A", dir);

    expect(() => createWorkspace("B", `${dir}${path.sep}`)).toThrow(/already registered as workspace "A"/);
    expect(listWorkspaces()).toHaveLength(1);
  });

  // Only meaningful where the volume actually folds case; on a case-sensitive
  // one these are genuinely two folders and registering both would be correct.
  it.runIf(CASE_INSENSITIVE_TMP)("rejects the same folder reached with different case on a case-insensitive volume", () => {
    const parent = tempDir("case");
    const dir = path.join(parent, "MyWorkspace");
    fs.mkdirSync(dir);
    createWorkspace("A", dir);

    const variant = path.join(parent, "myworkspace");
    expect(() => createWorkspace("B", variant)).toThrow(/already registered as workspace "A"/);
    expect(listWorkspaces()).toHaveLength(1);
  });

  it("rejects the same folder named in a different Unicode form", () => {
    // macOS hands back NFD from a file dialog where the user typed NFC.
    const parent = tempDir("nfc");
    const nfc = path.join(parent, "caf\u00e9");
    fs.mkdirSync(nfc);
    createWorkspace("A", nfc);

    const nfd = path.join(parent, "cafe\u0301");
    expect(() => createWorkspace("B", nfd)).toThrow(/already registered as workspace "A"/);
    expect(listWorkspaces()).toHaveLength(1);
  });

  it("rejects the same folder reached through a symlink", () => {
    const parent = tempDir("link");
    const real = path.join(parent, "real");
    fs.mkdirSync(real);
    createWorkspace("A", real);

    const link = path.join(parent, "link");
    fs.symlinkSync(real, link, DIRECTORY_LINK_TYPE);
    expect(() => createWorkspace("B", link)).toThrow(/already registered as workspace "A"/);
    expect(listWorkspaces()).toHaveLength(1);
  });

  it("still registers two genuinely different folders", () => {
    createWorkspace("A", tempDir("one"));
    createWorkspace("B", tempDir("two"));
    expect(listWorkspaces()).toHaveLength(2);
  });
});

describe("createWorkspace gating", () => {
  // What blocks creation is content the app would take over, not content as
  // such. An emptiness test refused a folder the user had merely opened in
  // Finder (.DS_Store) or prepared for versioning (.git), which is the workflow
  // per-post files exist to support.
  it("creates in a folder holding files it does not own", () => {
    const dir = tempDir("unrelated");
    fs.writeFileSync(path.join(dir, ".DS_Store"), "finder");
    fs.writeFileSync(path.join(dir, "stray.txt"), "not a workspace");
    fs.mkdirSync(path.join(dir, ".git"));

    const ws = createWorkspace("WS", dir);

    expect(ws.dataDirectory).toBe(dir);
    expect(fs.existsSync(path.join(dir, "config.json"))).toBe(false);
    // The folder's own contents survive untouched.
    expect(fs.readFileSync(path.join(dir, "stray.txt"), "utf-8")).toBe("not a workspace");
  });

  it("opens an untouched workspace with no config file", () => {
    const dir = tempDir("halfmade");
    fs.mkdirSync(path.join(dir, "posts"));
    fs.mkdirSync(path.join(dir, "assets"));

    expect(openWorkspace(dir).dataDirectory).toBe(dir);
    expect(fs.existsSync(path.join(dir, "config.json"))).toBe(false);
  });

  it("rejects a folder holding a config.json the app did not write", () => {
    const dir = tempDir("foreign-config");
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ title: "My Blog" }));
    expect(() => createWorkspace("WS", dir)).toThrow(/"config.json"/);
    expect(listWorkspaces()).toHaveLength(0);
  });

  it("rejects a folder whose posts already hold content", () => {
    const dir = tempDir("foreign-posts");
    fs.mkdirSync(path.join(dir, "posts"));
    fs.writeFileSync(path.join(dir, "posts", "hello.md"), "# Someone else's post");
    expect(() => createWorkspace("WS", dir)).toThrow(/"posts"/);
    expect(listWorkspaces()).toHaveLength(0);
  });

  it("rejects a folder where a name the app needs is taken by a file", () => {
    const dir = tempDir("assets-file");
    fs.writeFileSync(path.join(dir, "assets"), "not a directory");
    expect(() => createWorkspace("WS", dir)).toThrow(/"assets"/);
    expect(listWorkspaces()).toHaveLength(0);
  });

  it("refuses to create over a folder that already contains a workspace", () => {
    const dir = tempDir("existing-ws");
    initializeWorkspaceData(dir); // a complete workspace on disk, not yet registered
    expect(() => createWorkspace("WS", dir)).toThrow(/already contains a workspace/);
  });

  it("rejects registering the same directory twice", () => {
    const dir = tempDir("dup");
    const ws = createWorkspace("First", dir);
    expect(() => createWorkspace("Second", dir)).toThrow(/already registered/);
    // Opening the same directory returns the existing entry rather than duplicating.
    expect(openWorkspace(dir).id).toBe(ws.id);
    expect(listWorkspaces()).toHaveLength(1);
  });
});

describe("openWorkspace gating", () => {
  it("rejects a directory missing a required workspace directory", () => {
    const dir = tempDir("partial");
    initializeWorkspaceData(dir);
    fs.rmdirSync(path.join(dir, "assets"));
    expect(() => openWorkspace(dir)).toThrow(/workspaces\.notAWorkspace/);
  });

  it("accepts a sparse config object in a workspace directory", () => {
    const dir = tempDir("sparse");
    fs.mkdirSync(path.join(dir, "posts"));
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ formatVersion: 1, timezone: "UTC" }));
    expect(openWorkspace(dir).dataDirectory).toBe(dir);
  });

  it("rejects a generic folder whose config.json is not a BigMouth config", () => {
    // A blog or static-site folder can hold config.json + posts/ + assets/ without
    // being a workspace; accepting it would overwrite its config on the first save.
    const dir = tempDir("blog");
    fs.mkdirSync(path.join(dir, "posts"));
    fs.mkdirSync(path.join(dir, "assets"));
    const foreign = JSON.stringify({ title: "My Blog", theme: "dark" });
    fs.writeFileSync(path.join(dir, "config.json"), foreign);
    expect(() => openWorkspace(dir)).toThrow(/workspaces\.notAWorkspace/);
    expect(listWorkspaces()).toHaveLength(0);
    expect(fs.readFileSync(path.join(dir, "config.json"), "utf-8")).toBe(foreign);
  });

  it("names a damaged config.json beside posts/ and assets/ instead of calling the folder no workspace", () => {
    const dir = tempDir("damaged");
    fs.mkdirSync(path.join(dir, "posts"));
    fs.mkdirSync(path.join(dir, "assets"));
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(configPath, '{ "formatVersion": 1, ');
    expect(carriedMessage(unreadable(() => openWorkspace(dir)))).toEqual({ key: "store.unreadable", values: { path: configPath } });
    expect(listWorkspaces()).toHaveLength(0);
    expect(fs.readFileSync(configPath, "utf-8")).toBe('{ "formatVersion": 1, ');
  });

  it("rejects opening a workspace nested inside a registered workspace", () => {
    const outer = tempDir("open-outer");
    createWorkspace("Outer", outer);
    const inner = path.join(outer, "nested");
    initializeWorkspaceData(inner);

    expect(() => openWorkspace(inner)).toThrow(/inside workspace "Outer"/);
    expect(listWorkspaces()).toHaveLength(1);
  });

  it("rejects opening a workspace that contains a registered workspace", () => {
    const outer = tempDir("open-containing");
    const inner = path.join(outer, "nested");
    initializeWorkspaceData(inner);
    openWorkspace(inner, "Inner");
    initializeWorkspaceData(outer);

    expect(() => openWorkspace(outer)).toThrow(/contains workspace "Inner"/);
    expect(listWorkspaces()).toHaveLength(1);
  });

  it("resolves symlinks when checking workspace containment", () => {
    const outer = tempDir("open-link-outer");
    createWorkspace("Outer", outer);
    const inner = path.join(outer, "nested");
    initializeWorkspaceData(inner);
    const parent = tempDir("open-link-parent");
    const link = path.join(parent, "linked-workspace");
    fs.symlinkSync(inner, link, DIRECTORY_LINK_TYPE);

    expect(() => openWorkspace(link)).toThrow(/inside workspace "Outer"/);
    expect(listWorkspaces()).toHaveLength(1);
  });
});

/** Where a workspace created without a location goes, under the per-test home tests/main/setup.ts sets. */
function documentsBigMouth(): string {
  return path.join(os.homedir(), "Documents", "BigMouth");
}

describe("the default workspace location", () => {
  it("runs against a throwaway home, never the developer's", () => {
    expect(os.homedir()).toBe(process.env[process.platform === "win32" ? "USERPROFILE" : "HOME"]);
    expect(path.basename(os.homedir())).toMatch(/^bigmouth-test-home-/);
  });

  it.each(["My Blog", "マイブログ", "Drafts/Notes: 2026?", "...", "CON", "nul.notes"])(
    "creates %s directly at Documents/BigMouth independently of the name", (name) => {
      const ws = createWorkspace(name);
      expect(ws.name).toBe(name);
      expect(ws.dataDirectory).toBe(documentsBigMouth());
      expect(fs.statSync(path.join(ws.dataDirectory, "posts")).isDirectory()).toBe(true);
      expect(fs.statSync(path.join(ws.dataDirectory, "assets")).isDirectory()).toBe(true);
      expect(openWorkspace(ws.dataDirectory).id).toBe(ws.id);
      expect(fs.existsSync(path.join(process.env.BIGMOUTH_DATA_DIR!, "workspaces"))).toBe(false);
    },
  );

  it("returns the exact default without creating anything or considering registered names", () => {
    createWorkspace("Workspace", tempDir("elsewhere"));
    expect(suggestWorkspaceLocation()).toBe(documentsBigMouth());
    expect(fs.existsSync(documentsBigMouth())).toBe(false);
    expect(createWorkspace("Blog").dataDirectory).toBe(documentsBigMouth());
  });

  it("refuses an occupied default until another destination is explicitly chosen", () => {
    createWorkspace("First");
    expect(suggestWorkspaceLocation()).toBe(documentsBigMouth());
    expect(() => createWorkspace("Second")).toThrow(/already registered as workspace "First"/);
    expect(listWorkspaces()).toHaveLength(1);
    const chosen = tempDir("chosen");
    expect(createWorkspace("Second", chosen).dataDirectory).toBe(chosen);
  });

  it("refuses an unregistered workspace at the default instead of adopting it", () => {
    initializeWorkspaceData(documentsBigMouth());
    expect(suggestWorkspaceLocation()).toBe(documentsBigMouth());
    expect(() => createWorkspace("Blog")).toThrow(/already contains a workspace/);
    expect(listWorkspaces()).toHaveLength(0);
  });

  it("refuses conflicting content at the default without creating another folder", () => {
    fs.mkdirSync(documentsBigMouth(), { recursive: true });
    const foreign = JSON.stringify({ title: "Someone else's site" });
    fs.writeFileSync(path.join(documentsBigMouth(), "config.json"), foreign);
    expect(() => createWorkspace("Blog")).toThrow(/already has its own/);
    expect(fs.readFileSync(path.join(documentsBigMouth(), "config.json"), "utf-8")).toBe(foreign);
    expect(fs.readdirSync(documentsBigMouth())).toEqual(["config.json"]);
  });

  it("uses an existing available default directory", () => {
    fs.mkdirSync(documentsBigMouth(), { recursive: true });
    fs.writeFileSync(path.join(documentsBigMouth(), ".DS_Store"), "finder");
    expect(createWorkspace("Blog").dataDirectory).toBe(documentsBigMouth());
  });
});

describe("updateWorkspace renames, and only renames", () => {
  it("leaves the folder where it is", () => {
    // Re-pointing the registry entry without moving a file would leave every
    // post behind, so a rename takes no folder.
    const wsDir = tempDir("ws");
    const ws = createWorkspace("Original", wsDir);

    updateWorkspace(ws.id, { name: "Renamed" });

    expect(getWorkspace(ws.id)?.name).toBe("Renamed");
    expect(getWorkspace(ws.id)?.dataDirectory).toBe(wsDir);
  });

  it("applies a valid name-only change", () => {
    const ws = createWorkspace("Before", tempDir("ws"));
    const updated = updateWorkspace(ws.id, { name: "After" });
    expect(updated?.name).toBe("After");
    expect(getWorkspace(ws.id)?.name).toBe("After");
  });
});

describe("creating at an exact destination, and adding an existing folder", () => {
  it("creates directly in the chosen destination, independently of its name", () => {
    const destination = tempDir("chosen");
    const ws = createWorkspace("  Fresh  ", destination);
    expect(ws.name).toBe("Fresh");
    expect(ws.dataDirectory).toBe(destination);
    expect(fs.existsSync(path.join(destination, "Fresh"))).toBe(false);
    expect(fs.statSync(path.join(destination, "posts")).isDirectory()).toBe(true);
    expect(fs.existsSync(documentsBigMouth())).toBe(false);
  });

  it("preserves unrelated files in the chosen destination", () => {
    const destination = tempDir("chosen");
    fs.writeFileSync(path.join(destination, "junk.txt"), "x");
    expect(createWorkspace("X", destination).dataDirectory).toBe(destination);
    expect(fs.readFileSync(path.join(destination, "junk.txt"), "utf8")).toBe("x");
  });

  it("refuses a conflicting chosen destination without substituting a suffix", () => {
    const destination = tempDir("chosen");
    const foreign = JSON.stringify({ title: "My Blog" });
    fs.writeFileSync(path.join(destination, "config.json"), foreign);
    expect(() => createWorkspace("X", destination)).toThrow(/already has its own/);
    expect(fs.readFileSync(path.join(destination, "config.json"), "utf8")).toBe(foreign);
    expect(fs.existsSync(`${destination} (2)`)).toBe(false);
    expect(fs.existsSync(path.join(destination, "X"))).toBe(false);
    expect(listWorkspaces()).toHaveLength(0);
  });

  it("refuses a blank name", () => {
    expect(() => createWorkspace("   ", tempDir("chosen"))).toThrow(/name is required/i);
    expect(listWorkspaces()).toHaveLength(0);
  });

  it("refuses a destination that is a file", () => {
    const filePath = path.join(tempDir("hostdir"), "afile");
    fs.writeFileSync(filePath, "x");
    expect(() => createWorkspace("X", filePath)).toThrow();
    expect(fs.readFileSync(filePath, "utf8")).toBe("x");
    expect(listWorkspaces()).toHaveLength(0);
  });

  it("adds an existing workspace folder once, named after the folder", () => {
    const dir = path.join(tempDir("existing"), "Reopened");
    initializeWorkspaceData(dir); // a complete workspace on disk, not yet registered
    const ws = openWorkspace(dir);
    expect(ws.name).toBe("Reopened");
    expect(ws.dataDirectory).toBe(dir);
    expect(openWorkspace(dir).id).toBe(ws.id);
    expect(listWorkspaces()).toHaveLength(1);
  });

  it("refuses to add a folder holding no workspace, naming it in the user's words", () => {
    const dir = tempDir("empty");
    let thrown: unknown;
    try { openWorkspace(dir); } catch (err) { thrown = err; }
    expect(carriedMessage(thrown)).toEqual({ key: "workspaces.notAWorkspace", values: { path: dir } });
    expect(listWorkspaces()).toHaveLength(0);
  });
});

describe("updateWorkspace", () => {
  it("returns null when updating an unknown workspace", () => {
    expect(updateWorkspace("nope", { name: "x" })).toBeNull();
  });
});

describe("deleteWorkspace", () => {
  it("removes the workspace and clears its stored API keys", () => {
    const ws = createWorkspace("Keyed", tempDir("ws"));
    writeApiKey(getApiKeysPath(), ws.id, "anthropic", "sk-secret");
    expect(hasStoredApiKey(getApiKeysPath(), ws.id, "anthropic")).toBe(true);

    expect(deleteWorkspace(ws.id)).toEqual({});
    expect(getWorkspace(ws.id)).toBeUndefined();
    // The shared secrets file is keyed by workspace id; deletion must take its
    // keys with it rather than orphan them.
    expect(hasStoredApiKey(getApiKeysPath(), ws.id, "anthropic")).toBe(false);
  });

  it("returns null for an unknown workspace id", () => {
    expect(deleteWorkspace("nope")).toBeNull();
  });
});

// The registry's format version, which tells a build whether it can read the file.
describe("workspace registry format version", () => {
  const registry = () => path.join(process.env.BIGMOUTH_DATA_DIR!, "workspaces.json");

  it("writes this build's format version and reads the registry back", () => {
    const ws = createWorkspace("A", tempDir("fmt"));
    expect(JSON.parse(fs.readFileSync(registry(), "utf8"))).toEqual({ formatVersion: 1, workspaces: [ws] });
    expect(initAppDir().workspaces).toEqual([ws]);
  });

  it("reads a registry without its format version as this build's format", () => {
    const workspaces = [{ id: "a", name: "A", dataDirectory: tempDir("fmt") }];
    fs.writeFileSync(registry(), JSON.stringify({ workspaces }));
    expect(initAppDir().workspaces).toEqual(workspaces);
  });

  it("halts on a registry it could not read, naming it, and leaves it in place", () => {
    // A directory where the file should be fails the read itself, as a permission error does.
    fs.rmSync(registry());
    fs.mkdirSync(registry());
    expect(unreadable(() => initAppDir()).filePath).toBe(registry());
    expect(fs.statSync(registry()).isDirectory()).toBe(true);
  });

  it("halts on a registry a newer version wrote, naming it, and leaves it byte-identical", () => {
    const body = JSON.stringify({ formatVersion: 2, workspaces: { future: true } });
    fs.writeFileSync(registry(), body);

    expect(() => initAppDir()).toThrow(NewerFormatError);
    expect(() => initAppDir()).toThrow(registry());
    expect(fs.readFileSync(registry(), "utf8")).toBe(body);
  });

  it("opens a workspace folder whose config.json a newer version wrote, leaving the file to say so when read", () => {
    const dir = tempDir("fmt");
    initializeWorkspaceData(dir);
    const body = JSON.stringify({ formatVersion: 2, sets: {} });
    fs.writeFileSync(path.join(dir, "config.json"), body);

    expect(openWorkspace(dir).dataDirectory).toBe(dir);
    expect(fs.readFileSync(path.join(dir, "config.json"), "utf8")).toBe(body);
  });

  it("opens a workspace folder whose config.json holds only its format version", () => {
    const dir = tempDir("fmt");
    initializeWorkspaceData(dir);
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ formatVersion: 1 }));
    expect(openWorkspace(dir).dataDirectory).toBe(dir);
  });
});


describe("preparing external workspaces separately from registry publication", () => {
  const registry = () => path.join(process.env.BIGMOUTH_DATA_DIR!, "workspaces.json");

  it("prepares a new workspace without registry or key IO, then registers against the latest state", () => {
    const existing = createWorkspace("Before", tempDir("registered"));
    writeApiKey(getApiKeysPath(), existing.id, "anthropic", "sk-existing");
    const registryBefore = fs.readFileSync(registry(), "utf8");
    const keysBefore = fs.readFileSync(getApiKeysPath(), "utf8");
    const destination = path.join(tempDir("prepared-parent"), "workspace");
    const read = vi.spyOn(fs, "readFileSync");
    let prepared!: ReturnType<typeof prepareWorkspace>;
    try {
      prepared = prepareWorkspace("  Prepared  ", destination, [...listWorkspaces()]);
      expect(read.mock.calls.some(([input]) => [registry(), getApiKeysPath()].includes(String(input)))).toBe(false);
    } finally { read.mockRestore(); }
    expect(prepared.name).toBe("Prepared");
    expect(prepared.dataDirectory).toBe(destination);
    expect(fs.statSync(path.join(destination, "posts")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(destination, "assets")).isDirectory()).toBe(true);
    expect(getWorkspace(prepared.id)).toBeUndefined();
    expect(fs.readFileSync(registry(), "utf8")).toBe(registryBefore);
    expect(fs.readFileSync(getApiKeysPath(), "utf8")).toBe(keysBefore);

    updateWorkspace(existing.id, { name: "Changed after preparation" });
    expect(registerPreparedWorkspace(prepared)).toEqual(prepared);
    expect(listWorkspaces()).toEqual([{ ...existing, name: "Changed after preparation" }, prepared]);
    const committed = fs.readFileSync(registry(), "utf8");
    expect(registerPreparedWorkspace(prepared)).toEqual(prepared);
    expect(listWorkspaces()).toHaveLength(2);
    expect(fs.readFileSync(registry(), "utf8")).toBe(committed);
  });

  it("prepares an existing folder without publishing and registration never probes its files", () => {
    const destination = tempDir("prepared-existing");
    initializeWorkspaceData(destination);
    const before = fs.readFileSync(registry(), "utf8");
    const prepared = prepareExistingWorkspace(destination, [], "  Existing  ");
    expect(prepared.name).toBe("Existing");
    expect(listWorkspaces()).toEqual([]);
    expect(fs.readFileSync(registry(), "utf8")).toBe(before);
    const probes = [vi.spyOn(fs, "existsSync"), vi.spyOn(fs, "statSync"), vi.spyOn(fs, "readFileSync"), vi.spyOn(fs.realpathSync, "native")];
    try {
      expect(registerPreparedWorkspace(prepared)).toEqual(prepared);
      for (const probe of probes) {
        expect(probe.mock.calls.filter(([input]) => String(input) === destination || String(input).startsWith(destination + path.sep))).toEqual([]);
      }
    } finally { for (const probe of probes) probe.mockRestore(); }
    expect(listWorkspaces()).toEqual([prepared]);
  });

  it("uses the supplied registry snapshot for physical matches and overlap checks", () => {
    const destination = tempDir("prepared-snapshot");
    initializeWorkspaceData(destination);
    const existing = { id: "snapshot-id", name: "Snapshot", dataDirectory: destination };
    expect(prepareExistingWorkspace(destination + path.sep, [existing], "Ignored")).toBe(existing);
    expect(() => prepareWorkspace("Duplicate", destination, [existing])).toThrow(/already registered/);
    expect(() => prepareWorkspace("Nested", path.join(destination, "nested"), [existing])).toThrow(/inside workspace "Snapshot"/);
    expect(listWorkspaces()).toEqual([]);
  });
});
