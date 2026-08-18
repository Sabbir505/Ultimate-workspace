// Right-side tool panel (mockups 01 callout 4 / 03): one collapsible column
// hosting Terminal | Browser | Files | Canvas as tabs. Only one tab is
// visible at a time; the others stay MOUNTED with display:none so xterm
// instances, pty processes and native browser webviews keep running (§6.5:
// never kill on blur). Native webviews are explicitly hidden via the
// `visible` prop → browserOcclusion when their tab (or the whole panel) is
// not showing — display:none alone doesn't hide a floating native webview.
//
// This is the only home panes have: the chat is always full-width in the
// center, and terminals/browsers live here as tabs. The panel's own
// left-edge drag handle doubles as the chat|panel splitter (same pattern as
// DevDiffPanel's resize handle), with the width persisted in the ui store.
import { lazy, useState, Suspense, useCallback, useEffect, useMemo, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Globe, Layout, Terminal, FileDiff, GitPullRequest, Bot, FileCode } from "lucide-react";
import { openBrowserPane, openShellTerminal, restoreMinimizedBrowser } from "../../lib/sessionLauncher";
import { useChatStore } from "../../state/chat";
import {
  activeTerminalPair,
  terminalPanes,
  usePanesStore,
  type Pane,
} from "../../state/panes";
import { useUiStore, type ToolPanelTab, type ToolPanelTabInstance } from "../../state/ui";
import { harnessShortName } from "../../types";
// ArtifactPreviewPane is the heaviest chat component (syntax highlighting,
// markdown rendering, JSX live preview). Lazy-load so the right panel tab
// downloads it only when the user actually views an artifact — the terminal
// and browser tabs don't need it.
const ArtifactPreviewPane = lazy(() => import("../chat/ArtifactPreviewPane").then((m) => ({ default: m.ArtifactPreviewPane })));
import { DevDiffPanel } from "./DevDiffPanel";
import { PullsPanel } from "./PullsPanel";
import { DormantBrowsers, PaneFrame } from "./PaneFrame";
import { SubagentPanel } from "./SubagentPanel";

const TABS: { id: ToolPanelTab; label: string; Icon: React.ElementType }[] = [
  { id: "terminal", label: "Terminal", Icon: Terminal },
  { id: "browser", label: "Browser", Icon: Globe },
  { id: "files", label: "Changes", Icon: FileDiff },
  { id: "pulls", label: "Pull Requests", Icon: GitPullRequest },
  { id: "canvas", label: "Canvas", Icon: Layout },
  { id: "agents", label: "Agents", Icon: Bot },
  // Artifact tabs are spawned automatically by code generation — they don't
  // appear in the "+" picker, but are listed here so their icon renders in chips.
  { id: "artifact", label: "Artifact", Icon: FileCode },
];

function terminalLabel(t: Pane): string {
  return t.data.kind === "terminal"
    ? `${t.data.label || "Terminal"}${t.data.harness ? ` (${harnessShortName(t.data.harness)})` : ""}`
    : "Terminal";
}

/** Build a display label for a tab instance. For kinds that may have multiple
 *  instances open (terminal/browser/agents), append the instance's short id so
 *  the user can tell them apart. For artifact tabs, show the filename
 *  (e.g. "component.tsx"). For singletons (files/canvas) just the kind. */
function tabLabel(inst: ToolPanelTabInstance, fallback: string): string {
  if (inst.kind === "artifact") {
    return inst.artifactFilename ?? "Preview";
  }
  return fallback;
}

