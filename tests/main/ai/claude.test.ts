// Unit test for the Claude provider — the thin wrapper over the Anthropic
// Messages SDK. The SDK is fully mocked (a fake Anthropic client whose
// messages.{create,parse,stream} are vi.fns the tests drive), so this asserts
// the request mapping (model, max_tokens, system split, output_config),
// response extraction (text blocks, parsed_output), streaming (text deltas +
// finalMessage), and the stop-reason / null error handling — without any real
// network or API key.

import { describe, it, expect, beforeEach, vi } from "vitest";

// The fake SDK surface. Hoisted so the vi.mock factory can close over it.
const sdk = vi.hoisted(() => ({
  ctorArgs: null as null | { apiKey: string },
  create: vi.fn(),
  parse: vi.fn(),
  stream: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages: { create: typeof sdk.create; parse: typeof sdk.parse; stream: typeof sdk.stream };
    constructor(opts: { apiKey: string }) {
      sdk.ctorArgs = opts;
      this.messages = { create: sdk.create, parse: sdk.parse, stream: sdk.stream };
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

import { ClaudeProvider } from "@main/core/ai/claude.js";

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

beforeEach(() => {
  sdk.ctorArgs = null;
  sdk.create.mockReset();
  sdk.parse.mockReset();
  sdk.stream.mockReset();
});

describe("ClaudeProvider construction", () => {
  it("passes the api key to the Anthropic client", () => {
    new ClaudeProvider("sk-test", "claude-test-model");
    expect(sdk.ctorArgs).toEqual({ apiKey: "sk-test" });
  });
});

describe("generateText", () => {
  it("maps the request and joins text blocks from the response", async () => {
    sdk.create.mockResolvedValue(
      message({ blocks: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }] }),
    );
    const provider = new ClaudeProvider("k", "my-model");

    const text = await provider.generateText("Be brief.", "Say hi.");

    expect(text).toBe("Hello world");
    const req = sdk.create.mock.calls[0][0];
    expect(req.model).toBe("my-model");
    expect(req.messages).toEqual([{ role: "user", content: "Say hi." }]);
    expect(req.system).toBe("Be brief.");
    expect(typeof req.max_tokens).toBe("number");
    expect(req.max_tokens).toBeGreaterThan(0);
  });

  it("omits the system parameter when the system prompt is empty", async () => {
    sdk.create.mockResolvedValue(message({ text: "ok" }));
    const provider = new ClaudeProvider("k", "m");

    await provider.generateText("", "user only");

    const req = sdk.create.mock.calls[0][0];
    expect("system" in req).toBe(false);
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
    const provider = new ClaudeProvider("k", "m");

    expect(await provider.generateText("s", "u")).toBe("visible");
  });

  it("throws when the response was truncated at the output token limit", async () => {
    sdk.create.mockResolvedValue(message({ text: "partial", stop_reason: "max_tokens" }));
    const provider = new ClaudeProvider("k", "m");

    await expect(provider.generateText("s", "u")).rejects.toThrow(/output token limit/i);
  });

  it("throws when the request was refused", async () => {
    sdk.create.mockResolvedValue(message({ text: "", stop_reason: "refusal" }));
    const provider = new ClaudeProvider("k", "m");

    await expect(provider.generateText("s", "u")).rejects.toThrow(/refused/i);
  });

  it("throws when the response carries no text", async () => {
    sdk.create.mockResolvedValue(message({ blocks: [{ type: "thinking", text: "x" }] }));
    const provider = new ClaudeProvider("k", "m");

    await expect(provider.generateText("s", "u")).rejects.toThrow(/Unexpected response type/);
  });
});

describe("generateJson", () => {
  const schema = { type: "object", properties: { a: { type: "string" } } };

  it("maps the request with the schema output format and forwards request options", async () => {
    sdk.parse.mockResolvedValue(message({ parsed_output: { a: "b" }, stop_reason: "end_turn" }));
    const provider = new ClaudeProvider("k", "json-model");

    const result = await provider.generateJson("sys", "usr", schema, {
      timeoutMs: 1234,
      maxRetries: 2,
      maxTokens: 555,
    });

    expect(result).toEqual({ a: "b" });

    const [body, requestOptions] = sdk.parse.mock.calls[0];
    expect(body.model).toBe("json-model");
    expect(body.max_tokens).toBe(555);
    expect(body.messages).toEqual([{ role: "user", content: "usr" }]);
    expect(body.system).toBe("sys");
    // The schema is wrapped by the (mocked) jsonSchemaOutputFormat helper.
    expect(body.output_config).toEqual({ format: { __outputFormat: schema } });
    expect(requestOptions).toEqual({ timeout: 1234, maxRetries: 2, signal: undefined });
  });

  it("defaults max_tokens when no maxTokens option is given", async () => {
    sdk.parse.mockResolvedValue(message({ parsed_output: {}, stop_reason: "end_turn" }));
    const provider = new ClaudeProvider("k", "m");

    await provider.generateJson("sys", "usr", schema);

    expect(sdk.parse.mock.calls[0][0].max_tokens).toBe(2048);
  });

  it("omits the system parameter when the system prompt is empty", async () => {
    sdk.parse.mockResolvedValue(message({ parsed_output: {}, stop_reason: "end_turn" }));
    const provider = new ClaudeProvider("k", "m");

    await provider.generateJson("", "usr", schema);

    expect("system" in sdk.parse.mock.calls[0][0]).toBe(false);
  });

  it("forwards an abort signal through the request options", async () => {
    sdk.parse.mockResolvedValue(message({ parsed_output: {}, stop_reason: "end_turn" }));
    const provider = new ClaudeProvider("k", "m");
    const signal = new AbortController().signal;

    await provider.generateJson("sys", "usr", schema, { signal });

    expect(sdk.parse.mock.calls[0][1].signal).toBe(signal);
  });

  it("throws when structured generation hit the token cap", async () => {
    sdk.parse.mockResolvedValue(message({ parsed_output: { a: "b" }, stop_reason: "max_tokens" }));
    const provider = new ClaudeProvider("k", "m");

    await expect(provider.generateJson("s", "u", schema)).rejects.toThrow(/stopped before completing/i);
  });

  it("throws when structured generation was refused", async () => {
    sdk.parse.mockResolvedValue(message({ parsed_output: { a: "b" }, stop_reason: "refusal" }));
    const provider = new ClaudeProvider("k", "m");

    await expect(provider.generateJson("s", "u", schema)).rejects.toThrow(/refused/i);
  });

  it("throws when parsed_output is null", async () => {
    sdk.parse.mockResolvedValue(message({ parsed_output: null, stop_reason: "end_turn" }));
    const provider = new ClaudeProvider("k", "m");

    await expect(provider.generateJson("s", "u", schema)).rejects.toThrow(/Unexpected structured response/);
  });
});

describe("generateTextStream", () => {
  // A minimal fake of the SDK MessageStream: collects "text" listeners, lets the
  // test drive finalMessage(), and exposes the abort spy.
  function fakeStream() {
    const textListeners: Array<(delta: string) => void> = [];
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
        return handle;
      },
      finalMessage: () => finalMessagePromise,
      abort,
    };
    return {
      handle,
      abort,
      emitText: (delta: string) => textListeners.forEach((cb) => cb(delta)),
      resolveFinal: (msg: unknown) => resolveFinal(msg),
      rejectFinal: (err: unknown) => rejectFinal(err),
    };
  }

  it("maps the request, forwards text deltas, and resolves with the final text", async () => {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const provider = new ClaudeProvider("k", "stream-model");

    const received: string[] = [];
    const { finished } = provider.generateTextStream("sys", "usr", (d) => received.push(d));

    f.emitText("Hel");
    f.emitText("lo");
    f.resolveFinal(message({ text: "Hello", stop_reason: "end_turn" }));

    expect(await finished).toBe("Hello");
    expect(received).toEqual(["Hel", "lo"]);

    const req = sdk.stream.mock.calls[0][0];
    expect(req.model).toBe("stream-model");
    expect(req.messages).toEqual([{ role: "user", content: "usr" }]);
    expect(req.system).toBe("sys");
    expect(typeof req.max_tokens).toBe("number");
  });

  it("omits the system parameter when the system prompt is empty", () => {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const provider = new ClaudeProvider("k", "m");

    provider.generateTextStream("", "usr", () => {});

    expect("system" in sdk.stream.mock.calls[0][0]).toBe(false);
  });

  it("forwards abort() to the underlying SDK stream", () => {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const provider = new ClaudeProvider("k", "m");

    const { abort } = provider.generateTextStream("s", "u", () => {});
    abort();

    expect(f.abort).toHaveBeenCalledTimes(1);
  });

  it("rejects `finished` when the final message was truncated", async () => {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const provider = new ClaudeProvider("k", "m");

    const { finished } = provider.generateTextStream("s", "u", () => {});
    f.resolveFinal(message({ text: "partial", stop_reason: "max_tokens" }));

    await expect(finished).rejects.toThrow(/output token limit/i);
  });

  it("rejects `finished` when the final message was a refusal", async () => {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const provider = new ClaudeProvider("k", "m");

    const { finished } = provider.generateTextStream("s", "u", () => {});
    f.resolveFinal(message({ text: "", stop_reason: "refusal" }));

    await expect(finished).rejects.toThrow(/refused/i);
  });

  it("propagates a rejection from the underlying stream's finalMessage()", async () => {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const provider = new ClaudeProvider("k", "m");

    const { finished } = provider.generateTextStream("s", "u", () => {});
    f.rejectFinal(new Error("stream blew up"));

    await expect(finished).rejects.toThrow(/stream blew up/);
  });
});
