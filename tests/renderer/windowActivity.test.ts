// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { installWindowActivityState } from "@renderer/windowActivity";

describe("native window activity presentation", () => {
  it("maps native activation to the inactive chrome attribute", () => {
    let publish!: (active: boolean) => void;
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((listener: (active: boolean) => void) => {
      publish = listener;
      return unsubscribe;
    });

    const cleanup = installWindowActivityState(subscribe, document.documentElement);
    publish(false);
    expect(document.documentElement.hasAttribute("data-window-inactive")).toBe(true);
    publish(true);
    expect(document.documentElement.hasAttribute("data-window-inactive")).toBe(false);
    cleanup();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
