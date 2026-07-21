// A glass-styled custom dropdown. Native <select> option lists are OS-rendered
// and can't be themed to match Liquid Glass, so this component renders its own
// list as a floating glass popover. Keyboard-accessible (Enter/Space to open,
// Arrow keys to move, Enter to pick, Esc to close) and closes on outside click
// or blur. Used for the CLI harness chooser and the theme chooser.
import { useEffect, useLayoutEffect, useRef, useState } from "react";

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
  /** aria/title text. */
  title?: string;
  /** Extra class on the trigger button (e.g. size variant). */
  className?: string;
  /** Width the popover should match: "trigger" (default) or "content". */
  matchWidth?: "trigger" | "content";
}

export function GlassSelect<T extends string>({
  value,
  options,
  onChange,
  title,
  className,
  matchWidth = "trigger",
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.max(0, options.findIndex((o) => o.value === value)),
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Sync keyboard-cursor to the current value whenever it changes externally.
  useEffect(() => {
    const idx = options.findIndex((o) => o.value === value);
    if (idx >= 0) setActiveIndex(idx);
  }, [value, options]);

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
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
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
        setOpen(true);
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
        className={`glass-select-trigger${className ? ` ${className}` : ""}`}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
      >
        <span className="glass-select-value">{selected?.label ?? ""}</span>
        <span className="glass-select-chevron" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          ref={listRef}
          className="glass-select-list"
          role="listbox"
          style={matchWidth === "trigger" ? { minWidth: "100%" } : undefined}
        >
          {options.map((o, i) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              disabled={o.disabled}
              className={`glass-select-option${o.value === value ? " selected" : ""}${
                i === activeIndex ? " active" : ""
              }`}
              onPointerMove={() => setActiveIndex(i)}
              onClick={() => !o.disabled && choose(o.value)}
            >
              <span className="glass-select-option-label">
                {o.label}
                {o.hint && <span className="glass-select-option-hint">{o.hint}</span>}
              </span>
              {o.value === value && <span className="glass-select-check" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
