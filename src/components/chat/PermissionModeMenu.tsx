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
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
    value: "confirm_edits",
    label: "Confirm Edits",
    description:
      "Writes & edits pause with a diff card — accept all of it, just some occurrences, or none.",
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
  confirm_edits: "Confirm Edits",
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

export function PermissionModeMenuInner({ mode, onModeChange, variant = "pill", planAvailable = false, modes: modesOverride }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  // Viewport anchor for the PORTALED popup. The popup used to be absolutely
  // positioned inside the composer card, but the card's backdrop-filter makes
  // it a backdrop root AND a stacking context: the popup's z-index only ever
  // competed INSIDE the card, so the docked question / plan-proposal notch (a
  // sibling of the card at z-index 1) painted straight over it — opening the
  // mode menu with a question pending buried the menu under the question (and
  // under the queued-message stack's card chrome). Portaled to <body> and
  // anchored to the trigger's viewport rect it floats above every composer
  // surface, exactly like the agent/model popup. Re-measured on resize and
  // capture-phase scroll (the transcript scrolls inside a nested container)
  // so the menu tracks the chip.
  const [popupPos, setPopupPos] = useState<{ left: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPopupPos(null);
      return;
    }
    const measure = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const margin = 8;
      const width = popupRef.current?.offsetWidth ?? 0;
      // Open UPWARD from the trigger's top edge (what `bottom:
      // calc(100% + 6px)` expressed when the popup lived inside the card),
      // CENTERED on the trigger — the "Build" label then reads as the
      // popup's midpoint — clamped inside the viewport so the popup's fixed
      // 320px width can't hang off either edge in a narrow chat column.
      const triggerCenter = rect.left + rect.width / 2;
      const left = width
        ? Math.min(
            Math.max(margin, triggerCenter - width / 2),
            Math.max(margin, window.innerWidth - width - margin),
          )
        : Math.max(margin, rect.left);
      const bottom = Math.max(margin, window.innerHeight - rect.top + 6);
      // Skip no-op updates (scroll events fire constantly).
      setPopupPos((prev) =>
        prev && prev.left === left && prev.bottom === bottom ? prev : { left, bottom },
      );
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  // Close on outside pointer — EXCEPT inside the portaled popup: it renders
  // outside rootRef (body-level portal), so without this a click on a mode
  // row would close the menu before the click landed on the item.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (popupRef.current?.contains(t)) return;
      setOpen(false);
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
      </button>

      {/* Portaled to <body>: rendered inside the composer card the card's
          backdrop-filter is a backdrop root — the frost sampled the card's own
          paint instead of the transcript AND the card's stacking context
          trapped the popup UNDER the docked question / plan notch. Portaled +
          viewport-anchored it frosts the real page and floats above every
          composer surface (same fix as the agent/model popup). */}
      {open &&
        createPortal(
          <div
            ref={popupRef}
            className="permission-mode-popup"
            role="menu"
            style={popupPos ?? undefined}
            onKeyDown={onKeyDown}
          >
            <div className="permission-mode-hint">
              {modesOverride
                ? "The harness's own postures — applied when the pane starts. Relay approval cards relay into built-in chat only; this CLI answers its own prompts in-pane."
                : "Approval posture for tool calls this turn."}
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
          </div>,
          document.body,
        )}
    </div>
  );
}

// Memoized (PERF): the menu lives in the composer's control bar, which
// re-renders on every keystroke. All props are primitives / stable module
// constants / a useCallback from ChatView, so memo skips this subtree while
// the user types.
export const PermissionModeMenu = memo(PermissionModeMenuInner);
