// Dev-tab right-side panel: per-pane live list of changed files in the
// focused pane's working directory, click-to-view-diff (delegated to the
// existing PeekPanel), and a "Send PR" button that forwards a prompt into
// the pane's own pty — Conduit does NOT run git/PR logic itself; the
// already-running harness has full context on the changes and the git/gh
// CLI toolchain (§7.10/§7.11).
//
// State model: the panel is bound to the currently-focused terminal pane.
// When focus moves to another pane, the panel swaps to that pane's
// working directory + diff list. In embedded mode (the tool panel's Files
// tab) there may be no focused terminal at all — the user's context is the
// chat/selected project — so the panel falls back to the SELECTED PROJECT's
// root as the diff root. A fresh pane with no edits shows an empty/idle
// state — never stale data from the previously-focused pane.
//
// Polling: piggybacks on the existing `useGitStatusPolling` interval
// (refreshGitStatus in projects store, every 8s) plus an extra per-pane
// refresh on focus change. We deliberately do NOT add a second interval
// here — the user explicitly asked to reuse §7.11's mechanism rather than
// stand up a second one.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getChangedFiles, getGitFileDiff, safeListen, writePtySubmit } from "../../lib/ipc";
import { parseUnifiedDiff } from "../../lib/diff";
import { useChatStore } from "../../state/chat";
import { usePanesStore } from "../../state/panes";
import { useProjectsStore } from "../../state/projects";
import { useUiStore } from "../../state/ui";
import type { ChangedFile } from "../../types";

const POLL_MS = 4000;
/** Live-refresh cadence for the inline diff view. The file list polls at
 *  POLL_MS, and the per-file diff is a cheap `git diff -- <path>` so the
 *  same interval is fine — keeps the diff text visually tracking changes
 *  the agent makes in the pty (typing, file edits, `git add` etc). */
const DIFF_POLL_MS = 2000;
/** Hard cap on diff rows rendered in the inline diff view. A large change
 *  (lockfile regen, minified bundle) can be tens of thousands of lines;
 *  rendering them all as DOM rows froze the panel. Beyond the cap we show a
 *  truncation notice — the full diff is always available via git/the Peek. */
const DIFF_LINE_CAP = 2000;
/** Cap on file rows rendered in the list. The backend caps the payload at
 *  1000 entries; rendering all of them (re-laid-out whenever the 4s poll
 *  sees a count change) is still heavy, so we show the first slice plus a
 *  summary row — clicking a file beyond the cap is vanishingly rare. */
const FILE_ROW_CAP = 300;

/**
 * The literal prompt we type into the pane's pty when the user clicks Send
 * PR. The harness is the one with the full context (and the git/gh CLI),
 * so we keep this terse and let the harness decide how to commit and push.
 *
 * Why these exact words: "commit these changes" avoids a multi-step
 * approval flow on the harness's side ("stage first?"), and "open a pull
 * request" tells the harness to use `gh pr create` (or fall back to
 * surfacing a URL). We deliberately don't tell it which files to commit
 * or what the message should be — the agent that produced the diff is
 * best positioned to write a meaningful message.
 *
 * Note: a trailing \r is appended when sent, mimicking the BroadcastBar
 * pattern (writePty + "\r") so the harness actually submits the prompt
 * rather than just rendering it in the input box.
 */
const SEND_PR_PROMPT =
  "commit these changes with a clear message and open a pull request";

/**
 * Resolve the working directory to use for a terminal pane. Per PRD §7.10,
 * a session may run inside a worktree; that path is what `get_changed_files`
 * MUST target — not the project root. Order of preference:
 *   1. The session's persisted `worktreePath` (set when the session was
 *      created via a worktree-scoped flow).
 *   2. The project's root path (the typical case).
 *   3. Empty string when neither resolves (non-git project, no project
 *      binding). The panel renders an empty state in that case.
 */
function paneCwd(
  pane: { data: { kind: string; sessionId: string | null } | { kind: "browser" } } | null,
): string {
  if (!pane || pane.data.kind !== "terminal") return "";
  const sessionId = pane.data.sessionId;
  if (!sessionId) {
    // Shell/login panes have no Conduit session; fall back to the
    // selected project if we can find one. This is best-effort — shell
    // panes whose spawn cwd we don't surface here still get a usable
    // empty state instead of crashing.
    const selected = useProjectsStore.getState().selectedProjectId;
    const project = useProjectsStore.getState().projects.find((p) => p.id === selected);
    return project?.path ?? "";
  }
  const session = useProjectsStore.getState().sessions.find((s) => s.id === sessionId);
  if (session?.worktreePath) return session.worktreePath;
  const project = useProjectsStore.getState().projectById(session?.projectId ?? null);
  return project?.path ?? "";
}

