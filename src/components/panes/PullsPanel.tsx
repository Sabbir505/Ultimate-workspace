// Pulls tab: list / create / review GitHub pull requests (and issues) for the
// selected (or chat-bound) project, backed by the GitHub connector's OAuth
// token. Three surfaces in one panel: the list (default), a detail+review
// view with Conversation/Files tabs, and the create form. Pure pull-model —
// refresh on mount + every 30s while the list is visible.
//
// Panel chrome state (surface tab + both state filters) lives at THIS level
// and mirrors into PANEL_UI, so it survives the detail-view round-trip and
// tool-tab switches — going back from a PR must not reset "Closed" to "Open".
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleCheck, CircleDot, GitMerge, GitPullRequest } from "lucide-react";
import {
  githubAddIssueComment,
  githubCreateIssue,
  githubCreatePr,
  githubDraftPrText,
  githubGetIssue,
  githubListIssueComments,
  githubListIssues,
  githubLocalBranches,
  githubSetIssueState,
  githubSubmitReview,
  gitPush,
  toastError,
  toastSuccess,
  type BranchOption,
  type GitHubIssueComment,
  type GitHubIssueDetail,
  type GitHubIssueSummary,
  type PullRequestSummary,
} from "../../lib/ipc";
import { openInBrowserPane } from "../../lib/openBrowserPane";
import { parseUnifiedDiff } from "../../lib/diff";
import { useDiffHighlightRows } from "../../hooks/useDiffHighlight";
import { useChatStore } from "../../state/chat";
import { useProjectsStore } from "../../state/projects";
import { prListCacheKey, usePullRequestsStore, type PrListState } from "../../state/pullRequests";
import { useUiStore } from "../../state/ui";
import { listAutomationTemplates } from "../../lib/ipc";
import { relativeTime } from "../../lib/relativeTime";

type View =
  | { kind: "list" }
  | { kind: "detail"; number: number }
  | { kind: "create" }
  | { kind: "issue"; number: number }
  | { kind: "newIssue" };

/** Session-persisted panel chrome — see the file header. */
const PANEL_UI: {
  surface: "prs" | "issues";
  prFilter: PrListState;
  issueFilter: "open" | "closed" | "all";
} = { surface: "prs", prFilter: "open", issueFilter: "open" };

/** Test hook: PANEL_UI outlives individual renders, so a suite that touches
 *  one test's filter would leak it into the next — reset alongside the store. */
export function _resetPullsPanelUiForTests() {
  PANEL_UI.surface = "prs";
  PANEL_UI.prFilter = "open";
  PANEL_UI.issueFilter = "open";
}

