/**
 * Claude provider — uses the Anthropic Messages API with a proper system/user split.
 */

import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import type { AiProvider } from "./provider.js";

/**
 * How long a stream may go with NO output at all before it is abandoned.
 *
 * A stream is bounded by inactivity rather than by total time: analysing a long
 * post legitimately runs for minutes, so a whole-operation deadline would cut
 * off work that is going fine. A gap with no delta whatsoever is the shape a
 * stalled connection takes — a dropped VPN, a sleeping laptop, a proxy that
 * stops forwarding — where the socket stays open and nothing ever settles.
 */
const STREAM_IDLE_TIMEOUT_MS = 120_000;

/**
 * The signal that actually bounds a call.
 *
 * The SDK's own `timeout` option is NOT an operation bound: it is armed around
 * fetch and cleared the moment the response headers arrive, so it guards
 * time-to-first-byte and nothing after it. Measured against a stalling server, a
 * request carrying `timeout: 3000` was still pending past 15 seconds after a
 * mid-stream stall, while the same request given a signal gave up at 3.0.
 * `signal` is the only option the SDK applies to the body, so every call here
 * carries one.
 */
function operationBound(
  timeoutMs: number | undefined,
  caller: AbortSignal | undefined,
): AbortSignal | undefined {
  if (timeoutMs === undefined) return caller;
  const budget = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([caller, budget]) : budget;
}

/**
 * The model fields of an AI config, resolved against MODEL_DEFS by the factory. A
 * request is built from these alone, so the provider never guesses a capability.
 */
export interface ClaudeRequest {
  model: string;
  /** Adaptive thinking. The factory has already forced this false where the model rejects it. */
  thinking: boolean;
  maxTokens: number;
}

export class ClaudeProvider implements AiProvider {
  private client: Anthropic;
  private request: ClaudeRequest;

  constructor(apiKey: string, request: ClaudeRequest) {
    this.client = new Anthropic({ apiKey });
    this.request = request;
  }

  /**
   * Thinking must be stated explicitly, never left to the model's default: omitting
   * the parameter means "no thinking" on some models and "adaptive thinking" on
   * others, so the same silence would mean two different things. `summarized` is what
   * lets a caller show the reasoning while it happens — the default omits the text,
   * which reads as a dead pause before any output.
   */
  private thinkingParam(): Anthropic.MessageCreateParams["thinking"] {
    return this.request.thinking
      ? { type: "adaptive", display: "summarized" }
      : { type: "disabled" };
  }

  private baseParams(systemPrompt: string, userContent: string) {
    return {
      model: this.request.model,
      max_tokens: this.request.maxTokens,
      thinking: this.thinkingParam(),
      messages: [{ role: "user" as const, content: userContent }],
      ...(systemPrompt ? { system: systemPrompt } : {}),
    };
  }

