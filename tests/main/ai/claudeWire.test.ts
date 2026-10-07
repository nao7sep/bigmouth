// The Claude request as the real Anthropic SDK puts it on the wire. claude.test.ts
// replaces the SDK, so it sees the parameters handed to the client, not what the
// client sends; here the real SDK serializes the request and only fetch is fake,
// answering with a minimal event stream, so no call leaves the process.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@main/storageAccess.js", () => ({ writeProviderCall: async () => {} }));

import { ClaudeProvider } from "@main/core/ai/claude.js";

const CALL = { workspaceId: "ws", postId: "post", purpose: "analysis" } as const;
const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
const ADAPTIVE = { type: "adaptive", display: "summarized" };

// One text block, then end_turn, in the Messages streaming event shapes.
function eventStream(model: string, text: string): Response {
  const events = [
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  // Stubbed before each provider is built: the client takes the global fetch when constructed.
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function provider(model: string, thinking: string): ClaudeProvider {
  fetchMock.mockImplementation(async () => eventStream(model, '{"ok":true}'));
  return new ClaudeProvider("test-key", { endpoint: "https://api.anthropic.com", model, thinking }, CALL);
}

function sent(): { url: string; body: Record<string, unknown> } {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0]!;
  return { url: String(url), body: JSON.parse(String(init!.body)) };
}

describe("Claude request on the wire", () => {
  it("sends Sonnet adaptive summarized thinking, the chosen effort and the strict JSON format", async () => {
    await expect(provider("claude-sonnet-5-5", "high").generateJson("sys", "usr", SCHEMA)).resolves.toEqual({ ok: true });

    const { url, body } = sent();
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(body).toMatchObject({ model: "claude-sonnet-5-5", stream: true, system: "sys", messages: [{ role: "user", content: "usr" }] });
    expect(body.thinking).toEqual(ADAPTIVE);
    expect(body.output_config).toEqual({
      format: { type: "json_schema", schema: { ...SCHEMA, additionalProperties: false } },
      effort: "high",
    });
    expect(body).not.toHaveProperty("temperature");
  });

  it("sends Sonnet adaptive with no effort when none is chosen", async () => {
    const stream = provider("claude-sonnet-5-5", "adaptive").generateTextStream("sys", "usr", () => {});
    await expect(stream.finished).resolves.toBe('{"ok":true}');

    const { body } = sent();
    expect(body.thinking).toEqual(ADAPTIVE);
    expect(body).not.toHaveProperty("output_config");
    expect(body).not.toHaveProperty("temperature");
  });

  it("sends Haiku with thinking disabled and no effort", async () => {
    await expect(provider("claude-haiku-4-5", "off").generateJson("sys", "usr", SCHEMA)).resolves.toEqual({ ok: true });

    const { body } = sent();
    expect(body).toMatchObject({ model: "claude-haiku-4-5", stream: true });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.output_config).toEqual({ format: { type: "json_schema", schema: { ...SCHEMA, additionalProperties: false } } });
    expect(body).not.toHaveProperty("temperature");
  });
});
