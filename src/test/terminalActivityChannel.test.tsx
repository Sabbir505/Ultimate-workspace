// Audit 2026-09-14 #1: the backend only emits the `pty:output` EVENT when no
// channel consumer is registered — and TerminalPane always subscribes the pty
// channel on mount. The activity parser (pane-header chip + terminal activity
// feed) listened ONLY to the event, so it could never fire in production.
// The channel frames must feed the same parser (the event listener stays as
// the fallback path).
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  channels: [] as Array<{ onmessage: ((frame: number[]) => void) | null }>,
  // pty:output event handlers captured from safeListen (the fallback path).
  eventListeners: [] as Array<(p: { paneId: string; data: string }) => void>,
}));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  safeListen: (event: string, handler: (p: { paneId: string; data: string }) => void) => {
    if (event === "pty:output") hoisted.eventListeners.push(handler);
    return Promise.resolve(() => {});
  },
}));

// Capture every channel the pane subscribes so tests can push frames through
// the onmessage handler (the production hot path).
vi.mock("../lib/channels", () => ({
  ptyChannel: vi.fn(() => {
    const ch = { onmessage: null as ((frame: number[]) => void) | null };
    hoisted.channels.push(ch);
    return Promise.resolve(ch);
  }),
}));

// Stub xterm (real xterm needs layout) — same approach as
// terminalThemeAndExport.test.tsx.
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown>;
    buffer = { active: { viewportY: 0, baseY: 0 } };
    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts };
    }
    loadAddon() {}
    open() {}
    focus() {}
    attachCustomKeyEventHandler() {}
    onData() { return { dispose() {} }; }
    dispose() {}
    getSelection() { return ""; }
    hasSelection() { return false; }
    scrollToBottom() {}
    write() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class { fit() {} activate() {} dispose() {} },
}));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class { findNext() {} findPrevious() {} dispose() {} },
}));
vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class { serialize() { return ""; } dispose() {} },
}));

import { TerminalPane } from "../components/panes/TerminalPane";
import { usePanesStore, type Pane } from "../state/panes";
import { useSettingsStore } from "../state/settings";

const PANE: Pane = {
  paneId: "pane-act",
  // Non-idle — the idle-clear effect would wipe the activity chip otherwise.
  state: "working",
  lastUsedAt: 1,
  lastInputAt: 0,
  activity: null,
  data: {
    kind: "terminal",
    sessionId: "sess-1",
    harness: "claude_code",
    label: "T",
    spawn: { type: "agent", sessionId: "sess-1" },
    exited: false,
    exitCode: null,
    crashed: false,
  },
};

function lastChannel() {
  const ch = hoisted.channels[hoisted.channels.length - 1];
  if (!ch) throw new Error("no pty channel was subscribed");
  return ch;
}

function pushFrame(ch: { onmessage: ((frame: number[]) => void) | null }, text: string) {
  act(() => {
    ch.onmessage!(Array.from(new TextEncoder().encode(text)));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  hoisted.channels.length = 0;
  hoisted.eventListeners.length = 0;
  useSettingsStore.setState({ theme: "dark" });
  usePanesStore.setState({ panes: [{ ...PANE }], focusedPaneId: "pane-act" });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  usePanesStore.setState({ panes: [] });
});

describe("TerminalPane activity from channel frames", () => {
  it("sets the pane-header activity chip from channel output", async () => {
    render(<TerminalPane pane={PANE} focused={false} />);
    // Flush the (async) channel subscription so onmessage is attached.
    await act(async () => {});
    const ch = lastChannel();
    expect(ch.onmessage).toBeTruthy();

    pushFrame(ch, "⏺ Reading src/app.ts\n");
    await act(async () => {
      vi.advanceTimersByTime(600); // activity debounce is 500ms
    });

    const pane = usePanesStore.getState().panes.find((p) => p.paneId === "pane-act");
    expect(pane?.activity).toContain("Reading");
  });

  it("populates the activity feed with a fenced block from channel output", async () => {
    const { container } = render(<TerminalPane pane={PANE} focused={false} />);
    await act(async () => {});
    const ch = lastChannel();

    pushFrame(ch, "here you go:\n```mermaid\ngraph TD; A-->B;\n```\n");
    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    expect(container.querySelector(".terminal-feed-card")).toBeTruthy();
  });

  it("still parses via the pty:output event fallback", async () => {
    render(<TerminalPane pane={PANE} focused={false} />);
    await act(async () => {});
    // The activity effect registered the event listener at mount (fallback
    // path) — first of the two pty:output registrations.
    const activityListener = hoisted.eventListeners[0];
    expect(activityListener).toBeTruthy();
    // Kill the channel handler: only the event path flows now.
    lastChannel().onmessage = null;

    act(() => {
      activityListener({ paneId: "pane-act", data: "⏺ Writing out.ts\n" });
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    const pane = usePanesStore.getState().panes.find((p) => p.paneId === "pane-act");
    expect(pane?.activity).toContain("Writing");
  });
});
