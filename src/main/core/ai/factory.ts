/**
 * Creates the AiProvider for one role of a workspace from its Anthropic section.
 * Throws when no API key resolves; any model id is sent, and whether it works is
 * the provider's answer (ai-model-routing-conventions).
 */

import type { RoleCall } from "../services/configStore.js";
import type { AiProvider, ProviderCallContext } from "./provider.js";
import { ClaudeProvider } from "./claude.js";
import { carryingText } from "@shared/i18n/carriedMessage";
import { message } from "@shared/i18n/translate";

export function createProvider(call: RoleCall, context: ProviderCallContext): AiProvider {
  if (!call.apiKey) {
    // Setup asks for no key, so this is how a user learns one is needed: the
    // AI tabs show this message in place of their generic failure.
    throw new Error(carryingText(message("ai.noApiKey")));
  }
  return new ClaudeProvider(call.apiKey, { endpoint: call.endpoint, model: call.model, thinking: call.thinking }, context);
}
