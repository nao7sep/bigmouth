// Unit test for the Claude provider — the thin wrapper over the Anthropic
// Messages SDK. The SDK is fully mocked (a fake Anthropic client whose
// messages.{create,stream} are vi.fns the tests drive), so this asserts the
// request mapping (model, max_tokens, thinking, system split, output_config),
// response extraction (text blocks, parsed_output), streaming (text + thinking
// deltas, finalMessage), and the stop-reason / null error handling — without any
// real network or API key.
//
// The fake deliberately exposes NO `messages.parse`: generateJson streams, because
// the SDK refuses a non-streaming request whose max_tokens could run long. A
// regression back to parse fails here loudly rather than silently capping the
// user's budget.

import { describe, it, expect, beforeEach, vi } from "vitest";

// The fake SDK surface. Hoisted so the vi.mock factory can close over it.
const sdk = vi.hoisted(() => ({
  ctorArgs: null as null | { apiKey: string },
  create: vi.fn(),
  stream: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages: { create: typeof sdk.create; stream: typeof sdk.stream };
    constructor(opts: { apiKey: string }) {
      sdk.ctorArgs = opts;
      this.messages = { create: sdk.create, stream: sdk.stream };
    }
  }
  return { default: FakeAnthropic };
});

// jsonSchemaOutputFormat is an opaque marker for the format; the real SDK helper
// wraps the schema. We make it identifiable so generateJson's request mapping can
// be asserted.
vi.mock("@anthropic-ai/sdk/helpers/json-schema", () => ({
  jsonSchemaOutputFormat: (schema: unknown) => ({ __outputFormat: schema }),
}));

import { ClaudeProvider, type ClaudeRequest } from "@main/core/ai/claude.js";

// The model fields a provider is built from. A test names only what it asserts.
function req(model = "m", over: Partial<ClaudeRequest> = {}): ClaudeRequest {
  return { model, thinking: false, maxTokens: 4096, ...over };
}

// Builds an SDK-shaped message with the given text blocks + stop reason.
function message(opts: {
  text?: string;
  blocks?: Array<{ type: string; text?: string }>;
  stop_reason?: string | null;
  parsed_output?: unknown;
}) {
  const blocks = opts.blocks ?? (opts.text !== undefined ? [{ type: "text", text: opts.text }] : []);
  return {
    content: blocks,
    stop_reason: opts.stop_reason ?? "end_turn",
    ...(opts.parsed_output !== undefined ? { parsed_output: opts.parsed_output } : {}),
  };
}

// A minimal fake of the SDK MessageStream: collects "text"/"thinking" listeners,
// lets the test drive finalMessage(), and exposes the abort spy. Shared by the
// generateJson and generateTextStream suites — both stream.
function fakeStream() {
  const textListeners: Array<(delta: string) => void> = [];
  const thinkingListeners: Array<(delta: string) => void> = [];
  let resolveFinal!: (msg: unknown) => void;
  let rejectFinal!: (err: unknown) => void;
  const finalMessagePromise = new Promise<unknown>((resolve, reject) => {
    resolveFinal = resolve;
    rejectFinal = reject;
  });
  const abort = vi.fn();
  const handle = {
    on(event: string, cb: (delta: string) => void) {
      if (event === "text") textListeners.push(cb);
      if (event === "thinking") thinkingListeners.push(cb);
      return handle;
    },
    finalMessage: () => finalMessagePromise,
    abort,
  };
  return {
    handle,
    abort,
    emitText: (delta: string) => textListeners.forEach((cb) => cb(delta)),
    emitThinking: (delta: string) => thinkingListeners.forEach((cb) => cb(delta)),
    thinkingListenerCount: () => thinkingListeners.length,
    resolveFinal: (msg: unknown) => resolveFinal(msg),
    rejectFinal: (err: unknown) => rejectFinal(err),
  };
}

beforeEach(() => {
  sdk.ctorArgs = null;
  sdk.create.mockReset();
  sdk.stream.mockReset();
});

describe("ClaudeProvider construction", () => {
  it("passes the api key to the Anthropic client", () => {
    new ClaudeProvider("sk-test", req("claude-test-model"));
    expect(sdk.ctorArgs).toEqual({ apiKey: "sk-test" });
  });
});

