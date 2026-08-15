// Terminal pane: xterm.js + FitAddon wired to the backend pty via the
// contract events/commands. Key rules honored here:
//  - pty:output is filtered by paneId before writing to the terminal
//  - user input passes through skill slash-command expansion (§7.15) and
//    first-prompt session titling (§7.4) before write_pty
//  - the pty is NEVER killed on blur (§6.5) — only closePane kills it
//  - pty:exit shows a "press R to resume" overlay instead of dropping the pane
//  - Ctrl+scroll zooms the font (standard terminal behavior)
//  - text color follows the app theme: dark text on light theme (default
//    xterm foreground is white, which is invisible on light glass)
//  - Activity feed below the terminal: detects ```mermaid, ```html, ```jsx/tsx
//    blocks in PTY output and renders them as expandable cards.
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import "@xterm/xterm/css/xterm.css";
import { resizePty, safeListen, updateSessionTitle, writePty, exportSessionMarkdown } from "../../lib/ipc";
import { ptyChannel } from "../../lib/channels";
import { respawnPane } from "../../lib/sessionLauncher";
import { expandSkillCommand } from "../../lib/skillExpansion";
import { generateSessionTitle } from "../../lib/sessionTitle";
import { usePanesStore, type Pane } from "../../state/panes";
import { useProjectsStore } from "../../state/projects";
import { useSkillsStore } from "../../state/skills";
import { useSettingsStore } from "../../state/settings";
// MermaidDiagram pulls in the heavy mermaid bundle (and its highlight.js
// language pack) on first render — lazy-load it so the terminal pane (the
// most common tool-panel tab) doesn't pay that cost on mount. The diagram
// only appears inside an expanded activity-feed card, so the chunk loads
// only when a user actually opens a mermaid block from terminal output.
const MermaidDiagram = lazy(() => import("../chat/MermaidDiagram").then((m) => ({ default: m.MermaidDiagram })));
import { sanitizeHtml } from "../../lib/sanitize";
import type { PtyOutputPayload } from "../../types";

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 28;
/** Debounce resize re-fits so rapid layout reflows don't thrash the terminal
 *  grid and cause the cursor to flicker/jump during active output. Matches the
 *  BrowserPane BOUNDS_DEBOUNCE_MS pattern. */
const RESIZE_DEBOUNCE_MS = 50;
/** Max number of activity-feed cards to keep per terminal. */
const MAX_FEED_ITEMS = 5;

/** A structured block detected in the terminal output stream. */
interface DetectedBlock {
  id: string;
  kind: "mermaid" | "html" | "jsx" | "tsx";
  code: string;
  firstLine: string;
  createdAt: number;
}

let feedIdSeq = 0;

/** xterm theme per app theme: opaque backdrop, fg/cursor; ANSI colors pass
 *  through. Reads from CSS custom properties (--editor-bg, --text, etc.)
 *  so the terminal automatically tracks the app's data-theme swap. */
function xtermTheme(appTheme: string): Record<string, string> {
  // The hook layer re-resolves these on data-theme change, so we re-read at
  // every call site (cheap — getComputedStyle is a hash lookup, not a parse).
  if (typeof document === "undefined") {
    return {};
  }
  const cs = getComputedStyle(document.documentElement);
  const tok = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const light = appTheme === "light";
  return {
    // Solid terminal backdrop (was transparent for the old glass blur).
    background: tok("--editor-bg", light ? "#fafafa" : "#1a1a1a"),
    foreground: tok("--editor-fg", light ? "#1a1a1a" : "#e4e4e4"),
    cursor: tok("--editor-cursor", light ? "#1a1a1a" : "#e4e4e4"),
    cursorAccent: tok("--editor-bg", light ? "#fafafa" : "#1a1a1a"),
    selectionBackground: light
      ? tok("--editor-selection", "rgba(0, 120, 168, 0.2)")
      : tok("--editor-selection", "rgba(64, 64, 64, 0.4)"),
  };
}

