import { describe, it, expect } from "vitest";
import { createProvider } from "@main/core/ai/factory.js";
import { ClaudeProvider } from "@main/core/ai/claude.js";
import type { AiConfig } from "@main/core/shared/types.js";

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    id: "cfg1",
    name: "Claude",
    provider: "anthropic",
    apiKey: "sk-ant-test",
    model: "claude-opus-4-8",
    thinking: false,
    maxTokens: 12800,
    ...overrides,
  };
}

// The provider keeps its request private; this reads what the factory actually built,
// so the forcing rules below are asserted on the real thing rather than a re-derivation.
function requestOf(provider: unknown): { model: string; thinking: boolean; maxTokens: number } {
  return (provider as { request: { model: string; thinking: boolean; maxTokens: number } }).request;
}

describe("createProvider", () => {
  it("returns a ClaudeProvider for a configured claude config", () => {
    expect(createProvider(config())).toBeInstanceOf(ClaudeProvider);
  });

  it("throws when the API key is missing", () => {
    expect(() => createProvider(config({ apiKey: "" }))).toThrow(
      /API key is not configured/
    );
  });

  it("throws for an unknown provider", () => {
    expect(() =>
      createProvider(config({ provider: "openai" as AiConfig["provider"] }))
    ).toThrow(/Unknown AI provider/);
  });

  it("passes the config's model and budget through to the provider", () => {
    const provider = createProvider(config({ model: "claude-sonnet-5", maxTokens: 4242 }));
    expect(requestOf(provider)).toMatchObject({ model: "claude-sonnet-5", maxTokens: 4242 });
  });

  it("keeps thinking on for a model that supports it", () => {
    const provider = createProvider(config({ model: "claude-sonnet-5", thinking: true }));
    expect(requestOf(provider).thinking).toBe(true);
  });

  // The safety-critical one: Haiku answers a request for adaptive thinking with a 400,
  // so a stored `true` — left behind when the user switched models — must never reach
  // the API.
  it("forces thinking off for a model that rejects it, even when the config says on", () => {
    const provider = createProvider(config({ model: "claude-haiku-4-5", thinking: true }));
    expect(requestOf(provider).thinking).toBe(false);
  });

  it("names the config when its model is one this version no longer offers", () => {
    expect(() => createProvider(config({ name: "Old", model: "claude-3-opus-20240229" }))).toThrow(
      /"Old" uses a model this version no longer offers: claude-3-opus-20240229/
    );
  });

  it("rejects a budget that is not a usable number", () => {
    expect(() => createProvider(config({ maxTokens: 0 }))).toThrow(/whole number of 1 or more/);
    expect(() => createProvider(config({ maxTokens: 1.5 }))).toThrow(/whole number of 1 or more/);
  });

  // The app does not own the upper bound: whether a model accepts a large budget is
  // the API's judgment, surfaced at call time rather than guessed at here.
  it("accepts a large budget without second-guessing the model", () => {
    expect(() => createProvider(config({ maxTokens: 999_999 }))).not.toThrow();
  });
});
