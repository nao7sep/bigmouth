// Integration test for the imaging-generation IPC handler. Same harness as the
// metadata test: real services on a throwaway BIGMOUTH_HOME + a registered
// workspace + a real post, with only `electron`, the logger, and the AI factory
// mocked. The fake provider drives `generateJson` so the handler's success,
// invalid-option, no-active-config, post-not-found, and failure branches are all
// covered without the network.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHANNELS } from "@shared/ipc";
import type { ImagingOptions } from "@shared/types";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

const ai = vi.hoisted(() => ({
  generateJsonImpl: null as null | ((sys: string, user: string, schema: unknown, opts: unknown) => unknown),
  lastCall: null as null | { systemPrompt: string; userContent: string; schema: unknown; options: unknown },
  createProviderThrows: null as null | Error,
}));

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

vi.mock("@main/core/ai/factory.js", () => ({
  createProvider: () => {
    if (ai.createProviderThrows) throw ai.createProviderThrows;
    return {
      generateText: () => Promise.resolve(""),
      generateJson: (systemPrompt: string, userContent: string, schema: unknown, options: unknown) => {
        ai.lastCall = { systemPrompt, userContent, schema, options };
        if (!ai.generateJsonImpl) return Promise.resolve({});
        return Promise.resolve(ai.generateJsonImpl(systemPrompt, userContent, schema, options));
      },
      generateTextStream: () => ({ abort: () => {}, finished: Promise.resolve("") }),
    };
  },
}));

import { initAppDir, createWorkspace } from "@main/core/services/workspaceStore.js";
import { createPost, updatePost, clearCache } from "@main/core/services/postStore.js";
import { setActiveAiConfig } from "@main/core/services/configStore.js";
import { registerImagingHandlers } from "@main/ipc/imaging.js";

let home: string;
let dataDir: string;
let wsId: string;
let postId: string;

const SAVED_HOME = process.env.BIGMOUTH_HOME;
const SAVED_ANTHROPIC = process.env.ANTHROPIC_API_KEY;

// A valid baseline set of options; tests clone and tweak it.
function validOptions(): ImagingOptions {
  return {
    count: 3,
    relation: "direct",
    emotionalLens: "calm",
    literalness: "literal",
    people: "no-people",
    style: "photo",
  };
}

function invoke(channel: string, ...args: unknown[]): Promise<string[]> {
  return handlers.get(channel)!({}, ...args) as Promise<string[]>;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-ipc-imaging-"));
  process.env.BIGMOUTH_HOME = home;
  delete process.env.ANTHROPIC_API_KEY;
  initAppDir();
  handlers.clear();
  ai.generateJsonImpl = null;
  ai.lastCall = null;
  ai.createProviderThrows = null;

  const ws = createWorkspace("WS");
  wsId = ws.id;
  dataDir = ws.dataDirectory;

  const post = createPost(dataDir, "blogger", "en");
  postId = post.frontMatter.id;
  updatePost(dataDir, postId, { content: "A reflective post about quiet mornings." });

  registerImagingHandlers();
});

