// Codex-style sliding control (reasoning effort / Auto bias): a pill track
// with a per-level colored fill up to the active stop, a white knob that
// glides between dot-marked stops (CSS transitions — compositor-driven, so
// the slide stays smooth under composer re-renders), labels aligned under
// the stops. Click anywhere on the track to jump to the nearest stop; arrow
// keys move between stops (role="slider").
//
// The LAST stop is the "max" tier: the knob pulses and the fill shimmers so
// pushing the slider to the top feels deliberate.
import { useCallback, useRef } from "react";

export interface SegSliderOption<V extends string> {
  value: V;
  label: string;
  /** Hover/tooltip copy explaining the stop. */
  title?: string;
  /** Fill color for this level (any CSS color). Falls back to the accent. */
  color?: string;
}

interface Props<V extends string> {
  options: readonly SegSliderOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /** Accessible name for the whole control. */
  ariaLabel: string;
}

export function SegmentedSlider<V extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: Props<V>) {
  const n = Math.max(options.length, 1);
  const railRef = useRef<HTMLDivElement>(null);
  let active = options.findIndex((o) => o.value === value);
  if (active < 0) active = 0;
  // Stop positions: the knob CENTER travels inside a 13px inset on each
  // side — knob half-width (12px) + the rail's 1px border. Percentages in
  // `left` resolve against the PADDING box, so the border must be counted or
  // the last stop's knob overshoots the pill and clips its rounded cap.
  // The knob spans the rail's FULL content height (24px), so its curve
  // exactly matches the pill's cap curve at the ends. Dots and labels reuse
  // the identical formula to stay aligned.
  const INSET = 13;
  const pos = (i: number) => {
    const f = n <= 1 ? 0.5 : i / (n - 1);
    return `calc(${INSET}px + (100% - ${INSET * 2}px) * ${f})`;
  };
  // Edge labels would half-overflow the pane if centered on the end stops —
  // left-align the first, right-align the last.
  const labelTransform = (i: number) =>
    i === 0 && n > 1 ? "translateX(0)" : i === n - 1 ? "translateX(-100%)" : "translateX(-50%)";

  const activeOption = options[active];
  const activeColor = activeOption?.color;
  const isMax = n > 1 && active === n - 1;

  const setIndex = useCallback(
    (i: number) => {
      const clamped = Math.max(0, Math.min(n - 1, i));
      const opt = options[clamped];
      if (opt && opt.value !== value) onChange(opt.value);
    },
    [n, options, onChange, value],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowRight":
        case "ArrowUp":
          e.preventDefault();
          setIndex(active + 1);
          break;
        case "ArrowLeft":
        case "ArrowDown":
          e.preventDefault();
          setIndex(active - 1);
          break;
        case "Home":
          e.preventDefault();
          setIndex(0);
          break;
        case "End":
          e.preventDefault();
          setIndex(n - 1);
          break;
      }
    },
    [active, n, setIndex],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const rect = railRef.current?.getBoundingClientRect();
      // jsdom (tests) reports zero rects — position clicks need real layout.
      if (!rect || rect.width <= 0) return;
      // Fraction of the TRAVEL range (inside the 13px insets), matching the
      // pos() stop math.
      const frac = (e.clientX - rect.left - INSET) / (rect.width - INSET * 2);
      setIndex(Math.round(frac * (n - 1)));
    },
    [n, setIndex],
  );

  return (
    <div className="seg-slider-wrap" title={activeOption?.title ?? activeOption?.label}>
      <div
        ref={railRef}
        className={`seg-slider${isMax ? " max" : ""}`}
        role="slider"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={n - 1}
        aria-valuenow={active}
        aria-valuetext={activeOption?.label}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        // The active level's color drives the fill + the max-tier pulse.
        style={{ "--seg-color": activeColor } as React.CSSProperties}
      >
        <span
          aria-hidden="true"
          className="seg-slider-fill"
          style={{ width: pos(active), background: activeColor }}
        />
        {options.map((o, i) => (
          <span
            key={o.value}
            aria-hidden="true"
            className="seg-slider-dot"
            style={{ left: pos(i) }}
          />
        ))}
        <span aria-hidden="true" className="seg-slider-knob" style={{ left: pos(active) }} />
      </div>
      <div className="seg-slider-labels" aria-hidden="true">
        {options.map((o, i) => (
          <span
            key={o.value}
            className={`seg-slider-label${i === active ? " selected" : ""}`}
            style={{ left: pos(i), transform: labelTransform(i) }}
          >
            {o.label}
          </span>
        ))}
      </div>
    </div>
  );
}
