// Unit test for the Claude provider — the thin wrapper over the Anthropic
// Messages SDK. The SDK is fully mocked (a fake Anthropic client whose
// messages.{create,stream} are vi.fns the tests drive), so this asserts that the
// request is the builder's (claudeRequest.test.ts covers each branch),
// response extraction (text blocks, parsed_output), streaming (text + thinking
// deltas, finalMessage), and the stop-reason / null error handling — without any
// real network or API key.
//
// The fake deliberately exposes NO `messages.parse`: generateJson streams, because
// the SDK refuses a non-streaming request whose max_tokens could run long. A
// regression back to parse fails here loudly rather than silently capping the
// user's budget.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The fake SDK surface. Hoisted so the vi.mock factory can close over it.
const sdk = vi.hoisted(() => ({
  ctorArgs: null as null | { apiKey: string; baseURL?: string; maxRetries?: number },
  create: vi.fn(),
  stream: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages: { create: typeof sdk.create; stream: typeof sdk.stream };
    constructor(opts: { apiKey: string; baseURL?: string; maxRetries?: number }) {
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

const recorded = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("@main/core/services/recordsStore.js", () => ({
  writeProviderCall: (call: unknown) => recorded.calls.push(call),
}));

import type { Middleware } from "@anthropic-ai/sdk";
import { ClaudeProvider, type ClaudeRequest } from "@main/core/ai/claude.js";
import { buildClaudeParams, MAX_TOKENS } from "@main/core/ai/claudeRequest.js";

const CALL = { workspaceId: "ws", postId: "post", purpose: "analysis" } as const;

// What a provider is built from. A test names only what it asserts.
function req(model = "m", over: Partial<ClaudeRequest> = {}): ClaudeRequest {
  return { endpoint: "https://api.anthropic.com", model, thinking: undefined, ...over };
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
    stop_reason: Object.hasOwn(opts, "stop_reason") ? opts.stop_reason : "end_turn",
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
  recorded.calls.length = 0;
  sdk.ctorArgs = null;
  sdk.create.mockReset();
  sdk.stream.mockReset();
});

describe("ClaudeProvider construction", () => {
  // Every call is paid: the SDK's default of two retries could bill a request
  // up to three times, so the client never retries on its own.
  it("passes the api key and endpoint and turns off the SDK's own retries", () => {
    new ClaudeProvider("sk-test", req("claude-test-model", { endpoint: "https://proxy.example/anthropic" }), CALL);
    expect(sdk.ctorArgs).toEqual({ apiKey: "sk-test", baseURL: "https://proxy.example/anthropic", maxRetries: 0 });
  });
});

describe("provider call records", () => {
  it("records each call with its context, the request sent and the message received", async () => {
    const reply = message({ parsed_output: { a: "b" } });
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const pending = new ClaudeProvider("k", req("m"), CALL).generateJson("s", "u", { type: "object" });
    f.resolveFinal(reply);
    await pending;
    expect(recorded.calls).toEqual([
      expect.objectContaining({
        ...CALL,
        provider: "anthropic",
        request: sdk.stream.mock.calls[0][0],
        response: reply,
        error: undefined,
      }),
    ]);
  });

  it("records the request as it was sent, headers and API key included", async () => {
    const reply = message({ parsed_output: { a: "b" } });
    sdk.stream.mockImplementation((params: unknown, options: { middleware: Middleware[] }) => {
      const sent = {
        method: "POST",
        url: "https://api.anthropic.com/v1/messages",
        headers: new Headers({ "x-api-key": "sk-secret", "anthropic-version": "2023-06-01" }),
        body: JSON.stringify(params),
      };
      const settled = (async () => {
        for (const observe of options.middleware) await observe(sent, async () => new Response(), {} as never);
        return reply;
      })();
      return { on: () => {}, finalMessage: () => settled, abort: () => {} };
    });
    await new ClaudeProvider("sk-secret", req("m"), CALL).generateJson("s", "u", { type: "object" });
    expect(recorded.calls).toEqual([
      expect.objectContaining({
        request: {
          method: "POST",
          url: "https://api.anthropic.com/v1/messages",
          headers: { "x-api-key": "sk-secret", "anthropic-version": "2023-06-01" },
          body: JSON.parse(JSON.stringify(sdk.stream.mock.calls[0][0])),
        },
      }),
    ]);
  });

  it("records a streamed call that fails with its error", async () => {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const { finished } = new ClaudeProvider("k", req("m"), CALL).generateTextStream("s", "u", () => {});
    f.rejectFinal(new Error("socket closed"));
    await expect(finished).rejects.toThrow("socket closed");
    expect(recorded.calls).toEqual([
      expect.objectContaining({
        request: sdk.stream.mock.calls[0][0],
        response: undefined,
        error: expect.objectContaining({ message: "socket closed" }),
      }),
    ]);
  });
});

// A failed call the provider refused or never received is resent, up to three
// attempts, and every attempt is its own record (tapebox's rule): a retry never
// overwrites what an earlier attempt sent or got back.
describe("retries", () => {
  function refused(code: number, headers?: Record<string, string>) {
    return Object.assign(new Error(`${code} from the provider`), { status: code, headers: new Headers(headers) });
  }
  // A stream whose final message settles at once, as a refused request does.
  function settled(outcome: { message: unknown } | { error: unknown }) {
    return {
      on() { return this; },
      finalMessage: () => ("error" in outcome ? Promise.reject(outcome.error) : Promise.resolve(outcome.message)),
      abort: vi.fn(),
    };
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resends a 429 after its Retry-After and records each attempt as its own row", async () => {
    const reply = message({ parsed_output: { a: "b" } });
    sdk.stream
      .mockReturnValueOnce(settled({ error: refused(429, { "retry-after": "3" }) }))
      .mockReturnValueOnce(settled({ message: reply }));
    const pending = new ClaudeProvider("k", req("m"), CALL).generateJson("s", "u", { type: "object" });

    await vi.advanceTimersByTimeAsync(2_999);
    expect(sdk.stream).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ a: "b" });

    expect(sdk.stream).toHaveBeenCalledTimes(2);
    expect(recorded.calls).toEqual([
      expect.objectContaining({ response: undefined, error: expect.objectContaining({ message: "429 from the provider" }) }),
      expect.objectContaining({ response: reply, error: undefined }),
    ]);
  });

  it("gives up after three attempts, with three rows", async () => {
    sdk.stream.mockImplementation(() => settled({ error: refused(503) }));
    const pending = new ClaudeProvider("k", req("m"), CALL).generateJson("s", "u", { type: "object" });
    const rejection = expect(pending).rejects.toThrow("503 from the provider");
    await vi.advanceTimersByTimeAsync(2_000 + 5_000);
    await rejection;
    expect(sdk.stream).toHaveBeenCalledTimes(3);
    expect(recorded.calls).toHaveLength(3);
  });

  it("resends a refused connection", async () => {
    const refusedConnection = Object.assign(new Error("Connection error."), {
      cause: Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
    });
    sdk.stream
      .mockReturnValueOnce(settled({ error: refusedConnection }))
      .mockReturnValueOnce(settled({ message: message({ parsed_output: {} }) }));
    const pending = new ClaudeProvider("k", req("m"), CALL).generateJson("s", "u", { type: "object" });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual({});
    expect(recorded.calls).toHaveLength(2);
  });

  it.each([
    ["a 500", refused(500)],
    ["a 529", refused(529)],
    ["a dropped connection", Object.assign(new Error("Connection error."), { cause: { code: "ECONNRESET" } })],
  ])("reports %s to the waiting user without resending it", async (_case, error) => {
    sdk.stream.mockReturnValue(settled({ error }));
    await expect(new ClaudeProvider("k", req("m"), CALL).generateJson("s", "u", { type: "object" })).rejects.toBe(error);
    expect(sdk.stream).toHaveBeenCalledTimes(1);
    expect(recorded.calls).toHaveLength(1);
  });

  it("stops waiting to resend when the caller stops", async () => {
    sdk.stream.mockReturnValue(settled({ error: refused(429) }));
    const stop = new AbortController();
    const pending = new ClaudeProvider("k", req("m"), CALL).generateJson("s", "u", { type: "object" }, { signal: stop.signal });
    const rejection = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(500);
    stop.abort();
    await rejection;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sdk.stream).toHaveBeenCalledTimes(1);
  });

  it("resends an analysis stream refused before any output, and only then", async () => {
    sdk.stream
      .mockReturnValueOnce(settled({ error: refused(429) }))
      .mockReturnValueOnce(settled({ message: message({ text: "fine" }) }));
    const { finished } = new ClaudeProvider("k", req("m"), CALL).generateTextStream("s", "u", () => {});
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(finished).resolves.toBe("fine");
    expect(recorded.calls).toHaveLength(2);

    // Once output reached the caller, a failure is reported, never resent.
    const f = fakeStream();
    sdk.stream.mockReset();
    sdk.stream.mockReturnValue(f.handle);
    recorded.calls.length = 0;
    const second = new ClaudeProvider("k", req("m"), CALL).generateTextStream("s", "u", () => {});
    f.emitText("partial");
    f.rejectFinal(refused(429));
    await expect(second.finished).rejects.toThrow("429 from the provider");
    expect(sdk.stream).toHaveBeenCalledTimes(1);
    expect(recorded.calls).toHaveLength(1);
  });

  it("aborting an analysis while it waits to resend stops it", async () => {
    sdk.stream.mockReturnValue(settled({ error: refused(503) }));
    const { abort, finished } = new ClaudeProvider("k", req("m"), CALL).generateTextStream("s", "u", () => {});
    const rejection = expect(finished).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(100);
    abort();
    await rejection;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sdk.stream).toHaveBeenCalledTimes(1);
  });
});

