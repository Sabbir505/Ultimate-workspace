// Consolidated per-turn changes row (mockup: single card under the answer).
// Merges the three surfaces that used to stack under an assistant turn —
// the "N files changed +adds −dels" disclosure, the generated-file chip, and
// the checkpoint chip — into one row:
//   › 2 files changed +459 −65                    ↺ Undo
// Expanding lists each changed file with its +/− stats and Review / Open
// buttons; Undo restores the turn's git checkpoint (same confirm modal the
// old CheckpointChip used — the backend takes a SAFETY snapshot first, so a
// bad restore is itself one-click undoable, and it defaults to ALSO trimming
// the conversation after this turn).
//
// Data sources:
//  - `files`: the `<tool>` diff blocks streamed for write_file / edit_file
//    (see DiffCard) — these carry the model's find/replace args for +/− stats.
//  - `checkpoints`: per-turn git snapshots (refs/conduit/checkpoints/…).
//    Files the checkpoint captured that no diff block covers (e.g. edits made
//    through run_shell) render with an added/modified/deleted pill instead of
//    line stats.
//  - `artifacts`: files the backend registered as chat artifacts. When "Open"
//    is clicked on one, it routes to the preview pane (live HTML/React for
//    .html/.tsx/...); everything else opens in the Peek file viewer.
import { useState } from "react";
import { Modal } from "../common/Modal";
import {
  getGitStatus,
  listChatCheckpoints,
  restoreChatCheckpoint,
  toastError,
  toastSuccess,
  type ChatCheckpoint,
} from "../../lib/ipc";
import type { ChatArtifact } from "../../state/chat";
import { relativeTime } from "../../lib/relativeTime";
import { useChatStore } from "../../state/chat";
import { useProjectsStore } from "../../state/projects";
import { useUiStore } from "../../state/ui";
import { editLineStats, type EditPayload } from "./DiffCard";

export interface TurnFileChange {
  path: string;
  edit: EditPayload;
}

/** True when two path strings refer to the same file regardless of relative
 *  vs absolute form (tool markers carry project-relative paths; artifact
 *  events may carry absolute ones). */
export function sameTurnFile(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  return na === nb || na.endsWith("/" + nb) || nb.endsWith("/" + na);
}

const STATUS_LABEL: Record<string, string> = {
  A: "added",
  M: "modified",
  D: "deleted",
};

function UndoIcon() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-15-6.7L3 13" />
    </svg>
  );
}

/** Split a path into basename + dim directory, mirroring the old rows. */
function splitPath(path: string): { basename: string; dirname: string } {
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return sep >= 0
    ? { basename: path.slice(sep + 1), dirname: path.slice(0, sep) }
    : { basename: path, dirname: "" };
}

/** Per-file row inside the expanded card. `stats` renders +/− counts;
 *  `status` renders the checkpoint A/M/D pill instead (checkpoint-only files). */
function FileRow({
  path,
  adds,
  dels,
  status,
  onReview,
  onOpen,
}: {
  path: string;
  adds?: number;
  dels?: number;
  status?: string;
  onReview?: () => void;
  onOpen: () => void;
}) {
  const { basename, dirname } = splitPath(path);
  return (
    <li className="chat-files-row" title={path}>
      <span className="chat-files-name">{basename}</span>
      {dirname && <span className="chat-files-path">{dirname}/</span>}
      {status ? (
        <span className={`chat-checkpoint-status chat-checkpoint-status-${status}`}>
          {STATUS_LABEL[status] ?? status}
        </span>
      ) : (
        <span className="chat-files-stats">
          {adds! > 0 && <span className="dev-diff-stat-add">+{adds!.toLocaleString()}</span>}
          {dels! > 0 && <span className="dev-diff-stat-del">−{dels!.toLocaleString()}</span>}
        </span>
      )}
      {onReview && (
        <button
          type="button"
          className="chat-files-review"
          onClick={onReview}
          title={`Review diff for ${path}`}
        >
          Review
        </button>
      )}
      <button type="button" className="chat-files-open" onClick={onOpen} title={`Open ${path}`}>
        Open
      </button>
    </li>
  );
}

