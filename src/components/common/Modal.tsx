// Minimal modal used for: "not a git repo — initialize?" (§4.1), the
// New Worktree branch prompt (§7.10), and the replace-LRU-pane confirm (§4.3).
import type { ReactNode } from "react";

interface ModalProps {
  title: string;
  children: ReactNode;
  actions: ReactNode;
  onClose?: () => void;
}

export function Modal({ title, children, actions, onClose }: ModalProps) {
  return (
    <div
      className="modal-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && onClose) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-label={title}>
        <h3>{title}</h3>
        {children}
        <div className="actions">{actions}</div>
      </div>
    </div>
  );
}
