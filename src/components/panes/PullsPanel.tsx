// Pulls tab: list / create / review GitHub pull requests for the selected
// (or chat-bound) project, backed by the GitHub connector's OAuth token.
// Three views in one panel: the PR list (default), a detail+review view, and
// the create form. Pure pull-model — refresh on mount + every 30s while the
// list is visible.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  githubCreatePr,
  githubDraftPrText,
  githubLocalBranches,
  githubSubmitReview,
  gitPush,
  toastError,
  toastSuccess,
  type BranchOption,
  type PullRequestSummary,
} from "../../lib/ipc";
import { openInBrowserPane } from "../../lib/openBrowserPane";
import { useChatStore } from "../../state/chat";
import { useProjectsStore } from "../../state/projects";
import { prListCacheKey, usePullRequestsStore, type PrListState } from "../../state/pullRequests";
import { relativeTime } from "../../lib/relativeTime";

type View = { kind: "list" } | { kind: "detail"; number: number } | { kind: "create" };

function toEpoch(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

const STATE_LABEL: Record<PrListState, string> = {
  open: "Open",
  closed: "Closed",
  all: "All",
};

export function PullsPanel() {
  const projects = useProjectsStore((s) => s.projects);
  const selectedProjectId = useProjectsStore((s) => s.selectedProjectId);
  const gitStatuses = useProjectsStore((s) => s.gitStatuses);
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);
  const sessionProjects = useChatStore((s) => s.sessionProjects);
  const projectId =
    (activeChatSessionId ? sessionProjects[activeChatSessionId] : undefined) ?? selectedProjectId;
  const project = projects.find((p) => p.id === projectId);
  const gitStatus = projectId ? gitStatuses[projectId] : undefined;

  const [view, setView] = useState<View>({ kind: "list" });

  if (!project || !projectId) {
    return (
      <div className="pulls-empty">
        <div className="pulls-empty-title">No project selected</div>
        <div className="pulls-empty-hint">Select a project to see its pull requests.</div>
      </div>
    );
  }
  if (!gitStatus?.isRepo) {
    return (
      <div className="pulls-empty">
        <div className="pulls-empty-title">Not a git repository</div>
        <div className="pulls-empty-hint">{project.name} has no .git — PRs need a GitHub-backed repo.</div>
      </div>
    );
  }

  return (
    <div className="pulls-panel">
      {view.kind === "list" && (
        <PrList
          projectId={projectId}
          currentBranch={gitStatus.branch ?? ""}
          onOpen={(number) => setView({ kind: "detail", number })}
          onCreate={() => setView({ kind: "create" })}
        />
      )}
      {view.kind === "detail" && (
        <PrDetailView
          projectId={projectId}
          number={view.number}
          onBack={() => setView({ kind: "list" })}
        />
      )}
      {view.kind === "create" && (
        <PrCreateForm
          projectId={projectId}
          chatSessionId={activeChatSessionId}
          currentBranch={gitStatus.branch ?? ""}
          onCancel={() => setView({ kind: "list" })}
          onCreated={() => setView({ kind: "list" })}
        />
      )}
    </div>
  );
}

// ---- List view ----

