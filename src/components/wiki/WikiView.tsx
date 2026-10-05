// Project wiki (§6.15) — the reading surface. A full overlay (like the Skills
// Library): page tree left, rendered page + evidence ledger right. Generation
// runs in the background (progress rides `wiki:build:progress` into the
// store); the same store feeds the tool-panel Wiki tab, so both surfaces stay
// in sync whichever is mounted.
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LazyReactMarkdown } from "../common/LazyMarkdown";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "../chat/MermaidDiagram";
import { toastError } from "../../lib/ipc";
import { ToolbarHeader } from "../common/ToolbarHeader";
import { BookOpen, Loader2, Plus, RefreshCw, Trash2, X } from "lucide-react";
import type { WikiClaim, WikiPage } from "../../lib/ipc/wiki";
import { useProjectsStore } from "../../state/projects";
import { ensureWikiProgressSubscription, useWikiStore } from "../../state/wiki";
import { WikiBuildFeed } from "./WikiBuildFeed";

// Hoisted to module scope on purpose. `react-markdown` v9 does not memoize
// its processor — it rebuilds the unified pipeline and re-runs the full
// micromark → mdast → hast → JSX conversion on every render, so passing fresh
// object/array literals inline re-parsed the ENTIRE page body on every build
// progress event (a 60-page build emits hundreds of them). The store's
// `progress` subscription re-rendered this component for each one.
const MARKDOWN_PLUGINS = [remarkGfm];
const MARKDOWN_COMPONENTS = {
  code: ({ className, children }: { className?: string; children?: unknown }) => {
    const text = String(children ?? "");
    if (className?.includes("language-mermaid")) {
      return <MermaidDiagram code={text} />;
    }
    return <code className={className}>{text}</code>;
  },
};

function ClaimRow({ claim }: { claim: WikiClaim }) {
  const lines =
    claim.lineStart != null
      ? claim.lineEnd != null && claim.lineEnd > claim.lineStart
        ? `:${claim.lineStart}-${claim.lineEnd}`
        : `:${claim.lineStart}`
      : "";
  const sha = claim.blobSha ? ` @${claim.blobSha.slice(0, 8)}` : "";
  return (
    <div className="wiki-claim-row">
      <span>{claim.claim}</span>
      <code className="mono">
        {claim.evidencePath}
        {lines}
        {sha}
      </code>
    </div>
  );
}

function PageRow({
  page,
  selected,
  onSelect,
}: {
  page: WikiPage;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`wiki-page-row${selected ? " selected" : ""}`}
      onClick={onSelect}
      data-testid={`wiki-page-${page.slug}`}
    >
      <span className="wiki-page-row-title">
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{page.title}</span>
        {page.status !== "fresh" && (
          <span className={`wiki-chip ${page.status}`}>{page.status}</span>
        )}
      </span>
    </button>
  );
}

