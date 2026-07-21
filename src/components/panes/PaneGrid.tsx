// Pane grid: 2-column layout (rows as needed, §12.1/§12.6) with draggable
// splitters adjusting column/row fractions. Simple and robust: one vertical
// splitter between the two columns, one horizontal splitter between each pair
// of rows. Fractions live in component state.
//
// SPLIT MODE: as soon as a browser pane is open alongside at least one
// terminal, the grid becomes a two-part split — terminals on the left
// (up to 2 stacked vertically when 2+ terminals exist, driven by recency;
// switchable via the selector bar or the spotlightNext/Prev keybindings),
// browser on the right. Non-spotlight terminals stay MOUNTED but hidden
// (display:none) so xterm instances, scrollback and pty processes are
// untouched (§6.5: never kill on blur). Closing the last browser pane
// returns to the normal grid.
import { useCallback, memo, useMemo, useRef, useState } from "react";
import {
  activeTerminalPair,
  cycleTerminalPair,
  terminalPanes,
  usePanesStore,
  type Pane,
} from "../../state/panes";
import { useProjectsStore } from "../../state/projects";
import { useUiStore } from "../../state/ui";
import { harnessShortName } from "../../types";
import { BrowserPane } from "./BrowserPane";
import { TerminalPane } from "./TerminalPane";

const GAP_PX = 10;

interface GridFractions {
  colFrac: number; // 0..1 — width of the left column
  rowFracs: number[]; // 0..1 per gap between rows
}

function rowCount(paneCount: number): number {
  return Math.ceil(paneCount / 2);
}

