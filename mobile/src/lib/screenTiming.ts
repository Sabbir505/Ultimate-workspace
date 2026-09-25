/**
 * Screen mount timing, dev-only.
 *
 * The "does a screen open fast enough" question needs the number measured
 * INSIDE the app: Playwright can time a click, but it cannot tell you
 * whether the delay was navigation, the screen's own effects, or the relay
 * round-trip. Each screen calls `markScreenMounted` from a layout effect;
 * `window.__screenMarks` collects name -> ms-since-navigation-start, which
 * the measurement harness reads back.
 *
 * Costs nothing in production: the marks are only written when the global
 * collector is installed (the harness), and the hook is a no-op otherwise.
 */
import { useEffect, useRef } from 'react';

interface ScreenCollector {
  navStart: number;
  marks: Record<string, number>;
}

declare global {
  // eslint-disable-next-line no-var
  var __screenMarks: ScreenCollector | undefined;
}

export function beginScreenTiming() {
  if (typeof performance !== 'undefined' && !globalThis.__screenMarks) {
    globalThis.__screenMarks = { navStart: performance.now(), marks: {} };
  }
}

export function markScreenMounted(name: string) {
  const c = globalThis.__screenMarks;
  if (!c) return;
  const now = typeof performance !== 'undefined' ? performance.now() : 0;
  c.marks[name] = Math.round((now - c.navStart) * 10) / 10;
}

/**
 * Call at the top of a screen component. Returns nothing; the timing is
 * recorded from the mount layout effect.
 */
export function useScreenMountTiming(name: string) {
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    markScreenMounted(name);
  }, [name]);
}
