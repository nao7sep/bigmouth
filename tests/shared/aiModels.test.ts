// The guard test for the model tables (ai-model-routing-conventions): every row
// has its branch, every thinking value is translated, any other id gets the plain
// request, every role's kind has exactly one default, and every role has a field.
// The rows, lists and defaults are those of the lineup the table names.

import { describe, expect, it } from "vitest";

import {
  AI_ROLES,
  AI_ROLE_IDS,
  MODEL_LINEUP,
  SUPPORTED_MODELS,
  defaultModelFor,
  hasThinkingChoice,
  kindOf,
  modelsFor,
  rowFor,
  thinkingAfterModelEdit,
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
  it("names the lineup its rows come from", () => {
    expect(MODEL_LINEUP).toBe("ai-model-lineup-20261004");
  });

  it("keeps the lineup's rows, in order, with their thinking lists and defaults", () => {
    expect(SUPPORTED_MODELS.map((row) => [row.provider, row.id, row.kinds, row.defaultFor, row.thinking, row.defaultThinking])).toEqual([
      ["anthropic", "claude-fable-5-1", ["text-frontier"], [], ["adaptive", "low", "medium", "high", "xhigh", "max"], "adaptive"],
      ["anthropic", "claude-opus-5-5", ["text-smart"], ["text-smart"], ["adaptive", "low", "medium", "high", "xhigh", "max"], "adaptive"],
      ["anthropic", "claude-sonnet-5-5", ["text-balanced"], ["text-balanced"], ["between_tools", "adaptive", "low", "medium", "high", "xhigh", "max"], "adaptive"],
      ["anthropic", "claude-haiku-4-5", ["text-fast"], ["text-fast"], ["off"], "off"],
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

  it("gives an id with no row the plain request, a removed row's id included", () => {
    // The previous generation, which the lineup dropped, then ids it never listed.
    for (const id of ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-6", "gpt-6-luna", "local"]) {
      expect(rowFor(id), id).toBeUndefined();
      expect(thinkingFor(id, "adaptive"), id).toBeUndefined();
      expect(Object.keys(request(id, thinkingFor(id, "adaptive"))).sort(), id).toEqual(PLAIN_KEYS);
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

  it("defaults a model's thinking by the model's tier and lists that default among its values", () => {
    for (const row of SUPPORTED_MODELS) {
      expect(row.thinking, row.id).toContain(row.defaultThinking);
      // The fast tier thinks as little as it can; every other tier adaptively, where it is listed.
      expect(row.defaultThinking, row.id).toBe(row.kinds.includes("text-fast") ? row.thinking[0] : "adaptive");
    }
  });

  it("sends only a value the row lists, else the row's default", () => {
    const sonnet = rowFor("claude-sonnet-5-5")!;
    expect(thinkingFor("claude-opus-5-5", "between_tools")).toBe("adaptive");
    expect(thinkingFor(" CLAUDE-SONNET-5-5 ", "between_tools")).toBe("between_tools");
    expect(thinkingFor("claude-haiku-4-5", "adaptive")).toBe("off");
    expect(hasThinkingChoice(rowFor("claude-haiku-4-5"))).toBe(false);
    expect(hasThinkingChoice(sonnet)).toBe(true);
  });

  it("resets thinking on a model edit only when it reaches a different listed row than the last one the field held", () => {
    const sonnet = "claude-sonnet-5-5";
    for (const same of [`${sonnet} `, ` ${sonnet}`, "Claude-Sonnet-5-5", sonnet]) {
      expect(thinkingAfterModelEdit(sonnet, same, "between_tools"), same).toEqual({ thinking: "between_tools", lastListedModel: same });
    }
    expect(thinkingAfterModelEdit(sonnet, "claude-opus-5-5", "max")).toEqual({ thinking: "adaptive", lastListedModel: "claude-opus-5-5" });
    expect(thinkingAfterModelEdit(sonnet, "claude-haiku-4-5", "max").thinking).toBe("off");
    // An unlisted id keeps the value and the last listed id; a field that has held no row keeps the value
    // at the first row it reaches when that row lists it, and otherwise starts at that row's default.
    expect(thinkingAfterModelEdit(sonnet, "claude-next-9", "max")).toEqual({ thinking: "max", lastListedModel: sonnet });
    expect(thinkingAfterModelEdit("claude-next-9", sonnet, "max")).toEqual({ thinking: "max", lastListedModel: sonnet });
    expect(thinkingAfterModelEdit("claude-next-9", "claude-opus-5-5", "between_tools")).toEqual({ thinking: "adaptive", lastListedModel: "claude-opus-5-5" });
  });

  it("keeps the choice when a letter of the id is deleted and retyped, and resets it on reaching another row", () => {
    let state = { thinking: "between_tools", lastListedModel: "claude-sonnet-5-5" };
    for (const typed of ["claude-sonnet-5-", "claude-sonnet-", "claude-sonnet-5-", "claude-sonnet-5-5"]) {
      state = thinkingAfterModelEdit(state.lastListedModel, typed, state.thinking);
    }
    expect(state).toEqual({ thinking: "between_tools", lastListedModel: "claude-sonnet-5-5" });
    for (const typed of ["claude-", "claude-opus-5-5"]) {
      state = thinkingAfterModelEdit(state.lastListedModel, typed, state.thinking);
    }
    expect(state).toEqual({ thinking: "adaptive", lastListedModel: "claude-opus-5-5" });
  });

  it("gives every role a model set and a thinking set, holding its defaults", () => {
    const config = makeDefaultConfig();
    expect(config["anthropic.endpoint"]).toBe("https://api.anthropic.com");
    for (const role of AI_ROLE_IDS) {
      expect(WORKSPACE_SET_KEYS).toContain(modelSetKey(role));
      expect(WORKSPACE_SET_KEYS).toContain(thinkingSetKey(role));
      const model = defaultModelFor("anthropic", kindOf(role));
      expect(config[modelSetKey(role)]).toBe(model);
      expect(config[thinkingSetKey(role)]).toBe(rowFor(model)!.defaultThinking);
    }
  });
});