export function PaneGrid() {
  const panes = usePanesStore((s) => s.panes);
  const focusedPaneId = usePanesStore((s) => s.focusedPaneId);
  const containerRef = useRef<HTMLDivElement>(null);
  const [fracs, setFracs] = useState<GridFractions>({ colFrac: 0.5, rowFracs: [] });

  // A minimized browser is EXCLUDED from the visible layout: it doesn't force
  // split mode and isn't rendered in the grid, so minimizing returns the layout
  // to the normal up-to-6 CLI grid. Its webview is kept alive via the dormant
  // panes container below (visible=false), and restored from the toolbar.
  const visiblePanes = useMemo(
    () => panes.filter((p) => !(p.data.kind === "browser" && p.data.collapsed)),
    [panes],
  );

  const rows = rowCount(visiblePanes.length);

  const gridStyle = useMemo(() => {
    const left = Math.min(0.85, Math.max(0.15, fracs.colFrac));
    const cols =
      visiblePanes.length > 1
        ? `minmax(0, ${left}fr) minmax(0, ${1 - left}fr)`
        : "minmax(0, 1fr)";
    const rowTemplates: string[] = [];
    for (let r = 0; r < rows; r++) {
      // Distribute row heights around 1fr using rowFracs[r] for the gap after row r.
      let f = 1;
      if (r === 0 && fracs.rowFracs[0] !== undefined) f = (fracs.rowFracs[0] * rows) || 0.15;
      else if (r === rows - 1 && fracs.rowFracs[rows - 2] !== undefined && rows > 1)
        f = ((1 - fracs.rowFracs[rows - 2]) * rows) || 0.15;
      rowTemplates.push(`minmax(0, ${Math.max(0.15, f)}fr)`);
    }
    return {
      gridTemplateColumns: cols,
      gridTemplateRows: rowTemplates.join(" "),
    } as React.CSSProperties;
  }, [visiblePanes.length, rows, fracs]);

  const startColDrag = useCallback((e: React.PointerEvent) => {
    const container = containerRef.current;
    if (!container) return;
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const onMove = (ev: PointerEvent) => {
      const frac = (ev.clientX - rect.left) / rect.width;
      setFracs((f) => ({ ...f, colFrac: Math.min(0.85, Math.max(0.15, frac)) }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  const startRowDrag = useCallback(
    (gapIndex: number) => (e: React.PointerEvent) => {
      const container = containerRef.current;
      if (!container) return;
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const onMove = (ev: PointerEvent) => {
        const frac = (ev.clientY - rect.top) / rect.height;
        setFracs((f) => {
          const rowFracs = [...f.rowFracs];
          rowFracs[gapIndex] = Math.min(0.85, Math.max(0.15, frac));
          return { ...f, rowFracs };
        });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [],
  );

  if (visiblePanes.length === 0) {
    return (
      <>
        <div
          className="pane-grid"
          style={{ display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div className="empty-state">
            <div style={{ fontSize: 15, color: "var(--text)" }}>No panes open</div>
            <div>Open a session from the sidebar, or press ⌘/Ctrl+K to search.</div>
          </div>
        </div>
        <DormantBrowsers panes={panes} />
      </>
    );
  }

  // Split mode: a visible (non-minimized) browser + at least one terminal →
  // spotlight | browser. Minimized browsers don't count.
  const browsers = visiblePanes.filter((p) => p.data.kind === "browser");
  const terminals = terminalPanes(visiblePanes);
  if (browsers.length > 0 && terminals.length > 0) {
    return (
      <>
        <SplitLayout panes={visiblePanes} terminals={terminals} browsers={browsers} />
        <DormantBrowsers panes={panes} />
      </>
    );
  }

  // Grid with absolutely-positioned splitter overlays between tracks.
  return (
    <>
      <div className="pane-grid" ref={containerRef} style={gridStyle}>
        {visiblePanes.map((pane, i) => (
          <PaneFrame key={pane.paneId} pane={pane} index={i} focused={pane.paneId === focusedPaneId} />
        ))}

        {/* Column splitter (only when 2 columns are actually in use) */}
        {visiblePanes.length > 1 && (
          <SplitterOverlay
            orientation="vertical"
            onPointerDown={startColDrag}
            style={{
              left: `calc(${(Math.min(0.85, Math.max(0.15, fracs.colFrac)) * 100).toFixed(3)}% - ${GAP_PX / 2}px)`,
              top: 0,
              bottom: 0,
              width: GAP_PX,
            }}
          />
        )}
        {/* Row splitters */}
        {Array.from({ length: rows - 1 }, (_, gapIdx) => {
          const frac = fracs.rowFracs[gapIdx] ?? (gapIdx + 1) / rows;
          return (
            <SplitterOverlay
              key={gapIdx}
              orientation="horizontal"
              onPointerDown={startRowDrag(gapIdx)}
              style={{
                top: `calc(${(Math.min(0.85, Math.max(0.15, frac)) * 100).toFixed(3)}% - ${GAP_PX / 2}px)`,
                left: 0,
                right: 0,
                height: GAP_PX,
              }}
            />
          );
        })}
      </div>
      <DormantBrowsers panes={panes} />
    </>
  );
}

/**
 * Chat mode's layout host: renders the chat view full-width, and when a
 * visible (non-minimized) browser pane exists, splits chat left | browser
 * right — same as dev-mode split. Minimized browsers stay mounted via
 * DormantBrowsers so the toolbar can restore them from chat mode too.
 */
export function ChatBrowserSplit({ children }: { children: React.ReactNode }) {
  const panes = usePanesStore((s) => s.panes);
  const focusedPaneId = usePanesStore((s) => s.focusedPaneId);
  const containerRef = useRef<HTMLDivElement>(null);
  const [frac, setFrac] = useState(0.5);

  const browsers = useMemo(
    () => panes.filter((p) => p.data.kind === "browser" && !p.data.collapsed),
    [panes],
  );

  const startDrag = useCallback((e: React.PointerEvent) => {
    const container = containerRef.current;
    if (!container) return;
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const onMove = (ev: PointerEvent) => {
      const f = (ev.clientX - rect.left) / rect.width;
      setFrac(Math.min(0.8, Math.max(0.2, f)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  if (browsers.length === 0) {
    return (
      <>
        {children}
        <DormantBrowsers panes={panes} />
      </>
    );
  }

  const activeBrowserId = browsers
    .reduce((a, b) => (a.lastUsedAt > b.lastUsedAt ? a : b))
    .paneId;

  return (
    <>
      <div className="pane-grid split-layout" ref={containerRef}>
        <div
          className="split-left chat-split-left"
          style={{ width: `${(frac * 100).toFixed(2)}%` }}
        >
          {children}
        </div>
        <SplitterOverlay
          orientation="vertical"
          onPointerDown={startDrag}
          style={{
            left: `calc(${(frac * 100).toFixed(3)}% - ${GAP_PX / 2}px)`,
            top: 0,
            bottom: 0,
            width: GAP_PX,
          }}
        />
        <div className="split-right">
          {browsers.map((b) => (
            <PaneFrame
              key={b.paneId}
              pane={b}
              index={panes.indexOf(b)}
              focused={b.paneId === focusedPaneId}
              hidden={b.paneId !== activeBrowserId}
              visible={b.paneId === activeBrowserId}
            />
          ))}
        </div>
      </div>
      <DormantBrowsers panes={panes} />
    </>
  );
}

/**
 * Minimized browser panes live here: kept mounted (so their native webview +
 * URL/history tracking stay alive) but in a zero-size, off-screen container
 * with visible=false (the occlusion effect hides the webview). Restored from
 * the toolbar's "Browser" button, which flips collapsed back to false and
 * re-renders the pane in the grid/split.
 */
function DormantBrowsers({ panes }: { panes: Pane[] }) {
  const dormant = panes.filter(
    (p) => p.data.kind === "browser" && p.data.collapsed,
  );
  if (dormant.length === 0) return null;
  return (
    <div className="dormant-browsers" aria-hidden="true">
      {dormant.map((p) => (
        <BrowserPane key={p.paneId} pane={p} visible={false} />
      ))}
    </div>
  );
}

function SplitLayout({
  panes,
  terminals,
  browsers,
}: {
  panes: Pane[];
  terminals: Pane[];
  browsers: Pane[];
}) {
  const focusedPaneId = usePanesStore((s) => s.focusedPaneId);
  const spotlightOverride = usePanesStore((s) => s.spotlightOverride);
  const setSpotlight = usePanesStore((s) => s.setSpotlight);
  const containerRef = useRef<HTMLDivElement>(null);
  const [frac, setFrac] = useState(0.5);
  /** Fraction of the split-left height allocated to the top terminal slot
   *  (only meaningful when two terminals are stacked). */
  const [hFrac, setHFrac] = useState(0.5);

  // Up to 2 most-recent terminal ids for the split-left slots.
  const pair = activeTerminalPair(panes, spotlightOverride);
  const [topId, bottomId] = pair;
  const twoUp = bottomId !== null; // true when 2+ terminals exist → render both

  // Most recently used browser gets the visible right-hand slot.
  const activeBrowserId = browsers.reduce((a, b) => (a.lastUsedAt > b.lastUsedAt ? a : b)).paneId;

  const cycle = (dir: 1 | -1) => {
    const nextPair = cycleTerminalPair(usePanesStore.getState().panes, pair, dir);
    // Persist the new top slot as an explicit override so the choice sticks.
    if (nextPair[0]) setSpotlight(nextPair[0]);
  };

  const startDrag = useCallback((e: React.PointerEvent) => {
    const container = containerRef.current;
    if (!container) return;
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const onMove = (ev: PointerEvent) => {
      const f = (ev.clientX - rect.left) / rect.width;
      setFrac(Math.min(0.8, Math.max(0.2, f)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  const startHorizontalDrag = useCallback((e: React.PointerEvent) => {
    const leftEl = containerRef.current?.querySelector(".split-terminals-stack") as HTMLElement | null;
    if (!leftEl) return;
    e.preventDefault();
    const rect = leftEl.getBoundingClientRect();
    const onMove = (ev: PointerEvent) => {
      const f = (ev.clientY - rect.top) / rect.height;
      setHFrac(Math.min(0.85, Math.max(0.15, f)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  const terminalLabel = (t: Pane) =>
    t.data.kind === "terminal"
      ? `${t.data.label || "Terminal"}${t.data.harness ? ` (${harnessShortName(t.data.harness)})` : ""}`
      : "Terminal";

  return (
    <div className="pane-grid split-layout" ref={containerRef}>
      <div className="split-left" style={{ width: `${(frac * 100).toFixed(2)}%` }}>
        <div className="spotlight-bar">
          <button className="ghost" title={twoUp ? "Cycle terminal pair backward" : "Previous terminal"} onClick={() => cycle(-1)}>
            ‹
          </button>
          {/* Top-slot selector: controls which terminal is in the top slot. */}
          <select
            value={topId ?? ""}
            onChange={(e) => setSpotlight(e.target.value)}
            title="Top terminal"
          >
            {terminals.map((t) => (
              <option key={t.paneId} value={t.paneId}>
                {terminalLabel(t)}
              </option>
            ))}
          </select>
          {twoUp && (
            <>
              {/* Bottom-slot selector: picks the bottom terminal explicitly.
                  Setting it persists the top-slot choice (spotlightOverride)
                  and derives the bottom from recency; changing it here swaps
                  the override to the chosen terminal. */}
              <select
                value={bottomId ?? ""}
                onChange={(e) => setSpotlight(e.target.value)}
                title="Bottom terminal"
              >
                {terminals.map((t) => (
                  <option key={t.paneId} value={t.paneId}>
                    {terminalLabel(t)}
                  </option>
                ))}
              </select>
            </>
          )}
          <button className="ghost" title={twoUp ? "Cycle terminal pair forward" : "Next terminal"} onClick={() => cycle(1)}>
            ›
          </button>
        </div>
        <div className="split-terminals-stack">
          {/* Top slot — always rendered */}
          <div className="split-slot" style={twoUp ? { height: `${(hFrac * 100).toFixed(2)}%` } : { flex: 1 }}>
            {terminals.map((t) => (
              <PaneFrame
                key={t.paneId}
                pane={t}
                index={panes.indexOf(t)}
                focused={t.paneId === focusedPaneId}
                hidden={t.paneId !== topId}
                visible={t.paneId === topId}
              />
            ))}
          </div>
          {/* Horizontal splitter between top and bottom slots */}
          {twoUp && (
            <SplitterOverlay
              orientation="horizontal"
              onPointerDown={startHorizontalDrag}
              style={{
                position: "relative",
                height: GAP_PX,
                flexShrink: 0,
              }}
            />
          )}
          {/* Bottom slot — only rendered when 2+ terminals exist */}
          {twoUp && (
            <div className="split-slot" style={{ height: `${((1 - hFrac) * 100).toFixed(2)}%` }}>
              {terminals.map((t) => (
                <PaneFrame
                  key={t.paneId}
                  pane={t}
                  index={panes.indexOf(t)}
                  focused={t.paneId === focusedPaneId}
                  hidden={t.paneId !== bottomId}
                  visible={t.paneId === bottomId}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      <SplitterOverlay
        orientation="vertical"
        onPointerDown={startDrag}
        style={{
          left: `calc(${(frac * 100).toFixed(3)}% - ${GAP_PX / 2}px)`,
          top: 0,
          bottom: 0,
          width: GAP_PX,
        }}
      />
      <div className="split-right">
        {browsers.map((b) => (
          <PaneFrame
            key={b.paneId}
            pane={b}
            index={panes.indexOf(b)}
            focused={b.paneId === focusedPaneId}
            hidden={b.paneId !== activeBrowserId}
            visible={b.paneId === activeBrowserId}
          />
        ))}
      </div>
    </div>
  );
}

function SplitterOverlay({
  orientation,
  style,
  onPointerDown,
}: {
  orientation: "vertical" | "horizontal";
  style: React.CSSProperties;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      className={`splitter ${orientation}`}
      style={{ position: "absolute", ...style }}
      onPointerDown={onPointerDown}
    />
  );
}

// Memoized so a PaneFrame only re-renders when ITS OWN props change — not on
// every store tick. This is safe because the panes store preserves object
// identity for unchanged panes (every `set` uses `.map((p) => p.paneId === id
// ? {...p} : p)`, so a pane that didn't change keeps the same `pane` reference),
// and `index`/`focused`/`hidden`/`visible` are primitives. Without this, a
// `pty:state` transition on ONE pane re-renders ALL PaneFrames (and their
// TerminalPane/BrowserPane children) on every output chunk — xterm writes
// happen in TerminalPane's own event listener, independent of these renders,
// so skipping them loses nothing. The `broadcast`/`closePane`/etc. the frame
// subscribes to internally still trigger re-renders via their own selectors.
const PaneFrame = memo(function PaneFrame({
  pane,
  index,
  focused,
  hidden = false,
  visible = true,
}: {
  pane: Pane;
  index: number;
  focused: boolean;
  /** display:none wrapper — pane stays mounted (xterm + pty untouched, §6.5). */
  hidden?: boolean;
  /** Passed to TerminalPane so it re-fits when becoming visible again. */
  visible?: boolean;
}) {
  const broadcast = usePanesStore((s) => s.broadcast);
  const closePane = usePanesStore((s) => s.closePane);
  const focusPane = usePanesStore((s) => s.focusPane);
  const toggleBroadcastPane = usePanesStore((s) => s.toggleBroadcastPane);
  const toggleBrowserCollapsed = usePanesStore((s) => s.toggleBrowserCollapsed);
  const openPeek = useUiStore((s) => s.openPeek);

  const isTerminal = pane.data.kind === "terminal";
  const isBrowser = pane.data.kind === "browser";
  const sessionId = pane.data.kind === "terminal" ? pane.data.sessionId : null;
  const browserCollapsed = pane.data.kind === "browser" ? pane.data.collapsed : false;

  const title =
    pane.data.kind === "browser" ? "Browser" : pane.data.label || (isTerminal ? "Terminal" : "Pane");
  const harness = pane.data.kind === "terminal" ? pane.data.harness : null;

  return (
    <div
      className={`pane${focused ? " focused" : ""}${browserCollapsed ? " collapsed" : ""}`}
      data-state={pane.state}
      style={hidden ? { display: "none" } : undefined}
      onPointerDown={() => focusPane(pane.paneId)}
    >
      <div className="pane-header">
        <span className="state-dot" data-state={pane.state} title={stateTitle(pane.state)} />
        <span className="title" title={title}>
          {index + 1} · {title}
        </span>
        {harness && <span className="harness-badge">{harnessShortName(harness)}</span>}
        {broadcast.enabled && isTerminal && (
          <label className="broadcast-check" title="Include in broadcast">
            <input
              type="checkbox"
              checked={broadcast.selected.includes(pane.paneId)}
              onChange={() => toggleBroadcastPane(pane.paneId)}
              onPointerDown={(e) => e.stopPropagation()}
            />
            tx
          </label>
        )}
        {sessionId && (
          <button
            className="ghost"
            title="Peek at project diff (read-only)"
            onClick={(e) => {
              e.stopPropagation();
              openPeek({ mode: "diff", projectId: projectIdForSession(sessionId), filePath: null });
            }}
          >
            ⧉
          </button>
        )}
        {isBrowser && (
          <button
            className="ghost"
            title={browserCollapsed ? "Show browser" : "Minimize browser"}
            onClick={(e) => {
              e.stopPropagation();
              toggleBrowserCollapsed(pane.paneId);
            }}
          >
            {browserCollapsed ? "⊞" : "⊟"}
          </button>
        )}
        <button
          className="ghost"
          title="Close pane"
          onClick={(e) => {
            e.stopPropagation();
            closePane(pane.paneId);
          }}
        >
          ✕
        </button>
      </div>
      {pane.data.kind === "terminal" ? (
        <TerminalPane pane={pane} focused={focused} visible={visible} />
      ) : (
        // Keep <BrowserPane> mounted even when collapsed: minimizing must HIDE
        // the native webview (browser_set_visible(false) via the occlusion
        // effect, driven by pane.data.collapsed) — not destroy it. Unmounting
        // would call browser_close on cleanup, killing the webview and forcing
        // a full reload (losing scroll/form/history state) on expand. The CSS
        // rule `.pane.collapsed .pane-body { display: none }` shrinks the body
        // div, so the bounds effect stops fighting the hidden webview.
        <BrowserPane pane={pane} visible={visible} />
      )}
    </div>
  );
});

function stateTitle(state: string): string {
  switch (state) {
    case "working":
      return "working — agent actively producing output";
    case "waiting":
      return "waiting on user";
    case "diff_ready":
      return "diff ready — change proposed";
    default:
      return "idle";
  }
}

function projectIdForSession(sessionId: string): string | null {
  const session = useProjectsStore.getState().sessions.find((s) => s.id === sessionId);
  return session?.projectId ?? null;
}