// Thinking is never left to the model's default: the same omission means "off" on
// one model and "adaptive" on another, so the request always says which it wants.
describe("thinking parameter", () => {
  it("asks for adaptive thinking with a summarized display when thinking is on", async () => {
    sdk.create.mockResolvedValue(message({ text: "ok" }));
    await new ClaudeProvider("k", req("m", { thinking: true })).generateText("s", "u");

    expect(sdk.create.mock.calls[0][0].thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    });
  });

  it("disables thinking explicitly when thinking is off", async () => {
    sdk.create.mockResolvedValue(message({ text: "ok" }));
    await new ClaudeProvider("k", req("m", { thinking: false })).generateText("s", "u");

    expect(sdk.create.mock.calls[0][0].thinking).toEqual({ type: "disabled" });
  });

  it("states thinking on every route, not just free-text generation", async () => {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const provider = new ClaudeProvider("k", req("m", { thinking: true }));

    provider.generateTextStream("s", "u", () => {});
    void provider.generateJson("s", "u", { type: "object" });

    for (const call of sdk.stream.mock.calls) {
      expect(call[0].thinking).toEqual({ type: "adaptive", display: "summarized" });
    }
  });
});

describe("generateText", () => {
  it("maps the request and joins text blocks from the response", async () => {
    sdk.create.mockResolvedValue(
      message({ blocks: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }] }),
    );
    const provider = new ClaudeProvider("k", req("my-model", { maxTokens: 777 }));

    const text = await provider.generateText("Be brief.", "Say hi.");

    expect(text).toBe("Hello world");
    const body = sdk.create.mock.calls[0][0];
    expect(body.model).toBe("my-model");
    expect(body.messages).toEqual([{ role: "user", content: "Say hi." }]);
    expect(body.system).toBe("Be brief.");
    // The budget is the config's, not a constant baked into the provider.
    expect(body.max_tokens).toBe(777);
  });

  it("omits the system parameter when the system prompt is empty", async () => {
    sdk.create.mockResolvedValue(message({ text: "ok" }));
    const provider = new ClaudeProvider("k", req());

    await provider.generateText("", "user only");

    expect("system" in sdk.create.mock.calls[0][0]).toBe(false);
  });

  it("ignores non-text content blocks when extracting the response text", async () => {
    sdk.create.mockResolvedValue(
      message({
        blocks: [
          { type: "thinking", text: "internal" },
          { type: "text", text: "visible" },
        ],
      }),
    );
    const provider = new ClaudeProvider("k", req());

    expect(await provider.generateText("s", "u")).toBe("visible");
  });

  it("throws when the response was truncated at the output token limit", async () => {
    sdk.create.mockResolvedValue(message({ text: "partial", stop_reason: "max_tokens" }));
    const provider = new ClaudeProvider("k", req());

    await expect(provider.generateText("s", "u")).rejects.toThrow(/output token limit/i);
  });

  it("throws when the request was refused", async () => {
    sdk.create.mockResolvedValue(message({ text: "", stop_reason: "refusal" }));
    const provider = new ClaudeProvider("k", req());

    await expect(provider.generateText("s", "u")).rejects.toThrow(/refused/i);
  });

  it("throws when the response carries no text", async () => {
    sdk.create.mockResolvedValue(message({ blocks: [{ type: "thinking", text: "x" }] }));
    const provider = new ClaudeProvider("k", req());

    await expect(provider.generateText("s", "u")).rejects.toThrow(/Unexpected response type/);
  });
});

describe("generateJson", () => {
  const schema = { type: "object", properties: { a: { type: "string" } } };

  // Resolves generateJson by driving the fake stream's finalMessage.
  function jsonRun(provider: ClaudeProvider, msg: unknown, options?: Parameters<ClaudeProvider["generateJson"]>[3]) {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const promise = provider.generateJson("sys", "usr", schema, options);
    f.resolveFinal(msg);
    return promise;
  }

  it("maps the request with the schema output format and forwards request options", async () => {
    const provider = new ClaudeProvider("k", req("json-model", { maxTokens: 555 }));

    const result = await jsonRun(provider, message({ parsed_output: { a: "b" }, stop_reason: "end_turn" }), {
      timeoutMs: 1234,
      maxRetries: 2,
    });

    expect(result).toEqual({ a: "b" });

    const [body, requestOptions] = sdk.stream.mock.calls[0];
    expect(body.model).toBe("json-model");
    expect(body.max_tokens).toBe(555);
    expect(body.messages).toEqual([{ role: "user", content: "usr" }]);
    expect(body.system).toBe("sys");
    // The schema is wrapped by the (mocked) jsonSchemaOutputFormat helper.
    expect(body.output_config).toEqual({ format: { __outputFormat: schema } });
    expect(requestOptions).toEqual({ timeout: 1234, maxRetries: 2, signal: undefined });
  });

  it("takes its budget from the config rather than a per-call default", async () => {
    const provider = new ClaudeProvider("k", req("m", { maxTokens: 31337 }));

    await jsonRun(provider, message({ parsed_output: {}, stop_reason: "end_turn" }));

    expect(sdk.stream.mock.calls[0][0].max_tokens).toBe(31337);
  });

  it("omits the system parameter when the system prompt is empty", async () => {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const provider = new ClaudeProvider("k", req());

    const promise = provider.generateJson("", "usr", schema);
    f.resolveFinal(message({ parsed_output: {}, stop_reason: "end_turn" }));
    await promise;

    expect("system" in sdk.stream.mock.calls[0][0]).toBe(false);
  });

  it("forwards an abort signal through the request options", async () => {
    const provider = new ClaudeProvider("k", req());
    const signal = new AbortController().signal;

    await jsonRun(provider, message({ parsed_output: {}, stop_reason: "end_turn" }), { signal });

    expect(sdk.stream.mock.calls[0][1].signal).toBe(signal);
  });

  it("throws when structured generation hit the token cap", async () => {
    const provider = new ClaudeProvider("k", req());

    await expect(
      jsonRun(provider, message({ parsed_output: { a: "b" }, stop_reason: "max_tokens" })),
    ).rejects.toThrow(/stopped before completing/i);
  });

  it("throws when structured generation was refused", async () => {
    const provider = new ClaudeProvider("k", req());

    await expect(
      jsonRun(provider, message({ parsed_output: { a: "b" }, stop_reason: "refusal" })),
    ).rejects.toThrow(/refused/i);
  });

  it("throws when parsed_output is null", async () => {
    const provider = new ClaudeProvider("k", req());

    await expect(
      jsonRun(provider, message({ parsed_output: null, stop_reason: "end_turn" })),
    ).rejects.toThrow(/Unexpected structured response/);
  });

  it("throws when the response carries no parsed output at all", async () => {
    const provider = new ClaudeProvider("k", req());

    await expect(jsonRun(provider, message({ stop_reason: "end_turn" }))).rejects.toThrow(
      /Unexpected structured response/,
    );
  });
});

