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
});
