// ChatPaneGrid rendering smoke: the split-tree renderer draws one full chat
// pane per leaf (header on pinned panes only), one resizer per split, and
// live drop zones while a session drag is active — dropping a session on a
// zone must open that chat in a new pane on that edge.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  scanLocalModels: vi.fn(async () => []),
  localModelStatus: vi.fn(async () => null),
  getLocalModelOverrides: vi.fn(async () => ({})),
  countContextTokens: vi.fn(async () => null),
  listConnectors: vi.fn(async () => []),
  mcpGalleryList: vi.fn(async () => ({ installed: [] })),
  listSessionConnectors: vi.fn(async () => []),
  listChatSkills: vi.fn(async () => []),
  listPromptTemplates: vi.fn(async () => []),
  getChatMessages: vi.fn(async () => []),
  getChatSessionMetrics: vi.fn(async () => null),
  listChatArtifacts: vi.fn(async () => []),
  listChatCheckpoints: vi.fn(async () => []),
}));

import { ChatPaneGrid } from "../components/chat/ChatPaneGrid";
import { endChatSessionDrag, startChatSessionDrag } from "../lib/chatPaneDnd";
import { findPaneForSession, insertChatPaneSplit } from "../state/chat/paneTree";
import { useChatStore } from "../state/chat";

function session(id: string) {
  return { id, title: `Title ${id}`, provider: "openai", model: "m", createdAt: 0, lastActiveAt: 0 };
}

function seed() {
  const tree = insertChatPaneSplit(null, {
    targetPaneId: "main",
    edge: "right",
    newPaneId: "pane-2",
    sessionId: "s2",
    splitId: "split-1",
  });
  useChatStore.setState({
    loaded: true,
    sessions: [session("s1"), session("s2"), session("s3")],
    activeChatSessionId: "s1",
    messages: [],
    messagesSessionId: "s1",
    chatPaneTree: tree,
    paneBuffers: { "pane-2": { sessionId: "s2", messages: [], hasMoreHistory: false } },
    focusedPaneId: null,
    focusedChatSessionId: null,
    streaming: {},
    chatStatus: {},
  } as never);
  return tree!;
}

beforeAll(() => {
  // jsdom has no layout: give every element a nonzero box so the transcript
  // virtualizer inside each ChatView materializes its rows.
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return 600;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return 800;
    },
  });
});

afterAll(() => {
  // @ts-expect-error restore the jsdom accessor for other suites in the file
  delete HTMLElement.prototype.offsetHeight;
  // @ts-expect-error restore the jsdom accessor for other suites in the file
  delete HTMLElement.prototype.offsetWidth;
});

beforeEach(() => {
  vi.clearAllMocks();
  endChatSessionDrag();
});

afterEach(() => {
  cleanup();
  endChatSessionDrag();
});

describe("ChatPaneGrid", () => {
  it("renders one pane per leaf with a floating close ✕ on EVERY pane (no title bar)", () => {
    const tree = seed();
    render(<ChatPaneGrid node={tree} />);
    expect(document.querySelectorAll(".chat-pane").length).toBe(2);
    // No per-pane title bar — the top toolbar shows the focused chat's title.
    expect(document.querySelectorAll(".chat-pane-header").length).toBe(0);
    expect(document.querySelector(".chat-pane-title")).toBeNull();
    // One floating ✕ per pane, carrying its chat's title for a11y.
    expect(document.querySelectorAll(".chat-pane-float-close").length).toBe(2);
    expect(screen.getByLabelText("Close pane: Title s1")).toBeTruthy();
    expect(screen.getByLabelText("Close pane: Title s2")).toBeTruthy();
    // One gutter for the single split.
    expect(document.querySelectorAll(".chat-pane-resizer").length).toBe(1);
  });

  it("closing the pinned pane collapses the tree back to the plain view", async () => {
    const tree = seed();
    render(<ChatPaneGrid node={tree} />);
    fireEvent.click(screen.getByLabelText(/Close pane: Title s2/));
    await waitFor(() => {
      expect(useChatStore.getState().chatPaneTree).toBeNull();
    });
    expect(useChatStore.getState().paneBuffers).toEqual({});
  });

  it("hovering a drop edge previews an equal half-pane", () => {
    const tree = seed();
    const view = render(<ChatPaneGrid node={tree} />);
    act(() => startChatSessionDrag("s3"));
    view.rerender(<ChatPaneGrid node={tree} />);
    expect(document.querySelectorAll(".chat-pane-drop-preview").length).toBe(0);
    const zone = document.querySelector('.chat-pane[data-pane="main"] .chat-pane-dropzone.right')!;
    fireEvent.dragOver(zone);
    const preview = document.querySelector(".chat-pane-drop-preview.right");
    expect(preview).not.toBeNull();
    // Leaving the zone clears the preview.
    fireEvent.dragLeave(zone);
    expect(document.querySelectorAll(".chat-pane-drop-preview").length).toBe(0);
  });

  it("dropping a dragged session on a pane edge opens it there", async () => {
    const tree = seed();
    const view = render(<ChatPaneGrid node={tree} />);
    // A chat drag starts (sidebar dragstart mirrors into the module store);
    // the pane renders its four edge drop zones.
    act(() => startChatSessionDrag("s3"));
    view.rerender(<ChatPaneGrid node={tree} />);
    expect(document.querySelectorAll(".chat-pane-dropzone").length).toBe(8); // 4 per pane

    // Drop s3 on the RIGHT edge of the MAIN pane (the first .chat-pane).
    const mainPane = document.querySelector('.chat-pane[data-pane="main"]')!;
    const zone = mainPane.querySelector(".chat-pane-dropzone.right")!;
    await act(async () => {
      fireEvent.drop(zone);
      // App subscribes to the tree and re-renders the grid with the new node;
      // the test drives that same pass manually since it passes node as a prop.
      view.rerender(<ChatPaneGrid node={useChatStore.getState().chatPaneTree!} />);
    });
    const s = useChatStore.getState();
    expect(findPaneForSession(s.chatPaneTree, "s3")).not.toBeNull();
    // 3 panes now; s2's pane untouched; drop zones are gone (drag ended).
    expect(document.querySelectorAll(".chat-pane").length).toBe(3);
    expect(findPaneForSession(s.chatPaneTree, "s2")).toBe("pane-2");
    expect(document.querySelectorAll(".chat-pane-dropzone").length).toBe(0);
  });
});
