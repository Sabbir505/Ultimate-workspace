// The two approval surfaces for filesystem tool calls:
//   * ApprovalCard — a pending per-action card (Approve once / Deny) shown in
//     the message stream when `check_permission` gates a tool call.
//   * FullAutoConfirmModal — the one-time confirmation shown the first time a
//     session switches into full_auto mode (deliberate friction, not a silent
//     one-click toggle).
import { useEffect } from "react";
import { Modal } from "../common/Modal";
import { useUiStore } from "../../state/ui";
import type { PendingApproval } from "../../state/chat";

/** A compact approval card. Rendered inline where the model's tool call would
 *  appear. Buttons resolve the pending action via the chat store. */
export function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: PendingApproval;
  onResolve: (approved: boolean) => void;
}) {
  return (
    <div className="approval-card">
      <div className="approval-card-icon" aria-hidden="true">⚠</div>
      <div className="approval-card-body">
        <div className="approval-card-title">
          {approval.tool}: <code>{approval.summary}</code>
        </div>
        <div className="approval-card-hint">
          The model wants to {approval.summary}. Approve to run it now, or deny.
        </div>
      </div>
      <div className="approval-card-actions">
        <button
          type="button"
          className="approval-btn deny"
          onClick={() => onResolve(false)}
        >
          Deny
        </button>
        <button
          type="button"
          className="approval-btn approve"
          onClick={() => onResolve(true)}
        >
          Approve once
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
    setModalOpen(true);
    return () => setModalOpen(false);
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
        files within already-granted roots without pausing for an approval card each
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
