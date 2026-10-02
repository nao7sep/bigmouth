import { describe, expect, it } from "vitest";
import { isWorkspaceConfig } from "@main/core/shared/workspaceConfigShape.js";

describe("isWorkspaceConfig", () => {
  it("accepts an empty map and any object holding a known set key", () => {
    for (const value of [{}, { timezone: "UTC" }, { targets: "invalid set" }, { schemaVersion: 99, targets: [] }]) {
      expect(isWorkspaceConfig(value)).toBe(true);
    }
  });
  it("rejects an object holding no known set key", () => {
    for (const value of [{ title: "My Blog", theme: "dark" }, { schemaVersion: 99 }]) {
      expect(isWorkspaceConfig(value)).toBe(false);
    }
  });
  it("rejects non-objects", () => {
    for (const value of [null, [], "config", 3]) expect(isWorkspaceConfig(value)).toBe(false);
  });
});
