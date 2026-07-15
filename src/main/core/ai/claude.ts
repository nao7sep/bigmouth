/**
 * Claude provider — uses the Anthropic Messages API with a proper system/user split.
 */

import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import type { AiProvider } from "./provider.js";

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

  async generateText(systemPrompt: string, userContent: string): Promise<string> {
    const message = await this.client.messages.create(this.baseParams(systemPrompt, userContent));

    // Surface a truncated/refused response as an error rather than returning a
    // partial result the caller would treat as complete (the same contract as
    // generateJson and generateTextStream).
    assertCompleteStop(message.stop_reason);

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
    const stream = this.client.messages.stream(
      {
        ...this.baseParams(systemPrompt, userContent),
        output_config: {
          format: jsonSchemaOutputFormat(schema as { type: "object"; [key: string]: unknown }),
        },
      },
      {
        timeout: options.timeoutMs,
        maxRetries: options.maxRetries,
        signal: options.signal,
      }
    );

    const message = await stream.finalMessage();

    if (message.stop_reason === "max_tokens") {
      throw new Error("Claude stopped before completing structured output");
    }
    if (message.stop_reason === "refusal") {
      throw new Error("Claude refused the structured generation request");
    }

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
    const stream = this.client.messages.stream(this.baseParams(systemPrompt, userContent));

    stream.on("text", (delta) => {
      onText(delta);
    });

    // Only fires when thinking is on AND display is "summarized"; with thinking off
    // there is nothing to report and the callback is simply never called.
    if (onThinking) {
      stream.on("thinking", (delta) => {
        onThinking(delta);
      });
    }

    // `finished` rejects on a truncated/refused completion so the caller can tell
    // a complete analysis from one cut short — even after deltas have streamed.
    const finished = stream.finalMessage().then((message) => {
      assertCompleteStop(message.stop_reason);
      return textOf(message);
    });

    return {
      abort: () => stream.abort(),
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

function assertCompleteStop(stopReason: Anthropic.Message["stop_reason"]): void {
  if (stopReason === "max_tokens") {
    // Reached with thinking on and a tight budget too: reasoning shares the output
    // budget, so a hard task can consume all of it and leave no answer behind.
    throw new Error("Claude stopped before completing the response (hit the output token limit).");
  }
  if (stopReason === "refusal") {
    throw new Error("Claude refused the request.");
  }
}
