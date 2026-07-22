// Minimal modal used for: "not a git repo — initialize?" (§4.1), the
// New Worktree branch prompt (§7.10), and the replace-LRU-pane confirm (§4.3).
// Rendered through a portal to <body> so the fixed overlay centers on the
// viewport even when the caller lives inside a transformed/filtered ancestor
// (e.g. the glass sidebar), which would otherwise become its containing block.
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

interface ModalProps {
  title: string;
  children: ReactNode;
  actions: ReactNode;
  onClose?: () => void;
  /** Extra class on the modal box (e.g. for a wider, solid variant). */
  className?: string;
}

export function Modal({ title, children, actions, onClose, className }: ModalProps) {
  return createPortal(
    <div
      className="modal-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && onClose) onClose();
      }}
    >
      <div className={`modal${className ? ` ${className}` : ""}`} role="dialog" aria-label={title}>
        <h3>{title}</h3>
        {children}
        <div className="actions">{actions}</div>
      </div>
    </div>,
    document.body,
  );
}
