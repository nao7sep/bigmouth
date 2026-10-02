import { describe, expect, it } from "vitest";
import { setsDifferingFromBuiltIn, workspaceSetHasShape } from "@shared/configSets";
import { DEFAULT_CONTENT_FONT } from "@shared/types";
import { GENERATION_PROMPT_KEYS } from "@shared/metadataFields";

describe("config sets", () => {
  it("keeps each set that differs from its built-in, whole, and drops the rest", () => {
    const builtIn = { uiFontFamily: "", contentFont: DEFAULT_CONTENT_FONT };
    const keys = ["uiFontFamily", "contentFont"] as const;
    const contentFont = { ...DEFAULT_CONTENT_FONT, family: "Iosevka" };
    expect(setsDifferingFromBuiltIn({ ...builtIn, contentFont }, builtIn, keys)).toEqual({ contentFont });
    expect(setsDifferingFromBuiltIn(structuredClone(builtIn), builtIn, keys)).toEqual({});
    const reordered = Object.fromEntries(Object.entries(DEFAULT_CONTENT_FONT).reverse()) as typeof DEFAULT_CONTENT_FONT;
    expect(setsDifferingFromBuiltIn({ ...builtIn, contentFont: reordered }, builtIn, keys)).toEqual({});
  });
  it("validates the cluster shape without judging provider or numeric ranges", () => {
    expect(workspaceSetHasShape("contentFont", { family: "Partial" })).toBe(false);
    expect(workspaceSetHasShape("contentFont", { ...DEFAULT_CONTENT_FONT, size: -10 })).toBe(true);
    expect(workspaceSetHasShape("aiConfigs", [{ id: "custom", name: "Custom", provider: "anthropic", model: "new-model", thinking: true, maxTokens: -10 }])).toBe(true);
    expect(workspaceSetHasShape("aiConfigs", [{ id: "custom", name: "Custom", provider: "unknown", model: "new-model", thinking: true, maxTokens: 100 }])).toBe(false);
  });
  it("requires every generation prompt while preserving user text and extra string keys", () => {
    const prompts = Object.fromEntries(GENERATION_PROMPT_KEYS.map((key) => [key, ""]));
    expect(workspaceSetHasShape("generationPrompts", { prompts: { ...prompts, extra: "Custom" } })).toBe(true);
    expect(workspaceSetHasShape("generationPrompts", { prompts: { ...prompts, title: 1 } })).toBe(false);
    for (const key of GENERATION_PROMPT_KEYS) {
      const partial = { ...prompts };
      delete partial[key];
      expect(workspaceSetHasShape("generationPrompts", { prompts: partial })).toBe(false);
    }
  });
});
