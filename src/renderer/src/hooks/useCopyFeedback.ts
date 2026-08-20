import { useCallback, useEffect, useRef, useState } from "react";
import { reportProblem } from "../api";

export function useCopyFeedback(duration = 1500) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = useCallback(
    (text: string, key = "default") => {
      // "Copied" was shown before the write resolved and the rejection was
      // swallowed, so a failed copy still reported success and the user pasted
      // whatever was on the clipboard before.
      void navigator.clipboard
        .writeText(text)
        .then(() => {
          setCopiedKey(key);
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(
            () => setCopiedKey((current) => (current === key ? null : current)),
            duration
          );
        })
        .catch((err: unknown) => {
          reportProblem("clipboard write failed", err, { key });
        });
    },
    [duration]
  );

  // Drop the pending reset on unmount so it never fires on a gone component
  // (e.g. closing the Export modal right after Copy).
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return { copiedKey, copy };
}
