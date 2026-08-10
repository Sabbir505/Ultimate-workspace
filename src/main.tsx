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
      (window as unknown as Record<string, unknown>).__conduit = {
        panes: panes.usePanesStore,
        projects: projects.useProjectsStore,
      };
    },
  );
}

createRoot(document.getElementById("root")!).render(<App />);
