// Real handlers, provider, SDK and diagnostic sinks; only storage lookup, Electron
// and HTTP are substituted. A supported custom endpoint can echo the sent key.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CHANNELS, type AnalysisStreamFrame } from "@shared/ipc";
import { registerAnalysisHandlers } from "@main/ipc/analysis.js";
import { registerMetadataHandlers } from "@main/ipc/metadata.js";
import { registerImagingHandlers } from "@main/ipc/imaging.js";
import { initLogger, closeLogger } from "@main/core/services/logger.js";

const fixture = vi.hoisted(() => ({
  key: "sk-ant-fake-diagnostic-sentinel-12345",
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  calls: [] as unknown[],
}));
vi.mock("electron", () => ({ ipcMain: {
  handle: (channel: string, callback: (...args: unknown[]) => unknown) => fixture.handlers.set(channel, callback),
} }));
vi.mock("@main/ipc/context.js", () => ({ resolveWorkspace: async () => ({ id: "ws", dataDirectory: "/fixture" }) }));
vi.mock("@main/storageAccess.js", () => ({
  getPost: async () => ({ content: "stored draft", frontMatter: { id: "post", language: "en", target: "blog", title: "Title" } }),
  getAnalysisPrompts: async () => [{ name: "Check", text: "Check the draft." }],
  getGenerationPrompts: async () => ({ prompts: { title: "Write a title." } }),
  getRoleCall: async () => ({ apiKey: fixture.key, endpoint: "https://custom.example.test", model: "claude-haiku-4-5", thinking: "off" }),
  writeProviderCall: async (call: unknown) => { fixture.calls.push(call); },
}));

const fetchMock = vi.fn<typeof fetch>();
let home: string;
let ownerId = 0;
let output: string[];
beforeEach(() => {
  fixture.handlers.clear();
  fixture.calls.length = 0;
  registerAnalysisHandlers();
  registerMetadataHandlers();
  registerImagingHandlers();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-ai-diagnostics-"));
  initLogger(path.join(home, "records.sqlite3"), path.join(home, "logs"));
  output = [];
  vi.spyOn(console, "log").mockImplementation((...args) => { output.push(JSON.stringify(args)); });
  vi.spyOn(console, "error").mockImplementation((...args) => { output.push(JSON.stringify(args)); });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  closeLogger();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(home, { recursive: true, force: true });
});

function response(text: string): Response {
  const events = [
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200, headers: { "content-type": "text/event-stream" },
  });
}

async function invoke(kind: "analysis" | "metadata" | "imaging"): Promise<unknown> {
  const frames: AnalysisStreamFrame[] = [];
  const event = { sender: {
    id: ++ownerId, once: () => {}, on: () => {}, isDestroyed: () => false,
    send: (_channel: string, frame: AnalysisStreamFrame) => { frames.push(frame); },
  } };
  // A previous response may have been copied into the draft; input logs must mask
  // it too, while the live request is unchanged.
  const draft = `Draft mentioning ${fixture.key}`;
  if (kind === "analysis") {
    await fixture.handlers.get(CHANNELS.analysisStreamStart)!(event, "req", { wsId: "ws", postId: "post", promptName: "Check", content: draft });
    await vi.waitFor(() => expect(frames.some(frame => frame.type === "done" || frame.type === "error")).toBe(true));
    return frames;
  }
  if (kind === "metadata") return fixture.handlers.get(CHANNELS.generateMetadata)!(event, "req", "ws", "post", ["title"], draft);
  return fixture.handlers.get(CHANNELS.generateImaging)!(event, "req", "ws", "post", draft, {
    count: 3, relation: "direct", emotionalLens: "calm", literalness: "literal", people: "no-people", style: "photo",
  });
}

function logs(): Record<string, unknown>[] {
  const db = new DatabaseSync(path.join(home, "records.sqlite3"), { readOnly: true });
  try {
    return (db.prepare("SELECT event FROM log_records ORDER BY id").all() as { event: string }[]).map(row => JSON.parse(row.event));
  } finally { db.close(); }
}

function expectMaskedDiagnostics(): void {
  const stored = JSON.stringify(logs());
  expect(stored).toContain("[REDACTED]");
  expect(stored).not.toContain(fixture.key);
  expect(output.join("\n")).not.toContain(fixture.key);
  expect(JSON.stringify(fixture.calls)).not.toContain(fixture.key);
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(String(url)).toContain("custom.example.test");
  expect(new Headers(init!.headers).get("x-api-key")).toBe(fixture.key);
  expect(String(init!.body)).toContain(fixture.key);
}

describe.each(["analysis", "metadata", "imaging"] as const)("%s credential diagnostics", kind => {
  it("masks echoed SDK failures before database, console and error presentation", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({
      type: "error", error: { type: "authentication_error", message: `Invalid key ${fixture.key}` },
    }), { status: 401, headers: { "content-type": "application/json", "request-id": "request-1" } }));
    const result = await invoke(kind).catch((error: unknown) => ({ error: error instanceof Error ? error.message : error }));
    expect(JSON.stringify(result)).toContain("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain(fixture.key);
    const failure = logs().find(line => line.level === "error")!;
    expect(failure.status).toBe(401);
    expect(failure.providerRequestId).toBe("request-1");
    expect(failure.error).toMatchObject({ name: "Error", stack: expect.any(String), message: expect.stringContaining("[REDACTED]") });
    expectMaskedDiagnostics();
  });

  it("masks echoed success logs without changing the generated output", async () => {
    const text = kind === "analysis" ? `Answer ${fixture.key}` : kind === "metadata"
      ? JSON.stringify({ title: `Title ${fixture.key}` })
      : JSON.stringify({ items: [`First ${fixture.key}`, "Second prompt", "Third prompt"] });
    fetchMock.mockImplementation(async () => response(text));
    const result = await invoke(kind);
    expect(JSON.stringify(result)).toContain(fixture.key);
    expect(logs().some(line => String(line.message).endsWith("completed"))).toBe(true);
    expectMaskedDiagnostics();
  });
});
