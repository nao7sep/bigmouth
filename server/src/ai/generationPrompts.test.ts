import { describe, it, expect } from "vitest";
import {
  systemPromptForField,
  DEFAULT_GENERATION_PROMPTS,
} from "./generationPrompts.js";

describe("systemPromptForField", () => {
  it("returns the default prompt when no custom override exists", () => {
    expect(systemPromptForField("title", {})).toBe(
      DEFAULT_GENERATION_PROMPTS.title
    );
  });

  it("prefers a custom prompt over the default", () => {
    expect(systemPromptForField("title", { title: "Custom" })).toBe("Custom");
  });

  it("returns null for a field that is not a generatable metadata key", () => {
    expect(systemPromptForField("id", {})).toBeNull();
    expect(systemPromptForField("nonsense", { nonsense: "x" })).toBeNull();
  });
});
