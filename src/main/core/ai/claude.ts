/**
 * Claude provider — uses the Anthropic Messages API with a proper system/user split.
 */

import Anthropic, { type Middleware } from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import type { AiProvider, ProviderCallContext } from "./provider.js";
import { buildClaudeParams } from "./claudeRequest.js";
import { MAX_ATTEMPTS, isRetryable, retryDelayMs, waitFor } from "./retryPolicy.js";
import { utcNow } from "../shared/timestamps.js";
import { serializeError } from "../services/logger.js";
import { writeProviderCall } from "../services/recordsStore.js";

/**
 * How long a stream may go with NO output at all before it is abandoned.
 *
 * A stream is bounded by inactivity rather than by total time: analysing a long
 * post legitimately runs for minutes, and a thinking-enabled model can reason
 * well past any fixed deadline, so a whole-operation deadline would cut off work
 * that is going fine — after its tokens were billed. A gap with no delta
 * whatsoever is the shape a stalled connection takes — a dropped VPN, a sleeping
 * laptop, a proxy that stops forwarding — where the socket stays open and
 * nothing ever settles.
 *
 * The watchdog is the only timer on a call: the SDK's own `timeout` option is
 * armed around fetch and cleared the moment the response headers arrive, so it
 * guards time-to-first-byte and nothing after it, and `signal` is the only
 * option the SDK applies to the body. The watchdog is armed before the request
 * leaves, so it covers the wait for the headers as well.
 */
const STREAM_IDLE_TIMEOUT_MS = 120_000;

/**
 * An inactivity watchdog over one streamed call. `progress` restarts the clock;
 * `signal` aborts when the clock runs out; `tripped` says it was the watchdog,
 * not the caller, that gave up — the SDK reports both aborts the same way.
 */
function idleWatchdog(): { signal: AbortSignal; progress: () => void; stop: () => void; tripped: () => boolean } {
  const idle = new AbortController();
  let tripped = false;
  let timer: NodeJS.Timeout | undefined;
  const stop = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const progress = (): void => {
    stop();
    timer = setTimeout(() => {
      tripped = true;
      idle.abort();
    }, STREAM_IDLE_TIMEOUT_MS);
    // Never hold the process open waiting to give up on a stream.
    timer.unref();
  };
  progress();
  return { signal: idle.signal, progress, stop, tripped: () => tripped };
}

const idleMessage = (what: string): string =>
  `Claude stopped sending output for ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)}s, so the ${what} was abandoned.`;

/** What a role's calls are built from: its endpoint, model, and the thinking value it sends. */
export interface ClaudeRequest {
  endpoint: string;
  model: string;
  /** The role's thinking value; undefined for a model with no row, which sends none. */
  thinking: string | undefined;
}

/**
 * One call's request as it leaves the client, headers and API key included
 * (data-lifecycle-conventions, Nothing is cut). Until something is sent, it is the
 * parameters the call was given.
 */
function requestCapture(params: unknown): { middleware: Middleware[]; request: () => unknown } {
  let sent: unknown;
  const observe: Middleware = (request, next) => {
    sent = {
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers),
      body: typeof request.body === "string" ? JSON.parse(request.body) : request.body,
    };
    return next(request);
  };
  return { middleware: [observe], request: () => sent ?? params };
}

export class ClaudeProvider implements AiProvider {
  private client: Anthropic;
  private request: ClaudeRequest;
  private call: ProviderCallContext;

  constructor(apiKey: string, request: ClaudeRequest, call: ProviderCallContext) {
    // Every call here is paid, so the SDK never retries on its own: the app's
    // retryPolicy is the only loop, and each attempt is recorded.
    this.client = new Anthropic({ apiKey, baseURL: request.endpoint, maxRetries: 0 });
    this.request = request;
    this.call = call;
  }

  /** Records one attempt with what came back (data-lifecycle-conventions, Records). */
  private record(startedAt: Date, request: unknown, outcome: { response: unknown } | { error: unknown }): void {
    writeProviderCall({
      ...this.call,
      provider: "anthropic",
      startedAt,
      finishedAt: utcNow(),
      request,
      response: "response" in outcome ? outcome.response : undefined,
      error: "error" in outcome ? serializeError(outcome.error) : undefined,
    });
  }