function toEpoch(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

const STATE_LABEL: Record<PrListState, string> = {
  open: "Open",
  closed: "Closed",
  all: "All",
};

const ISSUE_STATE_LABEL: Record<"open" | "closed" | "all", string> = {
  open: "Open",
  closed: "Closed",
  all: "All",
};

// ---- State glyphs (the row/status rail) ----
// Green open, purple merged, red closed, dim draft — the same four realities
// a review can be in, carried by one glyph so color alone never has to speak.

type PrStateKind = "open" | "merged" | "closed" | "draft";

function prStateOf(pr: Pick<PullRequestSummary, "draft" | "merged" | "state">): PrStateKind {
  if (pr.draft) return "draft";
  if (pr.state !== "open") return pr.merged ? "merged" : "closed";
  return "open";
}

function PrStateGlyph({ kind, size = 13 }: { kind: PrStateKind; size?: number }) {
  if (kind === "merged") return <GitMerge size={size} strokeWidth={2} aria-hidden="true" />;
  return <GitPullRequest size={size} strokeWidth={2} aria-hidden="true" />;
}

/** Segmented pill — the panel's only filter/switch control. */
function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { key: T; text: string }[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="pulls-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          className={`pulls-seg-item${value === o.key ? " active" : ""}`}
          aria-pressed={value === o.key}
          onClick={() => onChange(o.key)}
        >
          {o.text}
        </button>
      ))}
    </div>
  );
}

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
  const [surface, setSurface] = useState<"prs" | "issues">(PANEL_UI.surface);
  const [prFilter, setPrFilter] = useState<PrListState>(PANEL_UI.prFilter);
  const [issueFilter, setIssueFilter] = useState<"open" | "closed" | "all">(PANEL_UI.issueFilter);

  useEffect(() => {
    PANEL_UI.surface = surface;
    PANEL_UI.prFilter = prFilter;
    PANEL_UI.issueFilter = issueFilter;
  }, [surface, prFilter, issueFilter]);

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
        <div className="pulls-surfacebar">
          <Segmented
            label="Pull requests or issues"
            options={[
              { key: "prs", text: "Pull requests" },
              { key: "issues", text: "Issues" },
            ]}
            value={surface}
            onChange={(k) => {
              setSurface(k);
              setView({ kind: "list" });
            }}
          />
        </div>
      )}
      {surface === "prs" && view.kind === "list" && (
        <PrList
          projectId={projectId}
          currentBranch={gitStatus.branch ?? ""}
          filter={prFilter}
          onFilter={setPrFilter}
          onOpen={(number) => setView({ kind: "detail", number })}
          onCreate={() => setView({ kind: "create" })}
        />
      )}
      {surface === "issues" && view.kind === "list" && (
        <IssueList
          projectId={projectId}
          filter={issueFilter}
          onFilter={setIssueFilter}
          onOpen={(number) => setView({ kind: "issue", number })}
          onCreate={() => setView({ kind: "newIssue" })}
        />
      )}
      {view.kind === "issue" && (
        <IssueDetailView
          projectId={projectId}
          number={view.number}
          onBack={() => setView({ kind: "list" })}
        />
      )}
      {view.kind === "newIssue" && (
        <NewIssueForm
          projectId={projectId}
          onCancel={() => setView({ kind: "list" })}
          onCreated={(n) => setView({ kind: "issue", number: n })}
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
  filter,
  onFilter,
  onOpen,
  onCreate,
}: {
  projectId: string;
  currentBranch: string;
  filter: PrListState;
  onFilter: (next: PrListState) => void;
  onOpen: (number: number) => void;
  onCreate: () => void;
}) {
  const cacheKey = prListCacheKey(projectId, filter);
  const list = usePullRequestsStore((s) => s.lists[cacheKey]);
  const error = usePullRequestsStore((s) => s.listErrors[cacheKey]);
  const loading = usePullRequestsStore((s) => (s.listLoading[cacheKey] ?? 0) > 0);
  const refreshList = usePullRequestsStore((s) => s.refreshList);

  const refresh = useCallback(() => void refreshList(projectId, filter), [projectId, filter, refreshList]);
  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  // Packaged PR review bot (§4.2.7): hand the template to the Automations
  // form via the same pendingArtifactFormData channel the chat proposal
  // cards use, then jump to the Automations view. The user still picks the
  // project folder and confirms — templates prefill, they don't create.
  const setPendingArtifactFormData = useUiStore((s) => s.setPendingArtifactFormData);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const createReviewBot = useCallback(async () => {
    try {
      const templates = await listAutomationTemplates();
      const t = templates.find((x) => x.id === "pr-review-bot");
      if (!t) return;
      setPendingArtifactFormData({
        artifactType: "automation",
        spec: {
          name: t.name,
          prompt: t.prompt,
          harness: t.harness,
          model: t.model ?? undefined,
          trigger: { schedule: t.schedule },
        },
      });
      setActiveView("automations");
    } catch {
      // Templates are a convenience — never block the PR list on them.
    }
  }, [setPendingArtifactFormData, setActiveView]);

  return (
    <>
      <div className="pulls-toolbar">
        <Segmented
          label="Filter by state"
          options={(["open", "closed", "all"] as const).map((k) => ({ key: k, text: STATE_LABEL[k] }))}
          value={filter}
          onChange={onFilter}
        />
        <div className="pulls-toolbar-spacer" />
        {list && list.length > 0 && (
          <span className="pulls-count" title="Pull requests shown (GitHub caps a page at 50)">
            {list.length} shown
          </span>
        )}
        <button type="button" className="ghost pulls-refresh" onClick={refresh} title="Refresh" disabled={loading}>
          {loading ? <span className="pulls-spinner" aria-hidden="true" /> : "⟳"}
        </button>
        <button
          type="button"
          className="ghost pulls-refresh"
          onClick={() => void createReviewBot()}
          title="Schedule an automated PR review bot for this repo (Automations)"
        >
          Review bot
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
          <span className="pulls-empty-icon" aria-hidden="true">
            <GitPullRequest size={22} strokeWidth={1.5} />
          </span>
          <div className="pulls-empty-title">No {filter} pull requests</div>
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
  const kind = prStateOf(pr);
  return (
    <button type="button" className="pulls-row" onClick={onOpen} aria-label={`PR #${pr.number}: ${pr.title}`}>
      <span className={`pulls-row-icon ${kind}`}>
        <PrStateGlyph kind={kind} />
      </span>
      <span className="pulls-row-main">
        <span className="pulls-row-title">{pr.title}</span>
        <span className="pulls-row-meta">
          <span className="pulls-row-num">#{pr.number}</span>
          <span className="pulls-branch">{pr.headBranch}</span>
          <span className="pulls-meta-sep" aria-hidden="true">→</span>
          <span className="pulls-branch">{pr.baseBranch}</span>
          <span className="pulls-meta-sep">·</span>
          <span>{pr.author}</span>
          <span className="pulls-meta-sep">·</span>
          <span>{relativeTime(toEpoch(pr.updatedAt))}</span>
        </span>
      </span>
      {pr.draft && <span className="pulls-chip">Draft</span>}
      <span className="pulls-row-chevron" aria-hidden="true">›</span>
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

  const [tab, setTab] = useState<"conversation" | "files">("conversation");
  const [reviewBody, setReviewBody] = useState("");
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void loadDetail(projectId, number);
  }, [projectId, number, loadDetail]);

  // Each PR opens on its conversation; a stale files-expansion from the last
  // viewed PR must not leak into this one.
  useEffect(() => {
    setTab("conversation");
    setExpandedFiles({});
  }, [projectId, number]);

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
  const kind = prStateOf(detail);
  const canApprove = submitting === null; // approve allows empty body
  const canCommentOrRequest = submitting === null && reviewBody.trim() !== "";
  const fileAdds = files.reduce((n, f) => n + f.additions, 0);
  const fileDels = files.reduce((n, f) => n + f.deletions, 0);

  return (
    <div className="pulls-detail">
      <div className="pulls-detail-header">
        <div className="pulls-detail-top">
          <button type="button" className="ghost" onClick={onBack} aria-label="Back to list">
            ←
          </button>
          <span className={`pulls-state ${kind}`}>
            <PrStateGlyph kind={kind} size={11} />
            {kind === "draft" ? "Draft" : kind}
          </span>
          <span className="pulls-detail-title">
            #{detail.number} {detail.title}
          </span>
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
        <div className="pulls-detail-meta">
          <span className="pulls-branch">{detail.headBranch}</span>
          <span className="pulls-meta-sep" aria-hidden="true">→</span>
          <span className="pulls-branch">{detail.baseBranch}</span>
          <span className="pulls-meta-sep">·</span>
          <span>{detail.author}</span>
          <span className="pulls-meta-sep">·</span>
          <span>opened {relativeTime(toEpoch(detail.createdAt))}</span>
          <span className="pulls-meta-sep">·</span>
          <span className="pulls-stat-add">+{detail.additions}</span>
          <span className="pulls-stat-del">−{detail.deletions}</span>
          <span className="pulls-meta-sep">·</span>
          <span>{detail.changedFiles} files</span>
          {detail.mergeable === false && <span className="pulls-conflicts">Conflicts</span>}
        </div>
      </div>

      <div className="pulls-tabs" role="tablist" aria-label="PR sections">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "conversation"}
          className={`pulls-tab${tab === "conversation" ? " active" : ""}`}
          onClick={() => setTab("conversation")}
        >
          Conversation
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "files"}
          className={`pulls-tab${tab === "files" ? " active" : ""}`}
          onClick={() => setTab("files")}
        >
          Files <span className="pulls-tab-count">{detail.changedFiles}</span>
        </button>
      </div>

      <div className="pulls-detail-scroll">
        {tab === "conversation" ? (
          <>
            {detail.body ? <MdBody text={detail.body} /> : <div className="pulls-nobody">No description.</div>}
            <div className="pulls-review">
              <span className="pulls-review-label">Your review</span>
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
          </>
        ) : (
          <>
            <div className="pulls-files-summary">
              {files.length} files
              <span className="pulls-meta-sep">·</span>
              <span className="pulls-stat-add">+{fileAdds}</span>
              <span className="pulls-stat-del">−{fileDels}</span>
            </div>
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
                    {open && f.patch && <PullsPatch path={f.path} patch={f.patch} />}
                    {open && !f.patch && <div className="pulls-patch-none">Binary or deleted file — no inline patch.</div>}
                  </div>
                );
              })}
            </div>
          </>
        )}
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

