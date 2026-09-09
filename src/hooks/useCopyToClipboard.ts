import { useCallback, useEffect, useRef, useState } from "react";

/** Copy-to-clipboard with a transient "copied" flag for button feedback.
 *  Returns [copied, copy]; copy resolves false when the clipboard is
 *  unavailable. The reset timer self-cancels on unmount and re-copy so
 *  rapid clicks don't flip the flag off early. */
export function useCopyToClipboard(
  resetMs = 1600,
): [boolean, (text: string) => Promise<boolean>] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), resetMs);
        return true;
      } catch {
        // Clipboard unavailable — treat as not-copied.
        return false;
      }
    },
    [resetMs],
  );
  return [copied, copy];
}
