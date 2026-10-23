import { EventEmitter } from "node:events";
// Integration test for the metadata-generation IPC handler. Real services run
// against a throwaway BIGMOUTH_DATA_DIR + a registered workspace + a real post; only
// `electron` (ipcMain), the logger, and the AI factory are mocked. The fake
// provider lets each test drive `generateJson` to a controlled result or error,
// so the handler's success / no-active-config / invalid-field / post-not-found
// branches are all exercised without touching the network.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHANNELS, type MetadataGenerationResults } from "@shared/ipc";

import * as logger from "@main/core/services/logger.js";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

// A controllable fake AI provider. Each test sets `generateJsonImpl` to decide
// what the structured-output call returns (or throws).
const ai = vi.hoisted(() => ({
  generateJsonImpl: null as null | ((sys: string, user: string, schema: unknown, opts: unknown) => unknown),
  lastCall: null as null | { systemPrompt: string; userContent: string; schema: unknown; options: unknown },
  createProviderThrows: null as null | Error,
  roleCall: null as unknown,
  context: null as unknown,
}));

vi.mock("@main/storageAccess.js", async () => {
  const workspaceStore = await import("@main/core/services/workspaceStore.js");
  const postStore = await import("@main/core/services/postStore.js");
  const configStore = await import("@main/core/services/configStore.js");
  return {
    getWorkspace: async (...args: Parameters<typeof workspaceStore.getWorkspace>) => workspaceStore.getWorkspace(...args),
    getPost: async (...args: Parameters<typeof postStore.getPost>) => postStore.getPost(...args),
    getGenerationPrompts: async (...args: Parameters<typeof configStore.getGenerationPrompts>) => configStore.getGenerationPrompts(...args),
    getRoleCall: async (...args: Parameters<typeof configStore.getRoleCall>) => configStore.getRoleCall(...args),
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
  info: vi.fn(),
  warn: () => {},
  error: vi.fn(),
  serializeError: (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
}));

vi.mock("@main/core/ai/factory.js", () => ({
  createProvider: (roleCall: unknown, context: unknown) => {
    ai.context = context;
    ai.roleCall = roleCall;
    if (ai.createProviderThrows) throw ai.createProviderThrows;
    return {
      generateJson: (systemPrompt: string, userContent: string, schema: unknown, options: unknown) => {
        ai.lastCall = { systemPrompt, userContent, schema, options };
        if (!ai.generateJsonImpl) return Promise.resolve({});
        return Promise.resolve(ai.generateJsonImpl(systemPrompt, userContent, schema, options));
      },
      generateTextStream: () => ({ abort: () => {}, finished: Promise.resolve("") }),
    };
  },
}));

import { initAppDir, createWorkspace, approveAiEndpoint } from "@main/core/services/workspaceStore.js";
import { createPost, updatePost, clearCache } from "@main/core/services/postStore.js";
import { saveAnthropicSettings } from "@main/core/services/configStore.js";
import { registerAiRequestHandlers } from "@main/ipc/aiRequests.js";
import { registerMetadataHandlers } from "@main/ipc/metadata.js";

let home: string;
let dataDir: string;
let wsId: string;
let postId: string;

const SAVED_HOME = process.env.BIGMOUTH_DATA_DIR;
const SAVED_ANTHROPIC = process.env.ANTHROPIC_API_KEY;

function invoke(channel: string, ...args: unknown[]): Promise<MetadataGenerationResults> {
  return handlers.get(channel)!(fakeEvent, "req-1", ...args) as Promise<MetadataGenerationResults>;
}

// The window the request comes from, as the AI request registry sees it.
let nextOwnerId = 1000;
let fakeEvent: { sender: EventEmitter & { id: number } };

/** The renderer's abort for request "req-1", as it arrives on the shared channel. */
function sendAbort(): void {
  handlers.get(CHANNELS.aiRequestAbort)!(fakeEvent, "req-1");
}

beforeEach(() => {
  vi.mocked(logger.info).mockClear();
  vi.mocked(logger.error).mockClear();
  fakeEvent = { sender: Object.assign(new EventEmitter(), { id: nextOwnerId++ }) };
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-ipc-meta-"));
  process.env.BIGMOUTH_DATA_DIR = home;
  delete process.env.ANTHROPIC_API_KEY;
  initAppDir();
  handlers.clear();
  ai.generateJsonImpl = null;
  ai.lastCall = null;
  ai.createProviderThrows = null;
  ai.roleCall = null;
  ai.context = null;

  const ws = createWorkspace("WS");
  wsId = ws.id;
  dataDir = ws.dataDirectory;

  const post = createPost(dataDir, "blogger", "en");
  postId = post.frontMatter.id;
  updatePost(dataDir, postId, { content: "A draft about gardening in spring." });

  registerMetadataHandlers();
  registerAiRequestHandlers();
});

afterEach(() => {
  clearCache(dataDir);
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_DATA_DIR;
  else process.env.BIGMOUTH_DATA_DIR = SAVED_HOME;
  if (SAVED_ANTHROPIC === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = SAVED_ANTHROPIC;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("metadata generation IPC handler", () => {
  // The renderer's abort must reach the paid call itself, not only
  // stop the renderer waiting for it.
  it.each(["abort", "reload"])("cancels the paid call on renderer %s", async (cause) => {
    let signal: AbortSignal | undefined;
    ai.generateJsonImpl = (_s, _u, _schema, opts) => {
      signal = (opts as { signal?: AbortSignal }).signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    };

    const pending = invoke(CHANNELS.generateMetadata, wsId, postId, ["title"], "");
    await vi.waitFor(() => expect(signal).toBeDefined());
    if (cause === "abort") sendAbort();
    else fakeEvent.sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });

    expect(signal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow(/cancelled/);
  });

  it.each(["abort", "reload"])("cancels during storage lookup on renderer %s before starting a paid call", async (cause) => {
    const generate = vi.fn(() => ({}));
    ai.generateJsonImpl = generate;
    const pending = invoke(CHANNELS.generateMetadata, wsId, postId, ["title"], "");
    if (cause === "abort") sendAbort();
    else fakeEvent.sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(generate).not.toHaveBeenCalled();
  });

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

  it.each(["tags", "tagsEn"])("returns %s as an array preserving punctuation inside each tag", async (field) => {
    updatePost(dataDir, postId, { frontMatter: { language: "ja" } });
    const tags = ["spring, garden", "soil、planting", "seeds", "watering", "growth"];
    ai.generateJsonImpl = () => ({ [field]: tags });

    const results = await invoke(CHANNELS.generateMetadata, wsId, postId, [field], "");
    expect(results[field]).toEqual({ value: tags });
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

  it("routes the call by its role, with that role's model and thinking", async () => {
    const ws = { id: wsId, name: "WS", dataDirectory: dataDir };
    saveAnthropicSettings(ws, {
      endpoint: "https://proxy.example",
      models: { analysis: "claude-opus-5-5", metadata: "claude-haiku-4-5", imagingPrompts: "claude-sonnet-5-5" },
      thinking: { analysis: "max", metadata: "off", imagingPrompts: "between_tools" },
      apiKey: "sk-ws",
    });
    approveAiEndpoint(wsId, "https://proxy.example");

    await invoke(CHANNELS.generateMetadata, wsId, postId, ["title"], "");

    expect(ai.roleCall).toEqual({
      endpoint: "https://proxy.example",
      model: "claude-haiku-4-5",
      thinking: "off",
      apiKey: "sk-ws",
    });
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
    expect(logger.error).toHaveBeenCalledWith("Metadata generation failed", expect.objectContaining({ operationId: "req-1", workspaceId: wsId, postId, error: expect.objectContaining({ message: "model exploded" }) }));
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

it("logs correlated metadata summaries while sending full prompt and schema to the provider", async () => {
  ai.generateJsonImpl = () => ({ title: "PRIVATE_RESULT" });
  const result = await invoke(CHANNELS.generateMetadata, wsId, postId, ["title"], "PRIVATE_CONTENT");
  expect(result.title).toEqual({ value: "PRIVATE_RESULT" });
  expect(ai.lastCall?.userContent).toContain("PRIVATE_CONTENT");
  expect(ai.lastCall?.schema).toBeDefined();
  expect(ai.context).toEqual({ operationId: "req-1", workspaceId: wsId, postId, purpose: "metadata" });
  const events = vi.mocked(logger.info).mock.calls.filter(([name]) => name.startsWith("metadata generation "));
  expect(events.map(([name]) => name)).toEqual(["metadata generation started", "metadata generation completed"]);
  for (const [, fields] of events) {
    expect(fields).toMatchObject({ operationId: "req-1", workspace: wsId, postId });
    for (const key of ["systemPrompt", "userContent", "frontMatter", "schema", "result"]) expect(fields).not.toHaveProperty(key);
  }
  expect(events[0][1]).toMatchObject({ contentLength: "PRIVATE_CONTENT".length, fields: ["title"] });
  expect(events[1][1]).toMatchObject({ itemCount: 1 });
  expect(JSON.stringify(events)).not.toContain("PRIVATE_");
});

it("correlates metadata provider initialization diagnostics and masks echoed credentials", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-operation-secret";
  ai.createProviderThrows = new Error("Initialization rejected sk-operation-secret");
  await expect(invoke(CHANNELS.generateMetadata, wsId, postId, ["title"], "")).rejects.toThrow("Initialization rejected [REDACTED]");
  expect(logger.error).toHaveBeenCalledWith("metadata generation provider init failed", expect.objectContaining({ operationId: "req-1", workspaceId: wsId, postId, error: expect.objectContaining({ message: "Initialization rejected [REDACTED]" }) }));
  expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("sk-operation-secret");
});
