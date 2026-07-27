// Filesystem permission-mode selector for the chat composer. A pill trigger
// ("Manual ▾") opens an upward glass menu listing the four postures
// (read_only / manual / auto_edit / full_auto), styled to match
// ModelEffortMenu's dropdown exactly — same glass surface, chevron, checkmark,
// and outside-click handling. Switching INTO full_auto does NOT apply here:
// the store opens a one-time confirmation modal instead; selecting full_auto
// in this menu calls onModeChange("full_auto") only as a request the store may
// intercept.
import { useEffect, useRef, useState } from "react";
import type { PermissionMode } from "../../state/chat";

export interface ModeOption {
  value: PermissionMode;
  label: string;
  /** One-line description shown under the label in the menu. */
  description: string;
}

export const PERMISSION_MODES: ModeOption[] = [
  {
    value: "read_only",
    label: "Read Only",
    description: "Model can list/read/search files, but cannot write, edit, or delete.",
  },
  {
    value: "manual",
    label: "Manual Approval",
    description: "Every write/edit/delete/move/copy pauses for an approval card. (Default)",
  },
  {
    value: "auto_edit",
    label: "Auto-Edit",
    description: "Reads & writes/edits in granted roots auto-run. Delete/move/copy still gated.",
  },
  {
    value: "full_auto",
    label: "Full Auto",
    description: "Everything auto-runs except delete, which is always gated.",
  },
];

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  read_only: "Read Only",
  manual: "Manual",
  auto_edit: "Auto-Edit",
  full_auto: "Full Auto",
};

interface Props {
  mode: PermissionMode;
  onModeChange: (mode: PermissionMode) => void;
  /** `"inline"` renders a borderless trigger that blends into the composer
   *  footer like the `+` attach button (no pill border); `"pill"` (default)
   *  renders the bordered pill matching ModelEffortMenu. */
  variant?: "pill" | "inline";
}

export function PermissionModeMenu({ mode, onModeChange, variant = "pill" }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  // Close on outside pointer.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  // Keep active index in range + scroll into view.
  useEffect(() => {
    setActiveIndex((i) => (i >= PERMISSION_MODES.length ? 0 : i));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const choose = (value: PermissionMode) => {
    onModeChange(value);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, PERMISSION_MODES.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = PERMISSION_MODES[activeIndex];
      if (opt) choose(opt.value);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const label = PERMISSION_MODE_LABELS[mode];
  const variantClass = variant === "inline" ? " inline" : "";

  return (
    <div className="permission-mode-menu" ref={rootRef}>
      <button
        type="button"
        className={`permission-mode-trigger mode-${mode}${variantClass}`}
        onClick={() => setOpen((o) => !o)}
        title="Filesystem permission mode"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="permission-mode-dot" aria-hidden="true" />
        <span className="permission-mode-label">{label}</span>
        <span className="permission-mode-chevron" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="permission-mode-popup" role="menu" onKeyDown={onKeyDown}>
          <div className="permission-mode-hint">
            Sets the default approval posture for filesystem tool calls this turn.
          </div>
          <div className="permission-mode-divider" />
          {PERMISSION_MODES.map((opt, i) => (
            <button
              key={opt.value}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={opt.value === mode}
              className={`permission-mode-item${opt.value === mode ? " selected" : ""}${
                i === activeIndex ? " active" : ""
              }`}
              onClick={() => choose(opt.value)}
              onPointerEnter={() => setActiveIndex(i)}
            >
              <span className="permission-mode-item-text">
                <span className="permission-mode-item-label">
                  {opt.label}
                  {opt.value === "manual" && (
                    <span className="permission-mode-badge">Default</span>
                  )}
                </span>
                <span className="permission-mode-item-desc">{opt.description}</span>
              </span>
              {opt.value === mode && <span className="permission-mode-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
