// Minimal modal used for: "not a git repo — initialize?" (§4.1), the
// New Worktree branch prompt (§7.10), and the replace-LRU-pane confirm (§4.3).
// Rendered through a portal to <body> so the fixed overlay centers on the
// viewport even when the caller lives inside a transformed/filtered ancestor
// (e.g. the glass sidebar), which would otherwise become its containing block.
//
// A11y: role="dialog" + aria-modal, Escape closes, focus is moved into the
// dialog on open, Tab/Shift+Tab cycle within it (focus trap), and focus
// returns to the previously-focused element on close.
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface ModalProps {
  title: string;
  children: ReactNode;
  actions: ReactNode;
  onClose?: () => void;
  /** Extra class on the modal box (e.g. for a wider, solid variant). */
  className?: string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, children, actions, onClose, className }: ModalProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  // Keep the latest onClose in a ref so the effect below mounts ONCE — an
  // inline-arrow onClose prop would otherwise re-run the effect (and steal
  // focus) on every parent render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;

    // Move focus into the dialog (first focusable element, else the box).
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
    const initial = focusables()[0] ?? box;
    initial.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      const close = onCloseRef.current;
      if (e.key === "Escape" && close) {
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      // Focus trap: wrap Tab / Shift+Tab within the dialog.
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !box.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !box.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      // Return focus to whatever had it before the modal opened.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, []);

  return createPortal(
    <div
      className="modal-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && onClose) onClose();
      }}
    >
      <div
        ref={boxRef}
        className={`modal${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <h3>{title}</h3>
        {children}
        <div className="actions">{actions}</div>
      </div>
    </div>,
    document.body,
  );
}