export function DevDiffPanel({ embedded = false }: { embedded?: boolean }) {
  const focusedPaneId = usePanesStore((s) => s.focusedPaneId);
  const panes = usePanesStore((s) => s.panes);
  const focusedPane = useMemo(
    () => panes.find((p) => p.paneId === focusedPaneId) ?? null,
    [panes, focusedPaneId],
  );

  // Per-pane diff content. Keyed by paneId so swapping focus swaps content
  // — and crucially, so a fresh pane with no edits shows the empty state
  // rather than inheriting the previous pane's file list.
  const [filesByPane, setFilesByPane] = useState<Record<string, ChangedFile[]>>({});
  const [loading, setLoading] = useState(false);
  const diffPanelCollapsed = useUiStore((s) => s.diffPanelCollapsed);
  const toggleDiffPanel = useUiStore((s) => s.toggleDiffPanel);
  const diffPanelWidth = useUiStore((s) => s.diffPanelWidth);
  const setDiffPanelWidth = useUiStore((s) => s.setDiffPanelWidth);
  const panelRef = useRef<HTMLDivElement>(null);

  // Subscribe to the slices that affect cwd resolution (sessions, projects)
  // so worktree creation / new sessions trigger a re-resolve, not a stale
  // closure from the first render.
  const sessions = useProjectsStore((s) => s.sessions);
  const projects = useProjectsStore((s) => s.projects);
  const selectedProjectId = useProjectsStore((s) => s.selectedProjectId);

  // Resolve the diff root once per focus change OR whenever the
  // projects/sessions list updates. Per PRD §7.10, a session may run inside
  // a worktree, so the worktree path MUST be preferred over the project root.
  // A non-terminal focused pane (browser) doesn't bind — the panel ignores it.
  const boundPane = focusedPane && focusedPane.data.kind === "terminal" ? focusedPane : null;
  // Embedded (tool panel Files tab) fallback: with no focused terminal the
  // user's context is the selected project, so diff against its root.
  const fallbackProject =
    embedded && !boundPane
      ? projects.find((p) => p.id === selectedProjectId) ?? null
      : null;
  const cwd = useMemo(
    () => (boundPane ? paneCwd(boundPane) : fallbackProject?.path ?? ""),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boundPane, fallbackProject, sessions, projects, selectedProjectId],
  );
  // Cache key for the file list: the pane id, or the fallback project id.
  const bindKey = boundPane?.paneId ?? (fallbackProject ? `project:${fallbackProject.id}` : null);

  // Project root for the "union" fetch: in worktree-scoped sessions the agent
  // may write files OUTSIDE the pane's cwd (e.g. directly into the project
  // root) — polling only the pane's cwd misses those. Always also poll the
  // project root when one is resolved; merge + dedupe by path before render.
  //
  // Resolution order matches `paneCwd` so a shell pane with no session falls
  // back to the same project as the Files tab's primary scope.
  const projectPath = useMemo(() => {
    if (boundPane) {
      // Reuse the same resolution: session's worktree path, then its
      // project root, then nothing. The worktree's parent project is what
      // we want here, NOT the worktree itself.
      const sessionId = boundPane.data.kind === "terminal" ? boundPane.data.sessionId : null;
      const session = sessionId
        ? useProjectsStore.getState().sessions.find((s) => s.id === sessionId)
        : null;
      const project = session
        ? useProjectsStore.getState().projectById(session.projectId)
        : null;
      return project?.path ?? "";
    }
    return fallbackProject?.path ?? "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundPane, fallbackProject, sessions, projects]);

  // Refresh on the same cadence as the existing git-status polling
  // (useGitStatusPolling, every 8s) — plus an immediate fetch on focus
  // change so the user sees the new pane's state without an 8s delay.
  // We deliberately don't subscribe to the projects store's `gitStatuses`
  // because that's a project-scoped badge, not a per-pane (worktree-aware)
  // file list. A second 4s timer is fine for just the focused pane.
  //
  // Two-scope fetch: primary is the pane's cwd (worktree). When a project
  // root is resolved AND it's a different path from the pane cwd, also poll
  // the project root. Merge by `path` (a ChangedFile's `path` is unique
  // within a single git tree; the project root may also surface the
  // worktree's file again under the same relative path — we keep the pane
  // entry because it carries the more specific worktree context). When the
  // pane cwd already IS the project root (typical non-worktree case), the
  // second fetch is skipped to avoid a duplicate round-trip.
  useEffect(() => {
    if (!bindKey || !cwd) return;
    let cancelled = false;
    let inFlight = false;
    const tick = () => {
      // Guard against stacking: a slow getChangedFiles (large worktree)
      // could pile up overlapping requests if the FS event burst exceeds
      // a single tick's round-trip. Skip a tick that fires while one is
      // still outstanding.
      if (cancelled || inFlight) return;
      inFlight = true;
      setLoading(true);
      const needsProjectFetch = projectPath && projectPath !== cwd;
      const primary = getChangedFiles(cwd);
      const secondary = needsProjectFetch ? getChangedFiles(projectPath) : Promise.resolve(null);
      void Promise.all([primary, secondary]).then(([paneFiles, projectFiles]) => {
        inFlight = false;
        if (cancelled) return;
        // Dedup by path; pane entries win on conflict so the focused
        // worktree's context is preserved (its Added/Deleted counts reflect
        // the worktree state, not the project root's).
        const byPath = new Map<string, ChangedFile>();
        for (const f of projectFiles ?? []) byPath.set(f.path, f);
        for (const f of paneFiles ?? []) byPath.set(f.path, f);
        // Stable order: pane files first (in their git-status order), then
        // any project-root-only files appended in git-status order. Matches
        // the visual hierarchy: "things the focused pane touched" then
        // "things outside the pane but in this project".
        const panePathSet = new Set((paneFiles ?? []).map((f) => f.path));
        const projectOnly = (projectFiles ?? []).filter((f) => !panePathSet.has(f.path));
        const merged = [...(paneFiles ?? []), ...projectOnly];
        // Belt-and-braces: the dedup map is the source of truth, the order
        // array is the layout. We rebuild merged from the map to drop any
        // accidental duplicates the loop above didn't catch (e.g. if both
        // scopes returned the same path with different stat counts).
        const finalOrder: ChangedFile[] = merged
          .filter((f) => byPath.has(f.path))
          .map((f) => byPath.get(f.path)!);
        setFilesByPane((prev) => {
          // Skip the update when the merged list is identical to what's
          // already shown — with big change sets a tick was re-rendering
          // the whole panel (and re-laying-out hundreds of rows) every tick.
          const cur = prev[bindKey] ?? [];
          const same =
            cur.length === finalOrder.length &&
            cur.every((f, i) => {
              const n = finalOrder[i];
              return (
                f.path === n.path &&
                f.kind === n.kind &&
                f.status === n.status &&
                (f.added ?? 0) === (n.added ?? 0) &&
                (f.deleted ?? 0) === (n.deleted ?? 0)
              );
            });
          return same ? prev : { ...prev, [bindKey]: finalOrder };
        });
        setLoading(false);
      });
    };
    // Initial fetch (covers the boot/mount case before the watcher fires).
    tick();
    // Subscribe to the FS change event. The backend debounces (300 ms
    // quiet window) before emitting, so a burst of file writes from
    // `npm install` or `git checkout` collapses to one tick. We filter
    // by path to only re-tick for the relevant scope (pane cwd OR
    // project root) — worktree changes that don't touch this pane
    // are no-ops.
    let unlisten: (() => void) | null = null;
    void safeListen<string>("project:fs-changed", (changedPath) => {
      if (
        changedPath === cwd ||
        (projectPath && changedPath === projectPath) ||
        changedPath.startsWith(cwd + "\\") ||
        changedPath.startsWith(cwd + "/") ||
        (projectPath && changedPath.startsWith(projectPath + "\\")) ||
        (projectPath && changedPath.startsWith(projectPath + "/"))
      ) {
        tick();
      }
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [bindKey, cwd, projectPath]);

  // Prune cached file lists whose pane closed or whose fallback project was
  // removed, so we don't leak. This is rare (panes close infrequently) so a
  // periodic sweep would be overkill; do it on the focused-pane effect instead.
  useEffect(() => {
    setFilesByPane((prev) => {
      const live = new Set(panes.map((p) => p.paneId));
      const liveProjects = new Set(projects.map((p) => `project:${p.id}`));
      let changed = false;
      const next: Record<string, ChangedFile[]> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (live.has(k) || liveProjects.has(k)) next[k] = v;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [panes, projects]);

  // Drag-to-resize: a left-edge grab zone. Dragging the splitter widens /
  // narrows the panel — the same UX as PaneGrid's column splitter.
  // MUST be declared before any early return below, otherwise the hook count
  // differs between the collapsed and expanded render paths and React throws
  // "Rendered more hooks than during the previous render."
  const startResize = useCallback(
    (e: React.PointerEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      e.preventDefault();
      const rect = panel.getBoundingClientRect();
      const startX = e.clientX;
      const startWidth = rect.width;
      const onMove = (ev: PointerEvent) => {
        const next = startWidth + (ev.clientX - startX);
        setDiffPanelWidth(next);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [setDiffPanelWidth],
  );

  // Local view state for the inline diff detail: which file (if any) is
  // currently expanded into a diff view inside THIS panel. Clicking a file
  // row sets this; the "‹ back" button clears it. Kept in component state
  // (not the UI store) because the diff lives entirely inside the side
  // panel now — no other component needs to know about it.
  //
  // These hooks MUST be above the early returns below (hidden / collapsed
  // states) — otherwise React sees a different hook count between renders
  // and throws "Rendered more hooks than during the previous render."
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diffText, setDiffText] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  // Watch for external diff requests (e.g. peek icon in branch-switch modal).
  const diffPanelFile = useUiStore((s) => s.diffPanelFile);
  const diffPanelCwd = useUiStore((s) => s.diffPanelCwd);
  useEffect(() => {
    if (diffPanelFile && diffPanelCwd) {
      setSelectedFile(diffPanelFile);
      // Clear the store so the same file can be selected again later.
      useUiStore.getState().setDiffPanelFile(null, null);
    }
  }, [diffPanelFile, diffPanelCwd]);

  // Reset the inline diff selection when the binding changes (pane focus or
  // fallback project), so a stale file diff doesn't linger over the new
  // file list.
  useEffect(() => {
    setSelectedFile(null);
    setDiffText(null);
  }, [bindKey]);

  // Fetch the file's diff whenever the selection (or cwd) changes. Guarded
  // internally so it no-ops when nothing is selected.
  //
  // Two-stage loading strategy (avoids the "flicker to empty" UX you'd get
  // by clearing `diffText` on every refresh):
  //   1. **Initial load / file switch**: clear `diffText` and show the
  //      spinner until the first fetch resolves.
  //   2. **Live re-poll** (every DIFF_POLL_MS while the panel is open):
  //      KEEP the previous `diffText` so the diff stays visible while we
  //      re-fetch. Replace it atomically when the new diff lands. If the
  //      diff is unchanged, nothing visually changes. If the user is in
  //      the middle of reading a hunk, the new content scrolls them to
  //      the right place because we don't reset scroll on text updates
  //      (the diff-file div's `key` doesn't change).
  //
  // The poll is per-file: it only ticks when a file is actually selected,
  // and it's tied to the lifecycle of `selectedFile` (cleanup stops it).
  // Two intervals would otherwise be a problem (one for the file list at
  // 4s, one for the diff at 4s) — but they only run concurrently when
  // the user is actively looking at a diff, which is the case where
  // freshness matters most. Driven by the same FS watcher event the file
  // list uses — no 2s poll left.
  useEffect(() => {
    if (!selectedFile || !cwd) {
      setDiffText(null);
      return;
    }
    let cancelled = false;
    let firstLoad = true;
    const tick = () => {
      if (cancelled) return;
      if (firstLoad) setDiffLoading(true);
      void getGitFileDiff(cwd, selectedFile).then((d) => {
        if (cancelled) return;
        const next = d ?? "";
        // Skip the state update when the diff text is unchanged — a
        // file watcher tick would otherwise re-parse and re-render
        // thousands of diff lines every tick even though nothing changed.
        setDiffText((prev) => (next === prev ? prev : next));
        if (firstLoad) {
          setDiffLoading(false);
          firstLoad = false;
        }
      });
    };
    tick();
    // Subscribe to FS changes for the relevant cwd. The backend
    // debounces, so this fires once per logical change, not per
    // intermediate file write. 2 s polling removed — see git_watcher.rs.
    let unlisten: (() => void) | null = null;
    void safeListen<string>("project:fs-changed", (changedPath) => {
      if (
        changedPath === cwd ||
        changedPath.startsWith(cwd + "\\") ||
        changedPath.startsWith(cwd + "/")
      ) {
        tick();
      }
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [selectedFile, cwd]);
  // Memoized: parseUnifiedDiff on a large diff is expensive, and this used
  // to re-run on EVERY panel render (each 4s file-list poll included).
  const diffFiles = useMemo(
    () => (diffText !== null ? parseUnifiedDiff(diffText) : []),
    [diffText],
  );

  // Per-file diff stats: count added vs deleted lines for the header bar.
  // Computed from the parsed diff so the counter updates live as the
  // 2s poll refreshes the diff text. No re-fetch needed — it's a pure
  // reduce over the already-parsed lines.
  const diffStats = useMemo(() => {
    let added = 0;
    let deleted = 0;
    for (const file of diffFiles) {
      for (const line of file.lines) {
        if (line.type === "add") added += 1;
        else if (line.type === "del") deleted += 1;
      }
    }
    return { added, deleted };
  }, [diffFiles]);

  // Re-resolve which files came from the pane (vs. project-root-only)
  // whenever the bind key or cwd changes. This is a cheap client-side
  // dedupe, not a re-fetch — we already polled both scopes; here we
  // just classify the result. MUST stay above the early returns below —
  // hooks after a conditional return change the hook order between
  // renders and crash React ("rendered more hooks than during the
  // previous render") the moment a project gets selected.
  const [panePaths, setPanePaths] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!bindKey || !cwd) {
      setPanePaths(null);
      return;
    }
    let cancelled = false;
    void getChangedFiles(cwd).then((paneFiles) => {
      if (cancelled) return;
      setPanePaths(new Set((paneFiles ?? []).map((f) => f.path)));
    });
    return () => {
      cancelled = true;
    };
  }, [bindKey, cwd]);

  // Hide the panel when nothing binds: standalone mode needs a focused
  // terminal pane; embedded mode falls back to the selected project but
  // still needs SOME diff root. In embedded mode the host keeps us mounted,
  // so we render an empty state instead of disappearing.
  if (!bindKey || !cwd) {
    if (!embedded) return null;
    return (
      <div className="dev-diff-panel dev-diff-panel-embedded">
        <div className="dev-diff-empty">
          Select a project (or focus a terminal pane) to see its changed files
          here.
        </div>
      </div>
    );
  }

  // Collapsed: render a thin restore strip on the right edge (matches the
  // browser-pane minimize UX). Body content stays in memory so a quick
  // expand is instant; the polling effect above still runs. Embedded mode
  // leaves collapse to the host tool panel.
  if (!embedded && diffPanelCollapsed) {
    return (
      <div className="dev-diff-panel dev-diff-panel-collapsed" aria-label="Changed files for focused pane (collapsed)">
        <button
          className="dev-diff-panel-restore"
          onClick={toggleDiffPanel}
          title="Show changed files panel"
          aria-label="Show changed files panel"
        >
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span className="dev-diff-panel-restore-label">Files</span>
        </button>
      </div>
    );
  }

  const files = filesByPane[bindKey] ?? [];
  // "Project extras": files surfaced by the project-root fetch that the
  // focused pane's cwd (typically a worktree) doesn't see. Render a tiny
  // hint in the header so the user knows these are coming from a wider
  // scope than the pane itself — without it, the file list looks like
  // ghost activity the focused pane never touched. (panePaths is computed
  // by the effect above the early returns.)
  const projectExtrasCount =
    panePaths && files.length > panePaths.size ? files.length - panePaths.size : 0;
  // Totals across all changed files, for the header counter.
  let totalAdded = 0;
  let totalDeleted = 0;
  for (const f of files) {
    totalAdded += f.added ?? 0;
    totalDeleted += f.deleted ?? 0;
  }
  // Project context: the focused session's project, or — in the embedded
  // project fallback — the selected project itself.
  const sessionId = boundPane?.data.kind === "terminal" ? boundPane.data.sessionId : null;
  const projectId = sessionId
    ? useProjectsStore.getState().sessions.find((s) => s.id === sessionId)?.projectId ?? null
    : fallbackProject?.id ?? null;

  const sendPr = () => {
    if (files.length === 0) return;
    if (boundPane) {
      // Legacy terminal-pane flow: forward into the pane's pty exactly like
      // a user-typed message, then press Enter for the harness:
      // writePtySubmit writes the prompt and a separate "\r" (standalone
      // Enter), which is what actually submits TUI harnesses — a trailing
      // \r merged into the same write does not.
      writePtySubmit(boundPane.paneId, SEND_PR_PROMPT);
      return;
    }
    // Unified layout: there are no terminal panes to focus — the chat IS
    // the agent surface. Send the PR prompt as a normal chat message; if a
    // turn is already running it stacks in the FIFO queue. The backend
    // scopes the turn to the selected project's directory, so the agent
    // sees these exact changes.
    void useChatStore.getState().sendMessage(SEND_PR_PROMPT);
  };

  const openFileDiff = (file: ChangedFile) => {
    // Show the diff INLINE inside this side panel — the file list is
    // replaced by the diff view for the clicked file. The user explicitly
    // asked for the diff to appear in the diff pane, not over the pty.
    if (!projectId) return;
    setSelectedFile(file.path);
  };

  return (
    <div
      className={`dev-diff-panel${embedded ? " dev-diff-panel-embedded" : ""}`}
      ref={panelRef}
      style={embedded ? undefined : { width: diffPanelWidth }}
      aria-label="Changed files for focused pane"
    >
      {!embedded && (
        <div
          className="dev-diff-panel-resize"
          onPointerDown={startResize}
          title="Drag to resize"
          role="separator"
          aria-orientation="vertical"
        />
      )}
      <div className="dev-diff-panel-header">
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span className="dev-diff-panel-title">Files</span>
        </div>
        <span className="dev-diff-panel-cwd" title={cwd}>
          {shortenCwd(cwd)}
        </span>
        {projectExtrasCount > 0 && (
          <span
            className="dev-diff-panel-extras"
            title={`${projectExtrasCount} file${
              projectExtrasCount === 1 ? "" : "s"
            } outside the focused pane's working tree`}
          >
            +{projectExtrasCount} in project
          </span>
        )}
        {totalAdded + totalDeleted > 0 && (
          <span className="dev-diff-panel-total" title="Total added / deleted lines">
            {totalAdded > 0 && (
              <span className="dev-diff-stat-add">+{totalAdded.toLocaleString()}</span>
            )}
            {totalDeleted > 0 && (
              <span className="dev-diff-stat-del">−{totalDeleted.toLocaleString()}</span>
            )}
          </span>
        )}
        <button
          className="dev-diff-send-pr"
          onClick={sendPr}
          disabled={files.length === 0}
          title={
            files.length === 0
              ? "No changes here yet"
              : boundPane
              ? `Forward into the pane's pty:\n"${SEND_PR_PROMPT}"`
              : `Send to the chat:\n"${SEND_PR_PROMPT}"`
          }
        >
          ⇧ Send PR
        </button>
        {!embedded && (
          <button
            className="dev-diff-panel-collapse"
            onClick={toggleDiffPanel}
            title="Hide the diff panel (matches browser pane minimize)"
            aria-label="Hide diff panel"
          >
            ⊟
          </button>
        )}
      </div>
      <div className="dev-diff-panel-body">
        {selectedFile ? (
          // Inline diff view: replaces the file list when a row is clicked.
          // Shows the same line-numbered diff as the per-pane overlay used
          // to, but rendered inside the side panel itself — exactly where
          // the user asked for it.
          <div className="dev-diff-detail">
            <button
              className="dev-diff-back"
              onClick={() => setSelectedFile(null)}
              title="Back to file list"
              aria-label="Back to file list"
            >
              ‹ Files
            </button>
            <div className="dev-diff-detail-path" title={selectedFile}>
              <span className="dev-diff-detail-path-name">{selectedFile}</span>
              {/* Diff stat counter: added (green) / deleted (red) line
                 counts, right-aligned on the filename row. Only shown
                 when the diff has loaded and isn't empty. */}
              {!diffLoading && diffFiles.length > 0 && (
                <span className="dev-diff-stats">
                  {diffStats.added > 0 && (
                    <span className="dev-diff-stat-add">
                      +{diffStats.added.toLocaleString()}
                    </span>
                  )}
                  {diffStats.deleted > 0 && (
                    <span className="dev-diff-stat-del">
                      −{diffStats.deleted.toLocaleString()}
                    </span>
                  )}
                </span>
              )}
            </div>
            {diffLoading ? (
              <div className="dev-diff-empty">Loading diff…</div>
            ) : diffFiles.length === 0 ? (
              <div className="dev-diff-empty">No changes in {selectedFile}.</div>
            ) : (
              diffFiles.map((file, i) => {
                const visibleLines = file.lines.filter((l) => l.type !== "meta");
                const capped = visibleLines.length > DIFF_LINE_CAP;
                const rows = capped ? visibleLines.slice(0, DIFF_LINE_CAP) : visibleLines;
                return (
                <div className="diff-file" key={`${file.newPath}-${i}`}>
                  {rows.map((line, j) => (
                      <div key={j} className={`diff-line ${line.type}`}>
                        <span className="diff-line-gutter diff-line-gutter-old">
                          {line.oldLine ?? ""}
                        </span>
                        <span className="diff-line-gutter diff-line-gutter-new">
                          {line.newLine ?? ""}
                        </span>
                        <span className="diff-line-content">
                          {line.type === "add"
                            ? "+ "
                            : line.type === "del"
                            ? "- "
                            : line.type === "hunk"
                            ? ""
                            : "  "}
                          {line.text}
                        </span>
                      </div>
                    ))}
                  {capped && (
                    <div className="diff-line meta">
                      <span className="diff-line-content">
                        … {(
                          visibleLines.length - DIFF_LINE_CAP
                        ).toLocaleString()} more lines not shown (large diff truncated)
                      </span>
                    </div>
                  )}
                </div>
                );
              })
            )}
          </div>
        ) : files.length === 0 ? (
          <div className="dev-diff-empty">
            {loading ? "Scanning…" : "No changes yet"}
          </div>
        ) : (
          <ul className="dev-diff-file-list">
            {files.slice(0, FILE_ROW_CAP).map((f, i) => (
              <li
                key={`${f.path}-${i}`}
                className={`dev-diff-file dev-diff-kind-${f.kind}${
                  panePaths && !panePaths.has(f.path) ? " dev-diff-file-out-of-scope" : ""
                }`}
                onClick={() => openFileDiff(f)}
                title={
                  f.oldPath
                    ? `${f.oldPath} → ${f.path}`
                    : panePaths && !panePaths.has(f.path)
                    ? `${f.path} (outside the focused pane's working tree)`
                    : f.path
                }
              >
                <span className="dev-diff-file-icon" aria-hidden="true">
                  {iconFor(f.kind)}
                </span>
                <span className="dev-diff-file-path">{f.path}</span>
                <span className="dev-diff-file-status">{f.status}</span>
                {(f.added ?? 0) + (f.deleted ?? 0) > 0 && (
                  <span className="dev-diff-file-counter" title={`${f.path}: added / deleted lines`}>
                    {(f.added ?? 0) > 0 && (
                      <span className="dev-diff-stat-add">+{(f.added ?? 0).toLocaleString()}</span>
                    )}
                    {(f.deleted ?? 0) > 0 && (
                      <span className="dev-diff-stat-del">−{(f.deleted ?? 0).toLocaleString()}</span>
                    )}
                  </span>
                )}
              </li>
            ))}
            {files.length > FILE_ROW_CAP && (
              <li className="dev-diff-file dev-diff-file-out-of-scope">
                <span className="dev-diff-file-path">
                  … {(files.length - FILE_ROW_CAP).toLocaleString()} more files not shown
                </span>
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

function iconFor(kind: string): string {
  switch (kind) {
    case "M":
      return "●";
    case "A":
      return "+";
    case "D":
      return "−";
    case "R":
      return "→";
    case "C":
      return "⎘";
    case "U":
      return "?";
    default:
      return "·";
  }
}

function shortenCwd(cwd: string): string {
  if (cwd.length <= 48) return cwd;
  return "…" + cwd.slice(cwd.length - 47);
}
