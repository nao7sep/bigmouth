import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureFrameworkStorage } from "@main/frameworkStorage.js";
import { getAppRoot } from "@main/core/services/storagePaths.js";

const temporaryRoots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it.each(["absolute", "expanded"])("creates both framework paths under the shared %s override before assigning them", (form) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-framework-"));
  temporaryRoots.push(root);
  vi.stubEnv("BIGMOUTH_FRAMEWORK_TEST_ROOT", root);
  vi.stubEnv("BIGMOUTH_DATA_DIR", form === "absolute" ? path.join(root, "profile") : "$BIGMOUTH_FRAMEWORK_TEST_ROOT/profile");
  const setPath = vi.fn((_name: "userData" | "sessionData", directory: string) => {
    expect(fs.statSync(directory).isDirectory()).toBe(true);
  });
  configureFrameworkStorage({ setPath });
  expect(getAppRoot()).toBe(path.join(root, "profile"));
  expect(setPath.mock.calls).toEqual([
    ["userData", path.join(root, "profile", "electron")],
    ["sessionData", path.join(root, "profile", "electron", "session")],
  ]);
});

it("rejects an unusable framework directory without assigning a default path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-framework-"));
  temporaryRoots.push(root);
  fs.writeFileSync(path.join(root, "electron"), "occupied by a file");
  vi.stubEnv("BIGMOUTH_DATA_DIR", root);
  const setPath = vi.fn();
  expect(() => configureFrameworkStorage({ setPath })).toThrow();
  expect(setPath).not.toHaveBeenCalled();
});
