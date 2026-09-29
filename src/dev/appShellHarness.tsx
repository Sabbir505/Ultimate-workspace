// Dev-only harness: boots the REAL App shell in a plain browser on top of
// the Tauri IPC stub so view/overlay navigation (chat ↔ vault ↔ settings)
// can be driven and screenshotted without the Rust backend. Serve `npx vite`,
// open http://localhost:1500/app-shell-harness.html and drive the stores via
// window.__ui (ui store: setActiveView / closeOverlay), window.__vault
// (vault store: mode / content), window.__projects / window.__chat /
// window.__projectsSidebar (seed projects + nested chats for the Projects
// panel).
import "./tauriStub";
import React from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "../components/common/ErrorBoundary";
import App from "../App";
import "../styles/global.css";
import { useUiStore } from "../state/ui";
import { useVaultStore } from "../state/vault";
import { useAutomationsStore } from "../state/automations";
import { useProjectsStore } from "../state/projects";
import { useChatStore } from "../state/chat";
import { useProjectsSidebarStore } from "../state/projectsSidebar";
import type { Automation } from "../lib/ipc";

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);

(window as unknown as Record<string, unknown>).__ui = useUiStore;
(window as unknown as Record<string, unknown>).__vault = useVaultStore;
// The automations view's header chrome lives in the title bar, so its metric
// chips can only be inspected with the store actually holding rows.
(window as unknown as Record<string, unknown>).__automations = useAutomationsStore;
(window as unknown as Record<string, unknown>).__projects = useProjectsStore;
(window as unknown as Record<string, unknown>).__chat = useChatStore;
(window as unknown as Record<string, unknown>).__projectsSidebar =
  useProjectsSidebarStore;

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

// Seed a few automations so the view renders its list (and the title bar its
// metric chips) instead of the empty state. A failing row is included on
// purpose — the failing chip is the one the title bar keeps longest when the
// window narrows.
const demoAutomation = (id: string, over: Partial<Automation> = {}): Automation => ({
  id,
  name: `Automation ${id.toUpperCase()}`,
  prompt: "Summarize yesterday's commits.",
  harness: "claude_code",
  model: "",
  cwd: "C:/demo",
  schedule: "0 * * * *",
  enabled: true,
  lastStatus: "ok",
  lastRunAt: 1756000000,
  chatSessionId: null,
  createdAt: 1755000000,
  origin: "user",
  triggerType: "cron",
  triggerConfig: "{}",
  lastTriggerState: null,
  lastEventRunAt: null,
  ...over,
});

useAutomationsStore.setState({
  loaded: true,
  automations: [
    demoAutomation("a1"),
    demoAutomation("a2"),
    demoAutomation("a3"),
    demoAutomation("a4", { enabled: false }),
    demoAutomation("a5", { lastStatus: "error" }),
  ],
});