function PrList({
  projectId,
  currentBranch,
  onOpen,
  onCreate,
}: {
  projectId: string;
  currentBranch: string;
  onOpen: (number: number) => void;
  onCreate: () => void;
}) {
  const [stateFilter, setStateFilter] = useState<PrListState>("open");
  const [filterOpen, setFilterOpen] = useState(false);
  const filterWrapRef = useRef<HTMLDivElement>(null);
  const cacheKey = prListCacheKey(projectId, stateFilter);
  const list = usePullRequestsStore((s) => s.lists[cacheKey]);
  const error = usePullRequestsStore((s) => s.listErrors[cacheKey]);
  const loading = usePullRequestsStore((s) => (s.listLoading[cacheKey] ?? 0) > 0);
  const refreshList = usePullRequestsStore((s) => s.refreshList);

  const refresh = useCallback(() => void refreshList(projectId, stateFilter), [projectId, stateFilter, refreshList]);
  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  // Close the scope menu on any outside click / Escape.
  useEffect(() => {
    if (!filterOpen) return;
    const close = (e: MouseEvent) => {
      if (filterWrapRef.current && !filterWrapRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFilterOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [filterOpen]);

  return (
    <>
      <div className="pulls-toolbar">
        {/* Custom glass dropdown (same liquid-glass menu as the composer) —
            the native <select> popup couldn't be styled. */}
        <div className="dev-diff-filter-wrap" ref={filterWrapRef}>
          <button
            type="button"
            className="dev-diff-filter-btn"
            onClick={() => setFilterOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={filterOpen}
            aria-label="Filter by state"
          >
            {STATE_LABEL[stateFilter]}
            <svg width={11} height={11} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="4 6 8 10 12 6" />
            </svg>
          </button>
          {filterOpen && (
            <div className="dev-diff-filter-menu" role="menu">
              {(["open", "closed", "all"] as const).map((k) => (
                <button
                  key={k}
                  role="menuitem"
                  className={`dev-diff-filter-item${stateFilter === k ? " active" : ""}`}
                  onClick={() => {
                    setStateFilter(k);
                    setFilterOpen(false);
                  }}
                >
                  <span className="dev-diff-filter-check">{stateFilter === k ? "✓" : ""}</span>
                  {STATE_LABEL[k]}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="pulls-toolbar-spacer" />
        <button type="button" className="ghost pulls-refresh" onClick={refresh} title="Refresh" disabled={loading}>
          {loading ? <span className="pulls-spinner" aria-hidden="true" /> : "⟳"}
        </button>
        <button
          type="button"
          className="primary pulls-new"
          onClick={onCreate}
          disabled={!currentBranch}
          title={currentBranch ? `Create a PR from ${currentBranch}` : "No current branch"}
        >
          New PR
        </button>
      </div>
      {error && !list ? (
        <div className="pulls-empty">
          <div className="pulls-empty-title">Couldn't load pull requests</div>
          <div className="pulls-empty-hint">{error}</div>
        </div>
      ) : !list ? (
        <div className="pulls-empty">
          <span className="pulls-spinner" aria-hidden="true" />
          <div className="pulls-empty-hint">Loading…</div>
        </div>
      ) : list.length === 0 ? (
        <div className="pulls-empty">
          <div className="pulls-empty-title">No {stateFilter} pull requests</div>
          <div className="pulls-empty-hint">Push a branch and hit New PR to start one.</div>
        </div>
      ) : (
        <div className="pulls-list">
          {list.map((pr) => (
            <PrRow key={pr.number} pr={pr} onOpen={() => onOpen(pr.number)} />
          ))}
        </div>
      )}
    </>
  );
}

function PrRow({ pr, onOpen }: { pr: PullRequestSummary; onOpen: () => void }) {
  return (
    <button type="button" className="pulls-row" onClick={onOpen}>
      <span className="pulls-row-num">#{pr.number}</span>
      <span className="pulls-row-main">
        <span className="pulls-row-title">{pr.title}</span>
        <span className="pulls-row-meta">
          {pr.headBranch} → {pr.baseBranch} · {pr.author} · {relativeTime(toEpoch(pr.updatedAt))}
        </span>
      </span>
      {pr.draft && <span className="pulls-chip">Draft</span>}
      {pr.state !== "open" && <span className="pulls-chip closed">{pr.state}</span>}
    </button>
  );
}

// ---- Detail + review view ----

function PrDetailView({
  projectId,
  number,
  onBack,
}: {
  projectId: string;
  number: number;
  onBack: () => void;
}) {
  const bundle = usePullRequestsStore((s) => s.details[projectId]?.[number]);
  const error = usePullRequestsStore((s) => s.detailErrors[projectId]?.[number]);
  const loadDetail = usePullRequestsStore((s) => s.loadDetail);
  const refreshList = usePullRequestsStore((s) => s.refreshList);

  const [reviewBody, setReviewBody] = useState("");
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void loadDetail(projectId, number);
  }, [projectId, number, loadDetail]);

  const submitReview = async (event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES") => {
    setSubmitting(event);
    try {
      await githubSubmitReview(projectId, number, event, reviewBody);
      toastSuccess(
        event === "APPROVE"
          ? "PR approved"
          : event === "REQUEST_CHANGES"
            ? "Changes requested"
            : "Review comment posted",
      );
      setReviewBody("");
      void loadDetail(projectId, number);
      void refreshList(projectId);
    } catch (err) {
      toastError(String(err));
    } finally {
      setSubmitting(null);
    }
  };

  if (error && !bundle) {
    return (
      <div className="pulls-empty">
        <button type="button" className="ghost" onClick={onBack}>← Back</button>
        <div className="pulls-empty-title">Couldn't load PR #{number}</div>
        <div className="pulls-empty-hint">{error}</div>
      </div>
    );
  }
  if (!bundle) {
    return <div className="pulls-empty"><div className="pulls-empty-hint">Loading PR #{number}…</div></div>;
  }
  const { detail, files, checks } = bundle;
  const canApprove = submitting === null; // approve allows empty body
  const canCommentOrRequest = submitting === null && reviewBody.trim() !== "";

  return (
    <div className="pulls-detail">
      <div className="pulls-detail-header">
        <button type="button" className="ghost" onClick={onBack} aria-label="Back to list">
          ←
        </button>
        <div className="pulls-detail-title-wrap">
          <span className="pulls-detail-title">
            #{detail.number} {detail.title}
          </span>
          <span className="pulls-detail-meta">
            {detail.headBranch} → {detail.baseBranch} · {detail.author} ·{" "}
            <span className="pulls-stat-add">+{detail.additions}</span>{" "}
            <span className="pulls-stat-del">−{detail.deletions}</span> · {detail.changedFiles} files
          </span>
        </div>
        {checks && checks.state !== "none" && (
          <span className={`pulls-checks ${checks.state}`} title={`${checks.total} checks, ${checks.failing} failing, ${checks.pending} pending`}>
            {checks.state === "success" ? "✓" : checks.state === "failure" ? "✗" : "…"} {checks.total}
          </span>
        )}
        <button
          type="button"
          className="ghost"
          title="Open on GitHub"
          onClick={() => openInBrowserPane(detail.htmlUrl)}
        >
          ↗
        </button>
      </div>

      <div className="pulls-detail-scroll">
        {detail.body && <pre className="pulls-body">{detail.body}</pre>}

        <div className="pulls-files">
          {files.map((f) => {
            const open = expandedFiles[f.path] ?? false;
            return (
              <div key={f.path} className="pulls-file">
                <button
                  type="button"
                  className="pulls-file-head"
                  onClick={() => setExpandedFiles((m) => ({ ...m, [f.path]: !open }))}
                >
                  <span className={`pulls-file-status ${f.status}`}>{f.status[0]?.toUpperCase()}</span>
                  <span className="pulls-file-path">
                    {f.previousPath ? `${f.previousPath} → ` : ""}{f.path}
                  </span>
                  <span className="pulls-file-stats">
                    <span className="pulls-stat-add">+{f.additions}</span>{" "}
                    <span className="pulls-stat-del">−{f.deletions}</span>
                  </span>
                  <span className="pulls-file-chevron">{open ? "▾" : "▸"}</span>
                </button>
                {open && f.patch && <pre className="pulls-patch">{f.patch}</pre>}
                {open && !f.patch && <div className="pulls-patch-none">Binary or deleted file — no inline patch.</div>}
              </div>
            );
          })}
        </div>

        <div className="pulls-review">
          <textarea
            className="pulls-review-body"
            placeholder="Review comment (required for Comment / Request changes)…"
            value={reviewBody}
            onChange={(e) => setReviewBody(e.target.value)}
            rows={3}
            disabled={submitting !== null}
          />
          <div className="pulls-review-actions">
            <button
              type="button"
              className="primary pulls-approve"
              disabled={!canApprove}
              onClick={() => void submitReview("APPROVE")}
              title="Approve (body optional)"
            >
              {submitting === "APPROVE" ? "…" : "Approve"}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={!canCommentOrRequest}
              onClick={() => void submitReview("COMMENT")}
              title="Post a comment review (body required)"
            >
              {submitting === "COMMENT" ? "…" : "Comment"}
            </button>
            <button
              type="button"
              className="ghost pulls-request-changes"
              disabled={!canCommentOrRequest}
              onClick={() => void submitReview("REQUEST_CHANGES")}
              title="Request changes (body required)"
            >
              {submitting === "REQUEST_CHANGES" ? "…" : "Request changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Create form ----

function PrCreateForm({
  projectId,
  chatSessionId,
  currentBranch,
  onCancel,
  onCreated,
}: {
  projectId: string;
  chatSessionId: string | null;
  currentBranch: string;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [branches, setBranches] = useState<BranchOption[] | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [head, setHead] = useState(currentBranch);
  const [base, setBase] = useState("main");
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState<"draft" | "push" | "create" | null>(null);
  const gitStatus = useProjectsStore((s) => s.gitStatuses[projectId]);
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const refreshList = usePullRequestsStore((s) => s.refreshList);

  useEffect(() => {
    githubLocalBranches(projectId)
      .then((bs) => {
        setBranches(bs);
        // Default base: main or master if present.
        const names = bs.map((b) => b.name);
        if (names.includes("main")) setBase("main");
        else if (names.includes("master")) setBase("master");
      })
      .catch(() => setBranches([]));
  }, [projectId]);

  // Unpushed-commits heuristic: ahead of upstream → offer push first.
  const unpushed = (gitStatus?.ahead ?? 0) > 0;

  const draftWithAgent = async () => {
    if (!chatSessionId) {
      toastError("Open a chat session to draft with the agent");
      return;
    }
    setBusy("draft");
    try {
      const d = await githubDraftPrText(projectId, base, chatSessionId);
      if (!d) {
        toastError("Couldn't draft — no diff vs base or no model configured");
      } else {
        setTitle(d.title);
        setBody(d.body);
      }
    } catch (err) {
      toastError(String(err));
    } finally {
      setBusy(null);
    }
  };

  const pushBranch = async () => {
    if (!project) return;
    setBusy("push");
    try {
      await gitPush(project.path);
      toastSuccess("Branch pushed");
    } catch (err) {
      toastError(String(err));
      return;
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    setBusy("create");
    try {
      const pr = await githubCreatePr(projectId, title.trim(), body, head, base, draft);
      toastSuccess(`PR #${pr.number} created`);
      void refreshList(projectId);
      onCreated();
    } catch (err) {
      toastError(String(err));
    } finally {
      setBusy(null);
    }
  };

  const valid = title.trim() !== "" && head !== "" && base !== "" && head !== base;
  const localBranches = useMemo(() => (branches ?? []).filter((b) => !b.isRemote), [branches]);

  return (
    <div className="pulls-create">
      <div className="pulls-create-header">
        <span className="pulls-detail-title">New pull request</span>
        <div className="pulls-toolbar-spacer" />
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
      </div>

      <label className="pulls-field">
        <span>Title</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="feat: add the thing"
          disabled={busy !== null}
        />
      </label>

      <div className="pulls-branches">
        <label className="pulls-field">
          <span>Head (changes)</span>
          <select value={head} onChange={(e) => setHead(e.target.value)} disabled={busy !== null}>
            {head && !localBranches.some((b) => b.name === head) && <option value={head}>{head}</option>}
            {localBranches.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}{b.isCurrent ? " (current)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="pulls-field">
          <span>Base (target)</span>
          <select value={base} onChange={(e) => setBase(e.target.value)} disabled={busy !== null}>
            {localBranches.map((b) => (
              <option key={b.name} value={b.name}>{b.name}</option>
            ))}
            {!localBranches.some((b) => b.name === base) && <option value={base}>{base}</option>}
          </select>
        </label>
      </div>

      {unpushed && (
        <div className="pulls-unpushed">
          <span>{gitStatus?.ahead} unpushed commit(s) on {currentBranch} — GitHub can't see them yet.</span>
          <button type="button" className="ghost" onClick={() => void pushBranch()} disabled={busy !== null}>
            {busy === "push" ? "Pushing…" : "Push now"}
          </button>
        </div>
      )}

      <label className="pulls-field">
        <span>Description</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          placeholder="What & why, notable changes, test plan…"
          disabled={busy !== null}
        />
      </label>

      <label className="pulls-draft-check">
        <input
          type="checkbox"
          checked={draft}
          onChange={(e) => setDraft(e.target.checked)}
          disabled={busy !== null}
        />
        <span>Create as draft</span>
      </label>

      <div className="pulls-create-actions">
        <button
          type="button"
          className="ghost"
          onClick={() => void draftWithAgent()}
          disabled={busy !== null || !chatSessionId}
          title={chatSessionId ? "Draft title + description from the branch diff" : "Open a chat session to enable"}
        >
          {busy === "draft" ? "Drafting…" : "✨ Draft with agent"}
        </button>
        <div className="pulls-toolbar-spacer" />
        <button
          type="button"
          className="primary"
          onClick={() => void create()}
          disabled={!valid || busy !== null}
          title={!valid ? "Title required; head and base must differ" : "Create the PR on GitHub"}
        >
          {busy === "create" ? "Creating…" : draft ? "Create draft PR" : "Create PR"}
        </button>
      </div>
    </div>
  );
}
