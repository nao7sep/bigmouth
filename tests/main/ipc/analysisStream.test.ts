import { describe, it, expect, beforeEach, vi } from "vitest";
import { CHANNELS, analysisStreamChannel, type AnalysisStreamFrame } from "@shared/ipc";

// Captured IPC registrations + a controllable fake provider stream. Hoisted so
// the (hoisted) vi.mock factories below can close over them.
const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
}));

const provider = vi.hoisted(() => ({
  onText: null as null | ((delta: string) => void),
  abort: null as null | (() => void),
  resolveFinished: null as null | ((text: string) => void),
  rejectFinished: null as null | ((err: unknown) => void),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, cb: (...args: unknown[]) => unknown) => ipc.handlers.set(channel, cb),
    on: (channel: string, cb: (...args: unknown[]) => unknown) => ipc.listeners.set(channel, cb),
  },
}));

vi.mock("@main/ipc/context.js", () => ({
  resolveWorkspace: () => ({ dataDirectory: "/ws" }),
}));

vi.mock("@main/core/services/postStore.js", () => ({
  getPost: () => ({
    frontMatter: { id: "p1", target: "blogger", status: "draft", language: "en", createdAtUtc: "x", updatedAtUtc: "x" },
    content: "stored body",
    filePath: "/ws/posts/p1.md",
  }),
}));

vi.mock("@main/core/services/configStore.js", () => ({
  getAnalysisPrompts: () => [{ name: "P", text: "Analyze: {content}" }],
  getActiveAiConfig: () => ({ id: "c1", name: "cfg", provider: "claude", model: "m", apiKey: "k" }),
}));

vi.mock("@main/core/ai/promptTemplates.js", () => ({
  resolvePromptRequest: () => ({ systemPrompt: "sys", userContent: "user" }),
  usesContentPlaceholder: () => true,
}));

vi.mock("@main/core/ai/factory.js", () => ({
  createProvider: () => ({
    generateText: () => Promise.resolve(""),
    generateJson: () => Promise.resolve({}),
    generateTextStream: (_sys: string, _user: string, onText: (delta: string) => void) => {
      provider.onText = onText;
      provider.abort = vi.fn();
      return {
        abort: provider.abort,
        finished: new Promise<string>((resolve, reject) => {
          provider.resolveFinished = resolve;
          provider.rejectFinished = reject;
        }),
      };
    },
  }),
}));

vi.mock("@main/core/ai/errorDetails.js", () => ({
  describeAiError: () => ({}),
  logAiFailure: () => "ai failure",
}));

vi.mock("@main/core/shared/logSummaries.js", () => ({
  metadataKeys: () => [],
  safeAiConfigLogContext: () => ({}),
  safePostLogContext: () => ({}),
}));

vi.mock("@main/core/services/logger.js", () => ({
  info: () => {},
  warn: () => {},
  error: () => {},
}));

const { registerAnalysisHandlers } = await import("@main/ipc/analysis.js");

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function makeEvent() {
  return { sender: { isDestroyed: () => false, send: vi.fn() } };
}

function framesFor(event: ReturnType<typeof makeEvent>, channel: string): AnalysisStreamFrame[] {
  return event.sender.send.mock.calls
    .filter(([ch]) => ch === channel)
    .map(([, frame]) => frame as AnalysisStreamFrame);
}

const params = { wsId: "w", postId: "p1", promptName: "P", content: "live content" };

let start: (...args: unknown[]) => unknown;
let abort: (...args: unknown[]) => unknown;

beforeEach(() => {
  ipc.handlers.clear();
  ipc.listeners.clear();
  provider.onText = null;
  provider.abort = null;
  provider.resolveFinished = null;
  provider.rejectFinished = null;
  registerAnalysisHandlers();
  start = ipc.handlers.get(CHANNELS.analysisStreamStart)!;
  abort = ipc.listeners.get(CHANNELS.analysisStreamAbort)!;
});

describe("analysis stream handlers", () => {
  it("forwards deltas then a done frame on normal completion", async () => {
    const event = makeEvent();
    const channel = analysisStreamChannel("req-done");
    start(event, "req-done", params);

    provider.onText!("Hello ");
    provider.onText!("world");
    provider.resolveFinished!("Hello world");
    await tick();

    expect(framesFor(event, channel)).toEqual([
      { type: "delta", text: "Hello " },
      { type: "delta", text: "world" },
      { type: "done" },
    ]);
  });

  it("aborting an active stream cancels the provider and suppresses later frames", async () => {
    const event = makeEvent();
    const channel = analysisStreamChannel("req-abort");
    start(event, "req-abort", params);

    provider.onText!("partial");
    abort(undefined, "req-abort");

    expect(provider.abort).toHaveBeenCalledTimes(1);

    // Anything the provider emits after the abort must be dropped, and no done
    // or error frame may follow.
    provider.onText!("late delta");
    provider.resolveFinished!("partial late delta");
    await tick();

    expect(framesFor(event, channel)).toEqual([{ type: "delta", text: "partial" }]);
  });

  it("ignores an abort for an unknown or already-finished request without throwing", async () => {
    const event = makeEvent();
    const channel = analysisStreamChannel("req-finish");
    start(event, "req-finish", params);
    provider.resolveFinished!("all done");
    await tick();

    // The stream already completed and was removed; a late abort is a clean no-op
    // — no throw, no extra provider.abort, no leaked pending-abort state.
    expect(() => abort(undefined, "req-finish")).not.toThrow();
    expect(() => abort(undefined, "never-existed")).not.toThrow();
    expect(provider.abort).not.toHaveBeenCalled();
    expect(framesFor(event, channel).some((f) => f.type === "done")).toBe(true);
  });

  it("sends an error frame when the provider stream rejects", async () => {
    const event = makeEvent();
    const channel = analysisStreamChannel("req-err");
    start(event, "req-err", params);

    provider.rejectFinished!(new Error("provider exploded"));
    await tick();

    expect(framesFor(event, channel)).toEqual([{ type: "error", message: "provider exploded" }]);
  });
});
