// Pane frame: the shared wrapper that renders one pane (terminal or browser)
// with its header (state dot, activity chip, title, harness badge, close
// button). Used by the ToolPanel's Terminal/Browser tabs — the old standalone
// 2-column PaneGrid / ChatBrowserSplit layout was removed when the Dev and
// Chat tabs merged into the unified chat layout; panes now live exclusively
// in the right-hand ToolPanel.
//
// BUNDLE: TerminalPane pulls in xterm.js + FitAddon (~80 KB) and
// BrowserPane pulls in tauri webview shims. Both are lazy-loaded so they
// stay out of the initial bundle and are only downloaded the first time
// the user opens a terminal or browser pane.
import { lazy, memo, Suspense } from "react";
import { usePanesStore, type Pane } from "../../state/panes";
import { harnessShortName } from "../../types";
const BrowserPane = lazy(() => import("./BrowserPane").then((m) => ({ default: m.BrowserPane })));
const TerminalPane = lazy(() => import("./TerminalPane").then((m) => ({ default: m.TerminalPane })));

/**
 * Minimized browser panes live here: kept mounted (so their native webview +
 * URL/history tracking stay alive) but in a zero-size, off-screen container
 * with visible=false (the occlusion effect hides the webview). Restored from
 * the toolbar's "Browser" button, which flips collapsed back to false and
 * re-renders the pane in the ToolPanel's Browser tab.
 */
export function DormantBrowsers({ panes }: { panes: Pane[] }) {
  const dormant = panes.filter(
    (p) => p.data.kind === "browser" && p.data.collapsed,
  );
  if (dormant.length === 0) return null;
  return (
    <div className="dormant-browsers" aria-hidden="true">
      <Suspense fallback={null}>
        {dormant.map((p) => (
          <BrowserPane key={p.paneId} pane={p} visible={false} />
        ))}
      </Suspense>
    </div>
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
export const PaneFrame = memo(function PaneFrame({
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
  // Dev-only live memory reading for this pane (bytes). Selected per-pane so a
  // single header re-renders when its value changes, not the whole grid.
  const memBytes = usePanesStore((s) => s.paneMemory[pane.paneId] ?? 0);

  const isTerminal = pane.data.kind === "terminal";
  const isBrowser = pane.data.kind === "browser";
  const browserCollapsed = pane.data.kind === "browser" ? pane.data.collapsed : false;

  const title =
    pane.data.kind === "browser" ? "Browser" : pane.data.label || (isTerminal ? "Terminal" : "Pane");
  const harness = pane.data.kind === "terminal" ? pane.data.harness : null;
  const activity = pane.activity;

  return (
    <div
      className={`pane${focused ? " focused" : ""}${browserCollapsed ? " collapsed" : ""}`}
      data-state={pane.state}
      style={hidden ? { display: "none" } : undefined}
      onPointerDown={() => focusPane(pane.paneId)}
    >
      <div className="pane-header">
        <span className="state-dot" data-state={pane.state} title={stateTitle(pane.state)} />
        {activity && <span className="pane-activity-chip" title={activity}>{activity}</span>}
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
        {import.meta.env.DEV && memBytes > 0 && (
          <span
            className="pane-memory-chip"
            title={`Resident memory of this pane's process (dev only)`}
          >
            {(memBytes / (1024 * 1024)).toFixed(memBytes >= 10 * 1024 * 1024 ? 0 : 1)} MB
          </span>
        )}
        <button
          className="ghost pane-action pane-close"
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
        <Suspense fallback={<div className="pane-body pane-loading">Loading terminal…</div>}>
          <TerminalPane pane={pane} focused={focused} visible={visible} />
        </Suspense>
      ) : (
        // Keep <BrowserPane> mounted even when collapsed: minimizing must HIDE
        // the native webview (browser_set_visible(false) via the occlusion
        // effect, driven by pane.data.collapsed) — not destroy it. Unmounting
        // would call browser_close on cleanup, killing the webview and forcing
        // a full reload (losing scroll/form/history state) on expand. The CSS
        // rule `.pane.collapsed .pane-body { display: none }` shrinks the body
        // div, so the bounds effect stops fighting the hidden webview.
        <Suspense fallback={<div className="pane-body pane-loading">Loading browser…</div>}>
          <BrowserPane pane={pane} visible={visible} />
        </Suspense>
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
