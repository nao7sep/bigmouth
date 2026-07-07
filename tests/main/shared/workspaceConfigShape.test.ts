import { describe, expect, it } from "vitest";
import { isWorkspaceConfig } from "@main/core/shared/workspaceConfigShape.js";
import { CONFIG_SCHEMA_VERSION } from "@main/core/shared/types.js";

function configShape(): Record<string, unknown> {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    aiConfigs: [],
    targets: [],
    analysisPrompts: [],
    generationPrompts: {},
  };
}

describe("isWorkspaceConfig", () => {
  it("accepts the supported BigMouth workspace shape", () => {
    expect(isWorkspaceConfig(configShape())).toBe(true);
  });

  it("rejects generic config objects", () => {
    expect(isWorkspaceConfig({ title: "My Blog", theme: "dark" })).toBe(false);
  });

  it("rejects unsupported schema versions", () => {
    expect(isWorkspaceConfig({ ...configShape(), schemaVersion: CONFIG_SCHEMA_VERSION + 1 })).toBe(false);
  });

  it("rejects incomplete workspace sections", () => {
    const { targets: _targets, ...incomplete } = configShape();
    expect(isWorkspaceConfig(incomplete)).toBe(false);
  });
});
