// A popover dropdown showing the repo's branches with search, create, and a
// compact git log graph. Used by both the composer's GitHub pill and the
// top-right git menu — both just render <BranchDropdown /> inside their own
// positioning wrapper.
//
// Fetches branches + log from the backend on open, with a 5s refresh. The
// active project path is resolved from the projects store (chat-bound project
// wins over global selection).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  listGitBranches,
  checkoutGitBranch,
  createGitBranch,
  getGitLog,
  getChangedFiles,
  safeListen,
  type ChangedFile,
  type BranchInfo,
  type GitLogEntry,
} from "../../lib/ipc";
import { useProjectsStore } from "../../state/projects";
import { useChatStore } from "../../state/chat";
import { useUiStore } from "../../state/ui";
import { Modal } from "../common/Modal";

export function BranchDropdown({ onClose }: { onClose?: () => void }) {
  const boundProjectId = useChatStore((s) =>
    s.activeChatSessionId ? s.sessionProjects[s.activeChatSessionId] : undefined,
  );
  const selectedProjectId = useProjectsStore((s) => s.selectedProjectId);
  const projects = useProjectsStore((s) => s.projects);
  const refreshGitStatus = useProjectsStore((s) => s.refreshGitStatus);

  const projectId = boundProjectId ?? selectedProjectId;
  const project = projects.find((p) => p.id === projectId);
  const path = project?.path ?? null;

  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  // Branch name pending checkout — set when there are uncommitted changes and
  // the user hasn't confirmed yet. null = no pending dirty checkout.
  const [dirtyCheckout, setDirtyCheckout] = useState<string | null>(null);
  // Files that would be left behind by the branch switch.
  const [dirtyFiles, setDirtyFiles] = useState<ChangedFile[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

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
    // Subscribe to the FS watcher event so the branch list and recent
    // commits refresh on actual changes (e.g. `git checkout` from the
    // terminal, an agent doing `git pull`, etc). The backend debounces
    // to 300 ms so a burst of FS events from one git op becomes one
    // refresh, not a thundering herd.
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

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    if (!query.trim()) return branches;
    const q = query.toLowerCase();
    return branches.filter((b) => b.name.toLowerCase().includes(q));
  }, [branches, query]);

  const localBranches = filtered.filter((b) => !b.isRemote);
  const remoteBranches = filtered.filter((b) => b.isRemote);

  // Shared checkout logic — performs the actual git checkout, then refreshes.
  const performCheckout = async (name: string) => {
    setBusy(name);
    try {
      await checkoutGitBranch(path!, name);
      await fetchAll();
      void refreshGitStatus();
      if (onClose) onClose();
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

  const handleCreate = async () => {
    if (!path || !newName.trim()) return;
    try {
      const files = await getChangedFiles(path);
      if (files && files.length > 0) {
        setDirtyCheckout("__create__");
        return;
      }
    } catch {
      // getChangedFiles failed — proceed anyway.
    }
    setBusy("__create__");
    try {
      await createGitBranch(path, newName.trim());
      setNewName("");
      setCreating(false);
      await fetchAll();
      void refreshGitStatus();
      if (onClose) onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  // Confirm a dirty checkout: the user acknowledged the warning.
  const confirmDirtyCheckout = async () => {
    if (!dirtyCheckout) return;
    const name = dirtyCheckout;
    setDirtyCheckout(null);
    if (name === "__create__") {
      // Retry the create flow (skip the dirty check this time).
      if (!path || !newName.trim()) return;
      setBusy("__create__");
      try {
        await createGitBranch(path, newName.trim());
        setNewName("");
        setCreating(false);
        await fetchAll();
        void refreshGitStatus();
        if (onClose) onClose();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
      return;
    }
    await performCheckout(name);
  };

  if (!path) {
    return <div className="branch-dropdown-empty">No project selected.</div>;
  }

  return (
    <>
    <div className="branch-dropdown" onClick={(e) => e.stopPropagation()}>
      <div className="branch-dropdown-header">
        <span className="branch-dropdown-title">Branches</span>
        <button
          className="branch-dropdown-create-btn"
          onClick={() => setCreating((c) => !c)}
          title="Create new branch"
        >
          + New
        </button>
      </div>

      {creating && (
        <div className="branch-dropdown-create-row">
          <input
            className="branch-dropdown-input"
            placeholder="branch-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            autoFocus
          />
          <button
            className="branch-dropdown-create-confirm"
            onClick={handleCreate}
            disabled={!newName.trim() || busy === "__create__"}
          >
            Create
          </button>
        </div>
      )}

      <input
        ref={inputRef}
        className="branch-dropdown-search"
        placeholder="Search branches…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {error && <div className="branch-dropdown-error">{error}</div>}

      <div className="branch-dropdown-list">
        {loading ? (
          <div className="branch-dropdown-empty">Loading branches…</div>
        ) : filtered.length === 0 ? (
          <div className="branch-dropdown-empty">No branches found.</div>
        ) : (
          <>
            {localBranches.length > 0 && (
              <>
                <div className="branch-dropdown-section">Local</div>
                {localBranches.map((b) => (
                  <BranchRow
                    key={b.name}
                    branch={b}
                    busy={busy === b.name}
                    onCheckout={() => handleCheckout(b.name)}
                  />
                ))}
              </>
            )}
            {remoteBranches.length > 0 && (
              <>
                <div className="branch-dropdown-section">Remote</div>
                {remoteBranches.map((b) => (
                  <BranchRow
                    key={b.name}
                    branch={b}
                    busy={busy === b.name}
                    onCheckout={() => handleCheckout(b.name)}
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>

      {log.length > 0 && (
        <>
          <div className="branch-dropdown-section">Recent commits</div>
          <div className="branch-dropdown-log">
            {log.slice(0, 15).map((e, i) => (
              <div key={i} className="branch-dropdown-log-row">
                <code className="branch-dropdown-log-graph">{e.graph}</code>
                <code className="branch-dropdown-log-sha">{e.sha}</code>
                <span className="branch-dropdown-log-msg">{e.message}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>

    {/* Dirty checkout modal — centered over the chat view */}
    {dirtyCheckout && (
      <Modal
        title="Uncommitted Changes"
        onClose={() => { setDirtyCheckout(null); setDirtyFiles([]); }}
        actions={
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="primary"
              onClick={() => void confirmDirtyCheckout()}
            >
              Switch anyway
            </button>
            <button onClick={() => { setDirtyCheckout(null); setDirtyFiles([]); }}>
              Cancel
            </button>
          </div>
        }
      >
        <p style={{ marginBottom: 12 }}>
          Switching branches will discard uncommitted changes in these files:
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
              <PeekButton filePath={f.path} projectPath={path!} onPeek={() => { setDirtyCheckout(null); setDirtyFiles([]); if (onClose) onClose(); }} />
            </div>
          ))}
        </div>
      </Modal>
    )}
  </>
  );
}

/** A small eye/peek icon that opens the diff panel in the ToolPanel. */
function PeekButton({ filePath, projectPath, onPeek }: { filePath: string; projectPath: string; projectId?: string; onPeek?: () => void }) {
  const setToolPanelCollapsed = useUiStore((s) => s.setToolPanelCollapsed);
  const setDiffPanelFile = useUiStore((s) => s.setDiffPanelFile);
  const addTab = useUiStore((s) => s.addTab);

  const handlePeek = () => {
    setDiffPanelFile(filePath, projectPath);
    addTab("files");
    setToolPanelCollapsed(false);
    onPeek?.();
  };

  return (
    <button
      type="button"
      className="ghost"
      title={`Peek diff: ${filePath}`}
      onClick={handlePeek}
      style={{ padding: "2px 4px", fontSize: 11, flexShrink: 0 }}
    >
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </button>
  );
}

function BranchRow({
  branch,
  busy,
  onCheckout,
}: {
  branch: BranchInfo;
  busy: boolean;
  onCheckout: () => void;
}) {
  return (
    <button
      className={`branch-dropdown-row ${branch.isCurrent ? "current" : ""}`}
      onClick={onCheckout}
      disabled={branch.isCurrent || busy}
      title={branch.lastCommitMessage}
    >
      <span className="branch-dropdown-row-icon">
        {branch.isCurrent ? "●" : ""}
      </span>
      <span className="branch-dropdown-row-name">{branch.name}</span>
      <span className="branch-dropdown-row-msg">{branch.lastCommitMessage}</span>
    </button>
  );
}
