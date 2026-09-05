import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/global.css";
// KaTeX is the math renderer used by MessageBubble (markdown) and
// ArtifactPreviewPane. Both are lazy-loaded so the CSS only matters once
// a math block actually renders, but the @import itself is eager at
// module-evaluation time. Importing it ONCE at the app entry and removing
// the per-component imports deduplicates it (vite produces one copy of the
// stylesheet instead of two for the entry + each lazy chunk that also
// requests it). See PERFORMANCE_AUDIT.md C8.
import "katex/dist/katex.min.css";

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
