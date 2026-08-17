// The two approval surfaces for gated tool calls (filesystem AND connected
// accounts — e.g. gmail send / label changes):
//   * ApprovalCard — a pending per-action card (Approve once / Deny) shown in
//     the message stream when `check_permission` / `check_connector_permission`
//     gates a tool call under the session's permission mode.
//   * FullAutoConfirmModal — the one-time confirmation shown the first time a
//     session switches into full_auto mode (deliberate friction, not a silent
//     one-click toggle).
import { useEffect, useState } from "react";
import { Modal } from "../common/Modal";
import { useUiStore } from "../../state/ui";
import {
  getPermissionsRules,
  setPermissionsRules,
  type ApprovalRule,
} from "../../lib/ipc";
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

/** Extract the target path from a tool's args object so an "always allow"
 *  rule can capture a precise glob. Mirrors the backend `fs_target_path`: the
 *  write-side path for move/copy, `path` for the rest. */
function targetPathFromArgs(tool: string, args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  if (tool === "move_file" || tool === "copy_file") {
    return str(a.dest) ?? str(a.src);
  }
  return str(a.path);
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
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  // Path this card is about, if extractable — drives the "always allow" glob.
  const targetPath = targetPathFromArgs(approval.tool, approval.args);

  const handleAllow = async () => {
    // If the user ticked "always allow", persist a rule before resolving so the
    // backend stops pausing for this tool+path on future calls.
    if (alwaysAllow && targetPath) {
      try {
        const rules = await getPermissionsRules();
        const pattern = `${newGlobFromPath(targetPath)}`;
        const exists = rules.some(
          (r) => r.tool === approval.tool && r.pattern === pattern,
        );
        if (!exists) {
          const next: ApprovalRule = {
            id: `rule-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
            tool: approval.tool,
            pattern,
            createdAt: Math.floor(Date.now() / 1000),
          };
          await setPermissionsRules([...rules, next]);
        }
      } catch {
        // Best-effort: a failed rule save must not block the allow itself.
      }
    }
    onResolve(true);
  };

  return (
    <div
      className={`approval-card approval-card-${badge.toLowerCase()}`}
      role="dialog"
      aria-label={`Allow ${approval.tool}`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") void handleAllow();
        else if (e.key === "Escape") onResolve(false);
      }}
    >
      <span className="approval-badge">{badge}</span>
      <span className="approval-card-title">{approval.summary}</span>
      {targetPath && (
        <label className="approval-card-always">
          <input
            type="checkbox"
            checked={alwaysAllow}
            onChange={(e) => setAlwaysAllow(e.target.checked)}
          />
          Always allow {approval.tool} for this path
        </label>
      )}
      <div className="approval-card-actions">
        <button type="button" className="approval-btn deny" onClick={() => onResolve(false)}>
          Deny
        </button>
        <button type="button" className="approval-btn approve" onClick={() => void handleAllow()}>
          Allow
        </button>
      </div>
    </div>
  );
}

/** Turn a concrete path into a directory-anchored glob so "always allow this
 *  tool for this path" covers the file's folder (the common editing intent),
 *  rather than a single exact file. `/p/src/foo.test.ts` → `/p/src/**`. */
function newGlobFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) {
    // Bare filename or root — match any path ending at this name.
    return `**/${normalized}`;
  }
  const dir = normalized.slice(0, lastSlash + 1);
  return `${dir}**`;
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
        In <strong>Full Auto</strong>, the model can read, write, edit, move, copy
        and <strong>delete</strong> files within already-granted roots — and run{" "}
        <strong>shell commands</strong> and connected-account tools like sending
        email or editing Notion — without pausing for an approval card each time.
      </p>
      <p>
        Actions <strong>outside the granted roots</strong> (e.g. a delete or a
        shell-driven write to a system folder) still pause for approval.
      </p>
      <p className="modal-note">
        You can switch back to Manual or Auto-Edit at any time.
      </p>
    </Modal>
  );
}
