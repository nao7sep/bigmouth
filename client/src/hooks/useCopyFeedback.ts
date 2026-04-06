import { useCallback, useState } from "react";

export function useCopyFeedback(duration = 1500) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copy = useCallback(
    (text: string, key = "default") => {
      navigator.clipboard.writeText(text).catch(() => {});
      setCopiedKey(key);
      setTimeout(
        () => setCopiedKey((current) => (current === key ? null : current)),
        duration
      );
    },
    [duration]
  );

  return { copiedKey, copy };
}
