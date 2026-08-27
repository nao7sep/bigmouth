// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { denyUnhandledExternalDrop } from "../../src/renderer/src/util/externalDropBoundary";

function drag(target: Element, types: string[], items: Array<{ kind: string }> = []): DragEvent {
  const event = new Event("drop", { cancelable: true }) as DragEvent;
  Object.defineProperties(event, {
    target: { value: target },
    dataTransfer: { value: { types, items, dropEffect: "copy" } },
  });
  return event;
}

describe("desktop drop boundary", () => {
  it("denies files even over an editor", () => {
    const event = drag(document.createElement("textarea"), [], [{ kind: "file" }]);
    denyUnhandledExternalDrop(event);
    expect(event.defaultPrevented).toBe(true);
    expect(event.dataTransfer?.dropEffect).toBe("none");
  });

  it("retains ordinary text drops in an editor and denies them elsewhere", () => {
    const editable = drag(document.createElement("textarea"), ["text/plain"]);
    denyUnhandledExternalDrop(editable);
    expect(editable.defaultPrevented).toBe(false);

    const unowned = drag(document.createElement("div"), ["text/plain"]);
    denyUnhandledExternalDrop(unowned);
    expect(unowned.defaultPrevented).toBe(true);
  });

  it("does not override an owned target", () => {
    const event = drag(document.createElement("div"), ["Files"]);
    event.preventDefault();
    event.dataTransfer!.dropEffect = "copy";
    denyUnhandledExternalDrop(event);
    expect(event.dataTransfer?.dropEffect).toBe("copy");
  });
});
