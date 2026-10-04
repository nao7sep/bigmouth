import { describe, it, expect } from "vitest";
import { createProvider } from "@main/core/ai/factory.js";
import { ClaudeProvider } from "@main/core/ai/claude.js";
import type { RoleCall } from "@main/core/services/configStore.js";

const CALL = { workspaceId: "ws", postId: "post", purpose: "analysis" } as const;

function roleCall(overrides: Partial<RoleCall> = {}): RoleCall {
  return {
    endpoint: "https://api.anthropic.com",
    model: "claude-sonnet-5-5",
    thinking: "adaptive",
    apiKey: "sk-ant-test",
    ...overrides,
  };
}

// The provider keeps its request private; this reads what the factory actually built.
function requestOf(provider: unknown): unknown {
  return (provider as { request: unknown }).request;
}

describe("createProvider", () => {
  it("builds a ClaudeProvider from the role's endpoint, model and thinking", () => {
    const provider = createProvider(roleCall({ endpoint: "https://proxy.example", thinking: "between_tools" }), CALL);
    expect(provider).toBeInstanceOf(ClaudeProvider);
    expect(requestOf(provider)).toEqual({
      endpoint: "https://proxy.example",
      model: "claude-sonnet-5-5",
      thinking: "between_tools",
    });
  });

  it("throws when no API key resolves", () => {
    expect(() => createProvider(roleCall({ apiKey: null }), CALL)).toThrow(/No Anthropic API key/);
  });

  // The provider's answer decides whether an id works (ai-model-routing-conventions).
  it("builds a provider for a model id with no row", () => {
    const provider = createProvider(roleCall({ model: "claude-next-9", thinking: undefined }), CALL);
    expect(requestOf(provider)).toMatchObject({ model: "claude-next-9", thinking: undefined });
  });
});