describe("generateTextStream", () => {
  it("maps the request, forwards text deltas, and resolves with the final text", async () => {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const provider = new ClaudeProvider("k", req("stream-model", { maxTokens: 999 }));

    const received: string[] = [];
    const { finished } = provider.generateTextStream("sys", "usr", (d) => received.push(d));

    f.emitText("Hel");
    f.emitText("lo");
    f.resolveFinal(message({ text: "Hello", stop_reason: "end_turn" }));

    expect(await finished).toBe("Hello");
    expect(received).toEqual(["Hel", "lo"]);

    const body = sdk.stream.mock.calls[0][0];
    expect(body.model).toBe("stream-model");
    expect(body.messages).toEqual([{ role: "user", content: "usr" }]);
    expect(body.system).toBe("sys");
    expect(body.max_tokens).toBe(999);
  });

  it("forwards reasoning deltas to onThinking, separately from the answer text", async () => {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const provider = new ClaudeProvider("k", req("m", { thinking: true }));

    const text: string[] = [];
    const thinking: string[] = [];
    const { finished } = provider.generateTextStream(
      "s",
      "u",
      (d) => text.push(d),
      (d) => thinking.push(d),
    );

    f.emitThinking("weigh");
    f.emitThinking("ing");
    f.emitText("answer");
    f.resolveFinal(message({ text: "answer", stop_reason: "end_turn" }));

    await finished;
    expect(thinking).toEqual(["weigh", "ing"]);
    // Reasoning must never leak into the analysis text.
    expect(text).toEqual(["answer"]);
  });

  it("subscribes to thinking only when a caller asked for it", () => {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const provider = new ClaudeProvider("k", req());

    provider.generateTextStream("s", "u", () => {});

    expect(f.thinkingListenerCount()).toBe(0);
  });

  it("omits the system parameter when the system prompt is empty", () => {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const provider = new ClaudeProvider("k", req());

    provider.generateTextStream("", "usr", () => {});

    expect("system" in sdk.stream.mock.calls[0][0]).toBe(false);
  });

  it("forwards abort() to the underlying SDK stream", () => {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const provider = new ClaudeProvider("k", req());

    const { abort } = provider.generateTextStream("s", "u", () => {});
    abort();

    expect(f.abort).toHaveBeenCalledTimes(1);
  });

  it("rejects `finished` when the final message was truncated", async () => {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const provider = new ClaudeProvider("k", req());

    const { finished } = provider.generateTextStream("s", "u", () => {});
    f.resolveFinal(message({ text: "partial", stop_reason: "max_tokens" }));

    await expect(finished).rejects.toThrow(/output token limit/i);
  });

  it("rejects `finished` when the final message was a refusal", async () => {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const provider = new ClaudeProvider("k", req());

    const { finished } = provider.generateTextStream("s", "u", () => {});
    f.resolveFinal(message({ text: "", stop_reason: "refusal" }));

    await expect(finished).rejects.toThrow(/refused/i);
  });

  it("propagates a rejection from the underlying stream's finalMessage()", async () => {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const provider = new ClaudeProvider("k", req());

    const { finished } = provider.generateTextStream("s", "u", () => {});
    f.rejectFinal(new Error("stream blew up"));

    await expect(finished).rejects.toThrow(/stream blew up/);
  });
});
