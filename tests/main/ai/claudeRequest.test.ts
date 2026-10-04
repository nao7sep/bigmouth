// The anthropic.messages request builder: each supported id's branch, and the
// plain request for any other id (ai-model-routing-conventions).

import { describe, expect, it } from "vitest";

import { buildClaudeParams, MAX_TOKENS } from "@main/core/ai/claudeRequest.js";

const FEATURE = { system: "sys", userContent: "usr" };
const FORMAT = { type: "json_schema", schema: { type: "object" } } as const;
const ADAPTIVE = { type: "adaptive", display: "summarized" };

function params(model: string, thinking: string | undefined, format?: typeof FORMAT) {
  return buildClaudeParams({ model, ...FEATURE, ...(format ? { format } : {}) }, thinking);
}

describe("buildClaudeParams", () => {
  it("sends adaptive thinking, summarized, for adaptive", () => {
    for (const model of ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5"]) {
      expect(params(model, "adaptive"), model).toEqual({
        model,
        max_tokens: MAX_TOKENS,
        thinking: ADAPTIVE,
        messages: [{ role: "user", content: "usr" }],
        system: "sys",
      });
    }
  });

  it("sends a level as adaptive thinking with that effort, beside the feature's format", () => {
    expect(params("claude-opus-5-5", "xhigh", FORMAT)).toMatchObject({
      thinking: ADAPTIVE,
      output_config: { format: FORMAT, effort: "xhigh" },
    });
    expect(params("claude-fable-5-1", "low")).toMatchObject({ thinking: ADAPTIVE, output_config: { effort: "low" } });
    expect(params("claude-sonnet-5-5", "max")).toMatchObject({ thinking: ADAPTIVE, output_config: { effort: "max" } });
  });

  it("sends Sonnet 5.5's between_tools as its own thinking type, with no other thinking field", () => {
    const request = params("claude-sonnet-5-5", "between_tools", FORMAT);
    expect(request.thinking).toEqual({ type: "between_tools" });
    expect(request.output_config).toEqual({ format: FORMAT });
  });

  it("disables thinking for Haiku 4.5", () => {
    expect(params("claude-haiku-4-5", "off").thinking).toEqual({ type: "disabled" });
  });

  it("refuses a thinking value a branch does not translate", () => {
    expect(() => params("claude-haiku-4-5", "adaptive")).toThrow(/No thinking translation/);
    expect(() => params("claude-opus-5-5", "between_tools")).toThrow(/No thinking translation/);
  });

  it("matches a supported id trimmed and case-insensitively and sends it as its row spells it", () => {
    expect(params(" Claude-Opus-5-5 ", "adaptive")).toEqual(params("claude-opus-5-5", "adaptive"));
  });

  it("gives an id with no row the plain request: model, messages, max_tokens and the feature's own fields", () => {
    expect(params("claude-next-9", undefined, FORMAT)).toEqual({
      model: "claude-next-9",
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: "usr" }],
      system: "sys",
      output_config: { format: FORMAT },
    });
    expect(buildClaudeParams({ model: "local-model", system: "", userContent: "u" }, undefined)).toEqual({
      model: "local-model",
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: "u" }],
    });
  });

  it("never sends a temperature", () => {
    for (const request of [params("claude-opus-5-5", "high"), params("other", undefined)]) {
      expect("temperature" in request).toBe(false);
    }
  });
});
