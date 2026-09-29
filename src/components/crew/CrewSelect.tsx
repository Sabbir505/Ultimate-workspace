import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** A styled dropdown for the Crew surfaces. Native <select> popups are
 *  OS-drawn and can't wear the app's skin (the engine picker's flat gray
 *  list), so every picker on these forms is one of these: an input-styled
 *  button opening a glass menu.
 *
 *  The menu portals to <body> with fixed positioning — the same reason the
 *  composer's agent-model popup portals: inside the modal it would be clipped
 *  by the scrolling body and the frost's backdrop root. It drops down when
 *  there's room and flips above the button when there isn't.
 *
 *  Mouse-first on purpose (the forms' other controls are too); Escape and
 *  outside-click close, options are real buttons so Tab reaches them. */
export function CrewSelect({
  value,
  options,
  onChange,
  ariaLabel,
  disabled,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; width: number } & (
    | { top: number; bottom?: never }
    | { bottom: number; top?: never }
  ) | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const openMenu = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom;
    const width = Math.max(rect.width, 230);
    if (below > 300 || below > rect.top) {
      setPos({ left: rect.left, top: rect.bottom + 4, width });
    } else {
      setPos({ left: rect.left, bottom: window.innerHeight - rect.top + 4, width });
    }
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest?.(".crew-select-menu")) return;
      if (!btnRef.current?.contains(el)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);
  return (
    <div className="crew-select">
      <button
        ref={btnRef}
        type="button"
        className="crew-select-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <span className="crew-select-value">{current?.label ?? "Select…"}</span>
        <span className="crew-select-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div className="crew-select-menu" role="listbox" aria-label={ariaLabel} style={pos}>
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={`crew-select-option${o.value === value ? " selected" : ""}`}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                <span>{o.label}</span>
                {o.value === value && (
                  <span className="crew-select-check" aria-hidden="true">
                    ✓
                  </span>
                )}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
