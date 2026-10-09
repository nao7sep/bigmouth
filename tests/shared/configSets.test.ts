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
    // A model id is free text the store never judges; a role only needs one.
    expect(workspaceSetIssue("anthropic.analysis", "new-model")).toBeNull();
    expect(workspaceSetIssue("anthropic.analysis", " ")).toMatch(/must name a model/);
    expect(workspaceSetIssue("anthropic.thinking.analysis", "anything")).toBeNull();
    expect(workspaceSetIssue("anthropic.thinking.analysis", 3)).not.toBeNull();
    expect(workspaceSetIssue("anthropic.endpoint", "http://localhost:8080/v1")).toBeNull();
    expect(workspaceSetIssue("anthropic.endpoint", "ftp://example.com")).not.toBeNull();
    expect(workspaceSetIssue("anthropic.endpoint", "api.anthropic.com")).not.toBeNull();
  });
  it("compares a model trimmed and case-insensitively, and a thinking value by what it sends", () => {
    const keys = ["anthropic.analysis", "anthropic.thinking.analysis"] as const;
    const builtIn = { "anthropic.analysis": "claude-sonnet-5-5", "anthropic.thinking.analysis": "adaptive" };
    expect(setsDifferingFromBuiltIn({ ...builtIn, "anthropic.analysis": " Claude-Sonnet-5-5 " }, builtIn, keys)).toEqual({});
    // Opus's default for the role is adaptive too, so only the model differs.
    expect(setsDifferingFromBuiltIn({ ...builtIn, "anthropic.analysis": "claude-opus-5-5" }, builtIn, keys))
      .toEqual({ "anthropic.analysis": "claude-opus-5-5" });
    expect(setsDifferingFromBuiltIn({ ...builtIn, "anthropic.thinking.analysis": "high" }, builtIn, keys))
      .toEqual({ "anthropic.thinking.analysis": "high" });
    // A value the row does not list sends the default, so it equals the built-in.
    expect(setsDifferingFromBuiltIn({ ...builtIn, "anthropic.thinking.analysis": "off" }, builtIn, keys)).toEqual({});
  });
  it("accepts any subset of the generation prompts and ignores keys this build does not have", () => {
    const prompts = Object.fromEntries(GENERATION_PROMPT_KEYS.map((key) => [key, ""]));
    expect(workspaceSetIssue("generationPrompts", { prompts })).toBeNull();
    expect(workspaceSetIssue("generationPrompts", { prompts: { ...prompts, extra: "Custom" } })).toBeNull();
    expect(workspaceSetIssue("generationPrompts", { prompts: {} })).toBeNull();
    for (const key of GENERATION_PROMPT_KEYS) {
      const partial = { ...prompts };
      delete partial[key];
      expect(workspaceSetIssue("generationPrompts", { prompts: partial })).toBeNull();
    }
    expect(workspaceSetIssue("generationPrompts", { prompts: { ...prompts, title: 1 } })).not.toBeNull();
    expect(workspaceSetIssue("generationPrompts", { prompts: [] })).not.toBeNull();
  });
});
