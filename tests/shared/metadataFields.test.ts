import { describe, it, expect } from "vitest";
import {
  GENERATION_PROMPT_KEYS,
  isMetadataField,
} from "@shared/metadataFields";
import { GENERATION_PROMPT_KEYS as MAIN_KEYS } from "@main/core/ai/generationPrompts.js";
import { GENERATION_PROMPT_KEYS as RENDERER_KEYS } from "@renderer/generationPromptDefaults";

describe("the generatable metadata fields", () => {
  // The list was declared byte-identically on both sides of the process
  // boundary: the main copy decided which keys config.json persists and which
  // fields the generator accepts, the renderer copy decided which rows Settings
  // renders. Adding a key to one meant either the UI editing a prompt the store
  // dropped on save, or the store carrying a prompt no UI showed.
  it("is one list, whichever side asks for it", () => {
    expect(MAIN_KEYS).toBe(GENERATION_PROMPT_KEYS);
    expect(RENDERER_KEYS).toBe(GENERATION_PROMPT_KEYS);
  });

  it("accepts only a field on the list", () => {
    expect(isMetadataField("metaDescriptionEn")).toBe(true);
    expect(isMetadataField("target")).toBe(false);
    expect(isMetadataField(undefined)).toBe(false);
  });
});
