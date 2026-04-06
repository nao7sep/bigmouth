/**
 * Creates an AiProvider from the current AI settings.
 * Throws if the provider is unknown or the API key is missing.
 */

import type { AiConfig } from "../shared/types.js";
import type { AiProvider } from "./provider.js";
import { ClaudeProvider } from "./claude.js";

export function createProvider(config: AiConfig): AiProvider {
  if (!config.apiKey) {
    throw new Error("AI API key is not configured");
  }

  if (config.provider === "claude") {
    const model = config.model || "claude-sonnet-4-6";
    return new ClaudeProvider(config.apiKey, model);
  }

  throw new Error(`Unknown AI provider: ${config.provider}`);
}
