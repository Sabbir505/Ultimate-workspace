import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/global.css";

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
