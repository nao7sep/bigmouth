/**
 * Claude provider — uses the Anthropic Messages API with a proper system/user split.
 */

import Anthropic from "@anthropic-ai/sdk";
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

    const block = message.content[0];
    if (block.type !== "text") {
      throw new Error("Unexpected response type from Claude");
    }

    return block.text;
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
