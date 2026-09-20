// Dev-only harness: boots the REAL App shell in a plain browser on top of
// the Tauri IPC stub so view/overlay navigation (chat ↔ vault ↔ settings)
// can be driven and screenshotted without the Rust backend. Serve `npx vite`,
// open http://localhost:1500/app-shell-harness.html and drive the stores via
// window.__ui (ui store: setActiveView / closeOverlay) and window.__vault
// (vault store: mode / content).
import "./tauriStub";
import React from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "../components/common/ErrorBoundary";
import App from "../App";
import "../styles/global.css";
import { useUiStore } from "../state/ui";
import { useVaultStore } from "../state/vault";

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);

(window as unknown as Record<string, unknown>).__ui = useUiStore;
(window as unknown as Record<string, unknown>).__vault = useVaultStore;

// Seed a bound vault + an open note so the live editor / reading view render
// without the Rust backend (state-only; IPC calls resolve to null).
const DEMO_NOTE = [
  "# Linear Regression",
  "",
  "Whats up bro",
  "",
  "i thing i am gonna shoot you [[night]]",
  "",
  "==highlight== me and **bold** text with ~~strike~~ and `code`.",
  "",
  "> a quote line",
  "",
  "- [ ] a task",
  "",
  "| A | B |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
].join("\n");

useVaultStore.setState({
  root: "C:/demo-vault",
  stats: { notes: 9, links: 23, unresolved: 3, files: 12 },
  activePath: "ML Lessons/Untitled.md",
  savedContent: DEMO_NOTE,
  content: DEMO_NOTE,
  meta: {
    path: "ML Lessons/Untitled.md",
    title: null,
    basename: "Untitled.md",
    backlinks: [],
    unresolved_mentions: [{ src: "night", line: 5, raw: "night", is_embed: false }],
    outgoing: [{ src: "night", line: 5, raw: "night", is_embed: false }],
    tags: [],
    headings: [[1, "Linear Regression", 1]],
    aliases: [],
    word_count: 11,
  },
});
