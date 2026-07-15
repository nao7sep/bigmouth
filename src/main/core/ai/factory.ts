/**
 * Creates an AiProvider from the current AI settings.
 * Throws if the provider is unknown, the model is unknown, or the API key is missing.
 */

import type { AiConfig } from "../shared/types.js";
import { findModelDef, resolveThinking, validateMaxTokens } from "@shared/types";
import type { AiProvider } from "./provider.js";
import { ClaudeProvider } from "./claude.js";

export function createProvider(config: AiConfig): AiProvider {
  if (!config.apiKey) {
    throw new Error("AI API key is not configured");
  }

  if (config.provider === "anthropic") {
    // The store never checks that a persisted model id is still one we ship, so this
    // is where a stale one surfaces — clearly, and before any request is built.
    const model = findModelDef(config.model);
    if (!model) {
      throw new Error(`AI config "${config.name}" uses a model this version no longer offers: ${config.model}`);
    }

    const budgetError = validateMaxTokens(config.maxTokens);
    if (budgetError) {
      throw new Error(`AI config "${config.name}": ${budgetError}`);
    }

    return new ClaudeProvider(config.apiKey, {
      model: model.id,
      // Forced off for a model that rejects it, whatever the config says — a stored
      // `true` from before a model swap must never reach the API.
      thinking: resolveThinking(model, config.thinking),
      maxTokens: config.maxTokens,
    });
  }

  throw new Error(`Unknown AI provider: ${config.provider}`);
}
