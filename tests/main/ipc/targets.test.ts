// Integration test for the targets IPC handlers: the real configStore and
// postStore run against a throwaway BIGMOUTH_DATA_DIR + a real registered workspace;
// The async storageAccess edge calls these real services while Electron and the logger are mocked. Exercises the registrar,
// argument validation, the store error mapping, and the cross-store rename that
// rewrites a post's target.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHANNELS, type TargetRenameResult } from "@shared/ipc";
import type { Target } from "@shared/types";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock("@main/storageAccess.js", async () => {
  const workspaceStore = await import("@main/core/services/workspaceStore.js");
  const configStore = await import("@main/core/services/configStore.js");
  const { storageTasks } = await import("@main/storageTasks.js");
  return {
    getWorkspace: async (...args: Parameters<typeof workspaceStore.getWorkspace>) => workspaceStore.getWorkspace(...args),
    getTargets: async (...args: Parameters<typeof configStore.getTargets>) => configStore.getTargets(...args),
    saveTargets: async (...args: Parameters<typeof configStore.saveTargets>) => configStore.saveTargets(...args),
    renameTarget: async (...args: Parameters<typeof storageTasks.renameTarget>) => storageTasks.renameTarget(...args),
  };
});

vi.mock("electron", () => ({
  ipcMain: {
    handle: (ch: string, cb: (...args: unknown[]) => unknown) => handlers.set(ch, cb),
    on: (ch: string, cb: (...args: unknown[]) => unknown) => handlers.set(ch, cb),
  },
}));

vi.mock("@main/core/services/logger.js", () => ({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  serializeError: (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
}));

import { initAppDir, createWorkspace, getWorkspace } from "@main/core/services/workspaceStore.js";
import { createPost, getPost } from "@main/core/services/postStore.js";
import { registerTargetHandlers } from "@main/ipc/targets.js";

let home: string;
let wsId: string;
const SAVED_HOME = process.env.BIGMOUTH_DATA_DIR;

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return handlers.get(channel)!({}, ...args) as Promise<T>;
}

