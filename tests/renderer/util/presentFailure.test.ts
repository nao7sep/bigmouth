import { afterEach, describe, expect, it, vi } from "vitest";

import { presentFailure } from "@renderer/util/presentFailure";
import { message } from "@shared/i18n/translate";
import { carryingText } from "@shared/i18n/carriedMessage";

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
      message("session.postListFailed"),
      "renderer: hostile boundary test",
      diagnostic,
    );

    expect(JSON.stringify(presented)).not.toMatch(/EACCES|private\/tmp|BIGMOUTH_SENTINEL|invoking remote method/i);
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

    expect(presentFailure(message("session.postListFailed"), "test diagnostic", new Error("original")))
      .toEqual(message("session.postListFailed"));
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("could not be recorded"),
      expect.objectContaining({ diagnostic: expect.objectContaining({ error: expect.objectContaining({ message: "original" }) }) }),
    );
  });

  it("shows the message a failure carries across IPC in place of the authored copy", () => {
    Object.defineProperty(window, "bigmouth", { configurable: true, value: { writeRendererLog: vi.fn() } });
    const carried = message("store.newerFormat", { path: "/data/ws/config.json" });
    const err = new Error(`Error invoking remote method 'settings:get': Error: ${carryingText(carried)}`);

    expect(presentFailure(message("settings.loadFailed"), "test diagnostic", err)).toEqual(carried);
  });
});