  async generateText(
    systemPrompt: string,
    userContent: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<string> {
    const signal = operationBound(options.timeoutMs, options.signal);
    const message = await this.client.messages.create(
      this.baseParams(systemPrompt, userContent),
      {
        ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
        ...(signal !== undefined ? { signal } : {}),
      },
    );

    // Surface a truncated/refused response as an error rather than returning a
    // partial result the caller would treat as complete (the same contract as
    // generateJson and generateTextStream).
    assertCompleteStop(message);

    const text = textOf(message);
    if (!text) {
      throw new Error("Unexpected response type from Claude");
    }

    return text;
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
      timeoutMs?: number;
      maxRetries?: number;
      signal?: AbortSignal;
    } = {}
  ): Promise<unknown> {
    // timeoutMs becomes BOTH: the SDK's connect-phase timeout, which produces a
    // retryable connection error, and a real deadline on the whole call. Before
    // this it was only the first, so a stall after the headers arrived hung the
    // caller for ever while the log recorded a timeout that had never applied.
    const signal = operationBound(options.timeoutMs, options.signal);
    const stream = this.client.messages.stream(
      {
        ...this.baseParams(systemPrompt, userContent),
        output_config: {
          format: jsonSchemaOutputFormat(schema as { type: "object"; [key: string]: unknown }),
        },
      },
      {
        // An omitted option must be an omitted KEY, not a key set to undefined: the SDK
        // validates request options on the way in and rejects `timeout: undefined` outright
        // ("timeout must be an integer") rather than reading it as absent. So the spreads
        // are what keep this signature's optionality honest — a call with no options at all
        // would otherwise throw before a request ever left the process. Surfaced by the
        // 0.111 -> 0.120 bump; a mocked SDK validates nothing, so the suite could not see it.
        ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
        ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
        ...(signal !== undefined ? { signal } : {}),
      }
    );

    const message = await stream.finalMessage();

    // The same allowlist the text paths use, so a stop reason the SDK adds later
    // cannot slip through here either.
    assertCompleteStop(message);

    const parsed = (message as { parsed_output?: unknown }).parsed_output;
    if (parsed === null || parsed === undefined) {
      throw new Error("Unexpected structured response type from Claude");
    }

    return parsed;
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
    // The inactivity watchdog. Every delta — answer text OR reasoning — is
    // progress and restarts it; only total silence trips it. It has to exist
    // because nothing else bounds a stream: the SDK's timeout is spent once the
    // headers land, so a connection that goes quiet afterwards leaves
    // finalMessage() pending for ever, and with it the caller's whole feature.
    const idle = new AbortController();
    let idleTripped = false;
    let idleTimer: NodeJS.Timeout | undefined;

    const stopWatchdog = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
    };

    const restartWatchdog = (): void => {
      stopWatchdog();
      idleTimer = setTimeout(() => {
        idleTripped = true;
        idle.abort();
      }, STREAM_IDLE_TIMEOUT_MS);
      // Never hold the process open waiting to give up on a stream.
      idleTimer.unref();
    };

    const stream = this.client.messages.stream(this.baseParams(systemPrompt, userContent), {
      signal: idle.signal,
    });
    restartWatchdog();

    stream.on("text", (delta) => {
      restartWatchdog();
      onText(delta);
    });

    // Only fires when thinking is on AND display is "summarized"; with thinking off
    // there is nothing to report and the callback is simply never called. Still
    // counts as progress: a model can reason for a long time before its first
    // answer token, and that is a working stream, not a stalled one.
    stream.on("thinking", (delta) => {
      restartWatchdog();
      onThinking?.(delta);
    });

    // `finished` rejects on a truncated/refused completion so the caller can tell
    // a complete analysis from one cut short — even after deltas have streamed.
    const finished = stream.finalMessage().then(
      (message) => {
        stopWatchdog();
        assertCompleteStop(message);
        return textOf(message);
      },
      (err: unknown) => {
        stopWatchdog();
        // The SDK reports the watchdog's abort the same way it reports the
        // user's, so say which one it was — otherwise a stall reads to the user
        // as though they cancelled.
        if (idleTripped) {
          throw new Error(
            `Claude stopped sending output for ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)}s, so the analysis was abandoned.`,
          );
        }
        throw err;
      },
    );

    return {
      abort: () => {
        stopWatchdog();
        stream.abort();
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
 * not a denylist of the ones known to be bad. It used to enumerate `max_tokens`
 * and `refusal` only, so `model_context_window_exceeded` fell straight through
 * and a truncated answer was returned as a complete one — the exact class the
 * guard exists for, missed because the SDK's union grew.
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
 * and it carries the policy category and a human-readable explanation. Reporting
 * a bare "Claude refused the request." threw that away and left a writer whose
 * draft tripped a classifier with a dead end and nothing to act on — while the
 * one thing that tells them what to change was sitting in the response.
 */
function refusalMessage(message: Anthropic.Message): string {
  const details = message.stop_details;
  const parts = [details?.explanation, details?.category ? `Category: ${details.category}.` : null]
    .filter((part): part is string => Boolean(part));
  return ["Claude refused the request.", ...parts].join(" ");
}
