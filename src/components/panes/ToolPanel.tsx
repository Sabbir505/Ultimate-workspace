// Right-side tool panel (mockups 01 callout 4 / 03): one collapsible column
// hosting Terminal | Browser | Files | Canvas as tabs. Only one tab is
// visible at a time; the others stay MOUNTED with display:none so xterm
// instances, pty processes and native browser webviews keep running (§6.5:
// never kill on blur). Native webviews are explicitly hidden via the
// `visible` prop → browserOcclusion when their tab (or the whole panel) is
// not showing — display:none alone doesn't hide a floating native webview.
//
// This replaces the browser half of the old ChatBrowserSplit: the chat is
// always full-width in the center, and browsers live here. The panel's own
// left-edge drag handle doubles as the chat|panel splitter (same pattern as
// DevDiffPanel's resize handle), with the width persisted in the ui store.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openBrowserPane, openShellTerminal, restoreMinimizedBrowser } from "../../lib/sessionLauncher";
import { useChatStore } from "../../state/chat";
import {
  activeTerminalPair,
  terminalPanes,
  usePanesStore,
  type Pane,
} from "../../state/panes";
import { useUiStore, type ToolPanelTab } from "../../state/ui";
import { harnessShortName } from "../../types";
// ArtifactPreviewPane is the heaviest chat component (syntax highlighting,
// markdown rendering, JSX live preview). Lazy-load so the right panel tab
// downloads it only when the user actually views an artifact — the terminal
// and browser tabs don't need it.
const ArtifactPreviewPane = lazy(() => import("../chat/ArtifactPreviewPane").then((m) => ({ default: m.ArtifactPreviewPane })));
import { DevDiffPanel } from "./DevDiffPanel";
import { DormantBrowsers, PaneFrame } from "./PaneGrid";
import { SubagentPanel } from "./SubagentPanel";

const TABS: { id: ToolPanelTab; label: string }[] = [
  { id: "terminal", label: "Terminal" },
  { id: "browser", label: "Browser" },
  { id: "files", label: "Changes" },
  { id: "canvas", label: "Canvas" },
  { id: "agents", label: "Agents" },
];

function terminalLabel(t: Pane): string {
  return t.data.kind === "terminal"
    ? `${t.data.label || "Terminal"}${t.data.harness ? ` (${harnessShortName(t.data.harness)})` : ""}`
    : "Terminal";
}

