// Combined model + effort selector for the chat composer. A single pill
// trigger ("kimi-k2.6 · Medium ▾") opens an upward glass menu listing the
// fetched models, with an "Effort" row that expands a side submenu.
import { useEffect, useRef, useState } from "react";

export const EFFORT_LABELS: Record<string, string> = {
  "": "Default",
  low: "Low",
  medium: "Medium",
  high: "High",
};

interface Props {
  model: string;
  models: string[];
  effort: string;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
}

export function ModelEffortMenu({
  model,
  models,
  effort,
  onModelChange,
  onEffortChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside pointer.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setEffortOpen(false);
      }
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  const modelItems = models.length > 0 ? models : model ? [model] : [];

  return (
    <div className="model-effort-menu" ref={rootRef}>
      <button
        type="button"
        className="model-effort-trigger"
        onClick={() => {
          setOpen((o) => !o);
          setEffortOpen(false);
        }}
        title="Model & effort"
      >
        <span className="model-effort-model">{model || "Select model"}</span>
        <span className="model-effort-effort">{EFFORT_LABELS[effort] ?? effort}</span>
        <span className="model-effort-chevron" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="model-effort-popup" role="menu">
          <div className="model-effort-section">
            {modelItems.length === 0 && (
              <div className="model-effort-empty">
                No models — set base URL &amp; key in Settings → API Keys
              </div>
            )}
            {modelItems.map((m) => (
              <button
                key={m}
                type="button"
                role="menuitemradio"
                aria-checked={m === model}
                className={`model-effort-item${m === model ? " selected" : ""}`}
                onClick={() => {
                  onModelChange(m);
                  setOpen(false);
                  setEffortOpen(false);
                }}
              >
                <span>{m}</span>
                {m === model && <span className="model-effort-check">✓</span>}
              </button>
            ))}
          </div>
          <div className="model-effort-divider" />
          <div
            className="model-effort-effort-row"
            onPointerEnter={() => setEffortOpen(true)}
          >
            <button
              type="button"
              className="model-effort-item"
              aria-haspopup="menu"
              aria-expanded={effortOpen}
              onClick={() => setEffortOpen((o) => !o)}
            >
              <span>Effort</span>
              <span className="model-effort-current">
                {EFFORT_LABELS[effort] ?? effort} ›
              </span>
            </button>
            {effortOpen && (
              <div className="model-effort-submenu" role="menu">
                <div className="model-effort-submenu-hint">
                  Higher effort means more thorough responses, but takes longer.
                </div>
                {Object.entries(EFFORT_LABELS).map(([value, label]) => (
                  <button
                    key={value || "default"}
                    type="button"
                    role="menuitemradio"
                    aria-checked={value === effort}
                    className={`model-effort-item${value === effort ? " selected" : ""}`}
                    onClick={() => {
                      onEffortChange(value);
                      setEffortOpen(false);
                      setOpen(false);
                    }}
                  >
                    <span>
                      {label}
                      {value === "" && <span className="model-effort-badge">Default</span>}
                    </span>
                    {value === effort && <span className="model-effort-check">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
