// The guard test for the model tables (ai-model-routing-conventions): every row
// has its branch, every thinking value is translated, any other id gets the plain
// request, every role's kind has exactly one default, and every role has a field.
// It reads the table rather than restating it: the rows, their order, lists and
// defaults come from the lineup research the table names and are reviewed there.

import { describe, expect, it } from "vitest";

import {
  AI_ROLES,
  AI_ROLE_IDS,
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
// Ids no lineup will list, so each stands for a typed model with no row.
const UNLISTED = ["claude-not-a-model", "gpt-not-a-model", "local"];
const UNLISTED_VALUE = "not-a-thinking-value";

function request(model: string, thinking: string | undefined) {
  return buildClaudeParams({ model, system: "", userContent: "u" }, thinking);
}

// Two rows to move between, and a value the first lists that the second does
// not start at, so a reset is visible.
function twoRows() {
  for (const from of SUPPORTED_MODELS) {
    for (const to of SUPPORTED_MODELS) {
      const value = from.thinking.find((candidate) => candidate !== to.defaultThinking);
      if (to !== from && value !== undefined) return { from, to, value };
    }
  }
  throw new Error("the table has no two rows a thinking choice can move between");
}

describe("the model tables", () => {
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
    for (const id of UNLISTED) {
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
      expect(rowFor(defaultModelFor("anthropic", role.kind))!.kinds, role.id).toContain(role.kind);
    }
    expect(SUPPORTED_MODELS.some((row) => row.defaultFor.includes("text-frontier"))).toBe(false);
  });

  it("defaults a model's thinking by the model's tier and lists that default among its values", () => {
    for (const row of SUPPORTED_MODELS) {
      expect(row.thinking, row.id).toContain(row.defaultThinking);
      // The fast tier thinks as little as it can; every other tier adaptively, where it is listed.
      expect(row.defaultThinking, row.id).toBe(row.kinds.includes("text-fast") ? row.thinking[0] : "adaptive");
    }
  });

  it("sends only a value the row lists, else the row's default", () => {
    for (const row of SUPPORTED_MODELS) {
      for (const value of row.thinking) {
        expect(thinkingFor(row.id, value), `${row.id} ${value}`).toBe(value);
        expect(thinkingFor(` ${row.id.toUpperCase()} `, value), `${row.id} ${value}`).toBe(value);
      }
      expect(thinkingFor(row.id, UNLISTED_VALUE), row.id).toBe(row.defaultThinking);
      expect(hasThinkingChoice(row), row.id).toBe(row.thinking.length > 1);
    }
    expect(hasThinkingChoice(undefined)).toBe(false);
  });

  it("resets thinking on a model edit only when it reaches a different listed row than the last one the field held", () => {
    const { from, to, value } = twoRows();
    for (const same of [`${from.id} `, ` ${from.id}`, from.id.toUpperCase(), from.id]) {
      expect(thinkingAfterModelEdit(from.id, same, value), same).toEqual({ thinking: value, lastListedModel: same });
    }
    expect(thinkingAfterModelEdit(from.id, to.id, value)).toEqual({ thinking: to.defaultThinking, lastListedModel: to.id });
    // An unlisted id keeps the value and the last listed id; a field that has held no row keeps the value
    // at the first row it reaches when that row lists it, and otherwise starts at that row's default.
    const unlisted = UNLISTED[0]!;
    expect(thinkingAfterModelEdit(from.id, unlisted, value)).toEqual({ thinking: value, lastListedModel: from.id });
    expect(thinkingAfterModelEdit(unlisted, from.id, value)).toEqual({ thinking: value, lastListedModel: from.id });
    expect(thinkingAfterModelEdit(unlisted, to.id, UNLISTED_VALUE)).toEqual({ thinking: to.defaultThinking, lastListedModel: to.id });
  });

  it("keeps the choice when a letter of the id is deleted and retyped, and resets it on reaching another row", () => {
    const { from, to, value } = twoRows();
    const typing = [from.id.slice(0, -1), from.id.slice(0, -2), from.id.slice(0, -1), from.id];
    for (const partial of typing.slice(0, -1)) expect(rowFor(partial), `${partial} is typed on the way`).toBeUndefined();
    let state = { thinking: value, lastListedModel: from.id };
    for (const typed of typing) {
      state = thinkingAfterModelEdit(state.lastListedModel, typed, state.thinking);
    }
    expect(state).toEqual({ thinking: value, lastListedModel: from.id });
    for (const typed of [to.id.slice(0, 1), to.id]) {
      state = thinkingAfterModelEdit(state.lastListedModel, typed, state.thinking);
    }
    expect(state).toEqual({ thinking: to.defaultThinking, lastListedModel: to.id });
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
