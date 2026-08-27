// Branch panel — the tool-panel "Git Graph" tab (opened from the branch
// dropdown's footer action). Shows the current branch status badge row,
// a searchable branch list with click-to-checkout (dirty changes warn
// first via the shared modal), and the recent-commits log graph.
//
// Data: branches + log come from the backend on mount and refresh on the
// FS watcher event, so a `git checkout` typed in a terminal updates the
// panel without a manual reload.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listGitBranches,
  checkoutGitBranch,
  getGitLog,
  getChangedFiles,
  safeListen,
  type BranchInfo,
  type GitLogEntry,
  type ChangedFile,
} from "../../lib/ipc";
import { useProjectsStore } from "../../state/projects";
import { useChatStore } from "../../state/chat";
import { Modal } from "../common/Modal";

/** Split a git decoration string ("HEAD -> master, origin/master") into the
 *  chip list shown above the description: "HEAD -> x" yields both HEAD and x,
 *  matching how GitLens/VS Code render decorations. */
function refChips(refs: string): string[] {
  const chips: string[] = [];
  for (const part of refs.split(",")) {
    const p = part.trim();
    if (!p) continue;
    if (p.includes("->")) {
      for (const half of p.split("->")) {
        const h = half.trim();
        if (h) chips.push(h);
      }
    } else {
      chips.push(p);
    }
  }
  return chips;
}

/** "2026-08-27 19:46:00 +06:00" → "08/27, 07:46 PM". Slices the %ci string
 *  instead of Date-parsing it — WebView date parsing of the space-separated
 *  form is inconsistent across platforms. */
function shortDate(date: string): string {
  if (!date || date.length < 16) return date;
  const month = date.slice(5, 7);
  const day = date.slice(8, 10);
  let hh = parseInt(date.slice(11, 13), 10);
  const mm = date.slice(14, 16);
  if (!Number.isFinite(hh)) return date;
  const ampm = hh >= 12 ? "PM" : "AM";
  hh = hh % 12 || 12;
  return `${month}/${day}, ${String(hh).padStart(2, "0")}:${mm} ${ampm}`;
}

