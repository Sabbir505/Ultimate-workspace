// Checkpoint chip for assistant messages: the visible face of Conduit's
// per-turn git checkpoints. Each chip represents a hidden-ref snapshot
// (refs/conduit/checkpoints/…) of the working tree taken after that turn.
// Expanding lists the files the checkpoint captured vs the previous one;
// "Restore" rolls the working tree back to the snapshot — the backend takes
// a SAFETY checkpoint of the current state first, so a bad restore is itself
// one-click undoable (the safety chip appears after restoring).
import { useState } from "react";
import { Modal } from "../common/Modal";
import { restoreChatCheckpoint, toastError, toastSuccess, type ChatCheckpoint } from "../../lib/ipc";
import { relativeTime } from "../../lib/relativeTime";

const STATUS_LABEL: Record<string, string> = {
  A: "added",
  M: "modified",
  D: "deleted",
};

/** Wrap the basename, dim the directory — mirrors chat-files-row styling. */
function FileRow({ path, status }: { path: string; status: string }) {
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const basename = sep >= 0 ? path.slice(sep + 1) : path;
  const dirname = sep >= 0 ? path.slice(0, sep) : "";
  return (
    <li className="chat-files-row" title={path}>
      <span className="chat-files-name">{basename}</span>
      {dirname && <span className="chat-files-path">→ {dirname}</span>}
      <span className={`chat-checkpoint-status chat-checkpoint-status-${status}`}>
        {STATUS_LABEL[status] ?? status}
      </span>
    </li>
  );
}

export function CheckpointChip({ checkpoints }: { checkpoints: ChatCheckpoint[] }) {
  // The newest checkpoint is the one that matters ("roll back to here");
  // earlier ones on the same message (restore-safety chains) stay in the list.
  const latest = checkpoints[checkpoints.length - 1];
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  if (!latest) return null;

  const restore = async () => {
    setRestoring(true);
    try {
      const safety = await restoreChatCheckpoint(latest.id);
      toastSuccess(
        "Working tree rolled back",
        safety ? "A safety snapshot of the previous state was saved — restore it to undo this." : undefined,
      );
      setConfirming(false);
      setOpen(false);
    } catch (err) {
      toastError("Restore failed", err);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="chat-checkpoint">
      <button
        className="chat-checkpoint-toggle"
        onClick={() => setOpen((o) => !o)}
        title="Per-turn git checkpoint — expand to see captured files and restore"
      >
        <span className="chat-checkpoint-icon" aria-hidden="true">⎌</span>
        <span className="chat-files-summary-count">
          Checkpoint · {relativeTime(latest.createdAt)}
          {latest.files.length > 0 && ` · ${latest.files.length} ${latest.files.length === 1 ? "file" : "files"}`}
        </span>
        <span className={`chat-thinking-chevron${open ? " open" : ""}`} aria-hidden="true">›</span>
      </button>
      {open && (
        <div className="chat-checkpoint-body">
          {latest.files.length === 0 ? (
            <div className="chat-checkpoint-empty">No file changes captured in this snapshot.</div>
          ) : (
            <ul className="chat-files-list">
              {latest.files.map((f) => (
                <FileRow key={`${f.status}:${f.path}`} path={f.path} status={f.status} />
              ))}
            </ul>
          )}
          <button className="chat-checkpoint-restore" onClick={() => setConfirming(true)}>
            Restore to this point
          </button>
        </div>
      )}
      {confirming && (
        <Modal
          title="Restore checkpoint?"
          className="modal-checkpoint"
          onClose={() => setConfirming(false)}
          actions={
            <>
              <button onClick={() => setConfirming(false)} disabled={restoring}>
                Cancel
              </button>
              <button className="danger" onClick={() => void restore()} disabled={restoring}>
                {restoring ? "Restoring…" : "Roll back working tree"}
              </button>
            </>
          }
        >
          <p>
            Files in <code>{latest.repoPath}</code> will be rolled back to the state right after
            this message's turn. Uncommitted changes made since then will be overwritten.
          </p>
          <p>
            Conduit saves a safety snapshot of the current state first, so you can undo this
            restore afterwards.
          </p>
        </Modal>
      )}
    </div>
  );
}
