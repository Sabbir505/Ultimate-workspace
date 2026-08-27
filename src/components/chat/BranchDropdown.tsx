// A compact popover dropdown for switching branches: search-first list with
// the current branch checked (plus an uncommitted-changes count under it)
// and two footer actions — "Create and switch to new branch…" and "Git
// Graph" (which opens the full branch panel tab with the log graph).
//
// Rendered by the composer's GitHub pill, the top-right git menu, and the
// Git tools sidebar — each supplies its own positioning wrapper.
//
// Fetches branches + dirty-file count from the backend on open, refreshed
// by the FS watcher. `chatBound` (Git tools sidebar) resolves the repo
// STRICTLY from the active chat session's binding — an unbound new chat
// gets "No project selected." instead of leaking the sidebar-selected
// project's branches. The composer/menu surfaces keep the chat-bound →
// globally-selected fallback.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  listGitBranches,
  checkoutGitBranch,
  createGitBranch,
  getChangedFiles,
  safeListen,
  type ChangedFile,
  type BranchInfo,
} from "../../lib/ipc";
import { useProjectsStore } from "../../state/projects";
import { useChatStore } from "../../state/chat";
import { useUiStore } from "../../state/ui";
import { Modal } from "../common/Modal";

export function BranchDropdown({
  onClose,
  chatBound = false,
}: {
  onClose?: () => void;
  /** Strictly resolve the repo from the active chat session's project
   *  binding (no global-selection fallback). Used by the Git tools sidebar
   *  whose git surface is chat-scoped. */
  chatBound?: boolean;
}) {
  const boundProjectId = useChatStore((s) =>
    s.activeChatSessionId ? s.sessionProjects[s.activeChatSessionId] : undefined,
  );
  const selectedProjectId = useProjectsStore((s) => s.selectedProjectId);
  const projects = useProjectsStore((s) => s.projects);
  const refreshGitStatus = useProjectsStore((s) => s.refreshGitStatus);

  const projectId = chatBound
    ? boundProjectId
    : boundProjectId ?? selectedProjectId;
  const project = projects.find((p) => p.id === projectId);
  const path = project?.path ?? null;

  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [dirtyCount, setDirtyCount] = useState(0);
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
  const createInputRef = useRef<HTMLInputElement>(null);

  const fetchAll = useCallback(async () => {
    if (!path) return;
    const [bl, cf] = await Promise.all([
      listGitBranches(path),
      getChangedFiles(path),
    ]);
    setBranches(bl ?? []);
    setDirtyCount(cf?.length ?? 0);
    setError(null);
    setLoading(false);
  }, [path]);

  useEffect(() => {
    setLoading(true);
    void fetchAll();
    // Subscribe to the FS watcher event so the branch list and dirty count
    // refresh on actual changes (e.g. `git checkout` from the terminal, an
    // agent editing files). The backend debounces to 300 ms so a burst of
    // FS events from one git op becomes one refresh, not a thundering herd.
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

  // Focus the create input the moment the inline create row appears.
  useEffect(() => {
    if (creating) createInputRef.current?.focus();
  }, [creating]);

  const filtered = useMemo(() => {
    if (!query.trim()) return branches;
    const q = query.toLowerCase();
    return branches.filter((b) => b.name.toLowerCase().includes(q));
  }, [branches, query]);

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

  // "Create and switch": create the branch, then check it out.
  const createAndSwitch = async () => {
    if (!path || !newName.trim()) return;
    setBusy("__create__");
    try {
      await createGitBranch(path, newName.trim());
      await checkoutGitBranch(path, newName.trim());
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
    await createAndSwitch();
  };

  // Confirm a dirty checkout: the user acknowledged the warning.
  const confirmDirtyCheckout = async () => {
    if (!dirtyCheckout) return;
    const name = dirtyCheckout;
    setDirtyCheckout(null);
    if (name === "__create__") {
      // Retry the create flow (skip the dirty check this time).
      if (!path || !newName.trim()) return;
      await createAndSwitch();
      return;
    }
    await performCheckout(name);
  };

  const openGitGraph = () => {
    const s = useUiStore.getState();
    s.addTab("branch");
    s.setToolPanelCollapsed(false);
    if (onClose) onClose();
  };

  if (!path) {
    return <div className="branch-dropdown-empty">No project selected.</div>;
  }

  return (
    <>
    <div className="branch-dropdown" onClick={(e) => e.stopPropagation()}>
      {/* Search-first header */}
      <div className="branch-dd-search-wrap">
        <svg className="branch-dd-search-icon" width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <input
          ref={inputRef}
          className="branch-dd-search"
          placeholder="Search branches"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {creating && (
        <div className="branch-dd-create-row">
          <input
            ref={createInputRef}
            className="branch-dd-create-input"
            placeholder="branch-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          />
          <button
            className="branch-dd-create-confirm"
            onClick={handleCreate}
            disabled={!newName.trim() || busy === "__create__"}
          >
            Create
          </button>
        </div>
      )}

      {error && <div className="branch-dropdown-error">{error}</div>}

      <div className="branch-dd-label">Branches</div>

      <div className="branch-dd-list">
        {loading ? (
          <div className="branch-dropdown-empty">Loading branches…</div>
        ) : filtered.length === 0 ? (
          <div className="branch-dropdown-empty">No branches found.</div>
        ) : (
          filtered.map((b) => (
            <BranchRow
              key={b.name}
              branch={b}
              dirtyCount={b.isCurrent ? dirtyCount : 0}
              busy={busy === b.name}
              onCheckout={() => handleCheckout(b.name)}
            />
          ))
        )}
      </div>

      {/* Footer actions */}
      <div className="branch-dd-actions">
        <button
          className="branch-dd-action"
          onClick={() => setCreating((c) => !c)}
          disabled={busy === "__create__"}
        >
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Create and switch to new branch…
        </button>
        <button className="branch-dd-action" onClick={openGitGraph}>
          <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
            <circle cx="4" cy="3" r="1.5" /><circle cx="4" cy="13" r="1.5" /><circle cx="12" cy="3" r="1.5" />
            <path d="M4 4.5v7" /><path d="M12 4.5c0 4-4 2-4 4.5" />
          </svg>
          Git Graph
        </button>
      </div>
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
  dirtyCount,
  busy,
  onCheckout,
}: {
  branch: BranchInfo;
  dirtyCount: number;
  busy: boolean;
  onCheckout: () => void;
}) {
  return (
    <button
      className={`branch-dd-row ${branch.isCurrent ? "current" : ""}`}
      onClick={onCheckout}
      disabled={branch.isCurrent || busy}
      title={branch.lastCommitMessage}
    >
      {/* Git-branch glyph — dimmed for the current row (the check marks it). */}
      <svg className="branch-dd-row-icon" width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="4" cy="3" r="1.5" /><circle cx="4" cy="13" r="1.5" /><circle cx="12" cy="3" r="1.5" />
        <path d="M4 4.5v7" /><path d="M12 4.5c0 4-4 2-4 4.5" />
      </svg>
      <span className="branch-dd-row-body">
        <span className="branch-dd-row-name">{branch.name}</span>
        {branch.isCurrent && dirtyCount > 0 && (
          <span className="branch-dd-row-sub">
            Uncommitted changes: {dirtyCount} {dirtyCount === 1 ? "file" : "files"}
          </span>
        )}
      </span>
      {branch.isCurrent && (
        <svg className="branch-dd-row-check" width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )}
    </button>
  );
}
