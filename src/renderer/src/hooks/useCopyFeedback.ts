import { useCallback, useEffect, useRef, useState } from "react";
import { reportProblem } from "../api";

export function useCopyFeedback(duration = 1500) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copyErrors, setCopyErrors] = useState<Record<string, string>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = useCallback(
    async (text: string, key = "default") => {
      // "Copied" was shown before the write resolved and the rejection was
      // swallowed, so a failed copy still reported success and the user pasted
      // whatever was on the clipboard before.
      try {
        await navigator.clipboard.writeText(text);
        setCopyErrors((current) => {
          if (!(key in current)) return current;
          const next = { ...current };
          delete next[key];
          return next;
        });
        setCopiedKey(key);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(
          () => setCopiedKey((current) => (current === key ? null : current)),
          duration
        );
      } catch (err) {
        reportProblem("clipboard write failed", err, { key });
        setCopiedKey((current) => (current === key ? null : current));
        setCopyErrors((current) => ({
          ...current,
          [key]: "Could not copy to the clipboard. Try again.",
        }));
      }
    },
    [duration]
  );

  const dismissCopyError = useCallback((key: string) => {
    setCopyErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const clearCopyErrors = useCallback(() => setCopyErrors({}), []);

  // Drop the pending reset on unmount so it never fires on a gone component
  // (e.g. closing the Export modal right after Copy).
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return { copiedKey, copy, copyErrors, dismissCopyError, clearCopyErrors };
}
