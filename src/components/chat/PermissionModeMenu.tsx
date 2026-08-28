// Approval-mode selector for the chat composer. A pill trigger
// ("Manual ▾") opens an upward glass menu listing the postures that govern
// tool calls. TWO catalogs:
//   * built-in sessions — our dual-policy postures (read_only / plan /
//     manual / auto_edit / full_auto);
//   * CLI-harness sessions — the HARNESS'S OWN postures via the `modes`
//     prop (OpenCode build/plan, Claude Code default/acceptEdits/plan/
//     bypassPermissions): what the user picks is what the harness spawn
//     passes to the CLI, with no mapping layer.
// Switching INTO full_auto does NOT apply here: the store opens a one-time
// confirmation modal instead; selecting full_auto in this menu calls
// onModeChange("full_auto") only as a request the store may intercept.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PermissionMode } from "../../state/chat";

export interface ModeOption {
  value: string;
  label: string;
  /** One-line description shown under the label in the menu. */
  description: string;
}

export const PERMISSION_MODES: ModeOption[] = [
  {
    value: "plan",
    label: "Plan",
    description:
      "Research first — the model must propose a plan you approve before it changes anything.",
  },
  {
    value: "read_only",
    label: "Read Only",
    description: "Read files & search accounts only. No writes or connected-account actions.",
  },
  {
    value: "manual",
    label: "Manual Approval",
    description: "Every mutating action pauses for approval. (Default)",
  },
  {
    value: "auto_edit",
    label: "Auto-Edit",
    description: "Reads & writes in granted roots auto-run. Delete/move/copy still gated.",
  },
  {
    value: "full_auto",
    label: "Full Auto",
    description: "Everything auto-runs — files, shell, connected accounts.",
  },
];

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  plan: "Plan",
  read_only: "Read Only",
  manual: "Manual",
  auto_edit: "Auto-Edit",
  full_auto: "Full Auto",
};

interface Props {
  mode: string;
  onModeChange: (mode: string) => void;
  /** `"inline"` renders a borderless trigger that blends into the composer
   *  footer like the `+` attach button (no pill border); `"pill"` (default)
   *  renders the bordered pill matching ModelEffortMenu. */
  variant?: "pill" | "inline";
  /** Whether the "Plan" posture is selectable for this session. Plan mode is
   *  enforced by the built-in provider's plan gate, so it only makes sense
   *  for builtin/local sessions with tools enabled; harness/ACP sessions
   *  hide the entry (default false — opt in). */
  planAvailable?: boolean;
  /** HARNESS catalog override: when set, the menu lists exactly these
   *  postures (the harness's own) instead of the built-in ones. */
  modes?: ModeOption[];
}

export function PermissionModeMenu({ mode, onModeChange, variant = "pill", planAvailable = false, modes: modesOverride }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  // Override for the popup's horizontal position when the default right-aligned
  // placement would push it off-screen (narrow chat column — collapsed sidebar
  // + browser pane open). Computed against the viewport on open.
  const [popupStyle, setPopupStyle] = useState<React.CSSProperties | undefined>(undefined);

  // Clamp the popup horizontally inside the viewport. The popup is absolutely
  // positioned `right: 0` to the trigger, so in a narrow column it can extend
  // past the left edge; measure the rendered popup and shift it right (or
  // left) when it would overflow.
  useLayoutEffect(() => {
    if (!open) {
      setPopupStyle(undefined);
      return;
    }
    const popup = popupRef.current;
    const root = rootRef.current;
    if (!popup || !root) return;
    const pr = popup.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    const margin = 8;
    let dx = 0;
    if (pr.left < margin) dx = margin - pr.left;
    else if (pr.right > window.innerWidth - margin) dx = window.innerWidth - margin - pr.right;
    if (dx !== 0) setPopupStyle({ left: pr.left - rr.left + dx, right: "auto" });
  }, [open]);

  // Close on outside pointer.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  // The effective catalog: a harness override wins wholesale; otherwise the
  // built-in postures, with "plan" filtered out where the plan gate doesn't
  // exist (filtered from keyboard-nav bounds too so arrows can't reach it).
  const modes: ModeOption[] =
    modesOverride ??
    (planAvailable
      ? PERMISSION_MODES
      : PERMISSION_MODES.filter((m) => m.value !== "plan"));

  // Keep active index in range + scroll into view.
  useEffect(() => {
    setActiveIndex((i) => (i >= modes.length ? 0 : i));
  }, [open, modes.length]);

  useEffect(() => {
    if (!open) return;
    itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const choose = (value: string) => {
    onModeChange(value);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, modes.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = modes[activeIndex];
      if (opt) choose(opt.value);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  // Trigger label: the catalog entry when present, else the raw value
  // (harness labels always resolve through their catalog).
  const label = modes.find((m) => m.value === mode)?.label ?? PERMISSION_MODE_LABELS[mode as PermissionMode] ?? mode;
  const variantClass = variant === "inline" ? " inline" : "";

  return (
    <div className="permission-mode-menu" ref={rootRef}>
      <button
        type="button"
        className={`permission-mode-trigger mode-${mode}${variantClass}`}
        onClick={() => setOpen((o) => !o)}
        title="Approval mode (files + connected accounts)"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="permission-mode-label">{label}</span>
        <span className="permission-mode-chevron" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div
          ref={popupRef}
          className="permission-mode-popup"
          role="menu"
          style={popupStyle}
          onKeyDown={onKeyDown}
        >
          <div className="permission-mode-hint">
            Approval posture for tool calls this turn.
          </div>
          <div className="permission-mode-divider" />
          {modes.map((opt, i) => (
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
