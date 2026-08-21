import { describe, it, expect } from "vitest";
import {
  DEFAULT_MODEL_ID,
  MODEL_DEFS,
  defaultMaxTokens,
  findModelDef,
  resolveThinking,
  validateMaxTokens,
} from "@shared/types";
import { makeDefaultAiConfigs } from "@main/core/shared/defaults.js";
import { createProvider } from "@main/core/ai/factory.js";

// The model list is app-owned and closed: the user picks a row and never edits
// it. The ai-model-routing conventions require a closed list to ship a guard
// test, and there was none — so a typo'd row id would have surfaced only as a
// 404 at call time for whoever selected it, and a typo'd DEFAULT_MODEL_ID would
// have made first-run workspace init throw.
describe("the model registry", () => {
  // Deliberately NOT "findModelDef resolves every row": that searches the same
  // list, so it holds for any string whatsoever and would pass a typo. Whether
  // an id names a real model can only be settled by a call to the API; what can
  // be settled here is that it is shaped like one.
  it("gives every row an id shaped like a Claude model id", () => {
    for (const model of MODEL_DEFS) {
      expect(model.id).toMatch(/^claude-[a-z0-9-]+$/);
      expect(model.label.trim()).not.toBe("");
    }
  });

  it("offers each id exactly once", () => {
    const ids = MODEL_DEFS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolves the default", () => {
    expect(findModelDef(DEFAULT_MODEL_ID)).toBeDefined();
  });

  it("builds a provider for every row", () => {
    for (const model of MODEL_DEFS) {
      expect(() =>
        createProvider({
          id: "c1",
          name: model.label,
          provider: "anthropic",
          apiKey: "sk-test",
          model: model.id,
          thinking: model.supportsAdaptiveThinking,
          maxTokens: defaultMaxTokens(model),
        }),
      ).not.toThrow();
    }
  });

  it("gives every row a usable starting budget", () => {
    for (const model of MODEL_DEFS) {
      expect(validateMaxTokens(defaultMaxTokens(model))).toBeNull();
    }
  });

  it("never asks for thinking from a model that rejects it", () => {
    // Haiku answers a request for adaptive thinking with a 400, so one must
    // never be built — verified live against the API during the review.
    for (const model of MODEL_DEFS) {
      expect(resolveThinking(model, true)).toBe(model.supportsAdaptiveThinking);
      expect(resolveThinking(model, false)).toBe(false);
    }
  });

  it("materializes a first-run AI config set that every field resolves for", () => {
    const configs = makeDefaultAiConfigs();

    expect(configs.length).toBeGreaterThan(0);
    for (const config of configs) {
      expect(findModelDef(config.model)).toBeDefined();
      expect(validateMaxTokens(config.maxTokens)).toBeNull();
    }
  });
});
