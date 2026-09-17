// Git Pill Lab (dev-only, /git-pill-harness.html): the REAL GitToolsSidebar
// mounted outside the Tauri shell with seeded store state, so the collapsed
// task pill can be inspected/screenshotted in a plain browser. Not part of
// the production build.
import "./tauriStub";
import React from "react";
import { createRoot } from "react-dom/client";

import "../styles/tokens.css";
import "../styles/global.css";
import "../styles/shell.css";
import "../styles/chat.css";
import "../styles/composer.css";
import "../styles/pickers.css";
import "../styles/sidebar.css";
import "../styles/panes.css";
import "../styles/toolpanel.css";
import { GitToolsSidebar } from "../components/chat/GitToolsSidebar";
import { useUiStore } from "../state/ui";
import { useChatStore } from "../state/chat";
import { useProjectsStore } from "../state/projects";

useUiStore.setState({ gitSidebarCollapsed: true });
useChatStore.setState({
  activeChatSessionId: "sess-task",
  sessionProjects: {},
  sessions: [
    { id: "sess-task", title: "t", provider: "openai", model: "m", createdAt: 1, lastActiveAt: 2 } as never,
  ],
  tasks: {},
  planSteps: {
    "sess-task": [
      { stepId: "p1", label: "Locate an existing image asset and note where it is used across the app", status: "in_progress", source: "todo_write", planIndex: 0, stepIndex: 0 },
      { stepId: "p2", label: "Second step", status: "pending", source: "todo_write", planIndex: 0, stepIndex: 1 },
    ],
  } as never,
  subagents: {},
  messages: [],
});
useProjectsStore.setState({ projects: [], gitStatuses: {} });

function Lab() {
  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh" }}>
      <GitToolsSidebar />
      <div
        id="diagnostics"
        style={{
          position: "fixed",
          left: 12,
          bottom: 12,
          fontFamily: "monospace",
          fontSize: 12,
          color: "#ddd",
          whiteSpace: "pre",
        }}
      />
    </div>
  );
}

function report() {
  const pill = document.querySelector(".git-sidebar-task-pill");
  const arrow = document.querySelector(".git-sidebar-task-pill-arrow");
  const d = document.getElementById("diagnostics");
  if (!pill || !arrow || !d) return;
  const cs = getComputedStyle(pill);
  const pr = pill.getBoundingClientRect();
  const ar = arrow.getBoundingClientRect();
  d.textContent = [
    `pill: display=${cs.display} pos=${cs.position} align=${cs.alignItems} radius=${cs.borderRadius} rect=${Math.round(pr.left)},${Math.round(pr.top)} ${Math.round(pr.width)}x${Math.round(pr.height)}`,
    `arrow: display=${getComputedStyle(arrow).display} rect=${Math.round(ar.left)},${Math.round(ar.top)} ${Math.round(ar.width)}x${Math.round(ar.height)}`,
    `arrow inside pill: ${ar.left >= pr.left && ar.right <= pr.right && ar.top >= pr.top && ar.bottom <= pr.bottom}`,
  ].join("\n");
}

// Report after mount and again after styles/layout settle.
createRoot(document.getElementById("root")!).render(<Lab />);
setTimeout(report, 50);
setTimeout(report, 500);
window.addEventListener("resize", report);
