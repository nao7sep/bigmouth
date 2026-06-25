/**
 * Claude provider — uses the Anthropic Messages API with a proper system/user split.
 */

import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import type { AiProvider } from "./provider.js";

export class ClaudeProvider implements AiProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async generateText(systemPrompt: string, userContent: string): Promise<string> {
    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: TEXT_MAX_TOKENS,
      messages: [{ role: "user", content: userContent }],
      ...(systemPrompt ? { system: systemPrompt } : {}),
    });

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

  async generateJson(
    systemPrompt: string,
    userContent: string,
    schema: Record<string, unknown>,
    options: {
      timeoutMs?: number;
      maxRetries?: number;
      maxTokens?: number;
      signal?: AbortSignal;
    } = {}
  ): Promise<unknown> {
    const message = await this.client.messages.parse(
      {
        model: this.model,
        max_tokens: options.maxTokens ?? 2048,
        messages: [{ role: "user", content: userContent }],
        ...(systemPrompt ? { system: systemPrompt } : {}),
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

    if (message.stop_reason === "max_tokens") {
      throw new Error("Claude stopped before completing structured output");
    }
    if (message.stop_reason === "refusal") {
      throw new Error("Claude refused the structured generation request");
    }
    if (message.parsed_output === null) {
      throw new Error("Unexpected structured response type from Claude");
    }

    return message.parsed_output;
  }

  generateTextStream(
    systemPrompt: string,
    userContent: string,
    onText: (delta: string) => void
  ): {
    abort: () => void;
    finished: Promise<string>;
  } {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: TEXT_MAX_TOKENS,
      messages: [{ role: "user", content: userContent }],
      ...(systemPrompt ? { system: systemPrompt } : {}),
    });

    stream.on("text", (delta) => {
      onText(delta);
    });

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

// Output budget for free-text generation (analysis). Editorial reviews run long,
// so this is well above the old 4K cap; both paths stream or stay under the
// non-streaming SDK timeout, and a response that still hits the cap is reported
// rather than silently truncated (see assertCompleteStop).
const TEXT_MAX_TOKENS = 16000;

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function assertCompleteStop(stopReason: Anthropic.Message["stop_reason"]): void {
  if (stopReason === "max_tokens") {
    throw new Error("Claude stopped before completing the response (hit the output token limit).");
  }
  if (stopReason === "refusal") {
    throw new Error("Claude refused the request.");
  }
}
