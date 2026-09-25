/**
 * afterPaint — run work once the screen has actually been presented.
 *
 * Why this exists: a screen whose mount effect kicks off async reads
 * (AsyncStorage, a relay round-trip, a biometric capability probe) settles
 * those promises a few frames in. Each resolution is a setState, so the
 * screen re-renders WHILE the browser is still trying to present its first
 * frame — the re-render lands inside the paint window and pushes the visible
 * frame out by tens of milliseconds. Profiling Settings showed its first
 * render at ~14ms and a second render at ~69ms, which is what put it at
 * 90ms+ instead of ~40ms.
 *
 * The fix is the standard one: paint the frame you have, then hydrate. This
 * hook defers to AFTER the browser has presented the frame — InteractionManager
 * is the RN-native signal for "the user is not mid-gesture", and the rAF pair
 * guarantees at least one frame has been painted.
 */
import { useEffect, useRef } from 'react';

/**
 * @param delayMs Extra settle time after the painted frame. Use a small
 *   non-zero value for content that is purely below-the-fold scaffolding:
 *   it has no business racing the frame the user is waiting on.
 */
export function useAfterPaint(fn: () => void, deps: unknown[] = [], delayMs = 0) {
  const done = useRef(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (done.current) return;
    let raf2 = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    // Two frames: the first schedules the paint, the second runs once the
    // frame carrying our content has been presented.
    //
    // Deliberately NOT InteractionManager: it only flushes once a native
    // interaction handle clears, and on web nothing ever registers one — the
    // callback simply never ran, so every deferred section stayed hidden.
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (cancelled) return;
        // A third beat: two frames land us AT the paint boundary, and doing
        // the deferred work there still competes with it. One macrotask later
        // the frame is unambiguously on screen.
        timer = setTimeout(() => {
          if (cancelled) return;
          done.current = true;
          fnRef.current();
        }, delayMs);
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, delayMs]);
}