export function TurnChangesRow({
  files,
  checkpoints,
  artifacts,
  onPreviewArtifact,
}: {
  files: TurnFileChange[];
  checkpoints: ChatCheckpoint[];
  /** Artifacts attributed to this message — used to route "Open" to the
   *  preview pane for generated files. */
  artifacts?: ChatArtifact[];
  onPreviewArtifact?: (artifact: ChatArtifact) => void;
}) {
  // The newest checkpoint is the undo target; earlier ones on the same
  // message (restore-safety chains) stay out of the way.
  const latest = checkpoints[checkpoints.length - 1];
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [rollback, setRollback] = useState(true);

  const setDiffPanelFile = useUiStore((s) => s.setDiffPanelFile);
  const openFilesTab = useUiStore((s) => s.openFilesTab);
  const openArtifactTab = useUiStore((s) => s.openArtifactTab);
  const projects = useProjectsStore((s) => s.projects);
  const selectedProjectId = useProjectsStore((s) => s.selectedProjectId);
  const cwd = projects.find((p) => p.id === selectedProjectId)?.path ?? null;

  if (files.length === 0 && !latest) return null;

  // Merge duplicate diff blocks for the same path (a file edited twice in one
  // turn) so the list — and the header totals — count each file once.
  const merged = new Map<string, { adds: number; dels: number }>();
  for (const f of files) {
    const { adds, dels } = editLineStats(f.edit);
    const prev = merged.get(f.path) ?? { adds: 0, dels: 0 };
    merged.set(f.path, { adds: prev.adds + adds, dels: prev.dels + dels });
  }
  let totalAdds = 0;
  let totalDels = 0;
  for (const s of merged.values()) {
    totalAdds += s.adds;
    totalDels += s.dels;
  }
  const fileCount = merged.size;

  // Checkpoint-captured files no diff block covers (shell-made edits).
  const checkpointOnlyFiles =
    latest?.files.filter((f) => !merged.has(f.path) && !files.some((c) => sameTurnFile(c.path, f.path))) ?? [];

  // Open `path` as its own named tab in the tool panel (filename + extension
  // as the label). Used when there's no git repo to diff against.
  const openFileTab = (path: string) => {
    openArtifactTab({ path, filename: splitPath(path).basename });
  };

  // Open the working-tree diff for `path` in the right-side tool panel.
  // `openFilesTab` activates (or creates) the singleton "files" tab instance
  // and expands the panel. When the folder isn't a git repo (or no project is
  // bound) there is nothing to diff against — the Changes panel would render
  // an empty state — so the file itself opens as a named tab instead.
  const review = (path: string) => {
    const status = selectedProjectId
      ? useProjectsStore.getState().gitStatuses[selectedProjectId]
      : undefined;
    if (!cwd || (status && !status.isRepo)) {
      openFileTab(path);
      return;
    }
    if (!status) {
      // Cache doesn't know this project yet — ask the backend once, then route.
      void getGitStatus(cwd)
        .then((info) => {
          if (info && !info.isRepo) openFileTab(path);
          else {
            setDiffPanelFile(path, cwd);
            openFilesTab();
          }
        })
        .catch(() => openFileTab(path));
      return;
    }
    setDiffPanelFile(path, cwd);
    openFilesTab();
  };

  const openFile = (path: string) => {
    const artifact = artifacts?.find((a) => sameTurnFile(a.path, path));
    if (artifact) {
      onPreviewArtifact?.(artifact);
      return;
    }
    // Same destination as artifacts: the file preview opens as its own tab in
    // the right-side tool panel. The peek overlay is not the "Open" target.
    openFileTab(path);
  };

  const restore = async () => {
    if (!latest) return;
    setRestoring(true);
    try {
      // "Undo" rolls the workspace back to the state BEFORE this turn — that
      // is the PREVIOUS checkpoint in the session timeline, never this turn's
      // own snapshot (which already contains this turn's file changes, so
      // restoring it would be a silent no-op, and there are no later messages
      // to trim when it's the newest turn).
      const all = (await listChatCheckpoints(latest.chatSessionId)) ?? [];
      const idx = all.findIndex((c) => c.id === latest.id);
      const prev = idx > 0 ? all[idx - 1] : null;
      if (!prev) {
        toastError(
          "Nothing to undo",
          "No checkpoint exists before this turn — it is the earliest snapshot of this chat.",
        );
        setConfirming(false);
        return;
      }
      const result = await restoreChatCheckpoint(prev.id, rollback);
      const deleted = result?.deletedMessages ?? 0;
      const detail = [
        deleted > 0
          ? `${deleted} message${deleted === 1 ? "" : "s"} rolled back with the tree.`
          : undefined,
        "A safety snapshot of the previous state was saved — restore it to undo this.",
      ]
        .filter(Boolean)
        .join(" ");
      toastSuccess("Turn undone — workspace rolled back", detail);
      // The conversation may have been trimmed — refetch from the backend.
      void useChatStore.getState().loadMessages(latest.chatSessionId);
      setConfirming(false);
    } catch (err) {
      toastError("Restore failed", err);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="chat-turn-changes">
      <div className="chat-turn-changes-head">
        <button
          type="button"
          className="chat-turn-changes-toggle"
          onClick={() => setOpen((o) => !o)}
          title={open ? "Hide changed files" : "Show changed files"}
        >
          <span className={`chat-thinking-chevron${open ? " open" : ""}`} aria-hidden="true">
            ›
          </span>
          {fileCount > 0 ? (
            <>
              <span className="chat-turn-changes-count">
                {fileCount} {fileCount === 1 ? "file" : "files"} changed
              </span>
              <span className="chat-turn-changes-stats">
                {totalAdds > 0 && (
                  <span className="dev-diff-stat-add">+{totalAdds.toLocaleString()}</span>
                )}
                {totalDels > 0 && (
                  <span className="dev-diff-stat-del">−{totalDels.toLocaleString()}</span>
                )}
              </span>
            </>
          ) : (
            <span className="chat-turn-changes-count">
              Checkpoint · {relativeTime(latest!.createdAt)}
            </span>
          )}
        </button>
        {latest && (
          <button
            type="button"
            className="chat-turn-changes-undo"
            onClick={() => {
              setRollback(true); // fresh modal → conversation rollback back on
              setConfirming(true);
            }}
            title="Undo this turn — roll the workspace back to the state before it"
          >
            <UndoIcon />
            Undo
          </button>
        )}
      </div>
      {open && (
        <div className="chat-turn-changes-body">
          {fileCount === 0 && checkpointOnlyFiles.length === 0 ? (
            <div className="chat-checkpoint-empty">No file changes captured in this snapshot.</div>
          ) : (
            <ul className="chat-files-list">
              {[...merged.entries()].map(([path, stats]) => (
                <FileRow
                  key={path}
                  path={path}
                  adds={stats.adds}
                  dels={stats.dels}
                  onReview={() => review(path)}
                  onOpen={() => openFile(path)}
                />
              ))}
              {checkpointOnlyFiles.map((f) => (
                <FileRow
                  key={`${f.status}:${f.path}`}
                  path={f.path}
                  status={f.status}
                  onOpen={() => openFile(f.path)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
      {confirming && latest && (
        <Modal
          title="Undo this turn?"
          className="modal-checkpoint"
          onClose={() => setConfirming(false)}
          actions={
            <>
              <button onClick={() => setConfirming(false)} disabled={restoring}>
                Cancel
              </button>
              <button className="danger" onClick={() => void restore()} disabled={restoring}>
                {restoring
                  ? "Restoring…"
                  : rollback
                    ? "Roll back tree + conversation"
                    : "Roll back working tree"}
              </button>
            </>
          }
        >
          <p>
            Files in <code>{latest.repoPath}</code> will be rolled back to the state right
            BEFORE this turn (the previous checkpoint). Changes made by this turn and any
            later turns will be overwritten.
          </p>
          <label className="chat-checkpoint-rollback">
            <input
              type="checkbox"
              checked={rollback}
              onChange={(e) => setRollback(e.target.checked)}
            />
            Also roll back the conversation to before this turn (delete its messages and
            everything after)
          </label>
          <p>
            Conduit saves a safety snapshot of the current state first, so you can undo this
            restore afterwards.
          </p>
        </Modal>
      )}
    </div>
  );
}
