// A glass-styled custom dropdown. Native <select> option lists are OS-rendered
// and can't be themed to match Liquid Glass, so this component renders its own
// list as a floating glass popover. Keyboard-accessible (Enter/Space to open,
// Arrow keys to move, Enter to pick, Esc to close) and closes on outside click
// or blur. Used for the CLI harness chooser, the theme chooser, the settings
// form pickers and the Automations form.
//
// The list is PORTALED to <body> with fixed positioning (same reason the
// composer's agent-model popup and SubagentSelect portal theirs): an in-flow
// absolute list gets clipped by any scrolling ancestor — every settings form
// and the Automations form body scroll — and can slide under a sibling
// stacking context. Fixed + body level + the app's top-layer z-index wins over
// every HTML surface. The position is recomputed from the trigger's rect on
// scroll/resize while open, and the list flips above the trigger when there is
// no room below.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** Optional small caption shown under the label (e.g. an installed/not-installed note). */
  hint?: string;
  disabled?: boolean;
}

interface Props<T extends string> {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  /** Accessible name for the trigger (the visible label lives outside this
   *  component, so the trigger can't be named by its content alone). */
  ariaLabel?: string;
  /** aria/title text. */
  title?: string;
  /** Extra class on the trigger button (e.g. size variant). */
  className?: string;
  /** Locked control (e.g. a provider's protocol kind is fixed after add):
   *  trigger renders disabled and the popover can't open. */
  disabled?: boolean;
  /** Width the popover should match: "trigger" (default) or "content". */
  matchWidth?: "trigger" | "content";
  /** Per-row control rendered after the label (e.g. audition a voice). Its
   *  clicks select nothing and leave the list open, so a row can be tried out
   *  without committing to it. Keyboard navigation still belongs to the
   *  trigger — the action is a pointer affordance, so it stays out of the tab
   *  order and off the arrow-key path. */
  optionAction?: (option: SelectOption<T>) => React.ReactNode;
}

export function GlassSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  title,
  className,
  disabled,
  matchWidth = "trigger",
  optionAction,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.max(0, options.findIndex((o) => o.value === value)),
  );
  // Fixed-position anchor (viewport coordinates) for the portaled list.
  const [pos, setPos] = useState<
    { left: number; width?: number; minWidth: number } & (
      | { top: number; bottom?: never }
      | { bottom: number; top?: never }
    )
    | null
  >(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Sync keyboard-cursor to the current value whenever it changes externally.
  useEffect(() => {
    const idx = options.findIndex((o) => o.value === value);
    if (idx >= 0) setActiveIndex(idx);
  }, [value, options]);

  /** Recompute the list's anchor from the trigger's current rect — drop down
   *  when there's room below, flip above when there isn't. */
  const updatePos = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom;
    const anchor = { left: rect.left, minWidth: rect.width };
    if (below > 300 || below > rect.top) {
      setPos({
        ...anchor,
        top: rect.bottom + 4,
        // "trigger" match fills the control exactly; "content" lets the list
        // size to its rows but never narrower than the control.
        ...(matchWidth === "trigger" ? { width: rect.width } : {}),
      });
    } else {
      setPos({
        ...anchor,
        bottom: window.innerHeight - rect.top + 4,
        ...(matchWidth === "trigger" ? { width: rect.width } : {}),
      });
    }
  };

  const openMenu = () => {
    updatePos();
    setOpen(true);
  };

  // Close on outside pointer.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (
        !triggerRef.current?.contains(e.target as Node) &&
        !listRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // The list is fixed-positioned, so anything that moves the trigger under it
    // (scrolling a form body, resizing the window) has to re-anchor it —
    // capture-phase on window, because scroll fires on the scrolling element
    // and does not bubble.
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", updatePos, true);
    window.addEventListener("resize", updatePos);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", updatePos, true);
      window.removeEventListener("resize", updatePos);
    };
  }, [open]);

  // Scroll the active option into view when navigating.
  useLayoutEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const el = list.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  const choose = (val: T) => {
    onChange(val);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    const enabled = options.map((o, i) => ({ o, i })).filter(({ o }) => !o.disabled);
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((cur) => {
          const enabledIdxs = enabled.map(({ i }) => i);
          const pos = enabledIdxs.indexOf(cur);
          const next = enabledIdxs[(pos + 1) % enabledIdxs.length] ?? enabledIdxs[0];
          return next ?? cur;
        });
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((cur) => {
          const enabledIdxs = enabled.map(({ i }) => i);
          const pos = enabledIdxs.indexOf(cur);
          const prev = enabledIdxs[(pos - 1 + enabledIdxs.length) % enabledIdxs.length] ?? enabledIdxs[0];
          return prev ?? cur;
        });
        break;
      case "Enter":
        e.preventDefault();
        if (options[activeIndex] && !options[activeIndex].disabled) choose(options[activeIndex].value);
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  };

  const selected = options.find((o) => o.value === value) ?? options[0];

  return (
    <div className={`glass-select${open ? " open" : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`glass-select-trigger${className ? ` ${className}` : ""}${disabled ? " is-disabled" : ""}`}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className="glass-select-value">{selected?.label ?? ""}</span>
        <span className="glass-select-chevron" aria-hidden="true">▾</span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={listRef}
            className="glass-select-list"
            role="listbox"
            aria-label={ariaLabel}
            style={pos}
          >
            {options.map((o, i) => (
              // A div, not a button: a row can carry an action of its own (the
              // voice audition), and a button inside a button is invalid HTML
              // that browsers resolve by dropping the inner one.
              <div
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                aria-disabled={o.disabled}
                tabIndex={-1}
                className={`glass-select-option${o.value === value ? " selected" : ""}${
                  i === activeIndex ? " active" : ""
                }${o.disabled ? " disabled" : ""}`}
                onPointerMove={() => setActiveIndex(i)}
                onClick={() => !o.disabled && choose(o.value)}
              >
                <span className="glass-select-option-label">
                  {o.label}
                  {o.hint && <span className="glass-select-option-hint">{o.hint}</span>}
                </span>
                {o.value === value && <span className="glass-select-check" aria-hidden="true">✓</span>}
                {optionAction && (
                  // Keeps the row's own action from selecting it (or closing the
                  // list): auditioning a voice is not choosing it.
                  <span
                    className="glass-select-option-action"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    {optionAction(o)}
                  </span>
                )}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
