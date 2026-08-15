// Tests the CommandPalette "Chats" section (FTS5 message/title search):
//   1. A 2+ char query fires the debounced searchChatMessages IPC and renders
//      a CHATS section with the session title as label + snippet as hint.
//   2. Selecting a hit closes the palette and calls
//      useChatStore.selectSession with the hit's chatSessionId.
//   3. Queries under 2 chars and rejected IPC calls render no CHATS section.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../lib/ipc", () => ({
  searchChatMessages: vi.fn(),
}));

const searchMock = vi.mocked((await import("../lib/ipc")).searchChatMessages);

// The palette pulls project/session lists from the projects store and select
// flows from the chat store — stub both stores' methods the component touches.
vi.mock("../state/projects", () => {
  const state = {
    projects: [],
    sessions: [],
    selectedProjectId: null,
    projectById: () => undefined,
    selectProject: vi.fn(),
    setExpanded: vi.fn(),
    addProjectAtPath: vi.fn(),
  };
  const useProjectsStore = (sel: (s: unknown) => unknown) => sel(state);
  useProjectsStore.getState = () => state;
  return { useProjectsStore };
});
const selectSession = vi.fn().mockResolvedValue(undefined);
vi.mock("../state/chat", () => ({
  useChatStore: { getState: () => ({ selectSession }) },
}));
vi.mock("../state/ui", () => {
  const listeners = new Set<() => void>();
  let open = false;
  const setOpen = (v: boolean) => {
    open = v;
    listeners.forEach((l) => l());
  };
  const store = {
    get paletteOpen() {
      return open;
    },
    setPaletteOpen: setOpen,
    setActiveView: vi.fn(),
    setProjectSettingsFor: vi.fn(),
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getState: () => store,
  };
  const useUiStore = (sel: (s: unknown) => unknown) => sel(store);
  useUiStore.getState = () => store;
  return { useUiStore };
});

import { useUiStore } from "../state/ui";
import { CommandPalette } from "../components/command-palette/CommandPalette";

function hit(over: Record<string, unknown> = {}) {
  return {
    chatSessionId: "chat-1",
    sessionTitle: "Relay debugging",
    messageId: 42,
    snippet: "…the relay timed out…",
    role: "user",
    createdAt: 1,
    lastActiveAt: 2,
    ...over,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reopen the palette for each test (the mock ui store starts closed and
  // the reset-on-open effect wipes state, so set it via setPaletteOpen).
  useUiStore.getState().setPaletteOpen(true);
});

afterEach(() => {
  cleanup();
});

describe("CommandPalette Chats (FTS) section", () => {
  it("debounces searchChatMessages for a 2+ char query and renders the CHATS section", async () => {
    searchMock.mockResolvedValue([hit({})]);
    const { container } = render(<CommandPalette />);
    const input = container.querySelector<HTMLInputElement>(".palette input");
    expect(input).not.toBeNull();

    fireEvent.change(input!, { target: { value: "relay" } });

    await waitFor(() => {
      expect(searchMock).toHaveBeenCalledWith("relay", 12);
    });
    await waitFor(() => {
      const sectionHeader = [...container.querySelectorAll(".section")].find((el) =>
        el.textContent?.includes("CHATS"),
      );
      expect(sectionHeader).toBeDefined();
    });
    const item = container.querySelector(".item");
    expect(item?.textContent).toContain("Relay debugging");
    expect(item?.textContent).toContain("relay timed out");
  });

  it("opens the session when a chat hit is activated", async () => {
    searchMock.mockResolvedValue([hit({ chatSessionId: "chat-9" })]);
    const { container } = render(<CommandPalette />);
    const input = container.querySelector<HTMLInputElement>(".palette input")!;
    fireEvent.change(input, { target: { value: "relay" } });

    await waitFor(() => {
      expect(container.querySelector(".item")).not.toBeNull();
    });
    fireEvent.click(container.querySelector(".item")!);

    expect(selectSession).toHaveBeenCalledWith("chat-9");
  });

  it("does not search for queries shorter than 2 chars and survives IPC errors", async () => {
    searchMock.mockRejectedValue(new Error("db locked"));
    const { container } = render(<CommandPalette />);
    const input = container.querySelector<HTMLInputElement>(".palette input")!;

    fireEvent.change(input, { target: { value: "r" } });
    expect(searchMock).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "rel" } });
    await waitFor(() => {
      expect(searchMock).toHaveBeenCalledWith("rel", 12);
    });
    // Rejected IPC must not leave the palette in a broken state.
    await waitFor(() => {
      const headers = [...container.querySelectorAll(".section")].map((el) => el.textContent);
      expect(headers.some((h) => h?.includes("CHATS"))).toBe(false);
    });
  });
});
