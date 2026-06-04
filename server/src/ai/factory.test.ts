import { describe, it, expect } from "vitest";
import { createProvider } from "./factory.js";
import { ClaudeProvider } from "./claude.js";
import type { AiConfig } from "../shared/types.js";

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    id: "cfg1",
    name: "Claude",
    provider: "claude",
    apiKey: "sk-ant-test",
    model: "claude-opus-4-8",
    ...overrides,
  };
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
});
