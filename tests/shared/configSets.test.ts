import { describe, expect, it } from "vitest";
import { setsDifferingFromBuiltIn, workspaceSetIssue } from "@shared/configSets";
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
  it("checks shape and the app's own value rules, but not the model id", () => {
    expect(workspaceSetIssue("contentFont", { family: "Partial" })).not.toBeNull();
    expect(workspaceSetIssue("contentFont", { ...DEFAULT_CONTENT_FONT, size: -10 })).toMatch(/contentFont\.size/);
    expect(workspaceSetIssue("contentFont", DEFAULT_CONTENT_FONT)).toBeNull();
    expect(workspaceSetIssue("timezone", "Mars/Olympus")).toMatch(/timezone/);
    expect(workspaceSetIssue("targets", [{ name: " ", defaultLanguage: "en", requiresMetadata: false }])).toMatch(/non-empty name/);
    expect(workspaceSetIssue("aiConfigs", [{ id: "custom", name: "Custom", provider: "anthropic", model: "new-model", thinking: true, maxTokens: 100 }])).toBeNull();
    expect(workspaceSetIssue("aiConfigs", [{ id: "custom", name: "Custom", provider: "anthropic", model: "new-model", thinking: true, maxTokens: -10 }])).not.toBeNull();
    expect(workspaceSetIssue("aiConfigs", [{ id: "custom", name: "Custom", provider: "unknown", model: "new-model", thinking: true, maxTokens: 100 }])).not.toBeNull();
  });
  it("requires every generation prompt and no other key", () => {
    const prompts = Object.fromEntries(GENERATION_PROMPT_KEYS.map((key) => [key, ""]));
    expect(workspaceSetIssue("generationPrompts", { prompts })).toBeNull();
    expect(workspaceSetIssue("generationPrompts", { prompts: { ...prompts, extra: "Custom" } })).not.toBeNull();
    expect(workspaceSetIssue("generationPrompts", { prompts: { ...prompts, title: 1 } })).not.toBeNull();
    for (const key of GENERATION_PROMPT_KEYS) {
      const partial = { ...prompts };
      delete partial[key];
      expect(workspaceSetIssue("generationPrompts", { prompts: partial })).not.toBeNull();
    }
  });
});
