// Branch panel — shows the current branch status (from the projects store's
// git polling) and serves as the host for the full branch switcher + git graph
// (Phase 2). In Phase 1 it displays the branch name, ahead/behind counts, and
// dirty status, with placeholder content for the switcher/search coming next.
import { useProjectsStore } from "../../state/projects";
import { useChatStore } from "../../state/chat";

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
          disabled
        />
        <button className="branch-panel-create" disabled title="Coming soon">
          + New
        </button>
      </div>
      <div className="tool-panel-empty" style={{ paddingTop: "20px" }}>
        <div>Branch list loading…</div>
        <div>The full branch switcher arrives in the next update.</div>
      </div>
    </div>
  );
}