function target(name: string, overrides: Partial<Target> = {}): Target {
  return { name, defaultLanguage: "en", requiresMetadata: false, ...overrides };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-ipc-targets-"));
  process.env.BIGMOUTH_DATA_DIR = home;
  initAppDir();
  handlers.clear();
  registerTargetHandlers();
  wsId = createWorkspace("WS").id;
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_DATA_DIR;
  else process.env.BIGMOUTH_DATA_DIR = SAVED_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("targets IPC handlers", () => {
  it("lists an empty target set for a fresh workspace", async () => {
    expect((await invoke<Target[]>(CHANNELS.listTargets, wsId))).toEqual([]);
  });

  it("saves targets through the store and round-trips them", async () => {
    const saved = (await invoke<Target[]>(CHANNELS.saveTargets, wsId, [target("Blog"), target("Notes")]));
    expect(saved.map((t) => t.name)).toEqual(["Blog", "Notes"]);
    expect((await invoke<Target[]>(CHANNELS.listTargets, wsId)).map((t) => t.name)).toEqual(["Blog", "Notes"]);
  });

  it("normalizes each saved target to only its known fields", async () => {
    const saved = (await invoke<Target[]>(CHANNELS.saveTargets, wsId, [
      { ...target("Blog"), stray: "x" } as unknown as Target,
    ]));
    expect(saved[0]).toEqual(target("Blog"));
    expect(saved[0]).not.toHaveProperty("stray");
  });

  it("validates the save payload before reaching the store", async () => {
    await expect(invoke(CHANNELS.saveTargets, wsId, "not an array")).rejects.toThrow(/must be an array/);
    await expect(invoke(CHANNELS.saveTargets, wsId, [null])).rejects.toThrow(/must be an object/);
    await expect(invoke(CHANNELS.saveTargets, wsId, [target("")])).rejects.toThrow(/non-empty name/);
    await expect(invoke(CHANNELS.saveTargets, wsId, [{ ...target("Blog"), defaultLanguage: 1 } as unknown as Target])).rejects.toThrow(/defaultLanguage string/);
    await expect(invoke(CHANNELS.saveTargets, wsId, [{ ...target("Blog"), requiresMetadata: "yes" } as unknown as Target])).rejects.toThrow(/boolean requiresMetadata/);
  });

  it("renames a target and rewrites the target field on its posts", async () => {
    (await invoke<Target[]>(CHANNELS.saveTargets, wsId, [target("Blog")]));
    const dir = getWorkspace(wsId)!.dataDirectory;
    // Two posts on the target, one on another, to confirm only matching posts move.
    const p1 = createPost(dir, "Blog", "en").frontMatter.id;
    const p2 = createPost(dir, "Blog", "ja").frontMatter.id;
    const other = createPost(dir, "Other", "en").frontMatter.id;

    const result = (await invoke<{ targets: Target[]; postsUpdated: number }>(
      CHANNELS.renameTarget,
      wsId,
      "Blog",
      "Journal",
    ));

    expect(result.postsUpdated).toBe(2);
    expect(result.targets.map((t) => t.name)).toEqual(["Journal"]);
    expect(getPost(dir, p1)!.frontMatter.target).toBe("Journal");
    expect(getPost(dir, p2)!.frontMatter.target).toBe("Journal");
    expect(getPost(dir, other)!.frontMatter.target).toBe("Other");
  });

  // A rename that fails on one post must leave the old target in place, so the
  // posts not yet renamed keep a valid target and the rename can be re-run.
  it("keeps the old target when a post write fails, and a re-run completes the rename", async () => {
    (await invoke<Target[]>(CHANNELS.saveTargets, wsId, [target("Blog")]));
    const dir = getWorkspace(wsId)!.dataDirectory;
    const first = createPost(dir, "Blog", "en");
    const second = createPost(dir, "Blog", "en");

    const realRename = fs.renameSync;
    const failing = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === second.filePath) throw Object.assign(new Error("EBUSY: file is locked"), { code: "EBUSY" });
      return realRename(from, to);
    });
    try {
      await expect(invoke(CHANNELS.renameTarget, wsId, "Blog", "Journal")).rejects.toThrow(/EBUSY/);
    } finally {
      failing.mockRestore();
    }
    expect((await invoke<Target[]>(CHANNELS.listTargets, wsId)).map((t) => t.name)).toEqual(["Blog"]);
    expect(getPost(dir, second.frontMatter.id)!.frontMatter.target).toBe("Blog");

    const retried = (await invoke<{ targets: Target[]; postsUpdated: number }>(CHANNELS.renameTarget, wsId, "Blog", "Journal"));

    expect(retried.targets.map((t) => t.name)).toEqual(["Journal"]);
    expect(getPost(dir, first.frontMatter.id)!.frontMatter.target).toBe("Journal");
    expect(getPost(dir, second.frontMatter.id)!.frontMatter.target).toBe("Journal");
  });

  it("names the post files it could not read, and still retires the old target", async () => {
    (await invoke<Target[]>(CHANNELS.saveTargets, wsId, [target("Blog")]));
    const dir = getWorkspace(wsId)!.dataDirectory;
    const broken = createPost(dir, "Blog", "en");
    const fine = createPost(dir, "Blog", "en");
    fs.writeFileSync(broken.filePath, "---\ntitle: [unclosed\n---\nbody\n");

    const result = (await invoke<TargetRenameResult>(CHANNELS.renameTarget, wsId, "Blog", "Journal"));

    expect(result.postsUpdated).toBe(1);
    expect(result.postsSkipped).toEqual([{ fileName: path.basename(broken.filePath), reason: expect.any(String) }]);
    expect(result.targets.map((t) => t.name)).toEqual(["Journal"]);
    expect(getPost(dir, fine.frontMatter.id)!.frontMatter.target).toBe("Journal");
  });

  it("keeps a concurrent target save when a rename reply is held", async () => {
    await invoke(CHANNELS.saveTargets, wsId, [target("Blog")]);
    const dir = getWorkspace(wsId)!.dataDirectory;
    const post = createPost(dir, "Blog", "en");
    const access = await import("@main/storageAccess.js");
    const { storageTasks } = await import("@main/storageTasks.js");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(access, "renameTarget").mockImplementation(async (...args) => {
      const result = storageTasks.renameTarget(...args);
      await held;
      return result;
    });
    let rename: Promise<unknown> | undefined;
    try {
      rename = invoke(CHANNELS.renameTarget, wsId, "Blog", "Journal");
      await vi.waitFor(() => expect(getPost(dir, post.frontMatter.id)!.frontMatter.target).toBe("Journal"));
      await invoke(CHANNELS.saveTargets, wsId, [target("Journal"), target("News")]);
      release();
      await rename;
      expect((await invoke<Target[]>(CHANNELS.listTargets, wsId)).map((item) => item.name)).toEqual(["Journal", "News"]);
    } finally { release(); await rename; spy.mockRestore(); }
  });

  it("trims the rename arguments before matching", async () => {
    (await invoke<Target[]>(CHANNELS.saveTargets, wsId, [target("Blog")]));
    const result = (await invoke<{ targets: Target[]; postsUpdated: number }>(
      CHANNELS.renameTarget,
      wsId,
      "  Blog  ",
      "  Journal  ",
    ));
    expect(result.targets.map((t) => t.name)).toEqual(["Journal"]);
  });

  it("validates rename arguments and the store-level conflict rules", async () => {
    (await invoke<Target[]>(CHANNELS.saveTargets, wsId, [target("Blog"), target("News")]));
    await expect(invoke(CHANNELS.renameTarget, wsId, "", "Journal")).rejects.toThrow(/oldName and newName are required/);
    await expect(invoke(CHANNELS.renameTarget, wsId, "Blog", "   ")).rejects.toThrow(/oldName and newName are required/);
    await expect(invoke(CHANNELS.renameTarget, wsId, "Missing", "Journal")).rejects.toThrow(/Target not found/);
    await expect(invoke(CHANNELS.renameTarget, wsId, "Blog", "News")).rejects.toThrow(/already exists/);
  });

  it("surfaces an unknown workspace as a thrown Error", async () => {
    await expect(invoke(CHANNELS.listTargets, "nope")).rejects.toThrow(/Workspace not found/);
    await expect(invoke(CHANNELS.saveTargets, "nope", [target("Blog")])).rejects.toThrow(/Workspace not found/);
    await expect(invoke(CHANNELS.renameTarget, "nope", "Blog", "Journal")).rejects.toThrow(/Workspace not found/);
  });
});