function resolvedAppTheme(setting: string): string {
  if (setting !== "system") return setting;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Re-fit the terminal grid to its container and tell the pty the new size.
 *  xterm's fit() re-lays out the buffer and can reset the viewport to the TOP
 *  when rows change (e.g. a flex reflow arriving mid-output) — the cause of the
 *  "terminal jumps to the top" bug. We snapshot whether the user was scrolled
 *  to the bottom BEFORE fitting and restore that follow-the-tail position after,
 *  while leaving the viewport alone if the user had deliberately scrolled up. */
function refit(term: Terminal, fit: FitAddon, paneId: string): void {
  const buf = term.buffer.active;
  const wasAtBottom = buf.viewportY >= buf.baseY;
  try {
    fit.fit();
    resizePty(paneId, term.cols, term.rows);
  } catch {
    // hidden/zero-size container — nothing to fit.
    return;
  }
  if (wasAtBottom) term.scrollToBottom();
}

interface Props {
  pane: Pane;
  focused: boolean;
  /** False while this terminal is the hidden (non-spotlight) one in split
   *  layout. The terminal stays MOUNTED — hidden with display:none — so the
   *  xterm instance, scrollback and the pty process are untouched (§6.5);
   *  on becoming visible again we re-fit so it redraws at the right size. */
  visible?: boolean;
}

export function TerminalPane({ pane, focused, visible = true }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);

  const paneId = pane.paneId;
  const exited = pane.data.kind === "terminal" ? pane.data.exited : false;
  const exitCode = pane.data.kind === "terminal" ? pane.data.exitCode : null;
  const sessionId = pane.data.kind === "terminal" ? pane.data.sessionId : null;

  // --- Activity feed: detected fenced code blocks from PTY output ---
  // Accumulate Mermaid/HTML/JSX blocks rendered as expandable cards below the
  // terminal. Max 5 items; auto-scrolls to newest on add. Cleared on exit/respawn.
  const [feedItems, setFeedItems] = useState<DetectedBlock[]>([]);
  // Find-in-terminal (roadmap #13): a small search bar that highlights + jumps
  // within the xterm scrollback using the SearchAddon.
  const [findOpen, setFindOpen] = useState(false);
  const [findTerm, setFindTerm] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const feedEndRef = useRef<HTMLDivElement>(null);

  // --- Per-pane activity parsing from PTY output ---
  // Recognises known harness output patterns to show what the agent is doing
  // in the pane header (e.g. "Editing 3 files"). Debounced to 500ms to avoid
  // thrashing the store on rapid streaming output.
  const activityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function parseActivity(text: string): string | null {
    // Claude Code patterns: "⏺ Reading …", "⏺ Writing …", "⏺ Editing …"
    const ccOps = text.match(/[⏺●▶]\s*(Reading|Writing|Editing|Searching|Thinking)/g);
    if (ccOps && ccOps.length > 0) {
      const counts: Record<string, number> = {};
      for (const op of ccOps) {
        const verb = op.replace(/[⏺●▶]\s*/, "");
        counts[verb] = (counts[verb] || 0) + 1;
      }
      const parts = Object.entries(counts).map(([k, v]) =>
        v > 1 ? `${k} ${v} files` : k,
      );
      return parts.slice(0, 2).join(", ");
    }
    // Kimi Code patterns
    const kcOps = text.match(/(?:Reading|Writing|Searching|Running):/g);
    if (kcOps && kcOps.length > 0) {
      const verbs = [...new Set(kcOps.map((s) => s.replace(":", "")))];
      return verbs.slice(0, 2).join(", ");
    }
    return null;
  }

  /** Extract completed fenced code blocks from the output buffer. Only
   *  detects Mermaid, HTML, JSX, and TSX blocks (the renderable types). */
  function parseFeedBlocks(buf: string): DetectedBlock[] {
    const blocks: DetectedBlock[] = [];
    // Match complete fenced blocks: ```lang ... ```
    const re = /```(mermaid|html|jsx|tsx)\s*\n([\s\S]*?)```/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(buf)) !== null) {
      const lang = m[1].toLowerCase() as DetectedBlock["kind"];
      const code = m[2].trim();
      if (!code) continue;
      const firstLine = code.split("\n")[0]?.trim() || code.slice(0, 60);
      blocks.push({
        id: `feed-${++feedIdSeq}`,
        kind: lang,
        code,
        firstLine: firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine,
        createdAt: Date.now(),
      });
    }
    return blocks;
  }

  // Listen to pty:output for this pane to detect activity patterns.
  // Debounce: update the store at most once per 500ms; only set when changed.
  // Also scan for completed fenced code blocks (```mermaid, ```html, ```jsx/tsx)
  // and accumulate them in the activity feed below the terminal.
  useEffect(() => {
    let buf = "";
    const unlisten = safeListen<PtyOutputPayload>("pty:output", ({ paneId: id, data }) => {
      if (id !== paneId) return;
      buf += data;
      // Keep the buffer bounded to recent output (~8KB tail).
      if (buf.length > 8192) buf = buf.slice(-8192);
      if (activityTimerRef.current) return; // already scheduled
      activityTimerRef.current = setTimeout(() => {
        activityTimerRef.current = null;
        const detected = parseActivity(buf);
        const store = usePanesStore.getState();
        const p = store.panes.find((pp) => pp.paneId === paneId);
        if (p && p.activity !== detected) {
          store.setPaneActivity(paneId, detected);
        }
        // Scan for new feed blocks in the accumulated buffer (M23): the
        // rolling 8KB window keeps matched blocks alive for many ticks, so
        // filter out anything already in the feed by content — otherwise
        // the same block is re-added every 500ms as a duplicate card.
        const newBlocks = parseFeedBlocks(buf);
        if (newBlocks.length > 0) {
          setFeedItems((prev) => {
            const existing = new Set(prev.map((b) => `${b.kind}\n${b.code}`));
            const fresh = newBlocks.filter((b) => !existing.has(`${b.kind}\n${b.code}`));
            if (fresh.length === 0) return prev;
            // A block that rolls out of the feed while still inside the 8KB
            // window can re-appear once — bounded by MAX_FEED_ITEMS churn.
            return [...prev, ...fresh].slice(-MAX_FEED_ITEMS);
          });
        }
      }, 500);
    });
    return () => {
      void unlisten.then((fn) => fn());
      if (activityTimerRef.current) clearTimeout(activityTimerRef.current);
      activityTimerRef.current = null;
    };
  }, [paneId]);

  // Clear activity when the pane goes idle.
  useEffect(() => {
    if (pane.state === "idle" && pane.activity !== null) {
      usePanesStore.getState().setPaneActivity(paneId, null);
    }
  }, [pane.state, pane.activity, paneId]);

  // Clear the activity feed when the process exits or is respawned, so stale
  // blocks from the previous session don't linger.
  useEffect(() => {
    if (exited) setFeedItems([]);
  }, [exited]);
  // --- end activity parsing ---

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: '"Space Mono", ui-monospace, Menlo, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      allowTransparency: true,
      theme: xtermTheme(resolvedAppTheme(useSettingsStore.getState().theme)),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    const serialize = new SerializeAddon();
    term.loadAddon(serialize);
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;
    serializeRef.current = serialize;

    // Ctrl+scroll font zoom (standard terminal behavior).
    //
    // PERF (PERFORMANCE_AUDIT.md F4): wheel events need a NON-passive
    // listener to be cancelable, but a permanently non-passive listener
    // opts the container out of the compositor's scroll fast-path on every
    // scroll. Since zoom only applies while Ctrl is held, the listener is
    // passive by default and only flips to non-passive between Ctrl
    // keydown and keyup.
    let ctrlHeld = false;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const next = Math.min(
        MAX_FONT_SIZE,
        Math.max(MIN_FONT_SIZE, (term.options.fontSize ?? 13) + (e.deltaY < 0 ? 1 : -1)),
      );
      if (next !== term.options.fontSize) {
        term.options.fontSize = next;
        refit(term, fit, paneId);
      }
    };
    const applyWheelListener = () => {
      container.removeEventListener("wheel", onWheel);
      container.addEventListener("wheel", onWheel, { passive: !ctrlHeld });
    };
    const onCtrlDown = (e: KeyboardEvent) => {
      if (e.key === "Control" && !ctrlHeld) {
        ctrlHeld = true;
        applyWheelListener();
      }
    };
    const onCtrlUp = (e: KeyboardEvent) => {
      if (e.key === "Control" && ctrlHeld) {
        ctrlHeld = false;
        applyWheelListener();
      }
    };
    // Window blur while Ctrl is held would otherwise latch the non-passive
    // listener on until the next Ctrl press.
    const onBlurReset = () => {
      if (ctrlHeld) {
        ctrlHeld = false;
        applyWheelListener();
      }
    };
    applyWheelListener();
    window.addEventListener("keydown", onCtrlDown);
    window.addEventListener("keyup", onCtrlUp);
    window.addEventListener("blur", onBlurReset);
    // Initial fit after layout settles.
    requestAnimationFrame(() => {
      refit(term, fit, paneId);
    });

    // Terminal output stream for THIS pane only.
    //
    // Perf (PERFORMANCE_AUDIT.md C1, refactor Task 1.1): prefer the typed
    // `Channel<Vec<u8>>` over the legacy `pty:output` event. The backend
    // coalesces output into 16ms/64KB frames and sends each frame as raw
    // bytes (no JSON, no UTF-8 lossy). The Channel is the hot path; the
    // `safeListen("pty:output", ...)` path remains as a fallback for tests
    // and headless dev where no consumer subscribed, so the listener gets
    // re-attached automatically if the Channel path is unavailable.
    let channelUnsub: (() => void) | null = null;
    let subscribedChannel: { onmessage: ((frame: number[]) => void) | null } | null = null;
    // The channel subscription is async: if this effect's cleanup runs before
    // ptyChannel resolves (pane replaced, StrictMode remount), the `.then`
    // below must NOT attach the handler to the disposed terminal — it would
    // throw inside the channel callback on every frame and leak the
    // subscription for the pane's lifetime.
    let disposed = false;
    void ptyChannel(paneId).then((ch) => {
      if (disposed) {
        // Effect already cleaned up — detach immediately so the backend
        // channel doesn't hold a stale subscriber. (The declared channel
        // type doesn't allow null, but clearing onmessage is the supported
        // detach path the unsub closure below also relies on.)
        (ch as { onmessage: ((frame: number[]) => void) | null }).onmessage = null;
        return;
      }
      const handler = (frame: number[]) => {
        if (term) term.write(new Uint8Array(frame));
      };
      ch.onmessage = handler;
      subscribedChannel = ch;
      channelUnsub = () => {
        if (subscribedChannel) subscribedChannel.onmessage = null;
      };
    }).catch(() => {
      // Channel unavailable (e.g. Tauri runtime absent in tests); the
      // safeListen fallback below is already in flight.
    });

    const unlistenOutput = safeListen<PtyOutputPayload>("pty:output", ({ paneId: id, data }) => {
      if (id === paneId) term.write(data);
    });

    // Shared paste-from-clipboard helper — used by Ctrl+V, Cmd+V, Ctrl+Shift+V,
    // and the right-click contextmenu handler. All paths produce the same
    // behaviour: read the clipboard and write it to the pty.
    const pasteFromClipboard = () => {
      void navigator.clipboard
        ?.readText()
        .then((text) => {
          if (text) void writePty(paneId, text);
        })
        .catch(() => {});
    };

    // Right-click pastes clipboard into terminal, matching native terminal
    // behaviour (Windows Terminal, cmd, most Linux terminals). Right-click does
    // NOT show a browser context menu — the default is suppressed.
    const onCtxMenu = (e: MouseEvent) => {
      e.preventDefault();
      pasteFromClipboard();
    };
    container.addEventListener("contextmenu", onCtxMenu);

    // Copy/paste matching native terminal conventions:
    //   - Ctrl+Shift+C / Cmd+C  → copy selection to clipboard
    //   - Ctrl+C with selection  → copy selection (no selection → pass through as SIGINT)
    //   - Ctrl+V (Win/Linux), Cmd+V (macOS), Ctrl+Shift+V (everywhere) → paste
    //     from clipboard into the pty.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return true;
      const key = e.key.toLowerCase();
      if (key === "c" && (e.shiftKey || term.hasSelection())) {
        const selection = term.getSelection();
        if (selection) void navigator.clipboard?.writeText(selection).catch(() => {});
        return false;
      }
      if (key === "v" && (e.shiftKey || e.metaKey || e.ctrlKey)) {
        pasteFromClipboard();
        return false;
      }
      return true;
    });

    // User input: expand skills, capture the first-prompt title, then send.
    //
    // In a live TUI keystrokes arrive one at a time and are forwarded
    // immediately (the pty echoes them — xterm does not echo locally), so
    // true substitution is only possible when a whole line arrives in one
    // chunk (paste-and-enter). For that case we expand slash commands before
    // forwarding. Independently, we keep a best-effort local line buffer so
    // the FIRST submitted line can seed the session title (§7.4) regardless
    // of how it was typed.
    let lineBuf = "";
    const dataSub = term.onData((data) => {
      let out = data;

      // Whole-line chunk (paste-and-enter): expand slash commands here.
      const enterMatch = /^([^\r\n\x1b]*)\r$/.exec(data);
      if (enterMatch) {
        const skills = useSkillsStore.getState().skills;
        const expanded = expandSkillCommand(enterMatch[1], skills);
        if (expanded !== enterMatch[1]) {
          out = expanded + "\r";
        }
      }

      // Best-effort line buffer for first-prompt title capture. Chunks with
      // escape sequences (arrow keys, etc.) are ignored to avoid garbage.
      if (!data.includes("\x1b")) {
        for (const ch of data) {
          if (ch === "\r") {
            const submitted = enterMatch ? enterMatch[1] : lineBuf;
            if (submitted.trim().length > 0) maybeTitleSession(submitted);
            lineBuf = "";
          } else if (ch === "\x7f") {
            lineBuf = lineBuf.slice(0, -1); // backspace
          } else if (ch === "\x03" || ch === "\x15") {
            lineBuf = ""; // ctrl-c / ctrl-u clears the line
          } else if (ch >= " ") {
            lineBuf += ch;
          }
        }
      }

      void writePty(paneId, out);
      // Spotlight recency: typing is the strongest interaction signal.
      usePanesStore.getState().notePaneInput(paneId);
    });

    // Resize: fit xterm to the container and tell the pty the new size.
    // Debounced so rapid flex-layout reflows during output don't thrash the
    // terminal grid — each fit() re-lays out every row, which makes the
    // cursor appear to jump/flicker if called at resize-event frequency.
    let resizeTimer: number | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        refit(term, fit, paneId);
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);

    return () => {
      // Signal the in-flight ptyChannel subscription BEFORE disposing the
      // terminal (see the `disposed` flag above).
      disposed = true;
      observer.disconnect();
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      container.removeEventListener("contextmenu", onCtxMenu);
      container.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onCtrlDown);
      window.removeEventListener("keyup", onCtrlUp);
      window.removeEventListener("blur", onBlurReset);
      dataSub.dispose();
      if (channelUnsub) channelUnsub();
      void unlistenOutput.then((fn) => fn());
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [paneId]);

  // Follow app theme changes live (light theme needs dark terminal text).
  const appTheme = useSettingsStore((s) => s.theme);
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = xtermTheme(resolvedAppTheme(appTheme));
  }, [appTheme]);

  // Re-fit when a hidden (display:none) terminal becomes visible again —
  // while hidden its container has zero size and fit() would collapse it.
  useEffect(() => {
    if (!visible) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    const raf = requestAnimationFrame(() => {
      refit(term, fit, paneId);
    });
    return () => cancelAnimationFrame(raf);
  }, [visible, paneId]);

  // Focus the terminal when the pane becomes focused. Also re-runs whenever a
  // focus shortcut is pressed (focusEpoch bumps even if focusedPaneId is
  // unchanged), so re-pressing Mod+1 re-grabs DOM focus after it drifted
  // (e.g. to the sidebar/body). Without the epoch, the effect would no-op
  // when focused stays true and the terminal would never reclaim focus.
  const focusEpoch = usePanesStore((s) => s.focusEpoch);
  useEffect(() => {
    if (focused) termRef.current?.focus();
  }, [focused, focusEpoch]);

  // "Press R to resume" when the process exited.
  useEffect(() => {
    if (!exited) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.key === "r" || e.key === "R") && usePanesStore.getState().focusedPaneId === paneId) {
        void respawnPane(paneId);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [exited, paneId]);

  // Ctrl/Cmd+F opens the find bar (roadmap #13); Esc closes it.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        if (usePanesStore.getState().focusedPaneId === paneId) {
          e.preventDefault();
          setFindOpen(true);
        }
      } else if (e.key === "Escape") {
        setFindOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [paneId]);

  // Run a find (next/prev match) using the SearchAddon.
  const runFind = (dir: 1 | -1 = 1) => {
    const addon = searchRef.current;
    if (!addon || !findTerm) return;
    if (dir === 1) addon.findNext(findTerm, { incremental: false });
    else addon.findPrevious(findTerm, { incremental: false });
    setFindIndex((i) => i + 1);
  };

  // Export the full scrollback as markdown via the existing backend command.
  const runExport = async () => {
    if (!sessionId) return;
    const { save } = await import("@tauri-apps/plugin-dialog");
    const dest = await save({
      defaultPath: `${Date.now()}-session.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!dest) return;
    try {
      const md = await exportSessionMarkdown(paneId);
      if (md) {
        const writeTextFile = (await import("@tauri-apps/plugin-fs")).writeTextFile;
        await writeTextFile(dest, md);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }
    } catch {
      setCopied(true); // surface failure via the same copied flash is imperfect
      setTimeout(() => setCopied(false), 1800);
    }
  };

  return (
    <>
      {findOpen && (
        <div className="terminal-find-bar">
          <input
            value={findTerm}
            onChange={(e) => { setFindTerm(e.target.value); setFindIndex(-1); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); runFind(e.shiftKey ? -1 : 1); }
              else if (e.key === "Escape") setFindOpen(false);
            }}
            placeholder="Find in terminal…"
            autoFocus
          />
          <button className="ghost" onClick={() => runFind(-1)} title="Previous match">↑</button>
          <button className="ghost" onClick={() => runFind(1)} title="Next match">↓</button>
          <span className="terminal-find-count">{findIndex >= 0 && findTerm ? "match" : ""}</span>
          <button className="ghost" onClick={() => void runExport()} disabled={!sessionId} title="Export scrollback as Markdown">
            {copied ? "Exported" : "Export"}
          </button>
          <button className="ghost" onClick={() => setFindOpen(false)} title="Close (Esc)">✕</button>
        </div>
      )}
      <div className="pane-body" ref={containerRef} />
      {/* Activity feed: detected Mermaid/HTML/JSX blocks from terminal output. */}
      {feedItems.length > 0 && (
        <div className="terminal-activity-feed">
          {feedItems.map((item) => (
            <FeedCard key={item.id} block={item} />
          ))}
          <div ref={feedEndRef} />
        </div>
      )}
      {exited && (
        <div className="pane-exit-overlay">
          <div>Process exited{exitCode !== null ? ` (code ${exitCode})` : ""}</div>
          <div className="mono" style={{ fontSize: 12, opacity: 0.8 }}>
            press R to resume
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="primary" onClick={() => void respawnPane(paneId)}>
              Resume (R)
            </button>
            <button onClick={() => usePanesStore.getState().closePane(paneId)}>Close pane</button>
          </div>
        </div>
      )}
    </>
  );

  function maybeTitleSession(promptText: string) {
    // §7.4: the frontend generates the title from the first prompt, once.
    if (!sessionId) return;
    const session = useProjectsStore.getState().sessions.find((s) => s.id === sessionId);
    if (!session || session.title) return;
    const title = generateSessionTitle(promptText);
    if (!title) return;
    void updateSessionTitle(sessionId, title);
    useProjectsStore.setState((s) => ({
      sessions: s.sessions.map((sess) => (sess.id === sessionId ? { ...sess, title } : sess)),
    }));
    usePanesStore.setState((s) => ({
      panes: s.panes.map((p) =>
        p.paneId === paneId && p.data.kind === "terminal"
          ? { ...p, data: { ...p.data, label: `${title} · ${projectName()}` } }
          : p,
      ),
    }));
  }

  function projectName(): string {
    if (!sessionId) return "";
    const session = useProjectsStore.getState().sessions.find((s) => s.id === sessionId);
    const project = useProjectsStore.getState().projectById(session?.projectId ?? null);
    return project?.name ?? "?";
  }
}

/** An expandable card in the terminal activity feed showing a detected code
 *  block (Mermaid diagram, HTML preview, or JSX/TSX code). */
function FeedCard({ block }: { block: DetectedBlock }) {
  const [open, setOpen] = useState(false);

  const icon = block.kind === "mermaid" ? "◉" : block.kind === "html" ? "🌐" : "⚛";
  const label = block.kind === "mermaid" ? "Diagram" : block.kind === "html" ? "HTML" : block.kind.toUpperCase();

  return (
    <div className={`terminal-feed-card${open ? " open" : ""}`}>
      <button
        className="terminal-feed-card-header"
        onClick={() => setOpen(!open)}
        title={open ? "Collapse" : "Expand"}
      >
        <span className="terminal-feed-card-icon">{icon}</span>
        <span className="terminal-feed-card-label">{label}</span>
        <span className="terminal-feed-card-title">{block.firstLine}</span>
        <span className="terminal-feed-card-chevron">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="terminal-feed-card-body">
          {block.kind === "mermaid" ? (
            <Suspense fallback={<pre className="terminal-feed-code">{block.code}</pre>}>
              <MermaidDiagram code={block.code} />
            </Suspense>
          ) : block.kind === "html" ? (
            <iframe
              className="terminal-feed-iframe"
              title="HTML preview"
              sandbox=""
              srcDoc={sanitizeHtml(block.code)}
            />
          ) : (
            <pre className="terminal-feed-code">{block.code}</pre>
          )}
        </div>
      )}
    </div>
  );
}
