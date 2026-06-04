import { describe, it, expect } from "vitest";
import {
  usesContentPlaceholder,
  renderPromptTemplate,
  resolvePromptRequest,
} from "./promptTemplates.js";

describe("usesContentPlaceholder", () => {
  it("detects the {content} token", () => {
    expect(usesContentPlaceholder("Review this: {content}")).toBe(true);
    expect(usesContentPlaceholder("No token here")).toBe(false);
  });
});

describe("renderPromptTemplate", () => {
  it("replaces every {content} occurrence and trims", () => {
    expect(
      renderPromptTemplate("  A {content} and {content}.  ", { content: "X" })
    ).toBe("A X and X.");
  });
});

describe("resolvePromptRequest", () => {
  it("placeholder template -> user content, empty system prompt", () => {
    const r = resolvePromptRequest("Check: {content}", { content: "body" });
    expect(r).toEqual({ systemPrompt: "", userContent: "Check: body" });
  });

  it("no placeholder -> template becomes the system prompt, content is the user turn", () => {
    const r = resolvePromptRequest("  Be terse.  ", { content: "body" });
    expect(r).toEqual({ systemPrompt: "Be terse.", userContent: "body" });
  });
});
