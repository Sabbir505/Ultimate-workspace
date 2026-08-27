// Branch panel — the tool-panel "Git Graph" tab (opened from the branch
// dropdown's footer action). Shows the current branch's status badges on
// top and the recent-commits graph table below.
//
// Data: the log comes from the backend on mount and refreshes on the FS
// watcher event, so a `git checkout` typed in a terminal updates the panel
// without a manual reload. Branch switching lives in the branch dropdown
// (git sidebar / composer pill) — this tab is a read-only view.
import { useCallback, useEffect, useState } from "react";
import { getGitLog, safeListen, type GitLogEntry } from "../../lib/ipc";
import { useProjectsStore } from "../../state/projects";
import { useChatStore } from "../../state/chat";

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

  // Resolve the active project (chat-bound project wins over global selection).
  const projectId =
    (activeChatSessionId && sessionProjects[activeChatSessionId]) ||
    selectedProjectId;
  const project = projects.find((p) => p.id === projectId);
  const status = projectId ? gitStatuses[projectId] : undefined;
  const path = project?.path ?? null;

  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchLog = useCallback(async () => {
    if (!path) return;
    const lg = await getGitLog(path);
    setLog(lg ?? []);
    setError(null);
    setLoading(false);
  }, [path]);

  useEffect(() => {
    setLoading(true);
    void fetchLog();
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void safeListen<string>("project:fs-changed", (changedPath) => {
      if (
        path &&
        (changedPath === path ||
          changedPath.startsWith(path + "\\") ||
          changedPath.startsWith(path + "/"))
      ) {
        void fetchLog();
      }
    }).then((u) => {
      if (!cancelled) unlisten = u;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [fetchLog, path]);

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

      {error && (
        <div className="branch-panel-error" role="alert">
          {error}
        </div>
      )}

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
    </div>
  );
}
