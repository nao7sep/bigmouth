// Integration test for the metadata-generation IPC handler. Real services run
// against a throwaway BIGMOUTH_HOME + a registered workspace + a real post; only
// `electron` (ipcMain), the logger, and the AI factory are mocked. The fake
// provider lets each test drive `generateJson` to a controlled result or error,
// so the handler's success / no-active-config / invalid-field / post-not-found
// branches are all exercised without touching the network.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHANNELS, type MetadataGenerationResults } from "@shared/ipc";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

// A controllable fake AI provider. Each test sets `generateJsonImpl` to decide
// what the structured-output call returns (or throws).
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
import { deleteAiConfig, getAiConfigsForClient } from "@main/core/services/configStore.js";
import { registerMetadataHandlers } from "@main/ipc/metadata.js";

let home: string;
let dataDir: string;
let wsId: string;
let postId: string;

const SAVED_HOME = process.env.BIGMOUTH_HOME;
const SAVED_ANTHROPIC = process.env.ANTHROPIC_API_KEY;

function invoke(channel: string, ...args: unknown[]): Promise<MetadataGenerationResults> {
  return handlers.get(channel)!({}, ...args) as Promise<MetadataGenerationResults>;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-ipc-meta-"));
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
  updatePost(dataDir, postId, { content: "A draft about gardening in spring." });

  registerMetadataHandlers();
});

afterEach(() => {
  clearCache(dataDir);
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_HOME;
  else process.env.BIGMOUTH_HOME = SAVED_HOME;
  if (SAVED_ANTHROPIC === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = SAVED_ANTHROPIC;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("metadata generation IPC handler", () => {
  it("generates the requested fields from the structured AI response", async () => {
    ai.generateJsonImpl = () => ({
      title: "Spring Gardening",
      slug: "spring-gardening",
    });

    const results = await invoke(CHANNELS.generateMetadata, wsId, postId, ["title", "slug"], "");

    expect(results.title).toEqual({ value: "Spring Gardening" });
    expect(results.slug).toEqual({ value: "spring-gardening" });
    // No explicit content was passed, so the handler falls back to stored content.
    expect(ai.lastCall?.userContent).toContain("A draft about gardening in spring.");
  });

  it("joins array fields (tags) into a comma-separated client string", async () => {
    ai.generateJsonImpl = () => ({
      tags: ["spring", "garden", "soil", "planting", "seeds"],
    });

    const results = await invoke(CHANNELS.generateMetadata, wsId, postId, ["tags"], "");
    expect(results.tags).toEqual({ value: "spring, garden, soil, planting, seeds" });
  });

  it("prefers request content over stored content when supplied", async () => {
    ai.generateJsonImpl = () => ({ title: "From Request" });

    await invoke(CHANNELS.generateMetadata, wsId, postId, ["title"], "Live editor content here.");

    expect(ai.lastCall?.userContent).toContain("Live editor content here.");
    expect(ai.lastCall?.userContent).not.toContain("A draft about gardening in spring.");
  });

  it("marks non-generatable fields as errors without sending them to the model", async () => {
    ai.generateJsonImpl = () => ({ title: "Real Title" });

    const results = await invoke(CHANNELS.generateMetadata, wsId, postId, ["title", "bogusField"], "");

    expect(results.title).toEqual({ value: "Real Title" });
    expect(results.bogusField).toEqual({ error: "Field is not generatable: bogusField" });
    // The schema sent to the model must not include the bogus field.
    const schema = ai.lastCall?.schema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(["title"]);
  });

  it("returns only field errors when every requested field is non-generatable (no AI call)", async () => {
    ai.generateJsonImpl = () => {
      throw new Error("should not be called");
    };

    const results = await invoke(CHANNELS.generateMetadata, wsId, postId, ["nope", "alsoNope"], "");

    expect(results).toEqual({
      nope: { error: "Field is not generatable: nope" },
      alsoNope: { error: "Field is not generatable: alsoNope" },
    });
    expect(ai.lastCall).toBeNull();
  });

  it("throws when there is no active AI configuration", async () => {
    const ws = { id: wsId, name: "WS", dataDirectory: dataDir };
    for (const c of getAiConfigsForClient(ws).configs) deleteAiConfig(ws, c.id); // no configs → no active

    await expect(invoke(CHANNELS.generateMetadata, wsId, postId, ["title"], "")).rejects.toThrow(
      /No active AI configuration/i,
    );
  });

  it("throws when the post does not exist", async () => {
    await expect(invoke(CHANNELS.generateMetadata, wsId, "no-such-post", ["title"], "")).rejects.toThrow(
      /Post not found/i,
    );
  });

  it("throws when the workspace id is unknown", async () => {
    await expect(invoke(CHANNELS.generateMetadata, "bad-ws", postId, ["title"], "")).rejects.toThrow(
      /Workspace not found/i,
    );
  });

  it("validates that postId and fields[] are required", async () => {
    await expect(invoke(CHANNELS.generateMetadata, wsId, "", ["title"], "")).rejects.toThrow(
      /postId and fields\[\] are required/,
    );
    await expect(invoke(CHANNELS.generateMetadata, wsId, postId, [], "")).rejects.toThrow(
      /postId and fields\[\] are required/,
    );
  });

  it("records the AI error message per field when generation fails", async () => {
    ai.generateJsonImpl = () => {
      throw new Error("model exploded");
    };

    const results = await invoke(CHANNELS.generateMetadata, wsId, postId, ["title", "slug"], "");

    expect(results.title).toEqual({ error: "model exploded" });
    expect(results.slug).toEqual({ error: "model exploded" });
  });

  it("reports a per-field error when the structured response omits a requested field", async () => {
    // The response is missing `slug`; normalizeGeneratedMetadata throws, which the
    // handler converts into a per-field error for every requested field.
    ai.generateJsonImpl = () => ({ title: "Only Title" });

    const results = await invoke(CHANNELS.generateMetadata, wsId, postId, ["title", "slug"], "");

    expect("error" in results.title).toBe(true);
    expect("error" in results.slug).toBe(true);
  });

  it("propagates a provider-init failure as a thrown error", async () => {
    ai.createProviderThrows = new Error("API key is not configured");

    await expect(invoke(CHANNELS.generateMetadata, wsId, postId, ["title"], "")).rejects.toThrow(
      /API key is not configured/,
    );
  });
});
