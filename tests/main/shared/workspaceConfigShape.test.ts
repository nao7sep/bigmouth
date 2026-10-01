import { describe, expect, it } from "vitest";
import { isWorkspaceConfig } from "@main/core/shared/workspaceConfigShape.js";

describe("isWorkspaceConfig", () => {
  it("accepts sparse JSON objects regardless of version or section presence", () => {
    for (const value of [{}, { timezone: "UTC" }, { schemaVersion: 99 }, { targets: "invalid set" }]) {
      expect(isWorkspaceConfig(value)).toBe(true);
    }
  });
  it("rejects non-objects", () => {
    for (const value of [null, [], "config", 3]) expect(isWorkspaceConfig(value)).toBe(false);
  });
});
