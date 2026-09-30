// Dev-only visual harness: the REAL UpdateButton (the sidebar "Update" word
// and its hover details popover) seeded with the last update payload, inside a
// facsimile of the sidebar header it actually lives in. The popover is
// position:fixed with coords computed from the button's rect, so the sidebar's
// real geometry is what determines the result — hence the shell below.
// Serve with `npx vite` and open /update-popover-harness.html.
import React from "react";
import { createRoot } from "react-dom/client";
import "../styles/global.css";
import { useUpdaterStore } from "../state/updater";
import { UpdateButton } from "../components/sidebar/UpdateButton";

/** The shape the updater manifest ships: a version, a date, and freeform
 *  markdown notes that parseReleaseNotes splits into sections. Shaped like a
 *  real release (several sections, mixed bullet/prose, inline code) so the
 *  popover is as tall as it gets in production. */
const LAST_UPDATE = {
  updateAvailable: true,
  version: "0.6.1",
  pubDate: "2026-09-24T09:12:00Z",
  notes: [
    "## Features",
    "",
    "- Inline artifacts now cap at a fixed height and scale tall diagrams to fit, so a 3000px flowchart no longer swallows the conversation.",
    "- Uploaded images are persisted to the app data dir, so a chat still shows the picture after a restart.",
    "- The update popover lists release notes as structured sections instead of raw markdown.",
    "",
    "## Bug Fixes",
    "",
    "- Hovering an inline diagram no longer dims the artwork: the global `button:hover` skin was painting a dark fill over the whole card.",
    "- The diagram full view clamped panning to the stage instead of the visible card, so a drag stopped short of the screen edge.",
    "- The kebab export menu was clipped by the card it hangs off and could run off the bottom of the window.",
    "",
    "## Changes",
    "",
    "- Tool specs trimmed; the registry is back under its budget.",
  ].join("\n"),
};

type State = "available" | "downloading" | "installed" | "error";

const STATES: Array<{ key: State; label: string }> = [
  { key: "available", label: "Update available" },
  { key: "downloading", label: "Downloading (62%)" },
  { key: "installed", label: "Installed" },
  { key: "error", label: "Error" },
];

function seed(state: State) {
  useUpdaterStore.setState({
    update: state === "available" || state === "downloading" ? LAST_UPDATE : LAST_UPDATE,
    install:
      state === "downloading"
        ? "downloading"
        : state === "installed"
          ? "installed"
          : state === "error"
            ? "error"
            : "idle",
    downloaded: state === "downloading" ? 68_400_000 : 0,
    total: state === "downloading" ? 110_300_000 : null,
    error: state === "error" ? "failed to download: connection reset" : null,
  });
}

/** The slice of the real sidebar the button is dropped into: a 236px column
 *  with the brand on the left and the nav cluster on the right, exactly like
 *  Sidebar.tsx renders it. */
function SidebarShell() {
  return (
    <div className="flex items-center gap-1 px-2 h-9" data-tauri-drag-region>
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="sidebar-wordmark px-1.5 py-0.5">Relay</span>
        <span className="sidebar-version">v0.6.0</span>
      </span>
      <span className="flex items-center flex-shrink-0 ml-auto">
        <UpdateButton />
      </span>
    </div>
  );
}

function App() {
  const [state, setState] = React.useState<State>("available");
  React.useEffect(() => seed(state), [state]);
  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <aside
        style={{
          width: 236,
          flex: "none",
          borderRight: "1px solid var(--border)",
          background: "var(--surface-1)",
        }}
      >
        <SidebarShell />
        <div style={{ padding: "10px 12px", fontSize: 12, opacity: 0.5 }}>
          sidebar body — the popover must not be clipped by this column
        </div>
      </aside>
      <main style={{ flex: 1, padding: 16 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {STATES.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setState(s.key)}
              style={{
                padding: "5px 10px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: s.key === state ? "var(--accent-soft)" : "transparent",
                color: "var(--text)",
                cursor: "pointer",
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
        <p style={{ fontSize: 12, opacity: 0.6, marginTop: 14 }}>
          Hover the <b>Update</b> button in the sidebar to open the details
          popover.
        </p>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
