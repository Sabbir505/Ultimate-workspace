// Sidebar project entry: collapsible, git status badge (§7.11), session
// history, New Session control with harness picker (§4.2), and the project
// context menu (New Worktree §7.10, Project Settings §7.7/§7.16, etc.).
import { useEffect, useRef, useState } from "react";
import { createWorktree, listQuickActions } from "../../lib/ipc";
import { newSessionFlow, runQuickAction } from "../../lib/sessionLauncher";
import { useProjectsStore } from "../../state/projects";
import { useUiStore } from "../../state/ui";
import { GlassSelect } from "../common/GlassSelect";
import { Modal } from "../common/Modal";
import { SessionRow } from "./SessionRow";
import type { HarnessId, Project } from "../../types";
import { harnessShortName } from "../../types";

interface Props {
  project: Project;
}

export function ProjectItem({ project }: Props) {
  const expanded = useProjectsStore((s) => !!s.expanded[project.id]);
  const selected = useProjectsStore((s) => s.selectedProjectId === project.id);
  const gitStatus = useProjectsStore((s) => s.gitStatuses[project.id]);
  const sessions = useProjectsStore((s) => s.sessionsFor(project.id));
  const harnesses = useProjectsStore((s) => s.harnesses);
  const toggleExpanded = useProjectsStore((s) => s.toggleExpanded);
  const selectProject = useProjectsStore((s) => s.selectProject);
  const renameProjectById = useProjectsStore((s) => s.renameProjectById);
  const removeProjectById = useProjectsStore((s) => s.removeProjectById);
  const openPeek = useUiStore((s) => s.openPeek);
  const setProjectSettingsFor = useUiStore((s) => s.setProjectSettingsFor);
  const setModalOpen = useUiStore((s) => s.setModalOpen);

  const installed = harnesses.filter((h) => h.installed);
  const [harness, setHarness] = useState<HarnessId>("claude_code");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [worktreeOpen, setWorktreeOpen] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(project.name);
  const menuRef = useRef<HTMLDivElement>(null);

  // Sync worktree modal state into UI store so native webviews hide.
  useEffect(() => {
    setModalOpen(worktreeOpen);
    return () => { setModalOpen(false); };
  }, [worktreeOpen, setModalOpen]);

  useEffect(() => {
    if (installed.length === 1) setHarness(installed[0].id);
  }, [harnesses]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close context menu on any outside click.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  const doCreateWorktree = async () => {
    const branch = branchName.trim();
    if (!branch) return;
    setWorktreeOpen(false);
    setBranchName("");
    const path = await createWorktree(project.id, branch);
    if (!path) return;
    // §7.10: run quick actions flagged "run on worktree creation".
    const actions = (await listQuickActions(project.id)) ?? [];
    for (const action of actions.filter((a) => a.runOnWorktree)) {
      await runQuickAction(project.id, action.label, action.command);
    }
  };

  const commitRename = () => {
    const name = renameDraft.trim();
    if (name && name !== project.name) void renameProjectById(project.id, name);
    setRenaming(false);
  };

  return (
    <div>
      <div
        className={`project-row${selected ? " selected" : ""}`}
        onClick={() => {
          selectProject(project.id);
          toggleExpanded(project.id);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          selectProject(project.id);
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <span className="caret">{expanded ? "▾" : "▸"}</span>
        {renaming ? (
          <input
            autoFocus
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setRenaming(false);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="name">{project.name}</span>
        )}
        {gitStatus && gitStatus.isRepo && (
          <span className="git-badge" title={gitStatus.dirty ? "uncommitted changes" : "clean"}>
            <span>{gitStatus.branch ?? "?"}</span>
            <span className={`dirty-dot ${gitStatus.dirty ? "dirty" : "clean"}`} />
            {(gitStatus.ahead > 0 || gitStatus.behind > 0) && (
              <span>
                ↑{gitStatus.ahead}↓{gitStatus.behind}
              </span>
            )}
          </span>
        )}
      </div>

      {expanded && (
        <div className="session-list">
          {sessions.map((session) => (
            <SessionRow key={session.id} session={session} projectName={project.name} />
          ))}
          <div className="new-session-row">
            <GlassSelect<HarnessId>
              value={harness}
              title="Harness for the new session"
              className="new-session-select"
              options={(installed.length > 0
                ? installed
                : harnesses.length > 0
                  ? harnesses
                  : [{ id: "claude_code" as HarnessId, displayName: "Claude Code", installed: false }]
              ).map((h) => ({
                value: h.id,
                label: harnessShortName(h.id),
                hint: h.installed ? undefined : "not on PATH",
                disabled: installed.length > 0 && !h.installed,
              }))}
              onChange={(v) => setHarness(v)}
            />
            <button onClick={() => void newSessionFlow(project.id, harness)}>+ New Session</button>
          </div>
        </div>
      )}

      {menu && (
        <div
          className="context-menu"
          ref={menuRef}
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              setMenu(null);
              void newSessionFlow(project.id, harness);
            }}
          >
            New Session
          </button>
          <button
            onClick={() => {
              setMenu(null);
              setWorktreeOpen(true);
            }}
            disabled={!project.isGitRepo}
            title={project.isGitRepo ? "" : "Requires a git repository"}
          >
            New Worktree…
          </button>
          <button
            onClick={() => {
              setMenu(null);
              openPeek({ mode: "diff", projectId: project.id, filePath: null });
            }}
            disabled={!project.isGitRepo}
          >
            Peek Project Diff
          </button>
          <hr />
          <button
            onClick={() => {
              setMenu(null);
              setProjectSettingsFor(project.id);
            }}
          >
            Project Settings…
          </button>
          <button
            onClick={() => {
              setMenu(null);
              setRenameDraft(project.name);
              setRenaming(true);
            }}
          >
            Rename…
          </button>
          <button
            className="danger"
            onClick={() => {
              setMenu(null);
              void removeProjectById(project.id);
            }}
          >
            Remove Project
          </button>
        </div>
      )}

      {worktreeOpen && (
        <Modal
          title={`New worktree for ${project.name}`}
          onClose={() => setWorktreeOpen(false)}
          actions={
            <>
              <button onClick={() => setWorktreeOpen(false)}>Cancel</button>
              <button className="primary" onClick={() => void doCreateWorktree()} disabled={!branchName.trim()}>
                Create
              </button>
            </>
          }
        >
          <p>Creates a git worktree in a sibling folder with a new branch.</p>
          <input
            autoFocus
            placeholder="branch-name"
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void doCreateWorktree();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