  /** Settles `pending` after recording it. */
  private async recorded<T>(
    startedAt: Date,
    capture: ReturnType<typeof requestCapture>,
    pending: Promise<T>,
  ): Promise<T> {
    try {
      const response = await pending;
      this.record(startedAt, capture.request(), { response });
      return response;
    } catch (error) {
      this.record(startedAt, capture.request(), { error });
      throw error;
    }
  }

  private params(system: string, userContent: string, format?: Anthropic.JSONOutputFormat) {
    return buildClaudeParams({ model: this.request.model, system, userContent, format }, this.request.thinking);
  }

  /**
   * Runs attempts until one settles, resending only a failure the retry policy
   * allows and `mayResend` agrees to, and never once `signal` has aborted. Each
   * attempt records its own row, so a retry never overwrites an earlier one.
   */
  private async withRetries<T>(
    signal: AbortSignal,
    attempt: () => Promise<T>,
    mayResend: () => boolean = () => true,
  ): Promise<T> {
    for (let count = 1; ; count += 1) {
      try {
        return await attempt();
      } catch (err) {
        if (signal.aborted || count >= MAX_ATTEMPTS || !isRetryable(err) || !mayResend()) throw err;
        await waitFor(retryDelayMs(err, count), signal);
      }
    }
  }

  /**
   * Structured generation. This streams internally even though it resolves with a
   * whole value: the SDK refuses a non-streaming request whose `max_tokens` it
   * estimates could run past ten minutes, which would put an arbitrary ceiling on a
   * budget the user owns. Streaming is transport only — the contract is unchanged.
   */
  async generateJson(
    systemPrompt: string,
    userContent: string,
    schema: Record<string, unknown>,
    options: {
      maxDurationMs?: number;
      signal?: AbortSignal;
    } = {}
  ): Promise<unknown> {
    // Bounded like the analysis stream, by inactivity per attempt, so a
    // thinking model is never cut off mid-answer by a deadline sized for a fast
    // one. `maxDurationMs` is only a generous outer cap over every attempt; the
    // caller's signal is the user's Stop.
    const cap = new AbortController();
    const capTimer =
      options.maxDurationMs !== undefined ? setTimeout(() => cap.abort(), options.maxDurationMs) : undefined;
    capTimer?.unref();
    const outer = AbortSignal.any([cap.signal, options.signal].filter((s): s is AbortSignal => s !== undefined));
    const params = this.params(
      systemPrompt,
      userContent,
      jsonSchemaOutputFormat(schema as { type: "object"; [key: string]: unknown }),
    );

    let message: Anthropic.Message;
    try {
      message = await this.withRetries(outer, () => this.jsonAttempt(params, outer));
    } catch (err) {
      if (cap.signal.aborted && !options.signal?.aborted) {
        throw new Error(
          `Claude did not finish within ${Math.round(options.maxDurationMs! / 60_000)} minutes, so the request was abandoned.`,
        );
      }
      throw err;
    } finally {
      clearTimeout(capTimer);
    }

    // The same allowlist the text paths use, so a stop reason the SDK adds later
    // cannot slip through here either.
    assertCompleteStop(message);

    const parsed = (message as { parsed_output?: unknown }).parsed_output;
    if (parsed === null || parsed === undefined) {
      throw new Error("Unexpected structured response type from Claude");
    }

    return parsed;
  }

  private async jsonAttempt(
    params: Anthropic.MessageCreateParamsNonStreaming,
    outer: AbortSignal,
  ): Promise<Anthropic.Message> {
    const watchdog = idleWatchdog();
    const capture = requestCapture(params);
    const startedAt = utcNow();
    const stream = this.client.messages.stream(params, {
      middleware: capture.middleware,
      signal: AbortSignal.any([watchdog.signal, outer]),
    });
    stream.on("text", watchdog.progress);
    stream.on("thinking", watchdog.progress);
    try {
      return await this.recorded(startedAt, capture, stream.finalMessage());
    } catch (err) {
      if (watchdog.tripped()) throw new Error(idleMessage("request"));
      throw err;
    } finally {
      watchdog.stop();
    }
  }

