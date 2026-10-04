// The guard test for the model tables (ai-model-routing-conventions): every row
// has its branch, every thinking value is translated, any other id gets the plain
// request, every role's kind has exactly one default, and every role has a field.

import { describe, expect, it } from "vitest";

import {
  AI_ROLES,
  AI_ROLE_IDS,
  SUPPORTED_MODELS,
  defaultModelFor,
  defaultThinkingFor,
  hasThinkingChoice,
  kindOf,
  modelsFor,
  rowFor,
  thinkingFor,
} from "@shared/aiModels";
import { WORKSPACE_SET_KEYS, modelSetKey, thinkingSetKey } from "@shared/configSets";
import { buildClaudeParams } from "@main/core/ai/claudeRequest.js";
import { makeDefaultConfig } from "@main/core/shared/defaults.js";

const PLAIN_KEYS = ["max_tokens", "messages", "model"];

function request(model: string, thinking: string | undefined) {
  return buildClaudeParams({ model, system: "", userContent: "u" }, thinking);
}

describe("the model tables", () => {
  it("keeps the approved rows with their thinking lists", () => {
    expect(SUPPORTED_MODELS.map((row) => [row.id, row.kinds, row.defaultFor, row.thinking])).toEqual([
      ["claude-fable-5-1", ["text-frontier"], [], ["adaptive", "low", "medium", "high", "xhigh", "max"]],
      ["claude-opus-5-5", ["text-smart"], ["text-smart"], ["adaptive", "low", "medium", "high", "xhigh", "max"]],
      ["claude-sonnet-5-5", ["text-balanced"], ["text-balanced"], ["between_tools", "adaptive", "low", "medium", "high", "xhigh", "max"]],
      ["claude-haiku-4-5", ["text-fast"], ["text-fast"], ["off"]],
    ]);
    expect(AI_ROLES).toEqual([
      { id: "analysis", kind: "text-balanced" },
      { id: "metadata", kind: "text-fast" },
      { id: "imagingPrompts", kind: "text-balanced" },
    ]);
  });

  it("gives every row its branch, translating every thinking value it lists into its own request", () => {
    for (const row of SUPPORTED_MODELS) {
      const sent = row.thinking.map((value) => JSON.stringify(request(row.id, value)));
      for (const [index, value] of row.thinking.entries()) {
        expect(Object.keys(request(row.id, value)).sort(), `${row.id} ${value}`).toContain("thinking");
        expect(sent.indexOf(sent[index]!), `${row.id} ${value} is told apart`).toBe(index);
      }
    }
  });

  it("gives an id with no row the plain request", () => {
    for (const id of ["claude-sonnet-5", "claude-opus-6", "gpt-6-luna", "local"]) {
      expect(rowFor(id), id).toBeUndefined();
      expect(thinkingFor(id, "analysis", "adaptive"), id).toBeUndefined();
      expect(Object.keys(request(id, thinkingFor(id, "analysis", "adaptive"))).sort(), id).toEqual(PLAIN_KEYS);
    }
  });

  it("has exactly one default for every kind a role uses, and never defaults the frontier", () => {
    for (const role of AI_ROLES) {
      const rows = modelsFor("anthropic", role.kind);
      expect(rows.length, role.id).toBeGreaterThan(0);
      expect(rows.filter((row) => row.defaultFor.includes(role.kind)), role.id).toHaveLength(1);
    }
    expect(SUPPORTED_MODELS.some((row) => row.defaultFor.includes("text-frontier"))).toBe(false);
    expect(defaultModelFor("anthropic", "text-balanced")).toBe("claude-sonnet-5-5");
    expect(defaultModelFor("anthropic", "text-fast")).toBe("claude-haiku-4-5");
  });

  it("defaults each role's thinking by its tier and sends only a value the row lists", () => {
    const sonnet = rowFor("claude-sonnet-5-5")!;
    expect(defaultThinkingFor(sonnet, "analysis")).toBe("adaptive");
    expect(defaultThinkingFor(sonnet, "metadata")).toBe("between_tools");
    expect(defaultThinkingFor(rowFor("claude-haiku-4-5")!, "metadata")).toBe("off");
    expect(defaultThinkingFor(rowFor("claude-haiku-4-5")!, "analysis")).toBe("off");
    expect(thinkingFor("claude-opus-5-5", "analysis", "between_tools")).toBe("adaptive");
    expect(thinkingFor(" CLAUDE-SONNET-5-5 ", "analysis", "between_tools")).toBe("between_tools");
    expect(hasThinkingChoice(rowFor("claude-haiku-4-5"))).toBe(false);
    expect(hasThinkingChoice(sonnet)).toBe(true);
  });

  it("gives every role a model set and a thinking set, holding its defaults", () => {
    const config = makeDefaultConfig();
    expect(config["anthropic.endpoint"]).toBe("https://api.anthropic.com");
    for (const role of AI_ROLE_IDS) {
      expect(WORKSPACE_SET_KEYS).toContain(modelSetKey(role));
      expect(WORKSPACE_SET_KEYS).toContain(thinkingSetKey(role));
      const model = defaultModelFor("anthropic", kindOf(role));
      expect(config[modelSetKey(role)]).toBe(model);
      expect(config[thinkingSetKey(role)]).toBe(defaultThinkingFor(rowFor(model)!, role));
    }
  });
});
