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
      max_tokens: 4096,
      messages: [{ role: "user", content: userContent }],
      ...(systemPrompt ? { system: systemPrompt } : {}),
    });

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

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
      signal?: AbortSignal;
    } = {}
  ): Promise<unknown> {
    const message = await this.client.messages.parse(
      {
        model: this.model,
        max_tokens: 2048,
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
      max_tokens: 4096,
      messages: [{ role: "user", content: userContent }],
      ...(systemPrompt ? { system: systemPrompt } : {}),
    });

    stream.on("text", (delta) => {
      onText(delta);
    });

    return {
      abort: () => stream.abort(),
      finished: stream.finalText(),
    };
  }
}
