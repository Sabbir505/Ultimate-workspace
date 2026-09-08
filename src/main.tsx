import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/global.css";
// KaTeX CSS (PERF rec #3) is NOT imported here anymore: it only matters once
// a math block renders, which happens exclusively inside the lazy-loaded
// MessageBubble / ArtifactPreviewPane chunks — those now import it, so the
// stylesheet (and the ~500 KB of font assets it references) arrives with the
// first lazy chunk that can render math instead of eagerly at boot. Vite
// still emits exactly ONE copy (module dedup), preserving the C8 fix.

// Dev-only debugging handle: lets Playwright/manual console inspection drive
// the stores (e.g. seeding panes to exercise the split layout) without a
// live Tauri backend.
if (import.meta.env.DEV) {
  void Promise.all([import("./state/panes"), import("./state/projects")]).then(
    ([panes, projects]) => {
      (window as unknown as Record<string, unknown>).__relay = {
        panes: panes.usePanesStore,
        projects: projects.useProjectsStore,
      };
    },
  );
}

createRoot(document.getElementById("root")!).render(<App />);

// Boot splash (index.html #splash): visible from the first webview paint.
// Hold it so the entrance animation plays (user-facing target ~2.5s), then
// fade + remove once React is rendering behind it. `performance.now()` is
// navigation-start-relative, so slow boots count toward the hold instead of
// adding on top of it.
{
  const splash = document.getElementById("splash");
  if (splash) {
    const SPLASH_HOLD_MS = 2400;
    const wait = Math.max(0, SPLASH_HOLD_MS - performance.now());
    window.setTimeout(() => {
      splash.classList.add("is-done");
      splash.addEventListener("transitionend", () => splash.remove(), { once: true });
      // Fallback: transitionend can be swallowed (e.g. reduced-motion +
      // instant style resolution) — never leave the splash in the DOM.
      window.setTimeout(() => splash.remove(), 800);
    }, wait);
  }
}
