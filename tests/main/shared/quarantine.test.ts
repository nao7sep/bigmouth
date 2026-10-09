import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuarantineError, moveAsideInvalid } from "@main/core/shared/quarantine.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-quarantine-"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T12:34:56.789Z"));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("moveAsideInvalid", () => {
  it("moves the file to a neighbour named to the second", () => {
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, "{ damaged");
    const movedTo = moveAsideInvalid(file);
    expect(path.basename(movedTo)).toBe("config-20261009-123456-utc.invalid");
    expect(fs.readFileSync(movedTo, "utf8")).toBe("{ damaged");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("never replaces an earlier set-aside copy, and leaves the file in place", () => {
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, "{ second");
    fs.writeFileSync(path.join(dir, "config-20261009-123456-utc.invalid"), "{ first");
    expect(() => moveAsideInvalid(file)).toThrow(QuarantineError);
    expect(fs.readFileSync(path.join(dir, "config-20261009-123456-utc.invalid"), "utf8")).toBe("{ first");
    expect(fs.readFileSync(file, "utf8")).toBe("{ second");
  });
});
