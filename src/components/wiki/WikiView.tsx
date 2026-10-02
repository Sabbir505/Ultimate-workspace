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
import { BookOpen, Plus, RefreshCw, Trash2, X } from "lucide-react";
import type { WikiClaim, WikiPage } from "../../lib/ipc/wiki";
import { useProjectsStore } from "../../state/projects";
import { ensureWikiProgressSubscription, useWikiStore } from "../../state/wiki";

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
  // Which project's delete is armed (clicked once, awaiting the second).
  // Keyed by path so arming one row doesn't arm another.
  const [armedRemove, setArmedRemove] = useState<string | null>(null);
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
  const project = useMemo(
    () =>
      projects.find((p) => p.path === viewProjectPath) ??
      projects.find((p) => p.id === selectedProjectId) ??
      null,
    [projects, viewProjectPath, selectedProjectId],
  );
  const root = project?.path ?? null;

  useEffect(() => {
    ensureWikiProgressSubscription();
    void loadAll().catch(() => {});
  }, [loadAll]);

  useEffect(() => {
    if (root) void load(root).catch((e) => toastError("Failed to load the wiki", e));
  }, [root, load]);

  // Live events OR the status snapshot's registry check — either means a
  // job is in flight (app reload mid-build leaves the event store blank).
  const running = progress?.state === "running" || status?.jobRunning === true;
  const pages = status?.pages ?? [];

  // Build progress lives in the window TITLE BAR (see .wiki-titlebar-progress),
  // not at the foot of the view. The store keeps the terminal event in place
  // rather than nulling it, so the pill lingers briefly and fades out instead
  // of disappearing mid-transition — same as the model download indicator.
  const [pillVisible, setPillVisible] = useState(false);
  const [pillFading, setPillFading] = useState(false);
  useEffect(() => {
    if (progress?.state === "running") {
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
  }, [progress, pillVisible]);
  const buildPct =
    progress && progress.pagesTotal > 0
      ? Math.min(100, Math.round((progress.pagesDone / progress.pagesTotal) * 100))
      : null;
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
    if (!root) return;
    update(root).catch((e) => toastError("Failed to update the wiki", e));
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
              the view. */}
          {pillVisible && progress && (
            <span
              className={`wiki-titlebar-progress${pillFading ? " is-fading" : ""}`}
              data-testid="wiki-titlebar-progress"
              role="status"
              title={
                progress.step ||
                (progress.mode === "build" ? "Building the wiki" : "Updating the wiki")
              }
            >
              <span className="wiki-titlebar-spinner" aria-hidden="true" />
              <span className="wiki-titlebar-label">
                {progress.mode === "build" ? "Building wiki" : "Updating wiki"}
                {buildPct !== null ? ` ${buildPct}%` : ""}
              </span>
              {buildPct !== null && (
                <span className="wiki-titlebar-bar" aria-hidden="true">
                  <span className="wiki-titlebar-bar-fill" style={{ width: `${buildPct}%` }} />
                </span>
              )}
            </span>
          )}
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
                        <span className="wiki-add-menu-name">{p.name}</span>
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
              const armed = armedRemove === sum.path;
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
                    <span className="wiki-rail-project-name">{name}</span>
                    <span className="wiki-rail-project-count">{sum.pageCount}</span>
                  </button>
                  {/* Hover-only, and it takes the page count's place on the
                      right of the row. First click arms; second deletes. */}
                  <button
                    type="button"
                    className={`wiki-rail-project-delete${armed ? " is-armed" : ""}`}
                    data-testid={`wiki-remove-${sum.path}`}
                    aria-label={`Delete the ${name} wiki`}
                    title={armed ? "Click again to permanently delete" : "Delete this wiki"}
                    onClick={() => {
                      if (armed) {
                        setArmedRemove(null);
                        remove(sum.path).catch((e) => toastError("Failed to remove the wiki", e));
                      } else {
                        setArmedRemove(sum.path);
                      }
                    }}
                    onBlur={() => setArmedRemove(null)}
                  >
                    <Trash2 size={13} strokeWidth={1.8} />
                  </button>
                </div>
              );
            })
          )}
        </nav>

        {statusLoading ? (
          <div className="wiki-empty">
            <h2>Loading…</h2>
            <p>Reading the wiki for this project.</p>
          </div>
        ) : pages.length === 0 ? (
          <div className="wiki-empty">
            <h2>No wiki yet</h2>
            <p>
              A build reads the repository (structure, key files, recent history), drafts an
              outline, then writes one page per subsystem — every claim grounded in the exact
              source lines it cites. Commits that touch cited files mark pages stale and
              regenerate just those.
            </p>
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
              Build the wiki
            </button>
            {status && !status.hasModel && (
              <p>No build model configured — pick one in Settings → Wiki.</p>
            )}
            {running && <p>A build is already running for this project.</p>}
            {!root && <p>Select a project first.</p>}
          </div>
        ) : (
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
        )}

        {root && pages.length > 0 && (
          <nav className="wiki-pages" aria-label="Wiki pages">
            <div className="wiki-rail-label">
              Pages{project ? ` · ${project.name}` : ""}
            </div>
            {pages.map((page) => (
              <PageRow
                key={page.slug}
                page={page}
                selected={page.slug === selectedSlug}
                onSelect={() =>
                  root && void select(root, page.slug).catch((e) => toastError("Failed to open the page", e))
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