afterEach(() => {
  clearCache(dataDir);
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_HOME;
  else process.env.BIGMOUTH_HOME = SAVED_HOME;
  if (SAVED_ANTHROPIC === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = SAVED_ANTHROPIC;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("imaging generation IPC handler", () => {
  it("returns the normalized prompt list on success", async () => {
    ai.generateJsonImpl = () => ({
      items: ["A quiet sunrise over still water", "An empty cup on a wooden table", "Soft light through a curtain"],
    });

    const items = await invoke(CHANNELS.generateImaging, wsId, postId, "", validOptions());

    expect(items).toEqual([
      "A quiet sunrise over still water",
      "An empty cup on a wooden table",
      "Soft light through a curtain",
    ]);
    // No request content → stored content used in the user prompt.
    expect(ai.lastCall?.userContent).toContain("A reflective post about quiet mornings.");
    // The schema's array bounds match the requested count.
    const schema = ai.lastCall?.schema as { properties: { items: { minItems: number; maxItems: number } } };
    expect(schema.properties.items.minItems).toBe(3);
    expect(schema.properties.items.maxItems).toBe(3);
  });

  it("prefers request content over stored content when supplied", async () => {
    ai.generateJsonImpl = () => ({ items: ["a", "b", "c"].map((s) => `prompt for ${s}`) });

    await invoke(CHANNELS.generateImaging, wsId, postId, "Live editor body for imaging.", validOptions());

    expect(ai.lastCall?.userContent).toContain("Live editor body for imaging.");
    expect(ai.lastCall?.userContent).not.toContain("A reflective post about quiet mornings.");
  });

  it("rejects an out-of-set option value before reaching the model", async () => {
    ai.generateJsonImpl = () => {
      throw new Error("should not be called");
    };
    const options = { ...validOptions(), style: "watercolor" } as unknown as ImagingOptions;

    await expect(invoke(CHANNELS.generateImaging, wsId, postId, "", options)).rejects.toThrow(
      /Invalid imaging option\(s\): style/,
    );
    expect(ai.lastCall).toBeNull();
  });

  it("rejects an invalid count value", async () => {
    const options = { ...validOptions(), count: 7 } as unknown as ImagingOptions;
    await expect(invoke(CHANNELS.generateImaging, wsId, postId, "", options)).rejects.toThrow(
      /Invalid imaging option\(s\): count/,
    );
  });

  it("lists every invalid option dimension in the error", async () => {
    const options = {
      count: 99,
      relation: "x",
      emotionalLens: "y",
      literalness: "z",
      people: "w",
      style: "v",
    } as unknown as ImagingOptions;

    await expect(invoke(CHANNELS.generateImaging, wsId, postId, "", options)).rejects.toThrow(
      /count, relation, emotionalLens, literalness, people, style/,
    );
  });

  it("throws when there is no active AI configuration", async () => {
    const ws = { id: wsId, name: "WS", dataDirectory: dataDir };
    setActiveAiConfig(ws, "");

    await expect(invoke(CHANNELS.generateImaging, wsId, postId, "", validOptions())).rejects.toThrow(
      /No active AI configuration/i,
    );
  });

  it("throws when the post does not exist", async () => {
    await expect(invoke(CHANNELS.generateImaging, wsId, "no-such-post", "", validOptions())).rejects.toThrow(
      /Post not found/i,
    );
  });

  it("throws when postId is missing", async () => {
    await expect(invoke(CHANNELS.generateImaging, wsId, "", "", validOptions())).rejects.toThrow(
      /postId is required/,
    );
  });

  it("throws when the workspace id is unknown", async () => {
    await expect(invoke(CHANNELS.generateImaging, "bad-ws", postId, "", validOptions())).rejects.toThrow(
      /Workspace not found/i,
    );
  });

  it("rethrows the provider error message on a generation failure", async () => {
    ai.generateJsonImpl = () => {
      throw new Error("imaging model failed");
    };

    await expect(invoke(CHANNELS.generateImaging, wsId, postId, "", validOptions())).rejects.toThrow(
      /imaging model failed/,
    );
  });

  it("rethrows when the normalized output count does not match the requested count", async () => {
    // Only two items returned for a count of three → normalizeImagingOutput throws,
    // and the handler rethrows the message.
    ai.generateJsonImpl = () => ({ items: ["one", "two"] });

    await expect(invoke(CHANNELS.generateImaging, wsId, postId, "", validOptions())).rejects.toThrow(
      /2 prompts instead of 3/,
    );
  });

  it("propagates a provider-init failure as a thrown error", async () => {
    ai.createProviderThrows = new Error("API key is not configured");

    await expect(invoke(CHANNELS.generateImaging, wsId, postId, "", validOptions())).rejects.toThrow(
      /API key is not configured/,
    );
  });
});
