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
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { resizePty, safeListen, updateSessionTitle, writePty } from "../../lib/ipc";
import { respawnPane } from "../../lib/sessionLauncher";
import { expandSkillCommand } from "../../lib/skillExpansion";
import { generateSessionTitle } from "../../lib/sessionTitle";
import { usePanesStore, type Pane } from "../../state/panes";
import { useProjectsStore } from "../../state/projects";
import { useSkillsStore } from "../../state/skills";
import { useSettingsStore } from "../../state/settings";
import type { PtyOutputPayload } from "../../types";

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 28;
/** Debounce resize re-fits so rapid layout reflows don't thrash the terminal
 *  grid and cause the cursor to flicker/jump during active output. Matches the
 *  BrowserPane BOUNDS_DEBOUNCE_MS pattern. */
const RESIZE_DEBOUNCE_MS = 50;

/** xterm theme per app theme: only fg/cursor differ; ANSI colors pass through. */
function xtermTheme(appTheme: string): Record<string, string> {
  const light = appTheme === "light";
  return {
    background: "#00000000", // let the glass show through
    foreground: light ? "#1e2235" : "#e6e8f2",
    cursor: light ? "#1e2235" : "#e6e8f2",
    cursorAccent: light ? "#f5f1e8" : "#1e2235",
    selectionBackground: light ? "rgba(30, 34, 53, 0.25)" : "rgba(230, 232, 242, 0.25)",
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

  const paneId = pane.paneId;
  const exited = pane.data.kind === "terminal" ? pane.data.exited : false;
  const exitCode = pane.data.kind === "terminal" ? pane.data.exitCode : null;
  const sessionId = pane.data.kind === "terminal" ? pane.data.sessionId : null;

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
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;

    // Ctrl+scroll font zoom (standard terminal behavior). Wheel events need a
    // non-passive listener to be cancelable.
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
    container.addEventListener("wheel", onWheel, { passive: false });
    // Initial fit after layout settles.
    requestAnimationFrame(() => {
      refit(term, fit, paneId);
    });

    // Terminal output stream for THIS pane only.
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
      observer.disconnect();
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      container.removeEventListener("contextmenu", onCtxMenu);
      container.removeEventListener("wheel", onWheel);
      dataSub.dispose();
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

  return (
    <>
      <div className="pane-body" ref={containerRef} />
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
