// Regression tests for the artifact auto-open gate: `onArtifact` must track
// every produced file in the store (Artifacts gallery) but only auto-open a
// right-side tool-panel tab for finished, viewable deliverables (images, pdf,
// office docs, csv). Source-code writes (html/tsx/jsx/…) used to pop a tab
// per file write — coding sessions turned into tab soup. The agent shows
// those deliberately via the `open_file` tool instead.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  listArtifacts: vi.fn().mockResolvedValue([]),
  deleteArtifact: vi.fn().mockResolvedValue(undefined),
  deleteAllArtifacts: vi.fn().mockResolvedValue(0),
  listChatArtifacts: vi.fn().mockResolvedValue([]),
  getChatMessages: vi.fn().mockResolvedValue([]),
  listChatSessions: vi.fn().mockResolvedValue([]),
}));

import { useChatStore } from "../state/chat";
import { useUiStore } from "../state/ui";

function seedStreaming() {
  useChatStore.setState({
    artifacts: {},
    pendingArtifacts: {},
    // onArtifact tracks regardless, but keep the session shape realistic.
    sessions: [],
    // Default: s1 is the active (focused) session, so the auto-open paths
    // under test still fire.
    focusedChatSessionId: null,
    activeChatSessionId: "s1",
  });
  useUiStore.setState({
    openTabs: [],
    nextTabId: 1,
    activeTabId: null,
    toolPanelTab: "terminal",
    toolPanelCollapsed: true,
  });
}

function artifactTabs() {
  return useUiStore.getState().openTabs.filter((t) => t.kind === "artifact");
}

describe("onArtifact auto-open gate", () => {
  beforeEach(() => {
    seedStreaming();
  });

  it("tracks a code file but does NOT open a tab for it", () => {
    useChatStore.getState().onArtifact({
      chatSessionId: "s1",
      path: "C:/proj/src/App.tsx",
      filename: "App.tsx",
    });
    // Tracked for the Artifacts gallery + bubble chips…
    expect(useChatStore.getState().artifacts.s1).toEqual([
      { path: "C:/proj/src/App.tsx", filename: "App.tsx" },
    ]);
    // …but no tab, and the tool panel stays collapsed.
    expect(artifactTabs()).toHaveLength(0);
    expect(useUiStore.getState().toolPanelCollapsed).toBe(true);
  });

  it("does not open tabs for html/jsx/css/json/md writes either", () => {
    for (const filename of ["index.html", "Widget.jsx", "style.css", "data.json", "README.md"]) {
      useChatStore.getState().onArtifact({
        chatSessionId: "s1",
        path: `C:/proj/${filename}`,
        filename,
      });
    }
    expect(artifactTabs()).toHaveLength(0);
    // All five were still tracked.
    expect(useChatStore.getState().artifacts.s1).toHaveLength(5);
  });

  it("auto-opens viewable deliverables (png/pdf/docx) as tabs", () => {
    for (const filename of ["diagram.png", "report.pdf", "summary.docx"]) {
      useChatStore.getState().onArtifact({
        chatSessionId: "s1",
        path: `C:/out/${filename}`,
        filename,
      });
    }
    const tabs = artifactTabs();
    expect(tabs.map((t) => t.artifactPath)).toEqual([
      "C:/out/diagram.png",
      "C:/out/report.pdf",
      "C:/out/summary.docx",
    ]);
    expect(useUiStore.getState().toolPanelCollapsed).toBe(false);
  });

  it("svg still renders inline only (no tab), as before", () => {
    useChatStore.getState().onArtifact({
      chatSessionId: "s1",
      path: "C:/out/flow.svg",
      filename: "flow.svg",
    });
    expect(artifactTabs()).toHaveLength(0);
    expect(useChatStore.getState().artifacts.s1).toHaveLength(1);
  });

  it("unknown extensions default to track-only (no junk-file tab spam)", () => {
    useChatStore.getState().onArtifact({
      chatSessionId: "s1",
      path: "C:/proj/package-lock.json.bak",
      filename: "package-lock.json.bak",
    });
    expect(artifactTabs()).toHaveLength(0);
    expect(useChatStore.getState().artifacts.s1).toHaveLength(1);
  });

  it("does NOT auto-open a viewable artifact from a background session", () => {
    // s2 runs in another pane; the user is working in s1 (active, no pin).
    useChatStore.getState().onArtifact({
      chatSessionId: "s2",
      path: "C:/out/browser-shot-1789829194043.png",
      filename: "browser-shot-1789829194043.png",
    });
    // Tracked for s2's gallery + bubble…
    expect(useChatStore.getState().artifacts.s2).toHaveLength(1);
    // …but the shared tool panel stays untouched.
    expect(artifactTabs()).toHaveLength(0);
    expect(useUiStore.getState().toolPanelCollapsed).toBe(true);
  });

  it("auto-open follows the focused split pane, not merely the active session", () => {
    // Split view with the focus pinned to s2: s1's deliverable must not yank
    // the shared panel even though s1 is the plain active session.
    useChatStore.setState({ focusedChatSessionId: "s2", activeChatSessionId: "s1" });
    useChatStore.getState().onArtifact({
      chatSessionId: "s1",
      path: "C:/out/report.pdf",
      filename: "report.pdf",
    });
    expect(useChatStore.getState().artifacts.s1).toHaveLength(1);
    expect(artifactTabs()).toHaveLength(0);

    // The focused session's own deliverable still opens.
    useChatStore.getState().onArtifact({
      chatSessionId: "s2",
      path: "C:/out/diagram.png",
      filename: "diagram.png",
    });
    expect(artifactTabs().map((t) => t.artifactPath)).toEqual(["C:/out/diagram.png"]);
    expect(useUiStore.getState().toolPanelCollapsed).toBe(false);
  });
});
