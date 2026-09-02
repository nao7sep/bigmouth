import { afterEach, describe, expect, it, vi } from "vitest";

import { presentFailure } from "@renderer/util/presentFailure";

afterEach(() => {
  delete (window as unknown as { bigmouth?: unknown }).bigmouth;
});

describe("presentFailure", () => {
  it("keeps hostile diagnostics out of presentation while retaining them in the log", () => {
    const writeRendererLog = vi.fn();
    Object.defineProperty(window, "bigmouth", {
      configurable: true,
      value: { writeRendererLog },
    });
    const diagnostic = new TypeError(
      "Error invoking remote method 'posts:list': EACCES /private/tmp/BIGMOUTH_SENTINEL",
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
        error: expect.objectContaining({ message: expect.stringContaining("BIGMOUTH_SENTINEL") }),
      }),
    }));
  });
});
