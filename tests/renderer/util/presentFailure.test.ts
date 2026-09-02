import { afterEach, describe, expect, it, vi } from "vitest";

import { presentFailure } from "@renderer/util/presentFailure";

afterEach(() => {
  delete (window as unknown as { bigmouth?: unknown }).bigmouth;
  vi.restoreAllMocks();
});

describe("presentFailure", () => {
  it("keeps hostile diagnostics out of presentation while retaining type and cause in the log", () => {
    const writeRendererLog = vi.fn();
    Object.defineProperty(window, "bigmouth", {
      configurable: true,
      value: { writeRendererLog },
    });
    const cause = new RangeError("EACCES /private/tmp/BIGMOUTH_CAUSE_SENTINEL");
    const diagnostic = new TypeError(
      "Error invoking remote method 'posts:list': BIGMOUTH_SENTINEL",
      { cause },
    );

    const presented = presentFailure(
      "Posts could not be loaded. Reopen the workspace to try again.",
      "renderer: hostile boundary test",
      diagnostic,
    );

    expect(presented).not.toMatch(/EACCES|private\/tmp|BIGMOUTH_SENTINEL|invoking remote method/i);
    expect(writeRendererLog).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      detail: expect.objectContaining({
        error: expect.objectContaining({
          message: expect.stringContaining("BIGMOUTH_SENTINEL"),
          cause: expect.objectContaining({ message: expect.stringContaining("BIGMOUTH_CAUSE_SENTINEL") }),
        }),
      }),
    }));
  });

  it("uses the console fallback when the logging bridge throws", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    Object.defineProperty(window, "bigmouth", {
      configurable: true,
      value: { writeRendererLog: vi.fn(() => { throw new Error("bridge failed"); }) },
    });

    expect(presentFailure("Authored copy", "test diagnostic", new Error("original"))).toBe("Authored copy");
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("could not be recorded"),
      expect.objectContaining({ diagnostic: expect.objectContaining({ error: expect.objectContaining({ message: "original" }) }) }),
    );
  });
});