export function ToolPanel() {
  const panes = usePanesStore((s) => s.panes);
  const focusedPaneId = usePanesStore((s) => s.focusedPaneId);
  const spotlightOverride = usePanesStore((s) => s.spotlightOverride);
  const setSpotlight = usePanesStore((s) => s.setSpotlight);
  const tab = useUiStore((s) => s.toolPanelTab);
  const setTab = useUiStore((s) => s.setToolPanelTab);
  const collapsed = useUiStore((s) => s.toolPanelCollapsed);
  const width = useUiStore((s) => s.toolPanelWidth);
  const setWidth = useUiStore((s) => s.setToolPanelWidth);
  const previewArtifacts = useChatStore((s) => s.previewArtifacts);
  const activePreviewPath = useChatStore((s) => s.activePreviewPath);
  const setPreviewArtifact = useChatStore((s) => s.setPreviewArtifact);
  const closePreviewArtifact = useChatStore((s) => s.closePreviewArtifact);
  const panelRef = useRef<HTMLDivElement>(null);

  // Only show running terminals (not exited ones).
  const terminals = useMemo(
    () => terminalPanes(panes).filter((t) => t.data.kind === "terminal" && !t.data.exited),
    [panes],
  );
  // Plan canvas content from the UI store (set by clicking a plan in GitToolsSidebar).
  const planCanvasContent = useUiStore((s) => s.planCanvasContent);
  const planCanvasTitle = useUiStore((s) => s.planCanvasTitle);
  const setPlanCanvas = useUiStore((s) => s.setPlanCanvas);
  // Minimized (collapsed) browsers are excluded here — they live in the
  // DormantBrowsers container below and are restored from the Browser tab.
  const browsers = useMemo(
    () => panes.filter((p) => p.data.kind === "browser" && !p.data.collapsed),
    [panes],
  );
  const minimizedBrowsers = useMemo(
    () => panes.filter((p) => p.data.kind === "browser" && p.data.collapsed),
    [panes],
  );

  // The spotlight terminal (most-recent pair top slot) owns the single
  // terminal slot; the rest stay mounted-but-hidden.
  const activeTerminalId =
    terminals.length > 0 ? activeTerminalPair(panes, spotlightOverride)[0] : null;
  // Most recently used browser gets the visible browser slot.
  const activeBrowserId =
    browsers.length > 0
      ? browsers.reduce((a, b) => (a.lastUsedAt > b.lastUsedAt ? a : b)).paneId
      : null;

  // Auto-open the Canvas tab when a new artifact preview becomes active
  // (e.g. the model just generated a file) — this preserves the old behavior
  // where the preview pane popped open on generation.
  useEffect(() => {
    if (!activePreviewPath) return;
    const ui = useUiStore.getState();
    ui.setToolPanelTab("canvas");
    ui.setToolPanelCollapsed(false);
  }, [activePreviewPath]);

  // Auto-open content when a tab is selected while empty — the Terminal and
  // Browser tabs spawn their own content instead of showing an "open" button.
  // The ref guards against double-spawns while the async spawn is in flight.
  const spawningRef = useRef(false);
  useEffect(() => {
    if (collapsed || spawningRef.current) return;
    if (tab === "terminal" && terminals.length === 0) {
      spawningRef.current = true;
      void openShellTerminal().finally(() => {
        spawningRef.current = false;
      });
    } else if (tab === "browser" && browsers.length === 0 && minimizedBrowsers.length === 0) {
      spawningRef.current = true;
      openBrowserPane();
      spawningRef.current = false;
    }
  }, [tab, collapsed, terminals.length, browsers.length, minimizedBrowsers.length]);

  // Drag-to-resize: left-edge grab zone. The panel is docked right, so the
  // width grows as the pointer moves left. Doubles as the chat|panel splitter.
  const startResize = useCallback(
    (e: React.PointerEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = panel.getBoundingClientRect().width;
      const onMove = (ev: PointerEvent) => {
        setWidth(startWidth + (startX - ev.clientX));
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [setWidth],
  );

  const show = (id: ToolPanelTab) =>
    tab === id && !collapsed ? undefined : { display: "none" as const };

  return (
    <>
      {/* When collapsed the panel is fully hidden — the toolbar's split icon
          reopens it. The full panel below stays mounted (display:none) so
          terminals and browser webviews keep running; webviews are hidden via
          the `visible` props. */}
      <div
        className="tool-panel"
        ref={panelRef}
        style={collapsed ? { display: "none" } : { width }}
        aria-label="Tool panel"
      >
        <div
          className="dev-diff-panel-resize"
          onPointerDown={startResize}
          title="Drag to resize"
          role="separator"
          aria-orientation="vertical"
        />
        <div className="tool-panel-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`tool-panel-tab${tab === t.id ? " active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="tool-panel-body">
          {/* TERMINAL — only shows active (running) background terminals. */}
          <div className="tool-panel-tab-content" style={show("terminal")}>
            {terminals.length === 0 ? (
              <div className="tool-panel-empty">
                <div>{terminalPanes(panes).length > 0 ? "No running terminals" : "Starting terminal…"}</div>
                <div>{terminalPanes(panes).length > 0 ? "All terminals have exited." : ""}</div>
              </div>
            ) : (
              <>
                {terminals.length > 1 && (
                  <div className="spotlight-bar tool-panel-switcher">
                    <select
                      value={activeTerminalId ?? ""}
                      onChange={(e) => setSpotlight(e.target.value)}
                      title="Visible terminal"
                    >
                      {terminals.map((t) => (
                        <option key={t.paneId} value={t.paneId}>
                          {terminalLabel(t)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="tool-panel-pane-slot">
                  {terminals.map((t) => (
                    <PaneFrame
                      key={t.paneId}
                      pane={t}
                      index={panes.indexOf(t)}
                      focused={t.paneId === focusedPaneId}
                      hidden={t.paneId !== activeTerminalId}
                      visible={tab === "terminal" && !collapsed && t.paneId === activeTerminalId}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
          {/* BROWSER */}
          <div className="tool-panel-tab-content" style={show("browser")}>
            {minimizedBrowsers.length > 0 && (
              <div className="tool-panel-switcher">
                <button
                  className="ghost"
                  onClick={restoreMinimizedBrowser}
                  title="Restore the minimized browser pane"
                >
                  ▣ Restore minimized browser ({minimizedBrowsers.length})
                </button>
              </div>
            )}
            {browsers.length === 0 ? (
              <div className="tool-panel-empty">
                <div>Opening browser…</div>
              </div>
            ) : (
              <div className="tool-panel-pane-slot">
                {browsers.map((b) => (
                  <PaneFrame
                    key={b.paneId}
                    pane={b}
                    index={panes.indexOf(b)}
                    focused={b.paneId === focusedPaneId}
                    hidden={b.paneId !== activeBrowserId}
                    visible={tab === "browser" && !collapsed && b.paneId === activeBrowserId}
                  />
                ))}
              </div>
            )}
          </div>
          {/* FILES (Changes) — the Dev-tab changed-files panel, embedded. */}
          <div className="tool-panel-tab-content" style={show("files")}>
            <DevDiffPanel embedded />
          </div>
          {/* CANVAS — artifact previews as browser-style tabs + plan markdown
              from the Git tools sidebar. Every open artifact stays MOUNTED
              (display:none when its tab is inactive) so zoom/pan state and
              loaded previews survive tab switches. */}
          <div className="tool-panel-tab-content" style={show("canvas")}>
            {previewArtifacts.length === 0 && !planCanvasContent ? (
              <div className="tool-panel-empty">
                <div>No canvas yet</div>
                <div>Artifacts from chat will appear here.</div>
              </div>
            ) : (
              <>
                {/* Plan markdown content — shown above the artifact tabs
                    when a plan was opened from the Git tools sidebar. */}
                {planCanvasContent && (
                  <div className="canvas-plan-view">
                    <div className="canvas-plan-header">
                      <span className="canvas-plan-title">
                        {planCanvasTitle || "Plan"}
                      </span>
                      <button
                        className="ghost"
                        onClick={() => setPlanCanvas(null, null)}
                        title="Close plan"
                      >
                        ✕
                      </button>
                    </div>
                    <div className="canvas-plan-body">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {planCanvasContent}
                      </ReactMarkdown>
                    </div>
                  </div>
                )}
                {previewArtifacts.length > 0 && (
                  <>
                    {/* Tab strip — same markup/styles as the browser tab bar. */}
                    <div className="browser-tabbar">
                      {previewArtifacts.map((a) => (
                        <div
                          key={a.path}
                          className={`browser-tab${a.path === activePreviewPath ? " active" : ""}`}
                          onClick={() => setPreviewArtifact(a)}
                          title={a.path}
                        >
                          <span className="tab-title">{a.filename}</span>
                          <button
                            className="ghost tab-close"
                            title="Close tab"
                            onClick={(e) => {
                              e.stopPropagation();
                              closePreviewArtifact(a.path);
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="tool-panel-canvas-slot">
                      {previewArtifacts.map((a) => (
                        <div
                          key={a.path}
                          className="tool-panel-canvas-item"
                          style={a.path === activePreviewPath ? undefined : { display: "none" }}
                        >
                          <Suspense fallback={<div className="artifact-preview-loading">Loading…</div>}>
                            <ArtifactPreviewPane
                              artifact={a}
                              onClose={() => closePreviewArtifact(a.path)}
                            />
                          </Suspense>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
          {/* AGENTS — subagent list + read-only chat view. */}
          <div className="tool-panel-tab-content" style={show("agents")}>
            <SubagentPanel />
          </div>
        </div>
      </div>
      {/* Minimized browser panes stay mounted here (webview kept alive,
          hidden via visible=false) and are restored from the Browser tab. */}
      <DormantBrowsers panes={panes} />
    </>
  );
}
