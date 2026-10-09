// The workspace registry is the gate for where workspace data lands. These
// tests cover the create/open/reject decisions and the rule that a rejected
// updateWorkspace leaves the in-memory registry untouched (no partial mutation).
// Path expansion / cwd-independence is covered separately in storagePaths.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initAppDir, createWorkspace, openWorkspace, openOrCreateWorkspace, suggestWorkspaceLocation, updateWorkspace, deleteWorkspace, getWorkspace, listWorkspaces } from "@main/core/services/workspaceStore.js";
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
// it was left in place. A bare JSON.parse used to throw a SyntaxError that
// reached the user as "Unexpected end of JSON input".
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

  it("rejects duplicate physical directories without rewriting the registry", () => {
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

    expect(unreadable(reload).detail).toMatch(/name the same folder/);
    expect(fs.readFileSync(path.join(process.env.BIGMOUTH_DATA_DIR!, "workspaces.json"), "utf8")).toBe(raw);
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

  it("rejects the same folder reached with different case on a case-insensitive volume", () => {
    const parent = tempDir("case");
    const dir = path.join(parent, "MyWorkspace");
    fs.mkdirSync(dir);
    createWorkspace("A", dir);

    // Only meaningful where the volume actually folds case; on a case-sensitive
    // one these are genuinely two folders and registering both would be correct.
    const variant = path.join(parent, "myworkspace");
    if (!fs.existsSync(variant)) return;

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

  it("rejects a folder that already contains a workspace (directing to Open)", () => {
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
    expect(() => openWorkspace(dir)).toThrow(/workspace folder/);
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
    expect(() => openWorkspace(dir)).toThrow(/workspace folder/);
    expect(listWorkspaces()).toHaveLength(0);
    expect(fs.readFileSync(path.join(dir, "config.json"), "utf-8")).toBe(foreign);
  });

  it("names a damaged config.json beside posts/ and assets/ instead of calling the folder no workspace", () => {
    const dir = tempDir("damaged");
    fs.mkdirSync(path.join(dir, "posts"));
    fs.mkdirSync(path.join(dir, "assets"));
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(configPath, '{ "formatVersion": 1, ');
    for (const open of [() => openWorkspace(dir), () => openOrCreateWorkspace(undefined, dir)]) {
      expect(carriedMessage(unreadable(open))).toEqual({ key: "store.unreadable", values: { path: configPath } });
    }
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

// A workspace is the user's own document, so one created without a location
// goes to <home>/Documents/BigMouth/<name> — never into the storage root, which
// is the app's (storage-path conventions, "Ownership decides location").
describe("the default workspace location", () => {
  it("runs against a throwaway home, never the developer's", () => {
    expect(os.homedir()).toBe(process.env[process.platform === "win32" ? "USERPROFILE" : "HOME"]);
    expect(path.basename(os.homedir())).toMatch(/^bigmouth-test-home-/);
  });

  it("creates the workspace in a folder named after it under Documents/BigMouth", () => {
    const ws = createWorkspace("My Blog");

    expect(ws.dataDirectory).toBe(path.join(documentsBigMouth(), "My Blog"));
    expect(fs.statSync(path.join(ws.dataDirectory, "posts")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(ws.dataDirectory, "assets")).isDirectory()).toBe(true);
    // Nothing of it lands in the storage root.
    expect(fs.existsSync(path.join(process.env.BIGMOUTH_DATA_DIR!, "workspaces"))).toBe(false);
  });

  it("names the folder with the asset-name sanitizer, falling back to Workspace", () => {
    expect(createWorkspace("Drafts/Notes: 2026?").dataDirectory).toBe(
      path.join(documentsBigMouth(), "Drafts_Notes_ 2026_"),
    );
    expect(createWorkspace("...").dataDirectory).toBe(path.join(documentsBigMouth(), "Workspace"));
  });

  it("numbers the folder when one of that name is already a workspace", () => {
    const first = createWorkspace("Blog");
    const second = createWorkspace("Blog");
    const third = createWorkspace("blog");

    expect(first.dataDirectory).toBe(path.join(documentsBigMouth(), "Blog"));
    expect(second.dataDirectory).toBe(path.join(documentsBigMouth(), "Blog (2)"));
    // On a case-insensitive volume "blog" is the same folder as "Blog".
    const caseFolds = fs.existsSync(path.join(documentsBigMouth(), "BLOG"));
    expect(third.dataDirectory).toBe(path.join(documentsBigMouth(), caseFolds ? "blog (3)" : "blog"));
  });

  it("numbers past a folder holding content a new workspace would take over", () => {
    const taken = path.join(documentsBigMouth(), "Blog");
    fs.mkdirSync(taken, { recursive: true });
    const foreign = JSON.stringify({ title: "Someone else's site" });
    fs.writeFileSync(path.join(taken, "config.json"), foreign);
    // An unregistered workspace folder is taken too: creating there would adopt it.
    initializeWorkspaceData(path.join(documentsBigMouth(), "Blog (2)"));

    expect(createWorkspace("Blog").dataDirectory).toBe(path.join(documentsBigMouth(), "Blog (3)"));
    expect(fs.readFileSync(path.join(taken, "config.json"), "utf-8")).toBe(foreign);
  });

  it("uses an existing folder a new workspace can take, rather than numbering past it", () => {
    const existing = path.join(documentsBigMouth(), "Blog");
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, ".DS_Store"), "finder");

    expect(createWorkspace("Blog").dataDirectory).toBe(existing);
  });

  it("suggests exactly the folder creation then uses", () => {
    fs.mkdirSync(path.join(documentsBigMouth(), "Blog", "posts"), { recursive: true });
    fs.writeFileSync(path.join(documentsBigMouth(), "Blog", "posts", "a.md"), "# taken");

    const suggested = suggestWorkspaceLocation("Blog");
    expect(suggested).toBe(path.join(documentsBigMouth(), "Blog (2)"));
    // Asking writes nothing.
    expect(fs.existsSync(suggested)).toBe(false);
    expect(listWorkspaces()).toHaveLength(0);
    expect(openOrCreateWorkspace("Blog").dataDirectory).toBe(suggested);
  });

  it("suggests the default name's folder for a blank name, as creation resolves it", () => {
    createWorkspace("Workspace", tempDir("elsewhere"));
    const suggested = suggestWorkspaceLocation(undefined);

    expect(suggested).toBe(path.join(documentsBigMouth(), "Workspace 2"));
    expect(openOrCreateWorkspace().dataDirectory).toBe(suggested);
  });

  it("stops at the first name when a workspace holds the whole default folder, and creation says why", () => {
    createWorkspace("Everything", documentsBigMouth());

    expect(suggestWorkspaceLocation("Blog")).toBe(path.join(documentsBigMouth(), "Blog"));
    expect(() => createWorkspace("Blog")).toThrow(/inside workspace "Everything"/);
    expect(listWorkspaces()).toHaveLength(1);
  });
});

describe("updateWorkspace renames, and only renames", () => {
  it("leaves the folder where it is", () => {
    // It used to take a dataDirectory and re-point the registry entry without
    // moving a file — a relocation unreachable from the UI that even permitted
    // an empty target, so surfacing it would have left every post behind.
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

describe("openOrCreateWorkspace", () => {
  it("creates a default-named workspace when no directory is given", () => {
    const ws = openOrCreateWorkspace();
    expect(ws.name).toBe("Workspace");
    expect(ws.dataDirectory).toBe(path.join(documentsBigMouth(), "Workspace"));
    expect(listWorkspaces()).toHaveLength(1);
    // A second nameless create resolves the next free default name, and its folder.
    const second = openOrCreateWorkspace();
    expect(second.name).toBe("Workspace 2");
    expect(second.dataDirectory).toBe(path.join(documentsBigMouth(), "Workspace 2"));
  });

  it("opens an existing workspace directory instead of recreating it", () => {
    const dir = tempDir("existing");
    initializeWorkspaceData(dir); // a complete workspace on disk, not yet registered
    const ws = openOrCreateWorkspace("Reopened", dir);
    expect(ws.dataDirectory).toBe(dir);
    expect(listWorkspaces()).toHaveLength(1);
    // Calling again returns the same registered entry, not a duplicate.
    expect(openOrCreateWorkspace(undefined, dir).id).toBe(ws.id);
    expect(listWorkspaces()).toHaveLength(1);
  });

  it("creates a workspace in an empty directory", () => {
    const dir = tempDir("empty");
    const ws = openOrCreateWorkspace("Fresh", dir);
    expect(ws.name).toBe("Fresh");
    expect(ws.dataDirectory).toBe(dir);
  });

  it("creates in a directory holding content the app would not take over", () => {
    const dir = tempDir("nonempty");
    fs.writeFileSync(path.join(dir, "junk.txt"), "x");
    expect(openOrCreateWorkspace("X", dir).dataDirectory).toBe(dir);
  });

  it("rejects a directory holding content the app would take over", () => {
    const dir = tempDir("foreign");
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ title: "My Blog" }));
    expect(() => openOrCreateWorkspace("X", dir)).toThrow(/would take over/i);
    expect(listWorkspaces()).toHaveLength(0);
  });

  it("rejects a path that exists but is a file", () => {
    const dir = tempDir("hostdir");
    const filePath = path.join(dir, "afile");
    fs.writeFileSync(filePath, "x");
    expect(() => openOrCreateWorkspace("X", filePath)).toThrow(/must be a directory/i);
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

    expect(deleteWorkspace(ws.id)).toBe(true);
    expect(getWorkspace(ws.id)).toBeUndefined();
    // The shared secrets file is keyed by workspace id; deletion must take its
    // keys with it rather than orphan them.
    expect(hasStoredApiKey(getApiKeysPath(), ws.id, "anthropic")).toBe(false);
  });

  it("returns false for an unknown workspace id", () => {
    expect(deleteWorkspace("nope")).toBe(false);
  });
});

// store-recovery-conventions: the registry's format version.
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