  generateTextStream(
    systemPrompt: string,
    userContent: string,
    onText: (delta: string) => void,
    onThinking?: (delta: string) => void
  ): {
    abort: () => void;
    finished: Promise<string>;
  } {
    const params = this.params(systemPrompt, userContent);
    const stop = new AbortController();
    let current: { stream: ReturnType<Anthropic["messages"]["stream"]>; watchdog: ReturnType<typeof idleWatchdog> } | null = null;
    // A stream is resent only before any of it reached the caller: what was
    // already shown cannot be taken back.
    let received = false;

    const attempt = async (): Promise<Anthropic.Message> => {
      // The inactivity watchdog. Every delta — answer text OR reasoning — is
      // progress and restarts it; only total silence trips it. It has to exist
      // because nothing else bounds a stream: the SDK's timeout is spent once the
      // headers land, so a connection that goes quiet afterwards leaves
      // finalMessage() pending for ever, and with it the caller's whole feature.
      const watchdog = idleWatchdog();
      const capture = requestCapture(params);
      const startedAt = utcNow();
      const stream = this.client.messages.stream(params, {
        middleware: capture.middleware,
        signal: watchdog.signal,
      });
      current = { stream, watchdog };

      stream.on("text", (delta) => {
        received = true;
        watchdog.progress();
        onText(delta);
      });

      // Only fires when thinking is adaptive (display "summarized"); with thinking off
      // there is nothing to report and the callback is simply never called. Still
      // counts as progress: a model can reason for a long time before its first
      // answer token, and that is a working stream, not a stalled one.
      stream.on("thinking", (delta) => {
        received = true;
        watchdog.progress();
        onThinking?.(delta);
      });

      try {
        return await this.recorded(startedAt, capture, stream.finalMessage());
      } catch (err) {
        // The SDK reports the watchdog's abort the same way it reports the
        // user's, so say which one it was — otherwise a stall reads to the user
        // as though they cancelled.
        if (watchdog.tripped()) throw new Error(idleMessage("analysis"));
        throw err;
      } finally {
        watchdog.stop();
      }
    };

    // `finished` rejects on a truncated/refused completion so the caller can tell
    // a complete analysis from one cut short — even after deltas have streamed.
    const finished = this.withRetries(stop.signal, attempt, () => !received).then((message) => {
      assertCompleteStop(message);
      return textOf(message);
    });

    return {
      abort: () => {
        stop.abort();
        current?.watchdog.stop();
        current?.stream.abort();
      },
      finished,
    };
  }
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * Rejects any completion that is not whole.
 *
 * Written as an allowlist of the two reasons that mean "the model finished",
 * not a denylist of the ones known to be bad, so any other reason, such as
 * `model_context_window_exceeded` or one the SDK adds later, is rejected rather
 * than returned as a complete answer.
 */
function assertCompleteStop(message: Anthropic.Message): void {
  const { stop_reason: stopReason } = message;
  if (stopReason === "end_turn" || stopReason === "stop_sequence") return;

  if (stopReason === "max_tokens") {
    // Reached with thinking on and a tight budget too: reasoning shares the output
    // budget, so a hard task can consume all of it and leave no answer behind.
    throw new Error("Claude stopped before completing the response (hit the output token limit).");
  }
  if (stopReason === "refusal") {
    throw new Error(refusalMessage(message));
  }
  throw new Error(`Claude stopped before completing the response (${stopReason}).`);
}

/**
 * A refusal, with the reason the provider actually gave.
 *
 * The SDK populates `stop_details` precisely when the stop reason is a refusal,
 * and it carries the policy category and a human-readable explanation: the one
 * thing that tells a writer whose draft tripped a classifier what to change.
 */
function refusalMessage(message: Anthropic.Message): string {
  const details = message.stop_details;
  const parts = [details?.explanation, details?.category ? `Category: ${details.category}.` : null]
    .filter((part): part is string => Boolean(part));
  return ["Claude refused the request.", ...parts].join(" ");
}
