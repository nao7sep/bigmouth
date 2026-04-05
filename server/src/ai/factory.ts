/**
 * Creates an AiProvider from the current AI settings.
 * Throws if the provider is unknown or the API key is missing.
 */

import type { AiSettings } from "../shared/types.js";
import type { AiProvider } from "./provider.js";
import { ClaudeProvider } from "./claude.js";

export function createProvider(settings: AiSettings): AiProvider {
  if (!settings.apiKey) {
    throw new Error("AI API key is not configured");
  }

  if (settings.provider === "claude") {
    const model = settings.model || "claude-sonnet-4-5";
    return new ClaudeProvider(settings.apiKey, model);
  }

  throw new Error(`Unknown AI provider: ${settings.provider}`);
}
