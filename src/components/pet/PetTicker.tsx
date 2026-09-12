// PetTicker — the single rAF loop that ages the pet (mood cooldowns, strolls,
// naps). Mounted once at app level; pauses when the pet is disabled, when the
// window is hidden, and caps its dt so a backgrounded webview doesn't fast-
// forward the pet's walk across the strip on return.
import { useEffect } from "react";

import { usePetStore } from "../../state/pet";

export function PetTicker(): null {
  const enabled = usePetStore((s) => s.enabled);

  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    let last = performance.now();
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden) {
        last = t;
        return;
      }
      const dtSec = Math.min((t - last) / 1000, 0.25);
      last = t;
      usePetStore.getState().tick(Date.now(), dtSec);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [enabled]);

  return null;
}
