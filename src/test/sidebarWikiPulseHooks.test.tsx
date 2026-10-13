// The wiki-build pulse in the Sidebar, and the hook-order trap it walked into:
// `wikiBuilding` used to be TWO `useWikiStore` calls joined by `||`. A build
// starting flips the first selector to true, JS short-circuits the right
// operand, and the second HOOK is skipped for that render — the component's
// hook count changes mid-life, so every later hook lands one slot off. The
// crash surfaced far from the cause: `useViewNav`'s `useCallback` read the
// previous render's `useRef` object as its deps array and React's compare
// threw "Cannot read properties of undefined (reading 'length')" — caught by
// the root ErrorBoundary, which is exactly the report from the field (the app
// died the moment a wiki build started).
//
// This test walks the transition that used to crash: mount the sidebar with
// the wiki idle, then start a build (status.jobRunning, then progress
// running) and assert the sidebar keeps rendering its pulse.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";

// Permissive IPC stub: the Sidebar's tree touches a lot of commands, and this
// test is about hook order, not any one of them. `then`/`catch`/ESM keys must
// resolve to undefined — a stub that answers them with functions makes the
// mocked module a thenable, and awaiting it wedges the test worker.
vi.mock("../lib/ipc", () => {
  const PASS_THROUGH = new Set([
    "then",
    "catch",
    "finally",
    "__esModule",
    "default",
    "SIDEBAR_ART_PRESETS",
  ]);
  const stub = new Proxy(
    {},
    {
      // Vitest's module proxy asks `in` before `get`; without this trap every
      // named import throws "no export is defined on the mock".
      has: (_t, prop) => typeof prop === "string" && !PASS_THROUGH.has(prop),
      get: (_t, prop) => {
        if (typeof prop !== "string") return undefined;
        if (prop === "SIDEBAR_ART_PRESETS") return [];
        if (PASS_THROUGH.has(prop)) return undefined;
        if (prop === "sidebarArtPresetUrl") return () => "";
        if (prop === "PROVIDER_INPUT_INCLUDES_CACHE") return {};
        if (prop === "toastError" || prop === "toastSuccess" || prop === "toastInfo")
          return () => {};
        return vi.fn().mockResolvedValue(null);
      },
    },
  );
  return stub;
});

import { Sidebar } from "../components/sidebar/Sidebar";
import { useChatStore } from "../state/chat";
import { useProjectsStore } from "../state/projects";
import { useWikiStore } from "../state/wiki";
import type { WikiProgress } from "../lib/ipc/wiki";

function runningProgress(): WikiProgress {
  return {
    path: "D:\\repo",
    mode: "build",
    state: "running",
    phase: "analysis",
    pageSlug: null,
    pagesDone: 0,
    pagesTotal: 0,
    error: null,
    step: "Exploring the project structure",
  };
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useWikiStore.setState({ progress: null, steps: [] });
  useProjectsStore.setState({ projects: [], gitStatuses: {}, loaded: true });
  useChatStore.setState({
    sessions: [],
    activeChatSessionId: null,
    streaming: {},
    chatStatus: {},
    messages: [],
    loaded: true,
  });
});

describe("sidebar wiki-build pulse", () => {
  it("survives the idle → running transition (hook order is stable)", async () => {
    render(<Sidebar />);
    expect(document.querySelector(".sidebar-wiki-running")).toBeNull();

    // The exact field sequence: the view starts a build; the store's status
    // snapshot says a job is running, then live progress events arrive.
    act(() => {
      useWikiStore.setState((s) => ({ status: { ...(s.status ?? {}), jobRunning: true } }) as never);
      useWikiStore.setState({ progress: runningProgress() });
    });

    await waitFor(() =>
      expect(document.querySelector(".sidebar-wiki-running")).toBeTruthy(),
    );
    // Still the sidebar, still rendering — no crash panel, no unmount.
    expect(screen.getByText("Wiki")).toBeTruthy();
  });

  it("keeps the pulse when only the status snapshot knows about the job", async () => {
    useWikiStore.setState((s) => ({ status: { ...(s.status ?? {}), jobRunning: true } }) as never);
    render(<Sidebar />);
    await waitFor(() =>
      expect(document.querySelector(".sidebar-wiki-running")).toBeTruthy(),
    );
  });
});
