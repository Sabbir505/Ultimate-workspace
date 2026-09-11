// Dev-only visual harness for the artifact-preview header (read-aloud button
// contrast/size investigation). Real components + real global CSS cascade, no
// Tauri backend. Serve with `npx vite` and open /artifact-header.html.
import React from "react";
import { createRoot } from "react-dom/client";
import "../styles/global.css";
import { SpeakerIcon, StopIcon } from "../lib/icons";

function DownloadIcon() {
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function PaneHeader({ speaking }: { speaking: boolean }) {
  return (
    <div className="artifact-preview-header">
      <div className="artifact-preview-header-actions">
        <button
          type="button"
          className={`artifact-preview-header-btn${speaking ? " active" : ""}`}
          title="Stop reading"
        >
          {speaking ? <StopIcon /> : <SpeakerIcon />}
        </button>
        <button type="button" className="artifact-preview-download-btn" title="Download">
          <DownloadIcon />
          <span>Download</span>
        </button>
        <button type="button" className="artifact-preview-header-btn" title="Open in default app">
          ↗
        </button>
        <button type="button" className="artifact-preview-header-btn" title="Close preview">
          ✕
        </button>
      </div>
    </div>
  );
}

const WIDTHS = [200, 260, 320, 420, 560];

function Case({ width, speaking }: { width: number; speaking: boolean }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ font: "11px monospace", color: "#888", padding: "2px 6px" }}>
        tool-panel width {width}px — speaking {String(speaking)}
      </div>
      <div className="tool-panel" style={{ width, position: "relative" }} id={`case-${width}-${speaking}`}>
        <div className="tool-panel-body">
          <div className="tool-panel-tab-content">
            <div className="artifact-preview-pane" data-pane>
              <PaneHeader speaking={speaking} />
              <div className="artifact-preview-content">
                <div className="artifact-preview-zoom" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <div className="app-shell" style={{ padding: 12 }}>
    <div className="chat-grid-wrap">
      {WIDTHS.map((w) => (
        <Case key={w} width={w} speaking />
      ))}
      {WIDTHS.map((w) => (
        <Case key={`s-${w}`} width={w} speaking={false} />
      ))}
    </div>
  </div>,
);
