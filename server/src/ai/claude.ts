/**
 * Claude provider — calls Anthropic Messages API with a single user message.
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

  async analyze(prompt: string): Promise<string> {
    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });

    // Extract text from the first content block
    const block = message.content[0];
    if (block.type !== "text") {
      throw new Error("Unexpected response type from Claude");
    }

    return block.text;
  }
}
