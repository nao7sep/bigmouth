import { describe, it, expect } from "vitest";
import {
  systemPromptForField,
  DEFAULT_GENERATION_PROMPTS,
} from "@main/core/ai/generationPrompts.js";

describe("systemPromptForField", () => {
  it("uses the effective built-in map supplied by the store", () => {
    expect(systemPromptForField("title", DEFAULT_GENERATION_PROMPTS)).toBe(
      DEFAULT_GENERATION_PROMPTS.title
    );
  });

  it("uses a saved prompt unchanged", () => {
    expect(systemPromptForField("title", { title: "Custom" })).toBe("Custom");
  });

  it("returns null for a field that is not a generatable metadata key", () => {
    expect(systemPromptForField("id", {})).toBeNull();
    expect(systemPromptForField("nonsense", { nonsense: "x" })).toBeNull();
  });
});

it("does not fill a missing member from the built-in", () => {
  expect(systemPromptForField("slug", { title: "Custom" })).toBeNull();
});
