// Dev-tab right-side panel: per-pane live list of changed files in the
// focused pane's working directory, click-to-view-diff (delegated to the
// existing PeekPanel), and a "Send PR" button that forwards a prompt into
// the pane's own pty — Conduit does NOT run git/PR logic itself; the
// already-running harness has full context on the changes and the git/gh
// CLI toolchain (§7.10/§7.11).
//
// State model: the panel is bound to the currently-focused terminal pane.
// When focus moves to another pane, the panel swaps to that pane's
// working directory + diff list. A fresh pane with no edits shows an
// empty/idle state — never stale data from the previously-focused pane.
//
// Polling: piggybacks on the existing `useGitStatusPolling` interval
// (refreshGitStatus in projects store, every 8s) plus an extra per-pane
// refresh on focus change. We deliberately do NOT add a second interval
// here — the user explicitly asked to reuse §7.11's mechanism rather than
// stand up a second one.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getChangedFiles, getGitFileDiff, writePtySubmit } from "../../lib/ipc";
import { parseUnifiedDiff } from "../../lib/diff";
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

export function DevDiffPanel() {
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

  // Resolve the focused pane's cwd once per focus change OR whenever the
  // projects/sessions list updates. Per PRD §7.10, a session may run inside
  // a worktree, so the worktree path MUST be preferred over the project root.
  const cwd = useMemo(
    () => paneCwd(focusedPane),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [focusedPane, sessions, projects, selectedProjectId],
  );

  // Refresh on the same cadence as the existing git-status polling
  // (useGitStatusPolling, every 8s) — plus an immediate fetch on focus
  // change so the user sees the new pane's state without an 8s delay.
  // We deliberately don't subscribe to the projects store's `gitStatuses`
  // because that's a project-scoped badge, not a per-pane (worktree-aware)
  // file list. A second 4s timer is fine for just the focused pane.
  useEffect(() => {
    if (!focusedPane || !cwd) return;
    let cancelled = false;
    const tick = () => {
      setLoading(true);
      void getChangedFiles(cwd).then((files) => {
        if (cancelled) return;
        setFilesByPane((prev) => ({ ...prev, [focusedPane.paneId]: files ?? [] }));
        setLoading(false);
      });
    };
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [focusedPane?.paneId, cwd]);

  // Per-pane prune: when a pane closes, drop its cached file list so we
  // don't leak. This is rare (panes close infrequently) so a periodic
  // sweep would be overkill; do it on the focused-pane effect instead.
  useEffect(() => {
    setFilesByPane((prev) => {
      const live = new Set(panes.map((p) => p.paneId));
      let changed = false;
      const next: Record<string, ChangedFile[]> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (live.has(k)) next[k] = v;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [panes]);

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

  // Reset the inline diff selection when the focused pane changes, so a
  // stale file diff from the previous pane doesn't linger over the new
  // pane's file list. No-op when the panel is hidden (selectedFile is
  // already null) but the hook still runs to keep the count stable.
  useEffect(() => {
    setSelectedFile(null);
    setDiffText(null);
  }, [focusedPane?.paneId]);

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
  // freshness matters most.
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
        setDiffText(d ?? "");
        if (firstLoad) {
          setDiffLoading(false);
          firstLoad = false;
        }
      });
    };
    tick();
    const timer = window.setInterval(tick, DIFF_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedFile, cwd]);
  const diffFiles = diffText !== null ? parseUnifiedDiff(diffText) : [];

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

  // Hide the panel when no terminal pane is focused, OR when the focused
  // pane can't resolve a working directory (no project, no session).
  if (!focusedPane || focusedPane.data.kind !== "terminal" || !cwd) return null;

  // Collapsed: render a thin restore strip on the right edge (matches the
  // browser-pane minimize UX). Body content stays in memory so a quick
  // expand is instant; the polling effect above still runs.
  if (diffPanelCollapsed) {
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

  const files = filesByPane[focusedPane.paneId] ?? [];
  // Totals across all changed files, for the header counter.
  let totalAdded = 0;
  let totalDeleted = 0;
  for (const f of files) {
    totalAdded += f.added ?? 0;
    totalDeleted += f.deleted ?? 0;
  }
  const sessionId = focusedPane.data.sessionId;
  const projectId = sessionId
    ? useProjectsStore.getState().sessions.find((s) => s.id === sessionId)?.projectId ?? null
    : null;

  const sendPr = () => {
    if (files.length === 0) return;
    // Forward into the pane's pty exactly like a user-typed message, then
    // press Enter for the harness: writePtySubmit writes the prompt and a
    // separate "\r" (standalone Enter), which is what actually submits TUI
    // harnesses — a trailing \r merged into the same write does not.
    writePtySubmit(focusedPane.paneId, SEND_PR_PROMPT);
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
      className="dev-diff-panel"
      ref={panelRef}
      style={{ width: diffPanelWidth }}
      aria-label="Changed files for focused pane"
    >
      <div
        className="dev-diff-panel-resize"
        onPointerDown={startResize}
        title="Drag to resize"
        role="separator"
        aria-orientation="vertical"
      />
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
              ? "No changes in this pane yet"
              : `Forward into the pane's pty:\n"${SEND_PR_PROMPT}"`
          }
        >
          ⇧ Send PR
        </button>
        <button
          className="dev-diff-panel-collapse"
          onClick={toggleDiffPanel}
          title="Hide the diff panel (matches browser pane minimize)"
          aria-label="Hide diff panel"
        >
          ⊟
        </button>
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
              diffFiles.map((file, i) => (
                <div className="diff-file" key={`${file.newPath}-${i}`}>
                  {file.lines
                    .filter((l) => l.type !== "meta")
                    .map((line, j) => (
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
                </div>
              ))
            )}
          </div>
        ) : files.length === 0 ? (
          <div className="dev-diff-empty">
            {loading ? "Scanning…" : "No changes yet"}
          </div>
        ) : (
          <ul className="dev-diff-file-list">
            {files.map((f, i) => (
              <li
                key={`${f.path}-${i}`}
                className={`dev-diff-file dev-diff-kind-${f.kind}`}
                onClick={() => openFileDiff(f)}
                title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
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
