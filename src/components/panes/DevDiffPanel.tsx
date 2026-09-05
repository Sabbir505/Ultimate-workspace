// Changes panel: per-pane live list of changed files in the
// focused pane's working directory, click-to-view-diff (delegated to the
// existing PeekPanel), and a "Send PR" button that forwards a prompt into
// the pane's own pty — Relay does NOT run git/PR logic itself; the
// already-running harness has full context on the changes and the git/gh
// CLI toolchain (§7.10/§7.11). Rendered embedded as the ToolPanel's
// "Changes" tab.
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
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SmoothReveal } from "../common/SmoothReveal";
import {
  getBranchChangedFiles,
  getChangedFiles,
  getGitFileDiffScoped,
  listChatCheckpoints,
  safeListen,
  writePtySubmit,
  generateDiffReview,
  type BranchChanges,
} from "../../lib/ipc";
import { parseUnifiedDiff } from "../../lib/diff";
import { useChatStore, selectContextSessionId } from "../../state/chat";
import { usePanesStore } from "../../state/panes";
import { useProjectsStore } from "../../state/projects";
import { useUiStore } from "../../state/ui";
import type { ChangedFile } from "../../types";

/** The Files tab's scope dropdown: which set of changed files is listed.
 *  unstaged/staged classify the porcelain status client-side; "branch" is
 *  the merge-base diff vs the base branch; "lastturn" is the last chat
 *  checkpoint's changed files. */
type ChangesFilter = "unstaged" | "staged" | "branch" | "lastturn";
const FILTER_LABEL: Record<ChangesFilter, string> = {
  unstaged: "Unstaged",
  staged: "Staged",
  branch: "All branch changes",
  lastturn: "Last turn",
};
const FILTER_ORDER: ChangesFilter[] = ["unstaged", "staged", "branch", "lastturn"];

/** Porcelain XY: X = index side (staged), Y = worktree side. "??" = untracked
 *  (unstaged by definition). */
