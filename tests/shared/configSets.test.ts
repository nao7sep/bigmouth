import { describe, expect, it } from "vitest";
import { changedSets, workspaceSetHasShape } from "@shared/configSets";
import { DEFAULT_CONTENT_FONT } from "@shared/types";

describe("config sets", () => {
  it("diffs per set and carries every member of a changed cluster", () => {
    const initial = { uiFontFamily: "", contentFont: DEFAULT_CONTENT_FONT };
    const contentFont = { ...DEFAULT_CONTENT_FONT, family: "Iosevka" };
    expect(changedSets({ ...initial, contentFont }, initial)).toEqual({ contentFont });
    expect(changedSets(initial, structuredClone(initial))).toEqual({});
  });
  it("validates the cluster shape without judging provider or numeric ranges", () => {
    expect(workspaceSetHasShape("contentFont", { family: "Partial" })).toBe(false);
    expect(workspaceSetHasShape("contentFont", { ...DEFAULT_CONTENT_FONT, size: -10 })).toBe(true);
    expect(workspaceSetHasShape("aiConfigs", [{ id: "custom", name: "Custom", provider: "anthropic", model: "new-model", thinking: true, maxTokens: -10 }])).toBe(true);
    expect(workspaceSetHasShape("aiConfigs", [{ id: "custom", name: "Custom", provider: "unknown", model: "new-model", thinking: true, maxTokens: 100 }])).toBe(false);
  });
});
