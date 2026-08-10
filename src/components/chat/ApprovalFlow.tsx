// The two approval surfaces for gated tool calls (filesystem AND connected
// accounts — e.g. gmail send / label changes):
//   * ApprovalCard — a pending per-action card (Approve once / Deny) shown in
//     the message stream when `check_permission` / `check_connector_permission`
//     gates a tool call under the session's permission mode.
//   * FullAutoConfirmModal — the one-time confirmation shown the first time a
//     session switches into full_auto mode (deliberate friction, not a silent
//     one-click toggle).
import { useEffect } from "react";
import { Modal } from "../common/Modal";
import { useUiStore } from "../../state/ui";
import type { PendingApproval } from "../../state/chat";

/** Classify a tool name into a short action badge for the card header.
 *  Token-based so `gmail_send_message` / `send_message` / `delete_thread`
 *  all map to the right chip. */
function actionBadge(tool: string): string {
  const tokens = tool
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const has = (...ks: string[]) => ks.some((k) => tokens.includes(k));
  if (has("delete", "remove", "trash", "unlink", "revoke")) return "DELETE";
  if (has("send", "post", "publish", "share")) return "SEND";
  if (has("write", "create", "draft", "insert", "add")) return "WRITE";
  if (has("edit", "update", "patch", "modify", "label", "move", "copy")) return "EDIT";
  return "ACTION";
}

/** A compact approval card. Rendered inline where the model's tool call would
 *  appear. Codex-style: a plain-language task message with a Deny / Allow
 *  action row — no raw tool name, no payload dump, no side ribbon. */
export function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: PendingApproval;
  onResolve: (approved: boolean) => void;
}) {
  const badge = actionBadge(approval.tool);

  return (
    <div
      className={`approval-card approval-card-${badge.toLowerCase()}`}
      role="dialog"
      aria-label={`Allow ${approval.tool}`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") onResolve(true);
        else if (e.key === "Escape") onResolve(false);
      }}
    >
      <span className="approval-badge">{badge}</span>
      <span className="approval-card-title">{approval.summary}</span>
      <div className="approval-card-actions">
        <button type="button" className="approval-btn deny" onClick={() => onResolve(false)}>
          Deny
        </button>
        <button type="button" className="approval-btn approve" onClick={() => onResolve(true)}>
          Allow
        </button>
      </div>
    </div>
  );
}

/** The one-time full_auto confirmation modal. Brief copy explaining what it
 *  does and that deletes remain gated regardless. */
export function FullAutoConfirmModal({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const setModalOpen = useUiStore((s) => s.setModalOpen);

  useEffect(() => {
    setModalOpen("approval:full-auto", true);
    return () => setModalOpen("approval:full-auto", false);
  }, [setModalOpen]);

  return (
    <Modal
      title="Switch to Full Auto?"
      onClose={onCancel}
      actions={
        <>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={onConfirm}>
            Enable Full Auto
          </button>
        </>
      }
    >
      <p>
        In <strong>Full Auto</strong>, the model can read, write, edit, move and copy
        files within already-granted roots — and use connected-account tools like
        sending email or editing Notion — without pausing for an approval card each
        time.
      </p>
      <p>
        <strong>Delete is still gated</strong> with a per-action approval card in
        every mode — no mode selection bypasses the delete gate. This is a hard rule,
        not a default.
      </p>
      <p className="modal-note">
        You can switch back to Manual or Auto-Edit at any time.
      </p>
    </Modal>
  );
}
