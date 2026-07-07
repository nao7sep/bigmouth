import { useCallback, useEffect, useRef, useState } from "react";

export function useCopyFeedback(duration = 1500) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = useCallback(
    (text: string, key = "default") => {
      navigator.clipboard.writeText(text).catch(() => {});
      setCopiedKey(key);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(
        () => setCopiedKey((current) => (current === key ? null : current)),
        duration
      );
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