// ---- Issues surface (SS4.4.6) ----

function IssueList({
  projectId,
  filter,
  onFilter,
  onOpen,
  onCreate,
}: {
  projectId: string;
  filter: "open" | "closed" | "all";
  onFilter: (next: "open" | "closed" | "all") => void;
  onOpen: (number: number) => void;
  onCreate: () => void;
}) {
  const issues = useIssueList(projectId, filter);

  return (
    <>
      <div className="pulls-toolbar">
        <Segmented
          label="Filter by state"
          options={(["open", "closed", "all"] as const).map((k) => ({ key: k, text: ISSUE_STATE_LABEL[k] }))}
          value={filter}
          onChange={onFilter}
        />
        <div className="pulls-toolbar-spacer" />
        {issues.list && issues.list.length > 0 && (
          <span className="pulls-count" title="Issues shown (GitHub caps a page at 50)">
            {issues.list.length} shown
          </span>
        )}
        <button type="button" className="ghost pulls-refresh" onClick={() => void issues.refresh()} title="Refresh" disabled={issues.loading}>
          {issues.loading ? <span className="pulls-spinner" aria-hidden="true" /> : "⟳"}
        </button>
        <button type="button" className="primary pulls-new" onClick={onCreate}>
          New issue
        </button>
      </div>
      {issues.error && !issues.list ? (
        <div className="pulls-empty">
          <div className="pulls-empty-title">Couldn't load issues</div>
          <div className="pulls-empty-hint">{issues.error}</div>
        </div>
      ) : !issues.list ? (
        <div className="pulls-empty">
          <span className="pulls-spinner" aria-hidden="true" />
          <div className="pulls-empty-hint">Loading...</div>
        </div>
      ) : issues.list.length === 0 ? (
        <div className="pulls-empty">
          <span className="pulls-empty-icon" aria-hidden="true">
            <CircleDot size={22} strokeWidth={1.5} />
          </span>
          <div className="pulls-empty-title">No {filter} issues</div>
          <div className="pulls-empty-hint">Hit New issue to file the first one.</div>
        </div>
      ) : (
        <div className="pulls-list">
          {issues.list.map((issue) => {
            const open = issue.state === "open";
            return (
              <button
                key={issue.number}
                type="button"
                className="pulls-row"
                onClick={() => onOpen(issue.number)}
                aria-label={`Issue #${issue.number}: ${issue.title}`}
              >
                <span className={`pulls-row-icon ${open ? "open" : "done"}`}>
                  {open ? <CircleDot size={13} strokeWidth={2} aria-hidden="true" /> : <CircleCheck size={13} strokeWidth={2} aria-hidden="true" />}
                </span>
                <span className="pulls-row-main">
                  <span className="pulls-row-title">{issue.title}</span>
                  <span className="pulls-row-meta">
                    <span className="pulls-row-num">#{issue.number}</span>
                    <span className="pulls-meta-sep">·</span>
                    <span>{issue.author}</span>
                    <span className="pulls-meta-sep">·</span>
                    <span>{relativeTime(toEpoch(issue.updatedAt))}</span>
                    {issue.comments > 0 && (
                      <>
                        <span className="pulls-meta-sep">·</span>
                        <span>{issue.comments} comment{issue.comments === 1 ? "" : "s"}</span>
                      </>
                    )}
                    {issue.labels.slice(0, 2).map((l) => (
                      <span key={l} className="pulls-label">{l}</span>
                    ))}
                  </span>
                </span>
                <span className="pulls-row-chevron" aria-hidden="true">›</span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

/** Issue list fetch with the stale-response guard (audit H33): switching the
 *  state filter re-creates `refresh` and re-arms the interval, but the
 *  PREVIOUS filter's in-flight request had no cancellation — resolving last
 *  it painted open-issue rows under the "Closed" label (and cleared any
 *  error). Self-healed only at the next 30s tick. */
function useIssueList(projectId: string, state: "open" | "closed" | "all") {
  const [list, setList] = useState<GitHubIssueSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const refreshSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    const stale = () => seq !== refreshSeqRef.current;
    setLoading(true);
    try {
      const next = await githubListIssues(projectId, state);
      if (stale()) return;
      setList(next);
      setError(null);
    } catch (err) {
      if (stale()) return;
      setError(String(err));
    } finally {
      if (!stale()) setLoading(false);
    }
  }, [projectId, state]);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 30_000);
    // Invalidate any in-flight response from the PREVIOUS filter.
    return () => {
      window.clearInterval(t);
      refreshSeqRef.current += 1;
    };
  }, [refresh]);

  return { list, error, loading, refresh };
}

function IssueDetailView({ projectId, number, onBack }: { projectId: string; number: number; onBack: () => void }) {
  const [issue, setIssue] = useState<GitHubIssueDetail | null>(null);
  const [comments, setComments] = useState<GitHubIssueComment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, c] = await Promise.all([githubGetIssue(projectId, number), githubListIssueComments(projectId, number)]);
      setIssue(d);
      setComments(c);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [projectId, number]);

  useEffect(() => {
    void load();
  }, [load]);

  const postComment = async () => {
    if (!comment.trim()) return;
    setBusy("comment");
    try {
      await githubAddIssueComment(projectId, number, comment.trim());
      setComment("");
      await load();
      toastSuccess("Comment posted");
    } catch (err) {
      toastError(String(err));
    } finally {
      setBusy(null);
    }
  };

  const toggleState = async () => {
    if (!issue) return;
    setBusy("state");
    try {
      const next = issue.state === "open" ? "closed" : "open";
      const updated = await githubSetIssueState(projectId, number, next);
      setIssue({ ...issue, ...updated });
    } catch (err) {
      toastError(String(err));
    } finally {
      setBusy(null);
    }
  };

  if (error && !issue) {
    return (
      <div className="pulls-empty">
        <div className="pulls-empty-title">Couldn't load issue</div>
        <div className="pulls-empty-hint">{error}</div>
        <button type="button" className="ghost" onClick={onBack}>Back</button>
      </div>
    );
  }
  if (!issue) {
    return (
      <div className="pulls-empty">
        <span className="pulls-spinner" aria-hidden="true" />
        <div className="pulls-empty-hint">Loading...</div>
      </div>
    );
  }
  const open = issue.state === "open";
  return (
    <div className="pulls-detail">
      <div className="pulls-detail-header">
        <div className="pulls-detail-top">
          <button type="button" className="ghost" onClick={onBack} aria-label="Back to list">←</button>
          <span className={`pulls-state ${open ? "open" : "done"}`}>
            {open ? <CircleDot size={11} strokeWidth={2} aria-hidden="true" /> : <CircleCheck size={11} strokeWidth={2} aria-hidden="true" />}
            {open ? "Open" : "Closed"}
          </span>
          <span className="pulls-detail-title">#{issue.number} {issue.title}</span>
          <button
            type="button"
            className="ghost"
            title="Open on GitHub"
            onClick={() => openInBrowserPane(issue.htmlUrl)}
          >
            ↗
          </button>
        </div>
        <div className="pulls-detail-meta">
          <span>{issue.author}</span>
          <span className="pulls-meta-sep">·</span>
          <span>opened {relativeTime(toEpoch(issue.createdAt))}</span>
          {issue.labels.map((l) => (
            <span key={l} className="pulls-label">{l}</span>
          ))}
          <div className="pulls-toolbar-spacer" />
          <button type="button" className="ghost" disabled={busy === "state"} onClick={() => void toggleState()}>
            {issue.state === "open" ? "Close issue" : "Reopen"}
          </button>
        </div>
      </div>
      <div className="pulls-detail-scroll">
        {issue.body ? <MdBody text={issue.body} /> : <div className="pulls-nobody">No description.</div>}
        <div className="pulls-detail-comments">
          {comments.map((c) => (
            <div key={c.id} className="pulls-comment">
              <div className="pulls-comment-head">
                <span className="pulls-comment-author">{c.author}</span>
                <span>{relativeTime(toEpoch(c.createdAt))}</span>
              </div>
              <MdBody text={c.body} />
            </div>
          ))}
        </div>
        <div className="pulls-review">
          <span className="pulls-review-label">Add a comment</span>
          <textarea
            rows={3}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Write a comment..."
          />
          <div className="pulls-review-actions">
            <div className="pulls-toolbar-spacer" />
            <button type="button" className="primary" disabled={!comment.trim() || busy === "comment"} onClick={() => void postComment()}>
              {busy === "comment" ? "Posting..." : "Comment"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function NewIssueForm({
  projectId,
  onCancel,
  onCreated,
}: {
  projectId: string;
  onCancel: () => void;
  onCreated: (number: number) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [creating, setCreating] = useState(false);

  const create = async () => {
    setCreating(true);
    try {
      const issue = await githubCreateIssue(projectId, title.trim(), body);
      toastSuccess(`Issue #${issue.number} created`);
      onCreated(issue.number);
    } catch (err) {
      toastError(String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="pulls-create">
      <div className="pulls-create-header">
        <button type="button" className="ghost" onClick={onCancel}>←</button>
        <span className="pulls-detail-title">New issue</span>
      </div>
      <input
        className="pulls-create-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title"
        autoFocus
      />
      <textarea
        rows={8}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Describe the problem or request (markdown supported by GitHub)"
      />
      <div className="pulls-create-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary" disabled={!title.trim() || creating} onClick={() => void create()}>
          {creating ? "Creating..." : "Create issue"}
        </button>
      </div>
    </div>
  );
}

// PR/issue bodies are GitHub markdown. They render through the same document
// pipeline as the .md artifact preview (MarkdownDoc), loaded lazily so the
// remark/KaTeX/Prism chunk only downloads when a body is actually opened —
// PullsPanel itself is part of the eagerly-loaded tool panel. Until the chunk
// lands, the raw text shows in the same box (no layout shift on upgrade).
const MarkdownDocument = lazy(() =>
  import("../chat/MarkdownDoc").then((m) => ({ default: m.MarkdownDocument })),
);

function MdBody({ text }: { text: string }) {
  return (
    <div className="pulls-md chat-markdown artifact-preview-md" dir="auto">
      <Suspense fallback={<pre className="pulls-md-fallback">{text}</pre>}>
        <MarkdownDocument text={text} />
      </Suspense>
    </div>
  );
}

// GitHub's per-file `patch` field starts at the `@@` hunk header with no
// `diff --git` preamble — parseUnifiedDiff keys a file off that header, so a
// synthetic one (from the file path we already have) opens the parse. Rows
// are then syntax-highlighted IDE-style by the shared diff highlighter
// (useDiffHighlightRows — the same one the Changes panel renders through).
function PullsPatch({ path, patch }: { path: string; patch: string }) {
  const lines = useMemo(() => {
    const files = parseUnifiedDiff(`diff --git a/${path} b/${path}\n${patch}`);
    return files.flatMap((file) => file.lines.filter((l) => l.type !== "meta"));
  }, [path, patch]);

  const htmlByRow = useDiffHighlightRows(lines, path);

  return (
    <div className="pulls-patch">
      {lines.map((line, j) => {
        const prefix =
          line.type === "add" ? "+ " : line.type === "del" ? "- " : line.type === "hunk" ? "" : "  ";
        const html = htmlByRow?.[j] ?? null;
        return (
          <div key={j} className={`diff-line ${line.type}`}>
            <span className="diff-line-gutter diff-line-gutter-old">{line.oldLine ?? ""}</span>
            <span className="diff-line-gutter diff-line-gutter-new">{line.newLine ?? ""}</span>
            <span className="diff-line-content">
              {prefix}
              {html !== null ? (
                // Serializer output is fully escaped source text — safe.
                <span dangerouslySetInnerHTML={{ __html: html }} />
              ) : (
                line.text
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