// The provider sends what the request builder builds; its branches are pinned
// in claudeRequest.test.ts.
describe("request building", () => {
  it("sends the builder's request on every route", async () => {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const provider = new ClaudeProvider("k", req("claude-sonnet-5-5", { thinking: "high" }), CALL);

    provider.generateTextStream("s", "u", () => {});
    void provider.generateJson("s", "u", { type: "object" });

    const [stream, json] = sdk.stream.mock.calls.map((call) => call[0]);
    expect(stream).toEqual(buildClaudeParams({ model: "claude-sonnet-5-5", system: "s", userContent: "u" }, "high"));
    expect(json).toEqual(buildClaudeParams(
      { model: "claude-sonnet-5-5", system: "s", userContent: "u", format: { __outputFormat: { type: "object" } } as never },
      "high",
    ));
  });

  it("sends no thinking parameter for a model with no row", () => {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    new ClaudeProvider("k", req("claude-next-9"), CALL).generateTextStream("s", "u", () => {});
    expect("thinking" in sdk.stream.mock.calls[0][0]).toBe(false);
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

  it("maps the request with the schema output format and bounds it by a signal", async () => {
    const provider = new ClaudeProvider("k", req("json-model"), CALL);

    const result = await jsonRun(provider, message({ parsed_output: { a: "b" }, stop_reason: "end_turn" }), {
      maxDurationMs: 1234,
    });

    expect(result).toEqual({ a: "b" });

    const [body, requestOptions] = sdk.stream.mock.calls[0];
    expect(body.model).toBe("json-model");
    expect(body.max_tokens).toBe(MAX_TOKENS);
    expect(body.messages).toEqual([{ role: "user", content: "usr" }]);
    expect(body.system).toBe("sys");
    // The schema is wrapped by the (mocked) jsonSchemaOutputFormat helper.
    expect(body.output_config).toEqual({ format: { __outputFormat: schema } });
    // The call is bounded by a signal (inactivity plus the outer cap), never by
    // the SDK's own `timeout`, which is cleared once the response headers arrive.
    expect("timeout" in requestOptions).toBe(false);
    // The app's retry policy is the only loop: the client was built with none.
    expect("maxRetries" in requestOptions).toBe(false);
    expect(requestOptions.signal).toBeInstanceOf(AbortSignal);
  });

  it("omits the system parameter when the system prompt is empty", async () => {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const provider = new ClaudeProvider("k", req(), CALL);

    const promise = provider.generateJson("", "usr", schema);
    f.resolveFinal(message({ parsed_output: {}, stop_reason: "end_turn" }));
    await promise;

    expect("system" in sdk.stream.mock.calls[0][0]).toBe(false);
  });

  it("aborts the request when the caller's signal aborts", async () => {
    const provider = new ClaudeProvider("k", req(), CALL);
    const controller = new AbortController();

    await jsonRun(provider, message({ parsed_output: {}, stop_reason: "end_turn" }), { signal: controller.signal });
    const requestSignal = sdk.stream.mock.calls[0][1].signal as AbortSignal;
    expect(requestSignal.aborted).toBe(false);
    controller.abort();

    expect(requestSignal.aborted).toBe(true);
  });

  // A thinking-enabled call can run far past any fixed deadline, so it is bounded
  // by inactivity, as analysis is, and never cut off after its tokens are billed.
  describe("inactivity bound", () => {
    const IDLE_MS = 60_000;

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function start(provider: ClaudeProvider, options?: Parameters<ClaudeProvider["generateJson"]>[3]) {
      const f = fakeStream();
      sdk.stream.mockReturnValue(f.handle);
      const promise = provider.generateJson("sys", "usr", schema, options);
      const [, requestOptions] = sdk.stream.mock.calls[0] as [unknown, { signal: AbortSignal }];
      requestOptions.signal.addEventListener("abort", () => f.rejectFinal(new Error("Request was aborted.")));
      return { f, promise };
    }

    it("keeps a call alive for as long as reasoning or output keeps arriving", async () => {
      const provider = new ClaudeProvider("k", req("m", { thinking: "adaptive" }), CALL);
      const { f, promise } = start(provider, { maxDurationMs: 10 * 60_000 });

      for (let i = 0; i < 4; i += 1) {
        await vi.advanceTimersByTimeAsync(IDLE_MS * 0.75);
        f.emitThinking("still reasoning");
      }
      f.emitText("{}");
      f.resolveFinal(message({ parsed_output: { a: "b" }, stop_reason: "end_turn" }));

      await expect(promise).resolves.toEqual({ a: "b" });
    });

    it("abandons a call that goes silent, and says so", async () => {
      const provider = new ClaudeProvider("k", req(), CALL);
      const { promise } = start(provider);

      const rejection = expect(promise).rejects.toThrow(/stopped sending output for 60s/);
      await vi.advanceTimersByTimeAsync(IDLE_MS);
      await rejection;
    });

    it("gives up at the outer cap even while output keeps arriving", async () => {
      const provider = new ClaudeProvider("k", req(), CALL);
      const { f, promise } = start(provider, { maxDurationMs: 5 * 60_000 });

      const rejection = expect(promise).rejects.toThrow(/did not finish within 5 minutes/);
      for (let i = 0; i < 11; i += 1) {
        f.emitText("x");
        await vi.advanceTimersByTimeAsync(30_000);
      }
      await rejection;
    });

    it("reports the caller's abort as itself", async () => {
      const provider = new ClaudeProvider("k", req(), CALL);
      const controller = new AbortController();
      const { promise } = start(provider, { signal: controller.signal });

      const rejection = expect(promise).rejects.toThrow(/Request was aborted/);
      controller.abort();
      await rejection;
    });
  });

  it("throws when structured generation hit the token cap", async () => {
    const provider = new ClaudeProvider("k", req(), CALL);

    await expect(
      jsonRun(provider, message({ parsed_output: { a: "b" }, stop_reason: "max_tokens" })),
    ).rejects.toThrow(/stopped before completing/i);
  });

  it("throws when structured generation was refused", async () => {
    const provider = new ClaudeProvider("k", req(), CALL);

    await expect(
      jsonRun(provider, message({ parsed_output: { a: "b" }, stop_reason: "refusal" })),
    ).rejects.toThrow(/refused/i);
  });

  it("throws when parsed_output is null", async () => {
    const provider = new ClaudeProvider("k", req(), CALL);

    await expect(
      jsonRun(provider, message({ parsed_output: null, stop_reason: "end_turn" })),
    ).rejects.toThrow(/Unexpected structured response/);
  });

  it("throws when the response carries no parsed output at all", async () => {
    const provider = new ClaudeProvider("k", req(), CALL);

    await expect(jsonRun(provider, message({ stop_reason: "end_turn" }))).rejects.toThrow(
      /Unexpected structured response/,
    );
  });
});

describe("generateTextStream", () => {
  it("maps the request, forwards text deltas, and resolves with the final text", async () => {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const provider = new ClaudeProvider("k", req("stream-model"), CALL);

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
    expect(body.max_tokens).toBe(MAX_TOKENS);
  });

  it("forwards reasoning deltas to onThinking, separately from the answer text", async () => {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const provider = new ClaudeProvider("k", req("m", { thinking: "adaptive" }), CALL);

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

  it("subscribes to thinking even when the caller does not display it", () => {
    // Reasoning is progress. A model can think for minutes before its first
    // answer token, and the inactivity watchdog must see that as a working
    // stream rather than a stalled one — so the subscription is unconditional
    // and the caller's optional callback is what is conditional.
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const provider = new ClaudeProvider("k", req(), CALL);

    expect(() => provider.generateTextStream("s", "u", () => {})).not.toThrow();
    expect(f.thinkingListenerCount()).toBe(1);
    expect(() => f.emitThinking("no listener supplied")).not.toThrow();
  });

  // The inactivity watchdog. Nothing else bounds a stream: the SDK's `timeout`
  // is armed around fetch and cleared the moment the response headers arrive, so
  // a connection that goes quiet afterwards leaves finalMessage() pending for
  // ever — and with it the whole Analysis feature, which has no cancel control.
  describe("inactivity watchdog", () => {
    const IDLE_MS = 60_000;

    /**
     * Wires the fake to the SDK's actual contract: an aborted request rejects.
     * Without this the fake would sit pending for ever and the test would be
     * asserting nothing.
     */
    function rejectOnAbort(f: ReturnType<typeof fakeStream>): void {
      const [, options] = sdk.stream.mock.calls[0] as [unknown, { signal: AbortSignal }];
      options.signal.addEventListener("abort", () => f.rejectFinal(new Error("Request was aborted.")));
    }

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("abandons a stream that goes silent, and says so", async () => {
      const f = fakeStream();
      sdk.stream.mockReturnValue(f.handle);
      const provider = new ClaudeProvider("k", req(), CALL);

      const { finished } = provider.generateTextStream("s", "u", () => {});
      rejectOnAbort(f);

      // Assert before advancing: the rejection lands inside the timer advance,
      // and an expectation attached afterwards leaves it briefly unhandled.
      const rejection = expect(finished).rejects.toThrow(/stopped sending output for 60s/);
      await vi.advanceTimersByTimeAsync(IDLE_MS);
      await rejection;
    });

    it("treats every delta as progress and starts the clock over", async () => {
      const f = fakeStream();
      sdk.stream.mockReturnValue(f.handle);
      const provider = new ClaudeProvider("k", req(), CALL);

      const { finished } = provider.generateTextStream("s", "u", () => {});
      rejectOnAbort(f);

      // Three quarters of the budget, a delta, then three quarters again: a
      // fixed deadline would have fired, an inactivity bound must not.
      await vi.advanceTimersByTimeAsync(IDLE_MS * 0.75);
      f.emitText("still working");
      await vi.advanceTimersByTimeAsync(IDLE_MS * 0.75);

      f.resolveFinal(message({ text: "still working", stop_reason: "end_turn" }));
      await expect(finished).resolves.toBe("still working");
    });

    it("counts reasoning as progress, even with no thinking callback", async () => {
      // A model can reason for longer than the whole budget before its first
      // answer token. That is a working stream.
      const f = fakeStream();
      sdk.stream.mockReturnValue(f.handle);
      const provider = new ClaudeProvider("k", req("m", { thinking: "adaptive" }), CALL);

      const { finished } = provider.generateTextStream("s", "u", () => {});
      rejectOnAbort(f);

      await vi.advanceTimersByTimeAsync(IDLE_MS * 0.75);
      f.emitThinking("weighing it up");
      await vi.advanceTimersByTimeAsync(IDLE_MS * 0.75);

      f.resolveFinal(message({ text: "answer", stop_reason: "end_turn" }));
      await expect(finished).resolves.toBe("answer");
    });

    it("stops watching once the stream has finished", async () => {
      const f = fakeStream();
      sdk.stream.mockReturnValue(f.handle);
      const provider = new ClaudeProvider("k", req(), CALL);

      const { finished } = provider.generateTextStream("s", "u", () => {});
      rejectOnAbort(f);
      f.resolveFinal(message({ text: "done", stop_reason: "end_turn" }));
      await expect(finished).resolves.toBe("done");

      // A timer left running would abort a request that already completed.
      await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
      expect(f.abort).not.toHaveBeenCalled();
    });

    it("reports a user abort as itself, not as a stall", async () => {
      const f = fakeStream();
      sdk.stream.mockReturnValue(f.handle);
      const provider = new ClaudeProvider("k", req(), CALL);

      const { finished, abort } = provider.generateTextStream("s", "u", () => {});
      const rejection = expect(finished).rejects.toThrow(/Request was aborted/);
      abort();
      f.rejectFinal(new Error("Request was aborted."));

      await rejection;
      // And the watchdog is not left running behind it.
      await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    });
  });

  it("omits the system parameter when the system prompt is empty", () => {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const provider = new ClaudeProvider("k", req(), CALL);

    provider.generateTextStream("", "usr", () => {});

    expect("system" in sdk.stream.mock.calls[0][0]).toBe(false);
  });

  it("forwards abort() to the underlying SDK stream", () => {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const provider = new ClaudeProvider("k", req(), CALL);

    const { abort } = provider.generateTextStream("s", "u", () => {});
    abort();

    expect(f.abort).toHaveBeenCalledTimes(1);
  });

  it("rejects `finished` when the final message was truncated", async () => {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const provider = new ClaudeProvider("k", req(), CALL);

    const { finished } = provider.generateTextStream("s", "u", () => {});
    f.resolveFinal(message({ text: "partial", stop_reason: "max_tokens" }));

    await expect(finished).rejects.toThrow(/output token limit/i);
  });

  it("rejects `finished` when the final message was a refusal", async () => {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const provider = new ClaudeProvider("k", req(), CALL);

    const { finished } = provider.generateTextStream("s", "u", () => {});
    f.resolveFinal(message({ text: "", stop_reason: "refusal" }));

    await expect(finished).rejects.toThrow(/refused/i);
  });

  it("propagates a rejection from the underlying stream's finalMessage()", async () => {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const provider = new ClaudeProvider("k", req(), CALL);

    const { finished } = provider.generateTextStream("s", "u", () => {});
    f.rejectFinal(new Error("stream blew up"));

    await expect(finished).rejects.toThrow(/stream blew up/);
  });
});

// The guard is an allowlist of the two reasons that mean "finished", not a
// denylist of the ones known to be bad. It used to enumerate max_tokens and
// refusal only, so model_context_window_exceeded fell through and a truncated
// answer was returned as a complete one - the exact class it exists for, missed
// because the SDK's union grew.
describe("incomplete completions", () => {
  function runStream(msg: unknown) {
    const f = fakeStream();
    sdk.stream.mockReturnValue(f.handle);
    const provider = new ClaudeProvider("k", req(), CALL);
    const { finished } = provider.generateTextStream("s", "u", () => {});
    const rejection = finished;
    f.resolveFinal(msg);
    return rejection;
  }

  it.each(["max_tokens", "refusal", "model_context_window_exceeded", "pause_turn", "tool_use", null])(
    "refuses a completion that stopped for %s",
    async (stop_reason) => {
      await expect(runStream(message({ text: "partial", stop_reason }))).rejects.toThrow();
    },
  );

  it.each(["end_turn", "stop_sequence"])("accepts a completion that stopped for %s", async (stop_reason) => {
    await expect(runStream(message({ text: "whole", stop_reason }))).resolves.toBe("whole");
  });

  it("reports the reason the provider gave for a refusal", async () => {
    // stop_details is populated precisely when the stop reason is a refusal, and
    // carries the policy category and a human-readable explanation. A bare
    // "Claude refused the request." threw away the one thing that tells a writer
    // what to change.
    const refused = {
      ...(message({ text: "", stop_reason: "refusal" }) as Record<string, unknown>),
      stop_details: { type: "refusal", category: "general_harms", explanation: "Draft names a real person." },
    };

    await expect(runStream(refused)).rejects.toThrow(/Draft names a real person\./);
    await expect(runStream(refused)).rejects.toThrow(/general_harms/);
  });

  it("still says something useful when the refusal carries no details", async () => {
    const refused = {
      ...(message({ text: "", stop_reason: "refusal" }) as Record<string, unknown>),
      stop_details: null,
    };

    await expect(runStream(refused)).rejects.toThrow(/Claude refused the request\./);
  });
});
