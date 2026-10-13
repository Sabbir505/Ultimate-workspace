// Dev-only visual harness (not part of the app build): renders the REAL
// BrowserPane's header stack — tab bar, URL bar (the 2026-10 redesign:
// history cluster | omnibox | overflow + action cluster), load bar and the
// agent-trust strip — against a LinkedIn profile URL, so the redesign can be
// inspected in a real engine at a realistic pane width.
// Serve with `npx vite` and open /browser-urlbar-harness.html.
import React from "react";
import { createRoot } from "react-dom/client";
import "../styles/global.css";
import { BrowserPane } from "../components/panes/BrowserPane";
import { usePanesStore, type Pane } from "../state/panes";
import { useUiStore } from "../state/ui";

/** Generic avatar square as a stand-in favicon. */
const FAVICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" rx="3" fill="#0a66c2"/><text x="8" y="12" font-family="sans-serif" font-size="10" font-weight="700" fill="#fff" text-anchor="middle">in</text></svg>`,
  );

function pane(): Pane {
  return {
    paneId: "pane-harness",
    state: "idle",
    lastUsedAt: 1,
    lastInputAt: 0,
    activity: null,
    data: {
      kind: "browser",
      url: "https://example.com/in/example-profile/",
      projectId: null,
      tabs: [
        {
          tabId: "t-1",
          url: "https://example.com/in/example-profile/",
          title: "Example Profile",
          faviconUrl: FAVICON,
        },
        {
          tabId: "t-2",
          url: "https://example.com/news",
          title: "Hacker News",
        },
      ],
      activeTabIndex: 0,
    },
  };
}

const HARNESS_PANE = pane();

function App() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "var(--surface-1)",
      }}
    >
      <div style={{ padding: "18px 20px 0", fontSize: 12, opacity: 0.55 }}>
        Browser header harness — the ⋯ button opens the home/DevTools overflow menu.
      </div>
      <div
        style={{
          margin: "18px 20px",
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          overflow: "hidden",
          background: "var(--surface)",
        }}
      >
        <BrowserPane pane={HARNESS_PANE} />
      </div>
    </div>
  );
}

// The pane's store reads (active tab, fullscreen flag) resolve against these
// seeds; the harness only paints the header, so the store stays otherwise empty.
usePanesStore.setState({ panes: [], focusedPaneId: null });
useUiStore.setState({ activeView: "chat", toolPanelTab: "browser", toolPanelCollapsed: false });

createRoot(document.getElementById("root")!).render(<App />);