export function ToolPanel() {
  const panes = usePanesStore((s) => s.panes);
  const focusedPaneId = usePanesStore((s) => s.focusedPaneId);
  const spotlightOverride = usePanesStore((s) => s.spotlightOverride);
  const setSpotlight = usePanesStore((s) => s.setSpotlight);
  const openTabs = useUiStore((s) => s.openTabs);
  const activeTabId = useUiStore((s) => s.activeTabId);
  const addTab = useUiStore((s) => s.addTab);
  const closeTab = useUiStore((s) => s.closeTab);
  const activateTab = useUiStore((s) => s.activateTab);
  const setToolPanelCollapsed = useUiStore((s) => s.setToolPanelCollapsed);
  const collapsed = useUiStore((s) => s.toolPanelCollapsed);
  const width = useUiStore((s) => s.toolPanelWidth);
  const setWidth = useUiStore((s) => s.setToolPanelWidth);
  // Dropdown picker state: opened by clicking the "+" button in the tab bar.
  const [tabPickerOpen, setTabPickerOpen] = useState(false);
  // Drag-to-reorder state: the index of the chip being dragged. A ref is used
  // for the actual drag tracking (so the value is always current during the
  // DnD cycle regardless of React's re-render timing); the state pair is only
  // for visual feedback (dragging/drag-over CSS).
  const dragIndexRef = useRef<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const reorderTab = useUiStore((s) => s.reorderTab);
  // Ref to the chips scroll container — needed for the wheel handler.
  const chipsRef = useRef<HTMLDivElement>(null);
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

  // The active tab instance (the one whose body content is shown).
  const activeInstance = openTabs.find((t) => t.instanceId === activeTabId) ?? null;
  const activeKind: ToolPanelTab = activeInstance?.kind ?? "terminal";

  // Auto-open the Canvas tab when a non-code artifact preview becomes active
  // (images, markdown, diagrams — NOT .tsx/.jsx/.html which now open as their
  // own artifact tabs). Skip if the active tab is already an artifact tab (a
  // code artifact just opened and we don't want to steal focus to Canvas).
  useEffect(() => {
    if (!activePreviewPath) return;
    // Don't steal focus from an artifact tab that was just auto-opened.
    const ui = useUiStore.getState();
    if (ui.activeTabId && ui.openTabs.some((t) => t.instanceId === ui.activeTabId && t.kind === "artifact")) {
      return;
    }
    // openCanvasTab dedupes: activates an existing canvas tab or creates one.
    // The old find-then-addTab path could race under StrictMode double-fire
    // and stack duplicate canvas tabs.
    ui.openCanvasTab();
  }, [activePreviewPath]);

  // Auto-open content when a tab is selected while empty — the Terminal and
  // Browser tabs spawn their own content instead of showing an "open" button.
  // The ref guards against double-spawns while the async spawn is in flight.
  const spawningRef = useRef(false);
  useEffect(() => {
    if (collapsed || spawningRef.current) return;
    if (activeKind === "terminal" && terminals.length === 0) {
      spawningRef.current = true;
      void openShellTerminal().finally(() => {
        spawningRef.current = false;
      });
    } else if (activeKind === "browser" && browsers.length === 0 && minimizedBrowsers.length === 0) {
      spawningRef.current = true;
      openBrowserPane();
      spawningRef.current = false;
    }
  }, [activeKind, collapsed, terminals.length, browsers.length, minimizedBrowsers.length]);

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

  // Horizontal wheel handler: vertical scroll wheel (and trackpad) horizontal
  // scrolls the chip strip. Horizontal scroll containers don't respond to
  // vertical wheel by default, so translate deltaY → scrollLeft.
  const onChipsWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const el = chipsRef.current;
    if (!el) return;
    // If the user scrolled horizontally, apply directly; else map vertical.
    const dx = e.deltaX !== 0 ? e.deltaX : e.deltaY;
    if (dx === 0) return;
    el.scrollLeft += dx;
    // Prevent the page from also scrolling when the strip has overflow.
    if (el.scrollLeft > 0 || el.scrollLeft + el.clientWidth < el.scrollWidth) {
      e.preventDefault();
    }
  }, []);

  // Drag-to-reorder via MOUSE pointer events (WebView2 has unreliable HTML5
  // drag-and-drop). A ref tracks the source index; the state pair powers the
  // visual feedback. onChipMouseDown starts the drag; the document-level
  // mousemove/mouseup (registered on drag start) drive it.
  const dragOverIndexRef = useRef<number | null>(null);

  const onChipMouseDown = useCallback(
    (index: number, e: React.MouseEvent) => {
      // Don't start a drag from the close button.
      if ((e.target as HTMLElement).closest(".tool-panel-tabchip-close")) return;
      e.preventDefault();
      dragIndexRef.current = index;
      setDragIndex(index);
      setDragOverIndex(index);

      const handleMove = (ev: MouseEvent) => {
        // Find the chip under the cursor by hit-testing.
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const chip = el?.closest(".tool-panel-tabchip") as HTMLElement | null;
        if (!chip) return;
        const newIndex = Number(chip.dataset.index);
        if (!Number.isNaN(newIndex) && newIndex !== dragOverIndexRef.current) {
          dragOverIndexRef.current = newIndex;
          setDragOverIndex(newIndex);
        }
      };
      const handleUp = () => {
        const from = dragIndexRef.current;
        const to = dragOverIndexRef.current;
        if (from !== null && to !== null && from !== to) {
          const inst = openTabs[from];
          if (inst) reorderTab(inst.instanceId, to);
        }
        dragIndexRef.current = null;
        dragOverIndexRef.current = null;
        setDragIndex(null);
        setDragOverIndex(null);
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
      };
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [openTabs, reorderTab],
  );

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
        {/* When NO tabs are open, show the centered grid picker (the original
            3+2 layout) so the user picks a pane to start. */}
        {!collapsed && openTabs.length === 0 && (
          <div className="tool-panel-picker">
            <div className="tool-panel-picker-grid">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  className="tool-panel-picker-btn"
                  onClick={() => addTab(t.id)}
                >
                  <t.Icon size={20} className="tool-panel-picker-btn-icon" aria-hidden />
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {/* When tabs ARE open, show the tab bar + pane body. */}
        {!collapsed && openTabs.length > 0 && (
          <>
          {/* Tab bar — Shows one chip per open tab INSTANCE + a "+" that pops a
              menu of panes to add. Chips are scrollable + drag-to-reorder. */}
          <div className="tool-panel-tabbar">
            <div className="tool-panel-tabbar-chips" ref={chipsRef} onWheel={onChipsWheel}>
              {openTabs.map((inst, index) => {
                const tabDef = TABS.find((tb) => tb.id === inst.kind);
                const label = tabLabel(inst, tabDef?.label ?? inst.kind);
                const TabIcon = tabDef?.Icon;
                const isActive = activeTabId === inst.instanceId;
                const isDragging = index === dragIndex;
                const isDragOver = index === dragOverIndex;
                return (
                  <div
                    key={inst.instanceId}
                    className={`tool-panel-tabchip${isActive ? " active" : ""}${isDragging ? " dragging" : ""}${isDragOver && dragIndex !== index ? " drag-over" : ""}`}
                    onClick={() => activateTab(inst.instanceId)}
                    onMouseDown={(e) => onChipMouseDown(index, e)}
                    title={`${inst.kind}${inst.paneId ? ` — ${inst.paneId}` : ""}`}
                    data-index={index}
                  >
                    {TabIcon && <TabIcon size={12} className="tool-panel-tabchip-icon" aria-hidden />}
                    <span className="tool-panel-tabchip-label">{label}</span>
                    <button
                      className="ghost tool-panel-tabchip-close"
                      onClick={(e) => { e.stopPropagation(); closeTab(inst.instanceId); }}
                      title="Close tab"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="tool-panel-add-wrap">
              <button
                className="ghost tool-panel-add-btn"
                onClick={() => setTabPickerOpen((v) => !v)}
                title="Add a pane"
                aria-label="Add a pane"
              >
                +
              </button>
              {tabPickerOpen && (
                <>
                  <div className="tool-panel-picker-scrim" onClick={() => setTabPickerOpen(false)} />
                  <div className="tool-panel-picker-menu" role="menu">
                    {TABS.filter((t) => t.id !== "artifact").map((t) => (
                      <button
                        key={t.id}
                        className="tool-panel-picker-item"
                        onClick={() => { addTab(t.id); setTabPickerOpen(false); }}
                        role="menuitem"
                      >
                        <t.Icon size={13} className="tool-panel-picker-item-icon" aria-hidden />
                        <span className="tool-panel-picker-item-label">{t.label}</span>
                        {openTabs.some((o) => o.kind === t.id) && (
                          <span className="tool-panel-picker-item-tag">+{openTabs.filter((o) => o.kind === t.id).length}</span>
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
          {/* Pane body — renders the ACTIVE tab instance's content. */}
          <div className="tool-panel-body">
          {activeInstance && (
            <div className="tool-panel-tab-content">
              {activeInstance.kind === "terminal" && (
                <>
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
                            visible={!collapsed && t.paneId === activeTerminalId}
                          />
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
              {activeInstance.kind === "browser" && (
                <>
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
                          /* Hide the native webview while the pane picker is
                              open, otherwise the OS-level webview floats on
                              top of the dropdown (HTML z-index can't cover a
                              native window). The webview is brought back the
                              moment the picker closes. */
                          visible={!collapsed && !tabPickerOpen && b.paneId === activeBrowserId}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}
              {activeInstance.kind === "files" && <DevDiffPanel embedded />}
              {activeInstance.kind === "pulls" && <PullsPanel />}
              {activeInstance.kind === "canvas" && (
                <>
                  {previewArtifacts.length === 0 && !planCanvasContent ? (
                    <div className="tool-panel-empty">
                      <div>No canvas yet</div>
                      <div>Artifacts from chat will appear here.</div>
                    </div>
                  ) : (
                    <>
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
                </>
              )}
              {activeInstance.kind === "agents" && <SubagentPanel />}
              {activeInstance.kind === "artifact" && activeInstance.artifactPath && (
                <Suspense fallback={<div className="artifact-preview-loading">Loading…</div>}>
                  <ArtifactPreviewPane
                    artifact={{
                      path: activeInstance.artifactPath,
                      filename: activeInstance.artifactFilename ?? "Preview",
                      inline: activeInstance.artifactInline,
                    }}
                    onClose={() => closeTab(activeInstance.instanceId)}
                  />
                </Suspense>
              )}
            </div>
          )}
          </div>
          </>
        )}
      </div>
      {/* Minimized browser panes stay mounted here (webview kept alive,
          hidden via visible=false) and are restored from the Browser tab. */}
      <DormantBrowsers panes={panes} />
    </>
  );
}
