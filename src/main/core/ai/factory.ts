/**
 * Creates the AiProvider for one role of a workspace from its Anthropic section.
 * Throws when no API key resolves; any model id is sent, and whether it works is
 * the provider's answer (ai-model-routing-conventions).
 */

import type { RoleCall } from "../services/configStore.js";
import type { AiProvider, ProviderCallContext } from "./provider.js";
import { ClaudeProvider } from "./claude.js";

export function createProvider(call: RoleCall, context: ProviderCallContext): AiProvider {
  if (!call.apiKey) {
    throw new Error("No Anthropic API key is set for this workspace. Add one in Settings.");
  }
  return new ClaudeProvider(call.apiKey, { endpoint: call.endpoint, model: call.model, thinking: call.thinking }, context);
}
