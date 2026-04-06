import { useEffect, useRef } from "react";

/**
 * Calls `handler` when the Escape key is pressed.
 * Uses a ref so the latest handler is always invoked without re-registering the listener.
 */
export function useEscapeKey(handler: () => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") ref.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