function isStagedFile(f: ChangedFile): boolean {
  const x = f.status[0] ?? " ";
  return f.status !== "??" && x !== " " && x !== "?";
}
function isUnstagedFile(f: ChangedFile): boolean {
  if (f.status === "??") return true;
  const y = f.status[1] ?? " ";
  return y !== " " && y !== "?";
}

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
 * Note: a trailing \r is appended when sent (writePty + "\r") so the
 * harness actually submits the prompt rather than just rendering it in
 * the input box.
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
    // Shell/login panes have no Relay session; fall back to the
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
  // Manual-refresh counter: bumped by the Refresh button and scope switches
  // so the polling effects re-run immediately. Declared before the poll
  // effect (its deps array references it).
  const [refreshNonce, setRefreshNonce] = useState(0);
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
  // Active chat session + its project binding — the embedded Files tab
  // follows the CHAT, never the sidebar-selected project. In split view it
  // follows the FOCUSED half (selectContextSessionId), matching the toolbar
  // and git sidebar. Falling back to the global selection leaked the LAST
  // project's changes into a brand-new (unbound) chat's Changes tab.
  const activeChatSessionId = useChatStore(selectContextSessionId);
  const chatSessions = useChatStore((s) => s.sessions);
  const sessionProjects = useChatStore((s) => s.sessionProjects);
  const activeChatSession = useMemo(
    () =>
      activeChatSessionId
        ? chatSessions.find((x) => x.id === activeChatSessionId)
        : undefined,
    [activeChatSessionId, chatSessions],
  );
  const activeBoundProjectId = activeChatSessionId
    ? sessionProjects[activeChatSessionId]
    : undefined;

  // Resolve the diff root once per focus change OR whenever the
  // projects/sessions list updates. Per PRD §7.10, a session may run inside
  // a worktree, so the worktree path MUST be preferred over the project root.
  // A non-terminal focused pane (browser) doesn't bind — the panel ignores it.
  const boundPane = focusedPane && focusedPane.data.kind === "terminal" ? focusedPane : null;
  // Embedded (tool panel Files tab) fallback: with no focused terminal the
  // user's context is the ACTIVE CHAT — diff against its worktree, or its
  // bound project's root. An unbound chat resolves to "" (empty state)
  // instead of diffing whatever project is selected in the sidebar.
  const fallbackCwd =
    embedded && !boundPane
      ? activeChatSession?.worktreePath ??
        projects.find((p) => p.id === activeBoundProjectId)?.path ??
        ""
      : "";
  const cwd = useMemo(
    () => (boundPane ? paneCwd(boundPane) : fallbackCwd),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boundPane, fallbackCwd, sessions, projects, activeBoundProjectId],
  );
  // Cache key for the file list: the pane id, or the active chat binding.
  const bindKey = boundPane?.paneId ?? (fallbackCwd ? `chat:${activeChatSessionId}` : null);

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
    // Embedded: the active chat's bound project root (union scope for a
    // worktree cwd; equals the cwd when bound without a worktree).
    return projects.find((p) => p.id === activeBoundProjectId)?.path ?? "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundPane, activeBoundProjectId, sessions, projects]);

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
      void Promise.all([primary, secondary])
        .then(([paneFiles, projectFiles]) => {
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
      })
      .catch(() => {
        // A failed sweep (deleted worktree/project, transient IPC error)
        // must release the latch and the loading flag — otherwise every
        // later tick returns early and the panel freezes on "Scanning…"
        // forever. The stale list stays rendered.
        inFlight = false;
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
    // Hold the listen() promise: if the component unmounts before it
    // resolves, the real unlisten arrives AFTER cleanup ran — dropping it
    // would leak the handler for the app's lifetime (StrictMode makes this
    // fire on every mount in dev). Resolve it here and unsubscribe late.
    const listenReady = safeListen<string>("project:fs-changed", (changedPath) => {
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
    });
    return () => {
      cancelled = true;
      void listenReady.then((u) => u());
    };
  }, [bindKey, cwd, projectPath, refreshNonce]);

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
  // narrows the panel — the same UX as the ToolPanel's own splitter.
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

  // --- Filter dropdown (Unstaged / Staged / All branch changes / Last turn).
  // The filter itself lives in the ui store (the panel unmounts on tab
  // switch); the menu open flag and the manual-refresh counter are local.
  const filter = useUiStore((s) => s.gitChangesFilter);
  const setFilter = useUiStore((s) => s.setGitChangesFilter);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const filterWrapRef = useRef<HTMLDivElement>(null);
  // Close the scope menu on any outside click / Escape.
  useEffect(() => {
    if (!filterMenuOpen) return;
    const close = (e: MouseEvent) => {
      if (filterWrapRef.current && !filterWrapRef.current.contains(e.target as Node)) {
        setFilterMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFilterMenuOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [filterMenuOpen]);

  // --- Per-filter data sources.
  const focusedChatSessionId = useChatStore(selectContextSessionId);
  const [branchChanges, setBranchChanges] = useState<BranchChanges | null>(null);
  const [lastTurnFiles, setLastTurnFiles] = useState<ChangedFile[] | null>(null);
  // Tree the "Last turn" rows expand against: the checkpoint BEFORE the last
  // one (all-added empty tree when it's the first).
  const [lastTurnBase, setLastTurnBase] = useState<string>("empty");
  // Per-scope fetch flags (separate on purpose: the inactive scope's effect
  // must not clear the active one's spinner — a shared flag got clobbered by
  // the other effect's early return and the spinner died instantly).
  const [branchLoading, setBranchLoading] = useState(false);
  const [lastTurnLoading, setLastTurnLoading] = useState(false);

  useEffect(() => {
    if (filter !== "branch" || !cwd) {
      setBranchChanges(null);
      setBranchLoading(false);
      return;
    }
    let cancelled = false;
    setBranchLoading(true);
    void getBranchChangedFiles(cwd)
      .then((r) => {
        if (!cancelled) {
          setBranchChanges(r ?? { files: [], mergeBase: "" });
          setBranchLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBranchChanges({ files: [], mergeBase: "" });
          setBranchLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [filter, cwd, refreshNonce]);

  useEffect(() => {
    if (filter !== "lastturn" || !focusedChatSessionId) {
      setLastTurnFiles(null);
      setLastTurnLoading(false);
      return;
    }
    let cancelled = false;
    setLastTurnLoading(true);
    void listChatCheckpoints(focusedChatSessionId)
      .then((cps) => {
        if (cancelled) return;
        const list = cps ?? [];
        const last = list[list.length - 1];
        if (!last) {
          setLastTurnFiles([]);
          setLastTurnBase("empty");
          setLastTurnLoading(false);
          return;
        }
        const prev = list.length >= 2 ? list[list.length - 2].treeSha : "empty";
        setLastTurnBase(prev || "empty");
        setLastTurnFiles(
          (last.files ?? []).map<ChangedFile>((f) => ({
            status: f.status,
            kind: f.status,
            path: f.path,
            oldPath: null,
            added: 0,
            deleted: 0,
          })),
        );
        setLastTurnLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setLastTurnFiles([]);
          setLastTurnLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [filter, focusedChatSessionId, refreshNonce]);

  // The list spinner: the shared poll flag for unstaged/staged, the scope's
  // own flag for branch/last-turn.
  const scopeLoading =
    (filter === "branch" && branchLoading) || (filter === "lastturn" && lastTurnLoading);

  // Which diff base the expanded row fetches against — the heart of making
  // each filter's rows expand to the RIGHT diff, not just list correctly.
  const diffScope = useMemo(() => {
    if (filter === "staged") return "staged";
    if (filter === "branch") {
      return branchChanges?.mergeBase ? `base:${branchChanges.mergeBase}` : "worktree";
    }
    if (filter === "lastturn") return `base:${lastTurnBase}`;
    return "worktree";
  }, [filter, branchChanges, lastTurnBase]);


  // Whole-tree review state (the "Review all" header action). The per-file
  // review button was removed — its stats duplicated the row header and the
  // whole-tree review covers the same need.
  const [wholeTreeReviewLoading, setWholeTreeReviewLoading] = useState(false);
  const [wholeTreeReview, setWholeTreeReview] = useState<string | null>(null);

  // Watch for external diff requests (e.g. peek icon in branch-switch modal).
  const diffPanelFile = useUiStore((s) => s.diffPanelFile);
  const diffPanelCwd = useUiStore((s) => s.diffPanelCwd);
  // When an external peek sets a file, store its cwd here so the diff-loading
  // effect can use it (the panel's own `cwd` is bound to a terminal pane).
  const [externalCwd, setExternalCwd] = useState<string | null>(null);
  useEffect(() => {
    if (!diffPanelFile) return;
    // Chat edit blocks carry ABSOLUTE workspace paths, but get_git_file_diff
    // only accepts repo-relative ones (validate_repo_relative rejects
    // absolutes as a path-traversal guard). Strip the repo prefix when the
    // external path lives inside it; otherwise pass through and let the
    // fetch's error handling surface the failure.
    setSelectedFile(toRepoRelativePath(diffPanelFile, diffPanelCwd ?? cwd));
    if (diffPanelCwd) setExternalCwd(diffPanelCwd);
    // Clear the store so the same file can be selected again later.
    useUiStore.getState().setDiffPanelFile(null, null);
  }, [diffPanelFile, diffPanelCwd, cwd]);

  // Reset the inline diff selection when the binding changes (pane focus or
  // fallback project), so a stale file diff doesn't linger over the new
  // file list. Skipped on mount: a fresh mount usually means an external
  // request (chat "Review" button / branch peek) just set diffPanelFile in
  // the store and then activated this tab — the consume effect above already
  // applied it during this same commit, so resetting here would wipe the
  // selection and leave only the generic file list visible.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    setSelectedFile(null);
    setDiffText(null);
    setExternalCwd(null);
  }, [bindKey]);

  // The working directory for fetching diffs: external peek takes priority,
  // otherwise fall back to the bound pane/project cwd.
  const diffCwd = externalCwd ?? cwd;

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
    if (!selectedFile || !diffCwd) {
      setDiffText(null);
      return;
    }
    let cancelled = false;
    let firstLoad = true;
    const tick = () => {
      if (cancelled) return;
      if (firstLoad) setDiffLoading(true);
      void getGitFileDiffScoped(diffCwd, selectedFile, diffScope).then((d) => {
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
      }).catch(() => {
        // A rejected fetch (bad path, git failure) must never leave the
        // panel stuck on "Loading diff…" — degrade to the empty state.
        if (cancelled) return;
        setDiffText("");
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
    // Promise-holding pattern — see the file-list effect above: call the
    // unlisten even if it resolves after this component already unmounted.
    const listenReady = safeListen<string>("project:fs-changed", (changedPath) => {
      if (
        changedPath === cwd ||
        changedPath.startsWith(cwd + "\\") ||
        changedPath.startsWith(cwd + "/")
      ) {
        tick();
      }
    });
    return () => {
      cancelled = true;
      void listenReady.then((u) => u());
    };
  }, [selectedFile, diffCwd, diffScope, refreshNonce]);
  // Memoized: parseUnifiedDiff on a large diff is expensive, and this used
  // to re-run on EVERY panel render (each 4s file-list poll included).
  const diffFiles = useMemo(
    () => (diffText !== null ? parseUnifiedDiff(diffText) : []),
    [diffText],
  );

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
  // The list the current scope filter shows. Unstaged/staged classify the
  // porcelain status of the merged pane+project poll client-side; branch and
  // last-turn have their own sources (fetched on filter enter / refresh).
  const visibleFiles = useMemo(() => {
    if (filter === "staged") return files.filter(isStagedFile);
    if (filter === "branch") return branchChanges?.files ?? [];
    if (filter === "lastturn") return lastTurnFiles ?? [];
    return files.filter(isUnstagedFile);
  }, [filter, files, branchChanges, lastTurnFiles]);
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
  // fallback — the active chat's bound project.
  const sessionId = boundPane?.data.kind === "terminal" ? boundPane.data.sessionId : null;
  const projectId = sessionId
    ? useProjectsStore.getState().sessions.find((s) => s.id === sessionId)?.projectId ?? null
    : activeBoundProjectId ?? null;

  const sendPr = () => {
    if (visibleFiles.length === 0) return;
    if (boundPane) {
      // Legacy terminal-pane flow: forward into the pane's pty exactly like
      // a user-typed message, then press Enter for the harness:
      // writePtySubmit writes the prompt and a separate "\r" (standalone
      // Enter), which is what actually submits TUI harnesses — a trailing
      // \r merged into the same write does not. The harness (with git/gh)
      // then commits and opens the PR; its reply streams in that terminal.
      writePtySubmit(boundPane.paneId, SEND_PR_PROMPT);
      useUiStore.getState().pushToast("info", "PR request typed into the terminal harness");
      return;
    }
    // Unified layout: there are no terminal panes to focus — the chat IS
    // the agent surface. Send the PR prompt as a normal chat turn to the
    // FOCUSED chat (the one whose project these changes belong to); if a
    // turn is already running it stacks in the FIFO queue. The agent then
    // commits the changes and opens the PR with its own git/gh tools.
    const targetSession =
      useChatStore.getState().focusedChatSessionId ??
      useChatStore.getState().activeChatSessionId;
    if (!targetSession) {
      useUiStore.getState().pushToast("error", "Open (or focus) a chat first — there is no agent to run the PR");
      return;
    }
    void useChatStore
      .getState()
      .sendMessage(SEND_PR_PROMPT, undefined, undefined, targetSession);
    useUiStore.getState().pushToast("success", "PR request sent to the focused chat");
  };

  const reviewWholeTree = useCallback(async () => {
    if (!cwd || files.length === 0) return;
    setWholeTreeReviewLoading(true);
    try {
      const chat = useChatStore.getState();
      const chatId = chat.focusedChatSessionId ?? chat.activeChatSessionId ?? undefined;
      const text = await generateDiffReview(cwd, chatId, undefined);
      if (!text) {
        // The backend returns null when no provider is usable (no stored API
        // key and no local model) — surface that instead of silently spinning
        // to nothing.
        useUiStore
          .getState()
          .pushToast("error", "No AI provider available for review — configure a chat API key or local model");
        return;
      }
      setWholeTreeReview(text);
    } catch (e) {
      useUiStore.getState().pushToast("error", "Diff review failed", String(e));
    } finally {
      setWholeTreeReviewLoading(false);
    }
  }, [cwd, files.length]);

  // Clicking a row toggles its inline diff (accordion). The diff machinery
  // (diffText/diffFiles) is keyed to selectedFile, so "expanded" is simply
  // "this row's path is the selected file".
  const toggleFile = useCallback((file: ChangedFile) => {
    setSelectedFile((prev) => (prev === file.path ? null : file.path));
  }, []);

  // The expanded row's inline diff body — shared by the accordion below.
  const diffBody = diffLoading ? (
    <div className="dev-diff-loading-row">
      <span className="dev-diff-spinner" aria-hidden="true" />
      Loading diff…
    </div>
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
              <span className="diff-line-gutter diff-line-gutter-old">{line.oldLine ?? ""}</span>
              <span className="diff-line-gutter diff-line-gutter-new">{line.newLine ?? ""}</span>
              <span className="diff-line-content">
                {line.type === "add" ? "+ " : line.type === "del" ? "- " : line.type === "hunk" ? "" : "  "}
                {line.text}
              </span>
            </div>
          ))}
          {capped && (
            <div className="diff-line meta">
              <span className="diff-line-content">… {(visibleLines.length - DIFF_LINE_CAP).toLocaleString()} more lines not shown (large diff truncated)</span>
            </div>
          )}
        </div>
      );
    })
  );

  const fileList = visibleFiles.length === 0 ? (
    loading || scopeLoading ? (
      <div className="dev-diff-loading-row">
        <span className="dev-diff-spinner" aria-hidden="true" />
        Scanning {FILTER_LABEL[filter].toLowerCase()} changes…
      </div>
    ) : (
      <div className="dev-diff-empty">No {FILTER_LABEL[filter].toLowerCase()} changes</div>
    )
  ) : (
    <>
      <div className="dev-diff-file-list">
        {visibleFiles.slice(0, FILE_ROW_CAP).map((f, i) => {
          const expanded = selectedFile === f.path;
          return (
            <div key={`${f.path}-${i}`} className={`dev-diff-row${expanded ? " expanded" : ""}`}>
              <div
                className={`dev-diff-file dev-diff-kind-${f.kind}`}
                onClick={() => toggleFile(f)}
                title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
              >
                <FileIcon path={f.path} />
                <span className="dev-diff-file-path" title={f.path}>
                  <FileNameLabel path={f.path} />
                </span>
                <span className="dev-diff-file-status">{f.kind}</span>
                {(f.added ?? 0) + (f.deleted ?? 0) > 0 && (
                  <span className="dev-diff-file-counter" title={`${f.path}: added / deleted lines`}>
                    {(f.added ?? 0) > 0 && <span className="dev-diff-stat-add">+{(f.added ?? 0).toLocaleString()}</span>}
                    {(f.deleted ?? 0) > 0 && <span className="dev-diff-stat-del">−{(f.deleted ?? 0).toLocaleString()}</span>}
                  </span>
                )}
                <svg
                  className={`dev-diff-chevron${expanded ? " open" : ""}`}
                  width={12}
                  height={12}
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="4 6 8 10 12 6" />
                </svg>
              </div>
              {expanded && (
                <SmoothReveal open className="dev-diff-reveal">
                  <div className="dev-diff-file-diff">
                    {diffBody}
                  </div>
                </SmoothReveal>
              )}
            </div>
          );
        })}
        {visibleFiles.length > FILE_ROW_CAP && (
          <div className="dev-diff-file dev-diff-file-out-of-scope">
            <span className="dev-diff-file-path">… {(visibleFiles.length - FILE_ROW_CAP).toLocaleString()} more files not shown</span>
          </div>
        )}
      </div>
    </>
  );

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
          disabled={visibleFiles.length === 0}
          title={
            visibleFiles.length === 0
              ? "No changes in this scope yet"
              : boundPane
              ? `Forward into the pane's pty:\n"${SEND_PR_PROMPT}"`
              : `Send to the focused chat:\n"${SEND_PR_PROMPT}"`
          }
        >
          ⇧ Send PR
        </button>
        <button
          className="dev-diff-review-all"
          onClick={() => void reviewWholeTree()}
          disabled={files.length === 0 || wholeTreeReviewLoading}
          title={files.length === 0 ? "No changes here yet" : "Review all changes with AI"}
        >
          {wholeTreeReviewLoading ? "Reviewing…" : "🔍 Review all"}
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
        {/* Scope toolbar: the filter dropdown (Unstaged / Staged / All branch
            changes / Last turn) on the left, manual Refresh on the right —
            matching the reference design. The accordion list follows. */}
        <div className="dev-diff-toolbar">
          <div className="dev-diff-filter-wrap" ref={filterWrapRef}>
            <button
              className="dev-diff-filter-btn"
              onClick={() => setFilterMenuOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={filterMenuOpen}
              title="Which changes to list"
            >
              {FILTER_LABEL[filter]}
              <svg width={11} height={11} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="4 6 8 10 12 6" />
              </svg>
            </button>
            {filterMenuOpen && (
              <div className="dev-diff-filter-menu" role="menu">
                {FILTER_ORDER.map((key) => (
                  <button
                    key={key}
                    role="menuitem"
                    className={`dev-diff-filter-item${filter === key ? " active" : ""}`}
                    onClick={() => {
                      setFilter(key);
                      setSelectedFile(null);
                      setFilterMenuOpen(false);
                      // Force an immediate re-scan for the new scope — the
                      // spinner shows while it runs instead of stale data
                      // snapping over. branch/last-turn raise their own
                      // loading flags when their effects re-run.
                      setLoading(true);
                      setRefreshNonce((n) => n + 1);
                    }}
                  >
                    <span className="dev-diff-filter-check">{filter === key ? "✓" : ""}</span>
                    {FILTER_LABEL[key]}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            className="dev-diff-refresh"
            onClick={() => {
              setLoading(true);
              setRefreshNonce((n) => n + 1);
            }}
            title="Re-scan for changes"
          >
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            Refresh
          </button>
        </div>
        {/* Review result renders ABOVE the list — at the bottom of a long
            scrollable list it was below the fold and read as "nothing
            happened". */}
        {wholeTreeReview && (
          <div className="dev-diff-review-card dev-diff-review-card-top">
            <div className="dev-diff-review-card-header">
              <span className="dev-diff-review-card-title">Whole-tree AI Review</span>
              <button className="dev-diff-review-card-close" onClick={() => setWholeTreeReview(null)} title="Dismiss review">✕</button>
            </div>
            <div className="dev-diff-review-card-body dev-diff-review-md">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{wholeTreeReview}</ReactMarkdown>
            </div>
          </div>
        )}
        {fileList}
      </div>
    </div>
  );
}

/** Per-extension file badge — a tiny colored tile with the language's usual
 *  mark, so a Python file reads as Python at a glance (reference design).
 *  Dependency-free: extension → [label, hue]. */
const FILE_TYPE_BADGES: Record<string, { label: string; color: string }> = {
  py: { label: "Py", color: "#4B8BBE" },
  js: { label: "JS", color: "#B8860B" },
  mjs: { label: "JS", color: "#B8860B" },
  cjs: { label: "JS", color: "#B8860B" },
  jsx: { label: "JX", color: "#61dafb" },
  ts: { label: "TS", color: "#3178C6" },
  tsx: { label: "TX", color: "#3178C6" },
  rs: { label: "Rs", color: "#DEA584" },
  go: { label: "Go", color: "#00ADD8" },
  rb: { label: "Rb", color: "#CC342D" },
  java: { label: "Jv", color: "#B07219" },
  kt: { label: "Kt", color: "#A97BFF" },
  c: { label: "C", color: "#555555" },
  h: { label: "H", color: "#8884c8" },
  cpp: { label: "C+", color: "#f34b7d" },
  cs: { label: "C#", color: "#178600" },
  md: { label: "MD", color: "#8fa6d0" },
  mdx: { label: "MX", color: "#8fa6d0" },
  json: { label: "{}", color: "#cbcb41" },
  toml: { label: "TM", color: "#9c8f7f" },
  yaml: { label: "Y", color: "#cb171e" },
  yml: { label: "Y", color: "#cb171e" },
  html: { label: "<>", color: "#e34c26" },
  css: { label: "#", color: "#563d7c" },
  scss: { label: "SC", color: "#c6538c" },
  sh: { label: "$", color: "#89e051" },
  sql: { label: "SQ", color: "#e38c00" },
  txt: { label: "T", color: "#8a919e" },
  png: { label: "▣", color: "#a074c4" },
  jpg: { label: "▣", color: "#a074c4" },
  jpeg: { label: "▣", color: "#a074c4" },
  gif: { label: "▣", color: "#a074c4" },
  svg: { label: "▣", color: "#ffb13b" },
  webp: { label: "▣", color: "#a074c4" },
  pdf: { label: "PDF", color: "#e2574c" },
};

function fileBadgeFor(path: string): { label: string; color: string } {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return FILE_TYPE_BADGES[ext] ?? { label: "•", color: "#8a919e" };
}

/** Colored per-file-type icon for a change row. */
function FileIcon({ path }: { path: string }) {
  const badge = fileBadgeFor(path);
  return (
    <span
      className="dev-file-badge"
      style={{ color: badge.color, borderColor: badge.color }}
      aria-hidden="true"
    >
      {badge.label}
    </span>
  );
}

/** Repo path with the directory dimmed and the basename strong — long paths
 *  stay scannable (the reference design shows plain basenames; the dimmed
 *  directory keeps same-named files distinguishable). */
function FileNameLabel({ path }: { path: string }) {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (slash < 0) return <>{path}</>;
  return (
    <>
      <span className="dev-diff-file-dir">{path.slice(0, slash + 1)}</span>
      <span className="dev-diff-file-name">{path.slice(slash + 1)}</span>
    </>
  );
}

/** Strip a repo-root prefix off an externally supplied (usually absolute)
 *  file path so the backend's repo-relative path validation accepts it.
 *  Returns the input unchanged when it is already relative, no repo root is
 *  known, or the path lives outside the repo. Separator-insensitive on
 *  purpose — chat edit blocks and git status disagree on "/" vs "\\". */
function toRepoRelativePath(filePath: string, repoCwd: string | null | undefined): string {
  if (!repoCwd) return filePath;
  const isAbsolute =
    /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\") || filePath.startsWith("/");
  if (!isAbsolute) return filePath;
  // Normalize separators only for the comparison; lengths stay identical so
  // the slice below can operate on the original string.
  const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();
  const base = norm(repoCwd).replace(/\\+$/, "");
  const full = norm(filePath);
  if (!full.startsWith(base + "\\")) return filePath;
  return filePath.slice(base.length + 1).replace(/\\/g, "/");
}

function shortenCwd(cwd: string): string {
  if (cwd.length <= 48) return cwd;
  return "…" + cwd.slice(cwd.length - 47);
}
