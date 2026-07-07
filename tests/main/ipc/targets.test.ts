// Integration test for the targets IPC handlers: the real configStore and
// postStore run against a throwaway BIGMOUTH_HOME + a real registered workspace;
// only `electron` (ipcMain) and the logger are mocked. Exercises the registrar,
// argument validation, the store error mapping, and the cross-store rename that
// rewrites a post's target.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHANNELS } from "@shared/ipc";
import type { Target } from "@shared/types";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock("electron", () => ({
  ipcMain: {
    handle: (ch: string, cb: (...args: unknown[]) => unknown) => handlers.set(ch, cb),
    on: (ch: string, cb: (...args: unknown[]) => unknown) => handlers.set(ch, cb),
  },
}));

vi.mock("@main/core/services/logger.js", () => ({
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
const SAVED_HOME = process.env.BIGMOUTH_HOME;

function invoke<T>(channel: string, ...args: unknown[]): T {
  return handlers.get(channel)!({}, ...args) as T;
}

function target(name: string, overrides: Partial<Target> = {}): Target {
  return { name, defaultLanguage: "en", requiresMetadata: false, ...overrides };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-ipc-targets-"));
  process.env.BIGMOUTH_HOME = home;
  initAppDir();
  handlers.clear();
  registerTargetHandlers();
  wsId = createWorkspace("WS").id;
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_HOME;
  else process.env.BIGMOUTH_HOME = SAVED_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("targets IPC handlers", () => {
  it("lists an empty target set for a fresh workspace", () => {
    expect(invoke<Target[]>(CHANNELS.listTargets, wsId)).toEqual([]);
  });

  it("saves targets through the store and round-trips them", () => {
    const saved = invoke<Target[]>(CHANNELS.saveTargets, wsId, [target("Blog"), target("Notes")]);
    expect(saved.map((t) => t.name)).toEqual(["Blog", "Notes"]);
    expect(invoke<Target[]>(CHANNELS.listTargets, wsId).map((t) => t.name)).toEqual(["Blog", "Notes"]);
  });

  it("normalizes each saved target to only its known fields", () => {
    const saved = invoke<Target[]>(CHANNELS.saveTargets, wsId, [
      { ...target("Blog"), stray: "x" } as unknown as Target,
    ]);
    expect(saved[0]).toEqual(target("Blog"));
    expect(saved[0]).not.toHaveProperty("stray");
  });

  it("validates the save payload before reaching the store", () => {
    expect(() => invoke(CHANNELS.saveTargets, wsId, "not an array")).toThrow(/must be an array/);
    expect(() => invoke(CHANNELS.saveTargets, wsId, [null])).toThrow(/must be an object/);
    expect(() => invoke(CHANNELS.saveTargets, wsId, [target("")])).toThrow(/non-empty name/);
    expect(() =>
      invoke(CHANNELS.saveTargets, wsId, [{ ...target("Blog"), defaultLanguage: 1 } as unknown as Target]),
    ).toThrow(/defaultLanguage string/);
    expect(() =>
      invoke(CHANNELS.saveTargets, wsId, [{ ...target("Blog"), requiresMetadata: "yes" } as unknown as Target]),
    ).toThrow(/boolean requiresMetadata/);
  });

  it("renames a target and rewrites the target field on its posts", () => {
    invoke<Target[]>(CHANNELS.saveTargets, wsId, [target("Blog")]);
    const dir = getWorkspace(wsId)!.dataDirectory;
    // Two posts on the target, one on another, to confirm only matching posts move.
    const p1 = createPost(dir, "Blog", "en").frontMatter.id;
    const p2 = createPost(dir, "Blog", "ja").frontMatter.id;
    const other = createPost(dir, "Other", "en").frontMatter.id;

    const result = invoke<{ targets: Target[]; postsUpdated: number }>(
      CHANNELS.renameTarget,
      wsId,
      "Blog",
      "Journal",
    );

    expect(result.postsUpdated).toBe(2);
    expect(result.targets.map((t) => t.name)).toEqual(["Journal"]);
    expect(getPost(dir, p1)!.frontMatter.target).toBe("Journal");
    expect(getPost(dir, p2)!.frontMatter.target).toBe("Journal");
    expect(getPost(dir, other)!.frontMatter.target).toBe("Other");
  });

  it("trims the rename arguments before matching", () => {
    invoke<Target[]>(CHANNELS.saveTargets, wsId, [target("Blog")]);
    const result = invoke<{ targets: Target[]; postsUpdated: number }>(
      CHANNELS.renameTarget,
      wsId,
      "  Blog  ",
      "  Journal  ",
    );
    expect(result.targets.map((t) => t.name)).toEqual(["Journal"]);
  });

  it("validates rename arguments and the store-level conflict rules", () => {
    invoke<Target[]>(CHANNELS.saveTargets, wsId, [target("Blog"), target("News")]);
    expect(() => invoke(CHANNELS.renameTarget, wsId, "", "Journal")).toThrow(/oldName and newName are required/);
    expect(() => invoke(CHANNELS.renameTarget, wsId, "Blog", "   ")).toThrow(/oldName and newName are required/);
    expect(() => invoke(CHANNELS.renameTarget, wsId, "Missing", "Journal")).toThrow(/Target not found/);
    expect(() => invoke(CHANNELS.renameTarget, wsId, "Blog", "News")).toThrow(/already exists/);
  });

  it("surfaces an unknown workspace as a thrown Error", () => {
    expect(() => invoke(CHANNELS.listTargets, "nope")).toThrow(/Workspace not found/);
    expect(() => invoke(CHANNELS.saveTargets, "nope", [target("Blog")])).toThrow(/Workspace not found/);
    expect(() => invoke(CHANNELS.renameTarget, "nope", "Blog", "Journal")).toThrow(/Workspace not found/);
  });
});