export function BranchPanel() {
  const projects = useProjectsStore((s) => s.projects);
  const selectedProjectId = useProjectsStore((s) => s.selectedProjectId);
  const sessionProjects = useChatStore((s) => s.sessionProjects);
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);
  const gitStatuses = useProjectsStore((s) => s.gitStatuses);
  const refreshGitStatus = useProjectsStore((s) => s.refreshGitStatus);

  // Resolve the active project (chat-bound project wins over global selection).
  const projectId =
    (activeChatSessionId && sessionProjects[activeChatSessionId]) ||
    selectedProjectId;
  const project = projects.find((p) => p.id === projectId);
  const status = projectId ? gitStatuses[projectId] : undefined;
  const path = project?.path ?? null;

  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  // Branch pending checkout while uncommitted changes exist — the modal
  // asks for confirmation before discarding them.
  const [dirtyCheckout, setDirtyCheckout] = useState<string | null>(null);
  const [dirtyFiles, setDirtyFiles] = useState<ChangedFile[]>([]);

  const fetchAll = useCallback(async () => {
    if (!path) return;
    const [bl, lg] = await Promise.all([
      listGitBranches(path),
      getGitLog(path),
    ]);
    setBranches(bl ?? []);
    setLog(lg ?? []);
    setError(null);
    setLoading(false);
  }, [path]);

  useEffect(() => {
    setLoading(true);
    void fetchAll();
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void safeListen<string>("project:fs-changed", (changedPath) => {
      if (
        path &&
        (changedPath === path ||
          changedPath.startsWith(path + "\\") ||
          changedPath.startsWith(path + "/"))
      ) {
        void fetchAll();
      }
    }).then((u) => {
      if (!cancelled) unlisten = u;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [fetchAll, path]);

  const filtered = useMemo(() => {
    if (!query.trim()) return branches;
    const q = query.toLowerCase();
    return branches.filter((b) => b.name.toLowerCase().includes(q));
  }, [branches, query]);

  const performCheckout = async (name: string) => {
    if (!path) return;
    setBusy(name);
    try {
      await checkoutGitBranch(path, name);
      await fetchAll();
      void refreshGitStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleCheckout = async (name: string) => {
    if (!path) return;
    try {
      const files = await getChangedFiles(path);
      if (files && files.length > 0) {
        setDirtyCheckout(name);
        setDirtyFiles(files);
        return;
      }
    } catch {
      // getChangedFiles failed (e.g. not a git repo) — proceed anyway.
    }
    await performCheckout(name);
  };

  if (!project) {
    return (
      <div className="tool-panel-empty">
        <div>No project</div>
        <div>Select a project to view its branches.</div>
      </div>
    );
  }

  if (!status?.isRepo) {
    return (
      <div className="tool-panel-empty">
        <div>Not a git repo</div>
        <div>{project.name} is not a git repository.</div>
      </div>
    );
  }

  return (
    <div className="branch-panel">
      <div className="branch-panel-current">
        <span className="branch-panel-branch-icon" />
        <span className="branch-panel-branch-name">{status.branch ?? "HEAD"}</span>
        <div className="branch-panel-badges">
          {status.dirty && <span className="branch-badge dirty">modified</span>}
          {status.ahead > 0 && (
            <span className="branch-badge ahead">↑{status.ahead}</span>
          )}
          {status.behind > 0 && (
            <span className="branch-badge behind">↓{status.behind}</span>
          )}
        </div>
      </div>

      <div className="branch-panel-search-wrap">
        <input
          type="text"
          className="branch-panel-search"
          placeholder="Search branches…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {error && (
        <div className="branch-panel-error" role="alert">
          {error}
        </div>
      )}

      <div className="branch-panel-list">
        {loading ? (
          <div className="tool-panel-empty">
            <div>Loading branches…</div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="tool-panel-empty">
            <div>No branches found</div>
            <div>{query ? `Nothing matches “${query}”.` : "This repo has no branches yet."}</div>
          </div>
        ) : (
          filtered.map((b) => (
            <button
              key={b.name}
              className={`branch-panel-row${b.isCurrent ? " current" : ""}`}
              onClick={() => void handleCheckout(b.name)}
              disabled={b.isCurrent || busy === b.name}
              title={b.lastCommitMessage}
            >
              <span className="branch-panel-row-marker">
                {b.isCurrent ? "●" : ""}
              </span>
              <span className="branch-panel-row-name">{b.name}</span>
              {b.isRemote && <span className="branch-badge dirty">remote</span>}
              {busy === b.name && <span className="branch-badge dirty">switching…</span>}
            </button>
          ))
        )}
      </div>

      {log.length > 0 ? (
        <div className="commit-graph">
          {/* Column headers — Graph / Description / Date / Author / Commit */}
          <div className="commit-graph-head" aria-hidden="true">
            <span>Graph</span>
            <span>Description</span>
            <span>Date</span>
            <span>Author</span>
            <span>Commit</span>
          </div>
          <div className="commit-graph-body">
            {log.map((e, i) => {
              const isHead = e.refs.includes("HEAD");
              return (
                <div key={`${e.sha}-${i}`} className={`commit-graph-row${isHead ? " head" : ""}`}>
                  {/* Graph rail: vertical line + node dot, drawn in CSS. */}
                  <span className="commit-graph-cell-rail" />
                  <span className="commit-graph-cell-desc">
                    {e.refs && (
                      <span className="commit-graph-refs">
                        {refChips(e.refs).map((chip) => (
                          <span
                            key={chip}
                            className={`commit-graph-ref${chip === "HEAD" ? " head" : ""}`}
                          >
                            {chip}
                          </span>
                        ))}
                      </span>
                    )}
                    <span className="commit-graph-msg" title={e.message}>
                      {e.message}
                    </span>
                  </span>
                  <span className="commit-graph-cell-date">{shortDate(e.date)}</span>
                  <span className="commit-graph-cell-author">{e.author}</span>
                  <span className="commit-graph-cell-sha">{e.sha}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        !loading && (
          <div className="tool-panel-empty">
            <div>No commits yet</div>
            <div>This repository has no commits to graph.</div>
          </div>
        )
      )}

      {/* Dirty checkout confirm — switching would discard uncommitted files. */}
      {dirtyCheckout && (
        <Modal
          title="Uncommitted Changes"
          onClose={() => { setDirtyCheckout(null); setDirtyFiles([]); }}
          actions={
            <div style={{ display: "flex", gap: 8 }}>
              <button className="primary" onClick={() => {
                const name = dirtyCheckout;
                setDirtyCheckout(null);
                setDirtyFiles([]);
                void performCheckout(name);
              }}>
                Switch anyway
              </button>
              <button onClick={() => { setDirtyCheckout(null); setDirtyFiles([]); }}>
                Cancel
              </button>
            </div>
          }
        >
          <p style={{ marginBottom: 12 }}>
            Switching to <strong>{dirtyCheckout}</strong> will discard
            uncommitted changes in {dirtyFiles.length}{" "}
            {dirtyFiles.length === 1 ? "file" : "files"}:
          </p>
          <div style={{ maxHeight: 200, overflow: "auto", marginBottom: 8 }}>
            {dirtyFiles.map((f) => (
              <div
                key={f.path}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "4px 0",
                  borderBottom: "1px solid var(--border)",
                  fontSize: 13,
                }}
              >
                <span style={{ color: f.added > 0 ? "#4caf7d" : "var(--text-dim)" }}>
                  +{f.added}
                </span>
                <span style={{ color: f.deleted > 0 ? "#ff6b6b" : "var(--text-dim)" }}>
                  -{f.deleted}
                </span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {f.path}
                </span>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
