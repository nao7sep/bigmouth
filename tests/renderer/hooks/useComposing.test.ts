import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import {
  isComposingEvent,
  isComposingKeyboardEvent,
  useComposing,
} from "@renderer/hooks/useComposing";

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

// The ref-tracking hook: compositionstart sets the flag, compositionend defers the
// clear by one animation frame (the WebKit ordering quirk documented in the source),
// and a fresh compositionstart cancels a pending clear. Fake timers stand in for the
// requestAnimationFrame the hook schedules its deferred clear through.
describe("useComposing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("starts not composing", () => {
    const { result } = renderHook(() => useComposing());
    expect(result.current.composingRef.current).toBe(false);
  });

  it("sets the ref immediately on compositionstart", () => {
    const { result } = renderHook(() => useComposing());
    act(() => result.current.handlers.onCompositionStart());
    expect(result.current.composingRef.current).toBe(true);
  });

  it("keeps the ref set until the next animation frame after compositionend", () => {
    const { result } = renderHook(() => useComposing());
    act(() => result.current.handlers.onCompositionStart());
    act(() => result.current.handlers.onCompositionEnd());

    // The clear is deferred so a keydown firing in the same tick still sees the
    // composition (the WebKit-before-keydown case); the flag is still set here.
    expect(result.current.composingRef.current).toBe(true);

    act(() => {
      vi.runAllTimers();
    });
    expect(result.current.composingRef.current).toBe(false);
  });

  it("cancels a pending clear when composition restarts before the frame fires", () => {
    const { result } = renderHook(() => useComposing());
    act(() => result.current.handlers.onCompositionStart());
    act(() => result.current.handlers.onCompositionEnd());

    // A new composition starts before the deferred clear runs: it must cancel the
    // pending frame so the still-true flag is not clobbered to false afterwards.
    act(() => result.current.handlers.onCompositionStart());
    act(() => {
      vi.runAllTimers();
    });
    expect(result.current.composingRef.current).toBe(true);
  });

  it("ignores a redundant compositionstart with no pending clear", () => {
    // Two starts in a row exercise the rafIdRef === null branch on the second call.
    const { result } = renderHook(() => useComposing());
    act(() => result.current.handlers.onCompositionStart());
    act(() => result.current.handlers.onCompositionStart());
    expect(result.current.composingRef.current).toBe(true);
  });
});
