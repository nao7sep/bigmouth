// What a provider call leaves in the records. The real Anthropic SDK builds and sends each request;
// only fetch is fake, so the recorded request is the one that would have gone on the wire. The key
// is a fake one, so no real credential is ever involved.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recorded = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("@main/storageAccess.js", () => ({
  writeProviderCall: async (call: Record<string, unknown>) => { recorded.push(call); },
}));

import { ClaudeProvider } from "@main/core/ai/claude.js";

const KEY = "sk-ant-fake-0123456789abcdef";
const CALL = { workspaceId: "ws", postId: "post", purpose: "analysis" } as const;
const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };

function events(stopReason: string, text: string): string {
  const all = [
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return all.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function stream(stopReason: string, text = '{"ok":true}'): Response {
  return new Response(events(stopReason, text), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  recorded.length = 0;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function provider(): ClaudeProvider {
  return new ClaudeProvider(KEY, { endpoint: "https://api.anthropic.com", model: "claude-haiku-4-5", thinking: "off" }, CALL);
}

/** The one record the call left, once its write has been handed over. */
async function onlyRecord(): Promise<Record<string, unknown>> {
  await vi.waitFor(() => expect(recorded).toHaveLength(1));
  return recorded[0]!;
}

describe("credentials in provider-call records", () => {
  it("masks the key in the recorded request, while the request sent still carries it", async () => {
    fetchMock.mockImplementation(async () => stream("end_turn"));
    await expect(provider().generateJson("sys", "usr", SCHEMA)).resolves.toEqual({ ok: true });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers(init!.headers).get("x-api-key")).toBe(KEY);

    const record = await onlyRecord();
    expect((record.request as { headers: Record<string, string> }).headers["x-api-key"]).toBe("[REDACTED]");
    expect(JSON.stringify(record)).not.toContain(KEY);
    expect(record.error).toBeUndefined();
  });

  it("masks the key where a failure echoes it", async () => {
    fetchMock.mockImplementation(async () => new Response(
      JSON.stringify({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` } }),
      { status: 401, headers: { "content-type": "application/json" } },
    ));
    await expect(provider().generateJson("sys", "usr", SCHEMA)).rejects.toThrow();

    const record = await onlyRecord();
    expect(record.error).toBeDefined();
    expect(JSON.stringify(record)).not.toContain(KEY);
    expect(JSON.stringify(record.error)).toContain("[REDACTED]");
  });
});
