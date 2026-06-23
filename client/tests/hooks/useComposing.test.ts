import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { describe, expect, it } from "vitest";
import { isComposingEvent, isComposingKeyboardEvent } from "../../src/hooks/useComposing";

const ref = (value: boolean): RefObject<boolean> => ({ current: value });

// Plain object literals stand in for keyboard events — these are pure-function checks, so no DOM
// event construction is needed.
const keyEvent = (props: Record<string, unknown>) => props as unknown as KeyboardEvent;

describe("isComposingKeyboardEvent", () => {
  it("is true when the composition ref is set, regardless of the event", () => {
    expect(isComposingKeyboardEvent(ref(true), keyEvent({ isComposing: false }))).toBe(true);
  });

  it("is true when the native event reports isComposing", () => {
    expect(isComposingKeyboardEvent(ref(false), keyEvent({ isComposing: true }))).toBe(true);
  });

  it("falls back to legacy keyCode 229", () => {
    expect(isComposingKeyboardEvent(ref(false), keyEvent({ isComposing: false, keyCode: 229 }))).toBe(true);
  });

  it("reads through a React synthetic event's nativeEvent", () => {
    const synthetic = { nativeEvent: { isComposing: true } } as unknown as ReactKeyboardEvent;
    expect(isComposingKeyboardEvent(ref(false), synthetic)).toBe(true);
  });

  it("is false when no composition signal is present", () => {
    expect(isComposingKeyboardEvent(ref(false), keyEvent({ isComposing: false, keyCode: 0 }))).toBe(false);
  });
});

// The ref-free variant the global shortcut dispatcher uses: a command chord mid-composition carries
// isComposing on its own keydown, so no per-input ref is needed there.
describe("isComposingEvent", () => {
  it("is true when the native event reports isComposing", () => {
    expect(isComposingEvent(keyEvent({ key: "n", metaKey: true, isComposing: true }))).toBe(true);
  });

  it("falls back to legacy keyCode 229", () => {
    expect(isComposingEvent(keyEvent({ isComposing: false, keyCode: 229 }))).toBe(true);
  });

  it("reads through a React synthetic event's nativeEvent", () => {
    const synthetic = { nativeEvent: { isComposing: true } } as unknown as ReactKeyboardEvent;
    expect(isComposingEvent(synthetic)).toBe(true);
  });

  it("is false for a plain command chord with no composition in progress", () => {
    expect(isComposingEvent(keyEvent({ key: "n", metaKey: true, isComposing: false, keyCode: 0 }))).toBe(false);
  });
});
