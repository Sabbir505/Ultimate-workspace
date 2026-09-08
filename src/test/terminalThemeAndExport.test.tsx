// C9 (ISSUES.md): with theme "system" the TerminalPane resolved the xterm
// colorscheme once — an OS appearance flip never re-resolved it because the
// store's `theme` string didn't change. The theme effect must subscribe to
// matchMedia("(prefers-color-scheme: dark)") changes.
// C10 (ISSUES.md): an export failure flipped the same `copied` flag used for
// success, so the button showed the success label "Exported" on failure. A
// distinct exportError state must render "Export failed".
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// jsdom has no matchMedia — install a controllable stub BEFORE any render
// (resolvedAppTheme + the theme effect both query it).
interface FakeMql {
  matches: boolean;
  media: string;
  listeners: Set<(e: { matches: boolean }) => void>;
  addEventListener: (type: string, cb: (e: { matches: boolean }) => void) => void;
  removeEventListener: (type: string, cb: (e: { matches: boolean }) => void) => void;
  addListener: (cb: (e: { matches: boolean }) => void) => void;
  removeListener: (cb: (e: { matches: boolean }) => void) => void;
  onchange: unknown;
  dispatchEvent: () => boolean;
}
const mediaQueries: FakeMql[] = [];
const mediaState = { matches: false };
function installMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): FakeMql => {
      const listeners = new Set<(e: { matches: boolean }) => void>();
      const mq: FakeMql = {
        get matches() {
          return mediaState.matches;
        },
        set matches(v: boolean) {
          mediaState.matches = v;
        },
        media: query,
        listeners,
        addEventListener: (_t, cb) => listeners.add(cb),
        removeEventListener: (_t, cb) => listeners.delete(cb),
        addListener: (cb) => listeners.add(cb),
        removeListener: (cb) => listeners.delete(cb),
        onchange: null,
        dispatchEvent: () => false,
      };
      mediaQueries.push(mq);
      return mq;
    },
  });
}
installMatchMedia();

// Stub xterm (real xterm needs layout TerminalPane tests don't exercise); the
// stub records instances so tests can inspect .options.theme.
const hoisted = vi.hoisted(() => ({ terminals: [] as Array<{ options: Record<string, unknown> }> }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown>;
    buffer = { active: { viewportY: 0, baseY: 0 } };
    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts };
      hoisted.terminals.push(this);
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

const exportMarkdownMock = vi.fn();
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  exportSessionMarkdown: (...a: unknown[]) => exportMarkdownMock(...(a as [])),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(async () => "D:/tmp/session.md"),
  open: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: vi.fn(async () => undefined),
}));

import { TerminalPane } from "../components/panes/TerminalPane";
import { usePanesStore } from "../state/panes";
import { useSettingsStore } from "../state/settings";
import type { Pane } from "../state/panes";

const PANE: Pane = {
  paneId: "pane-t1",
  state: "idle",
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

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({ theme: "system" });
  usePanesStore.setState({ focusedPaneId: "pane-t1" });
});

afterEach(() => {
  cleanup();
  usePanesStore.setState({ focusedPaneId: null });
});

describe("TerminalPane system-theme tracking (C9)", () => {
  it("re-resolves the xterm theme when the OS scheme flips", () => {
    render(<TerminalPane pane={PANE} focused={false} />);
    const term = hoisted.terminals[hoisted.terminals.length - 1];

    // Initial resolution: OS light → light terminal backdrop.
    expect((term.options.theme as Record<string, string>).background).toBe("#fafafa");

    // OS flips to dark — the media listener must fire and re-resolve.
    const subscribed = mediaQueries.filter((mq) => mq.listeners.size > 0);
    expect(subscribed.length).toBeGreaterThanOrEqual(1);
    act(() => {
      mediaState.matches = true;
      for (const mq of subscribed) {
        for (const cb of mq.listeners) cb({ matches: true });
      }
    });
    expect((term.options.theme as Record<string, string>).background).toBe("#1a1a1a");

    // ...and back to light.
    act(() => {
      mediaState.matches = false;
      for (const mq of subscribed) {
        for (const cb of mq.listeners) cb({ matches: false });
      }
    });
    expect((term.options.theme as Record<string, string>).background).toBe("#fafafa");
  });

  it("does not subscribe when a fixed theme is set", () => {
    useSettingsStore.setState({ theme: "light" });
    render(<TerminalPane pane={PANE} focused={false} />);
    // Only pre-existing subscriptions (none from this render's theme effect).
    const before = mediaQueries.reduce((n, mq) => n + mq.listeners.size, 0);
    expect(before).toBe(0);
  });
});

describe("TerminalPane export failure label (C10)", () => {
  function openFindBar() {
    const { container } = render(<TerminalPane pane={PANE} focused={false} />);
    // Ctrl/Cmd+F opens the find bar which hosts the Export button.
    fireEvent.keyDown(window, { ctrlKey: true, key: "f" });
    return container;
  }

  it("shows 'Export failed' (not 'Exported') when the export rejects", async () => {
    exportMarkdownMock.mockRejectedValue(new Error("disk full"));
    const container = openFindBar();
    fireEvent.click(screen_getExportButton(container));
    expect(await vi.waitFor(async () => {
      const el = container.querySelector(".terminal-find-bar");
      if (!el || !el.textContent?.includes("Export failed")) throw new Error("not yet");
      return el;
    })).toBeTruthy();
    expect(container.querySelector(".terminal-find-bar")!.textContent).not.toContain("Exported");
  });

  it("shows 'Exported' on success", async () => {
    exportMarkdownMock.mockResolvedValue("# session");
    const container = openFindBar();
    fireEvent.click(screen_getExportButton(container));
    await vi.waitFor(async () => {
      const el = container.querySelector(".terminal-find-bar");
      if (!el || !el.textContent?.includes("Exported")) throw new Error("not yet");
      return el;
    });
  });
});

function screen_getExportButton(container: HTMLElement): HTMLElement {
  const buttons = Array.from(container.querySelectorAll("button"));
  const btn = buttons.find((b) => b.textContent === "Export");
  if (!btn) throw new Error("Export button not found");
  return btn;
}
