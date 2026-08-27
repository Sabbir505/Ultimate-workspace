// Measure an element's rendered height via ResizeObserver. Used by the chat
// view to size the transcript's bottom padding to the FLOATING composer
// dock's real height — the dock overlays the transcript, so its height
// (multi-line input, queue chip, approval card, goal-loop chip) is exactly
// the space the last message needs reserved below it.
import { useEffect, useRef, useState } from "react";

export function useElementHeight<T extends HTMLElement>(): [
  React.RefObject<T>,
  number,
] {
  // null! keeps the ref's type as RefObject<T> (assignable straight to a
  // JSX ref prop) while starting empty; the effect guards for real.
  const ref = useRef<T>(null!);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Remeasure on any size change — content-driven growth (the composer
    // gaining lines, a queue chip stacking on) re-fires this.
    const observer = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height ?? el.offsetHeight;
      setHeight(h);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, height];
}