export function WikiView() {
  const projects = useProjectsStore((s) => s.projects);
  const selectedProjectId = useProjectsStore((s) => s.selectedProjectId);

  const status = useWikiStore((s) => s.status);
  const statusLoading = useWikiStore((s) => s.statusLoading);
  const selectedSlug = useWikiStore((s) => s.selectedSlug);
  const pageDetail = useWikiStore((s) => s.pageDetail);
  const pageLoading = useWikiStore((s) => s.pageLoading);
  const progress = useWikiStore((s) => s.progress);
  const updating = useWikiStore((s) => s.updating);
  const updateNote = useWikiStore((s) => s.updateNote);
  const load = useWikiStore((s) => s.load);
  const select = useWikiStore((s) => s.select);
  const build = useWikiStore((s) => s.build);
  const update = useWikiStore((s) => s.update);
  const cancel = useWikiStore((s) => s.cancel);
  const remove = useWikiStore((s) => s.remove);
  // Which project's delete confirmation popover is open (single click on the
  // trash opens it — the old arm-then-click-again flow made the SECOND click
  // feel like a coin flip). Keyed by path so one row's popover doesn't belong
  // to another. `confirmPos` anchors the popover under that row's trash.
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [confirmPos, setConfirmPos] = useState<{ left: number; top: number } | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);
  // The row whose removal is in flight — `wiki_remove` + the reload round trip
  // takes a beat, and a dead-looking button invited extra clicks.
  const [removingPath, setRemovingPath] = useState<string | null>(null);
  // Close on OUTSIDE pointerdown or Escape — not on blur. An onBlur close
  // fires whenever focus moves anywhere (even the window losing focus), so
  // the old armed state silently evaporated between clicks. Focus changes are
  // irrelevant; only a press outside the popover and its row's trash (or
  // Escape) cancels.
  useEffect(() => {
    if (!confirmRemove) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (confirmRef.current?.contains(t)) return;
      const btn = t?.closest?.('[data-testid^="wiki-remove-"]');
      if (btn?.getAttribute("data-testid") === `wiki-remove-${confirmRemove}`) return;
      setConfirmRemove(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmRemove(null);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [confirmRemove]);
  const [addOpen, setAddOpen] = useState(false);
  const addBtnRef = useRef<HTMLButtonElement | null>(null);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);

  // The menu is PORTALED to <body>, like the model picker. The window caption
  // is itself a backdrop-filter surface, so a nested menu could only frost the
  // caption's own paint — it read as a flat opaque slab. Portaled, it frosts
  // the real page behind it (same glass as the composer card).
  useLayoutEffect(() => {
    if (!addOpen) {
      setMenuPos(null);
      return;
    }
    const measure = () => {
      const rect = addBtnRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = 260;
      // Right-align under the button, then clamp so it never leaves the window.
      const left = Math.min(
        Math.max(8, rect.right - width),
        window.innerWidth - width - 8,
      );
      const top = rect.bottom + 6;
      setMenuPos((prev) =>
        prev && prev.left === left && prev.top === top ? prev : { left, top },
      );
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [addOpen]);

  // Dismiss on outside click or Escape. The menu is portaled, so the button's
  // ref and the menu's own ref are checked separately — neither contains the
  // other in the DOM.
  useEffect(() => {
    if (!addOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (addBtnRef.current?.contains(t) || addMenuRef.current?.contains(t)) return;
      setAddOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAddOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [addOpen]);

  const viewProjectPath = useWikiStore((s) => s.viewProjectPath);
  const allSummaries = useWikiStore((s) => s.allSummaries);
  const openProject = useWikiStore((s) => s.openProject);
  const loadAll = useWikiStore((s) => s.loadAll);
  const loadedPath = useWikiStore((s) => s.loadedPath);
  const steps = useWikiStore((s) => s.steps);
  const project = useMemo(
    () =>
      projects.find((p) => p.path === viewProjectPath) ??
      projects.find((p) => p.id === selectedProjectId) ??
      null,
    [projects, viewProjectPath, selectedProjectId],
  );
  const root = project?.path ?? null;
  // The project whose pages are ACTUALLY on screen: `status`/`pages` belong
  // to `loadedPath`, while `root` can disagree (project fallback to the
  // sidebar selection after a wiki was deleted). Page clicks and the pages
  // rail label must follow the LOADED wiki — clicks keyed on `root` asked
  // the backend for a project that no longer existed and silently returned
  // null, leaving the reader stuck on "Select a page.".
  const statusProject = useMemo(
    () => projects.find((p) => p.path === loadedPath) ?? null,
    [projects, loadedPath],
  );
  // Display names always lead with a capital, whatever the folder is called.
  const cap = (n: string) => (n ? n.charAt(0).toUpperCase() + n.slice(1) : n);
  // Empty-state shelf: every project except the one already on offer via the
  // primary Build button.
  const otherProjects = useMemo(
    () => projects.filter((p) => p.path !== root),
    [projects, root],
  );

  useEffect(() => {
    ensureWikiProgressSubscription();
    void loadAll().catch(() => {});
  }, [loadAll]);

  useEffect(() => {
    if (root) void load(root).catch((e) => toastError("Failed to load the wiki", e));
  }, [root, load]);

  // Live events OR the status snapshot's registry check — either means a
  // job is in flight (app reload mid-build leaves the event store blank).
  // A STALE "running" progress whose registry slot is already gone (app
  // restart mid-build, a crashed task) is DEAD: without this reconciliation
  // the feed spun forever over a job that would never emit a terminal event.
  const jobDead =
    progress?.state === "running" &&
    status != null &&
    status.jobRunning === false &&
    (loadedPath === null || progress.path === loadedPath);
  const running =
    (progress?.state === "running" && !jobDead) || status?.jobRunning === true;
  const pages = status?.pages ?? [];

  // Build progress lives in the window TITLE BAR (see .wiki-titlebar-progress),
  // not at the foot of the view. The store keeps the terminal event in place
  // rather than nulling it, so the pill lingers briefly and fades out instead
  // of disappearing mid-transition — same as the model download indicator.
  const [pillVisible, setPillVisible] = useState(false);
  const [pillFading, setPillFading] = useState(false);
  useEffect(() => {
    if (progress?.state === "running" && !jobDead) {
      setPillVisible(true);
      setPillFading(false);
      return;
    }
    if (!pillVisible) return;
    const fade = setTimeout(() => setPillFading(true), 1200);
    const drop = setTimeout(() => setPillVisible(false), 1500);
    return () => {
      clearTimeout(fade);
      clearTimeout(drop);
    };
  }, [progress, pillVisible, jobDead]);
  const buildPct =
    progress && progress.pagesTotal > 0
      ? Math.min(100, Math.round((progress.pagesDone / progress.pagesTotal) * 100))
      : null;
  // A job the progress store can't see (double Build click racing the
  // registry guard, or an app reload mid-build) still has to show up here:
  // the status snapshot's `jobRunning` renders an INDETERMINATE pill instead
  // of a "Failed to start" toast for a build that is, in fact, running. Only
  // the no-events case: when a progress object exists (running or the kept
  // terminal one), the event-based pill logic above owns the pill.
  const snapshotRunning = status?.jobRunning === true && progress === null;
  // Pages are authored WITH their own `# Title` heading — rendering ours
  // above it doubled every page title.
  const bodyStartsWithH1 =
    pageDetail != null && /^\s*#\s+/.test(pageDetail.body);

  const onBuild = () => {
    if (!root) return;
    useWikiStore.getState().resetFeed();
    build(root).catch((e) => toastError("Failed to start the wiki build", e));
  };
  const onUpdate = () => {
    // Refresh the wiki the view is actually SHOWING (loadedPath owns
    // status/pages) — `root` can point at a different project after a
    // delete/switch, and the refresh would then no-op on a phantom wiki.
    const target = loadedPath ?? root;
    if (!target) return;
    update(target).catch((e) => toastError("Failed to update the wiki", e));
  };

  return (
    <div className="wiki-view" data-testid="wiki-view">
      {/* Header rides in the WINDOW TITLE BAR (portaled into the caption
          beside the window controls) — same as Automations. */}
      <ToolbarHeader>
      <header className="wiki-header">
        <div className="wiki-header-left" data-tauri-drag-region="">
          <BookOpen size={20} strokeWidth={1.8} />
          <h1>Project Wiki</h1>
        </div>
        {/* Icon-only controls at title-bar scale, same as the Automations
            header's refresh button. Every one carries a title + aria-label,
            and the destructive one arms on the first click rather than
            swapping to a text label (there is no room for one). */}
        <div className="wiki-header-actions">
          {/* Build progress rides the caption like model downloads do — spinner,
              phase label and a slim bar — instead of a panel at the foot of
              the view. When all we know is the registry's `jobRunning` (no
              events heard yet), the pill renders indeterminate: spinner +
              label, no percentage. */}
          {(progress ? pillVisible : snapshotRunning) ? (
            <span
              className={`wiki-titlebar-progress${pillFading && !snapshotRunning ? " is-fading" : ""}`}
              data-testid="wiki-titlebar-progress"
              role="status"
              title={
                progress?.step ||
                (snapshotRunning
                  ? "A wiki build or update is already running for this project"
                  : progress?.mode === "build"
                    ? "Building the wiki"
                    : "Updating the wiki")
              }
            >
              <span className="wiki-titlebar-spinner" aria-hidden="true" />
              <span className="wiki-titlebar-label">
                {progress
                  ? progress.mode === "build"
                    ? "Building wiki"
                    : "Updating wiki"
                  : "Building wiki"}
                {buildPct !== null ? ` ${buildPct}%` : ""}
              </span>
              {buildPct !== null && (
                <span className="wiki-titlebar-bar" aria-hidden="true">
                  <span className="wiki-titlebar-bar-fill" style={{ width: `${buildPct}%` }} />
                </span>
              )}
            </span>
          ) : null}
          {/* "Add" replaced "Build": the rails make the wiki a LIST you grow,
              so the title bar's job is adding a project to it. Clicking a
              project here either builds its wiki (first time) or jumps to the
              one it already has. */}
          <button
            type="button"
            ref={addBtnRef}
            onClick={() => setAddOpen((v) => !v)}
            disabled={running || updating}
            data-testid="wiki-add"
            aria-label="Add a project to the wiki"
            aria-expanded={addOpen}
            title={
              status && !status.hasModel
                ? "Pick a build model in Settings → Wiki first"
                : "Add a project — build a wiki on it"
            }
          >
            <Plus size={15} strokeWidth={1.8} />
          </button>
          {addOpen &&
            menuPos &&
            createPortal(
              <div
                className="wiki-add-menu"
                role="menu"
                aria-label="Add a project to the wiki"
                ref={addMenuRef}
                style={{ left: menuPos.left, top: menuPos.top }}
              >
                {projects.length === 0 ? (
                  <div className="wiki-add-menu-empty">
                    No projects yet — add one from the sidebar.
                  </div>
                ) : (
                  projects.map((p) => {
                    const sum = allSummaries.find((s) => s.path === p.path);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        role="menuitem"
                        className={`wiki-add-menu-item${p.path === root ? " is-current" : ""}`}
                        data-testid={`wiki-add-${p.path}`}
                        onClick={() => {
                          setAddOpen(false);
                          if (sum) {
                            void openProject(p.path).catch(() => {});
                            return;
                          }
                          useWikiStore.getState().resetFeed();
                          build(p.path).catch((e) =>
                            toastError("Failed to start the wiki build", e),
                          );
                        }}
                      >
                        <span className="wiki-add-menu-name">{cap(p.name)}</span>
                        <span className={`wiki-add-menu-state${sum ? " is-built" : ""}`}>
                          {sum ? `${sum.pageCount} pages` : "Build"}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>,
              document.body,
            )}
          {!running ? (
            <button
              type="button"
              onClick={onUpdate}
              disabled={!root || !status?.project || updating}
              data-testid="wiki-update"
              aria-label={updating ? "Updating" : "Update the wiki"}
              title="Update — refresh pages whose cited sources changed"
            >
              <RefreshCw
                size={15}
                strokeWidth={1.8}
                className={updating ? "wiki-spin" : undefined}
              />
            </button>
          ) : (
            <button
              type="button"
              onClick={() =>
                // Every other handler here attaches a catch; this one did not,
                // and `wiki_cancel` rejects outright when the project root is
                // unreadable (deleted folder) — the button just looked dead.
                root && void cancel(root).catch((e) => toastError("Failed to cancel the build", e))
              }
              data-testid="wiki-cancel"
              aria-label="Cancel the running job"
              title="Cancel the running job"
            >
              <X size={15} strokeWidth={1.8} />
            </button>
          )}
        </div>
      </header>
      </ToolbarHeader>

      {/* Two rails around the reader: projects on the LEFT (the single home
          for the project list — the sidebar row no longer nests one), and the
          SELECTED project's pages on the RIGHT. The page rail only exists
          once a project is selected, so the reader gets the full width while
          nothing is picked. */}
      <div className="wiki-body">
        <nav className="wiki-projects" aria-label="Wiki projects">
          <div className="wiki-rail-label">Projects</div>
          {allSummaries.length === 0 ? (
            <div className="wiki-rail-empty">No wiki built yet</div>
          ) : (
            allSummaries.map((sum) => {
              const name =
                projects.find((pr) => pr.path === sum.path)?.name ?? sum.path;
              const openConfirm = confirmRemove === sum.path;
              return (
                /* A div, not a button: the row holds a select button AND a
                   delete button, and a button cannot nest another one. */
                <div
                  key={sum.path}
                  className={`wiki-rail-project${sum.path === root ? " is-active" : ""}`}
                >
                  <button
                    type="button"
                    className="wiki-rail-project-main"
                    onClick={() => void openProject(sum.path).catch(() => {})}
                  >
                    <span className="wiki-rail-project-name">{cap(name)}</span>
                    <span className="wiki-rail-project-count">{sum.pageCount}</span>
                  </button>
                  {/* Hover-only, and it takes the page count's place on the
                      right of the row. ONE click opens the confirmation
                      popover (anchored under this row); the popover's Delete
                      button does the removing. */}
                  <button
                    type="button"
                    className={`wiki-rail-project-delete${removingPath === sum.path ? " is-removing" : ""}`}
                    data-testid={`wiki-remove-${sum.path}`}
                    disabled={removingPath === sum.path}
                    aria-label={
                      removingPath === sum.path
                        ? `Deleting the ${name} wiki`
                        : `Delete the ${name} wiki`
                    }
                    aria-expanded={openConfirm}
                    title={
                      removingPath === sum.path ? "Deleting…" : "Delete this wiki"
                    }
                    onClick={(e) => {
                      if (openConfirm) {
                        setConfirmRemove(null);
                        return;
                      }
                      // Anchor the popover under this row's trash, clamped to
                      // the window (same math as the Add menu).
                      const rect = e.currentTarget.getBoundingClientRect();
                      const width = 240;
                      const left = Math.min(
                        Math.max(8, rect.right - width),
                        window.innerWidth - width - 8,
                      );
                      const top = Math.min(
                        rect.bottom + 6,
                        window.innerHeight - 120,
                      );
                      setConfirmPos({ left, top });
                      setConfirmRemove(sum.path);
                    }}
                  >
                    {removingPath === sum.path ? (
                      <Loader2 size={13} strokeWidth={1.8} className="wiki-spin" />
                    ) : (
                      <Trash2 size={13} strokeWidth={1.8} />
                    )}
                  </button>
                </div>
              );
            })
          )}
        </nav>

        {confirmRemove &&
          confirmPos &&
          createPortal(
            <div
              className="wiki-confirm-menu"
              role="alertdialog"
              aria-label={`Delete the wiki for ${confirmRemove}?`}
              data-testid="wiki-confirm"
              ref={confirmRef}
              style={{ left: confirmPos.left, top: confirmPos.top }}
            >
              <div className="wiki-confirm-title">Delete this wiki?</div>
              <div className="wiki-confirm-note">
                Pages and their evidence ledgers are removed permanently.
              </div>
              <div className="wiki-confirm-actions">
                <button
                  type="button"
                  className="wiki-confirm-btn ghost"
                  data-testid="wiki-confirm-cancel"
                  onClick={() => setConfirmRemove(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="wiki-confirm-btn danger"
                  data-testid="wiki-confirm-delete"
                  disabled={removingPath === confirmRemove}
                  onClick={() => {
                    const path = confirmRemove;
                    setConfirmRemove(null);
                    setRemovingPath(path);
                    remove(path)
                      .catch((err) => toastError("Failed to remove the wiki", err))
                      .finally(() => setRemovingPath((p) => (p === path ? null : p)));
                  }}
                >
                  Delete
                </button>
              </div>
            </div>,
            document.body,
          )}

        {statusLoading ? (
          <div className="wiki-empty">
            <h2>Loading…</h2>
            <p>Reading the wiki for this project.</p>
          </div>
        ) : pages.length === 0 ? (
          <div className="wiki-empty">
            {/* A running build owns the heading; with OTHER wikis present the
                plain "No wiki yet" lied (three built wikis are listed right
                below), so name the project that lacks one. */}
            <h2>
              {running || snapshotRunning
                ? "Building the wiki…"
                : allSummaries.length > 0
                  ? `No wiki for ${cap(project?.name ?? "this project")} yet`
                  : "No wiki yet"}
            </h2>
            {!(running || snapshotRunning) && (
              <p>
                A build reads the repository (structure, key files, recent history), drafts an
                outline, then writes one page per subsystem — every claim grounded in the exact
                source lines it cites. Commits that touch cited files mark pages stale and
                regenerate just those.
              </p>
            )}
            <button
              type="button"
              className="primary"
              onClick={onBuild}
              // A build leaves `status.pages` empty until the terminal event
              // reloads it, so this button stayed live for the whole run and a
              // second click died on the Rust registry's "already running"
              // guard as a red toast.
              disabled={!root || !status?.hasModel || running || updating}
            >
              {project ? `Build a wiki for ${cap(project.name)}` : "Build the wiki"}
            </button>
            {status && !status.hasModel && (
              <p>No build model configured — pick one in Settings → Wiki.</p>
            )}
            {/* LIVE build feed: what phase we're in, which page is being
                written right now, per-page progress — the title-bar pill only
                had a percentage, so a build read as a silent "Building…" for
                minutes. Also covers the reload-mid-build snapshot. */}
            {(running || snapshotRunning) && (
              <WikiBuildFeed
                steps={steps}
                state={
                  jobDead
                    ? "error"
                    : progress?.state === "error"
                      ? "error"
                      : progress?.state === "cancelled"
                        ? "cancelled"
                        : "running"
                }
                phase={progress?.phase ?? "analysis"}
                mode={progress?.mode ?? "build"}
                pagesDone={progress?.pagesDone ?? 0}
                pagesTotal={progress?.pagesTotal ?? 0}
                onCancel={() => {
                  const target = loadedPath ?? root ?? progress?.path;
                  if (target) {
                    void cancel(target).catch((e) => toastError("Failed to cancel the build", e));
                  }
                }}
              />
            )}
            {!root && <p>Select a project first.</p>}
            {/* The rest of the shelf: every OTHER project one click away —
                click builds its wiki (or opens it when one exists). "No wiki
                yet" used to offer only THIS project's Build button, sending
                every other project through the Add-menu detour. */}
            {otherProjects.length > 0 && (
              <div className="wiki-empty-projects" data-testid="wiki-empty-projects">
                <div className="wiki-rail-label">Available projects</div>
                {otherProjects.map((p) => {
                  const sum = allSummaries.find((s) => s.path === p.path);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className="wiki-empty-project"
                      data-testid={`wiki-empty-build-${p.path}`}
                      disabled={running || updating}
                      title={
                        sum
                          ? `Open the wiki for ${p.name}`
                          : `Build a wiki for ${p.name}`
                      }
                      onClick={() => {
                        if (sum) {
                          void openProject(p.path).catch(() => {});
                          return;
                        }
                        useWikiStore.getState().resetFeed();
                        build(p.path).catch((e) =>
                          toastError("Failed to start the wiki build", e),
                        );
                      }}
                    >
                      <span className="wiki-empty-project-name">{cap(p.name)}</span>
                      <span className="wiki-empty-project-state">
                        {sum ? `${sum.pageCount} pages` : "Build"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <>
            {/* Rebuild over an existing wiki: the reader stays usable, so
                the live feed rides as a slim strip above it. */}
            {(running || snapshotRunning) && (
              <div className="wiki-reader-live">
                <WikiBuildFeed
                  compact
                  steps={steps}
                  state={
                    jobDead
                      ? "error"
                      : progress?.state === "error"
                        ? "error"
                        : progress?.state === "cancelled"
                          ? "cancelled"
                          : "running"
                  }
                  phase={progress?.phase ?? "analysis"}
                  mode={progress?.mode ?? "build"}
                  pagesDone={progress?.pagesDone ?? 0}
                  pagesTotal={progress?.pagesTotal ?? 0}
                  onCancel={() => {
                    const target = loadedPath ?? root ?? progress?.path;
                    if (target) {
                      void cancel(target).catch((e) =>
                        toastError("Failed to cancel the build", e),
                      );
                    }
                  }}
                />
              </div>
            )}
            <article className="wiki-reader" data-testid="wiki-reader">
            {pageDetail ? (
              <>
                {!bodyStartsWithH1 && <h1>{pageDetail.title}</h1>}
                {pageDetail.status === "stale" && (
                  <div className="wiki-stale-banner">
                    Stale — its cited sources changed: {pageDetail.staleReason ?? "unknown"}. Press
                    Update to regenerate.
                  </div>
                )}
                {pageLoading ? (
                  <div className="wiki-tab-empty">Loading…</div>
                ) : (
                  <LazyReactMarkdown
                    remarkPlugins={MARKDOWN_PLUGINS}
                    components={MARKDOWN_COMPONENTS}
                  >
                    {pageDetail.body}
                  </LazyReactMarkdown>
                )}
                {pageDetail.claims.length > 0 && (
                  <div className="wiki-claims" data-testid="wiki-claims">
                    <h3>Evidence ({pageDetail.claims.length})</h3>
                    {pageDetail.claims.map((claim, i) => (
                      <ClaimRow key={i} claim={claim} />
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="wiki-tab-empty">{pageLoading ? "Loading…" : "Select a page."}</div>
            )}
          </article>
          </>
        )}

        {loadedPath && pages.length > 0 && (
          <nav className="wiki-pages" aria-label="Wiki pages">
            <div className="wiki-rail-label">
              Pages{statusProject ? ` · ${cap(statusProject.name)}` : ""}
            </div>
            {pages.map((page) => (
              <PageRow
                key={page.slug}
                page={page}
                selected={page.slug === selectedSlug}
                onSelect={() =>
                  // Keyed on loadedPath — the project whose pages these
                  // actually are (see statusProject above): `root` can point
                  // at a different (even deleted) project, and every click
                  // then read as dead.
                  void select(loadedPath, page.slug).catch((e) =>
                    toastError("Failed to open the page", e),
                  )
                }
              />
            ))}
          </nav>
        )}
      </div>

      {/* Build progress moved to the title bar; only the transient update note
          still reports from the foot of the view. */}
      {updateNote && !progress && (
        <footer className="wiki-progress">
          <span>{updateNote}</span>
        </footer>
      )}
    </div>
  );
}
