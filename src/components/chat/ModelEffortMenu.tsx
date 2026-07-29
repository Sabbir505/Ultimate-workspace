// Combined model + effort selector for the chat composer. A single pill
// trigger ("kimi-k2.6 · Medium ▾") opens an upward glass menu listing the
// fetched models, with a search box to filter them (fuzzy, same matcher as the
// command palette) and an "Effort" row that expands a side submenu.
import { useEffect, useMemo, useRef, useState } from "react";
import { fuzzyFilter, type FuzzyResult } from "../../lib/fuzzy";
import { shortModelName } from "../../lib/modelLabel";

export const EFFORT_LABELS: Record<string, string> = {
  "": "Default",
  low: "Low",
  medium: "Medium",
  high: "High",
};

interface Props {
  model: string;
  models: string[];
  /** Scanned local GGUF display names — rendered as a separate "Local models"
   *  section so local models are reachable from any session's selector. */
  localModels?: string[];
  effort: string;
  provider?: string;
  /** When true, a local model is being loaded onto the GPU — show a spinner
   *  on the trigger and disable model selection until it's ready. */
  modelLoading?: boolean;
  /** Local-model context size in tokens (0 = Auto). Only rendered when
   *  `provider === "local_gguf"`. */
  localCtx?: number;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
  onLocalCtxChange?: (ctx: number) => void;
}

/** Render `text` with the matched indices from `res` wrapped in <mark>. */
function highlight(text: string, res: FuzzyResult | null): JSX.Element {
  if (!res || res.matches.length === 0) return <>{text}</>;
  const set = new Set(res.matches);
  const out: Array<string | JSX.Element> = [];
  let key = 0;
  let chunk = "";
  for (let i = 0; i < text.length; i++) {
    if (set.has(i)) {
      if (chunk) {
        out.push(chunk);
        chunk = "";
      }
      out.push(
        <mark key={key++} className="model-effort-match">
          {text[i]}
        </mark>,
      );
    } else {
      chunk += text[i];
    }
  }
  if (chunk) out.push(chunk);
  return <>{out}</>;
}

/** Manual context-size entry for a local model. Keeps a local text buffer so
 *  the user can freely type a multi-digit number (e.g. "32768") without the
 *  per-keystroke clamp snapping "2" → 4096 mid-entry. The clamped value is
 *  committed only on blur or Enter; 0 / cleared / "auto" means Auto.
 *  Range + step mirror the slider (4096–131072, step 4096). */
const CTX_MIN = 4096;
const CTX_MAX = 131072;
const CTX_STEP = 4096;

function LocalContextInput({
  localCtx,
  onLocalCtxChange,
}: {
  localCtx: number | undefined;
  onLocalCtxChange: (ctx: number) => void;
}) {
  // The committed value from the slider/parent (0 or undefined = Auto). The
  // input shows this when the user isn't actively typing.
  const committed = localCtx ?? 0;
  const [draft, setDraft] = useState<string | null>(null);

  // What the input displays: the user's in-progress draft, else the committed
  // value (or "0" for Auto so the field isn't empty when not focused).
  const value = draft ?? String(committed);

  const commit = () => {
    const trimmed = (draft ?? "").trim().toLowerCase();
    if (trimmed === "" || trimmed === "0" || trimmed === "auto") {
      onLocalCtxChange(0);
    } else {
      const v = Number(trimmed);
      if (Number.isFinite(v)) {
        // Clamp to the slider range; round to the step so the slider + number
        // never disagree. 0 means Auto.
        const clamped = v <= 0 ? 0 : Math.min(CTX_MAX, Math.max(CTX_MIN, v));
        const snapped = clamped === 0 ? 0 : Math.round(clamped / CTX_STEP) * CTX_STEP;
        onLocalCtxChange(snapped);
      }
    }
    setDraft(null);
  };

  return (
    <input
      type="number"
      className="model-effort-ctx-number"
      min={0}
      max={CTX_MAX}
      step={CTX_STEP}
      value={value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          // Discard the in-progress edit.
          setDraft(null);
          (e.target as HTMLInputElement).blur();
        }
      }}
      onFocus={(e) => {
        // Seed the draft with the current committed value so the user edits
        // from a clean base, and select it for quick replacement.
        setDraft(String(committed));
        requestAnimationFrame(() => e.target.select());
      }}
      aria-label="Context size in tokens (manual)"
      title="Context size in tokens (0 = Auto; Enter to apply)"
      placeholder="Auto"
    />
  );
}

export function ModelEffortMenu({
  model,
  models,
  localModels,
  effort,
  provider,
  modelLoading,
  localCtx,
  onModelChange,
  onEffortChange,
  onLocalCtxChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(0);

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

  const cloudItems = models.length > 0 ? models : model && provider !== "local_gguf" ? [model] : [];
  // Local models, minus any already listed among the cloud models
  // (case-insensitive) so a model never appears in both sections.
  const localItems = (localModels ?? []).filter(
    (l) => !cloudItems.some((c) => c.trim().toLowerCase() === l.trim().toLowerCase()),
  );
  const totalCount = cloudItems.length + localItems.length;

  // A ranked row carries the full model id (the value passed to chooseModel /
  // stored on the session / used to spawn the sidecar) AND a display label.
  // For local models the label is the shortened base name (no quant suffix /
  // .gguf); for cloud models id === label. Deriving the label from the id
  // guarantees the same model renders the same label in every chat.
  interface Ranked {
    id: string;
    label: string;
    matches: number[];
    score: number;
  }

  // Fuzzy-filter each section by the search query (empty query shows all).
  // Keyboard navigation spans the concatenation: cloud items first, local after.
  const rankedCloud = useMemo<Ranked[]>(() => {
    if (query.trim().length === 0) {
      return cloudItems.map((m) => ({ id: m, label: m, matches: [], score: 0 }));
    }
    const hits = fuzzyFilter(query, cloudItems, (m) => m);
    return hits.map((h) => ({ id: h.item, label: h.item, matches: h.matches, score: h.score }));
  }, [query, models, localModels]);

  const rankedLocal = useMemo<Ranked[]>(() => {
    if (query.trim().length === 0) {
      return localItems.map((m) => ({ id: m, label: shortModelName(m), matches: [], score: 0 }));
    }
    // Filter against the shortened label so typing the base name matches, and
    // the highlight indices (into the label) line up with the rendered text.
    const hits = fuzzyFilter(query, localItems, (m) => shortModelName(m));
    return hits.map((h) => ({ id: h.item, label: shortModelName(h.item), matches: h.matches, score: h.score }));
  }, [query, models, localModels]);

  const ranked = useMemo<Ranked[]>(() => [...rankedCloud, ...rankedLocal], [
    rankedCloud,
    rankedLocal,
  ]);

  // Keep the active index in range as the filtered set changes.
  useEffect(() => {
    setActiveIndex((i) => (i >= ranked.length ? 0 : i));
  }, [ranked.length]);

  // Focus the search box and reset state whenever the menu opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      // Defer until the input is mounted.
      requestAnimationFrame(() => searchRef.current?.focus());
    } else {
      setEffortOpen(false);
    }
  }, [open]);

  // Scroll the active item into view during keyboard navigation.
  useEffect(() => {
    if (!open) return;
    itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const chooseModel = (m: string) => {
    onModelChange(m);
    setOpen(false);
    setEffortOpen(false);
  };

  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, ranked.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = ranked[activeIndex];
      if (pick) chooseModel(pick.id);
    } else if (e.key === "Escape") {
      if (query.length > 0) {
        setQuery("");
      } else {
        setOpen(false);
      }
    }
  };

  // One model row. `i` is the index into the concatenated ranked list (cloud
  // first, local after) used for keyboard navigation and scroll-into-view.
  // `r.id` is the value (passed to chooseModel / matched against the session's
  // stored model); `r.label` is what the user sees (shortened for local models).
  const renderItem = (r: Ranked, i: number, local = false) => (
    <button
      key={`${local ? "local:" : ""}${r.id}`}
      ref={(el) => {
        itemRefs.current[i] = el;
      }}
      type="button"
      role="menuitemradio"
      aria-checked={r.id === model}
      className={`model-effort-item${r.id === model ? " selected" : ""}${
        i === activeIndex ? " active" : ""
      }`}
      onClick={() => chooseModel(r.id)}
      onPointerEnter={() => setActiveIndex(i)}
    >
      <span title={local ? r.id : undefined}>
        {query.trim().length > 0
          ? highlight(r.label, {
              score: r.score,
              matches: r.matches,
            })
          : r.label}
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        {local && <span className="model-effort-local-badge">Local</span>}
        {r.id === model && <span className="model-effort-check">✓</span>}
      </span>
    </button>
  );

  return (
    <div className="model-effort-menu" ref={rootRef}>
      <button
        type="button"
        className="model-effort-trigger"
        onClick={() => {
          if (modelLoading) return;
          setOpen((o) => !o);
          setEffortOpen(false);
        }}
        title={modelLoading ? "Loading local model…" : "Model & effort"}
        disabled={modelLoading}
      >
        <span className="model-effort-model">
          {modelLoading ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span className="local-spinner" /> Loading…
            </span>
          ) : (
            // Show the shortened base name for local models (no quant suffix /
            // .gguf) so the pill stays readable; cloud ids are already short.
            provider === "local_gguf" && model ? shortModelName(model) : model || "Select model"
          )}
          {provider === "local_gguf" && !modelLoading && (
            <span className="model-effort-local-badge">Local</span>
          )}
        </span>
        <span className="model-effort-effort">{EFFORT_LABELS[effort] ?? effort}</span>
        <span className="model-effort-chevron" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="model-effort-popup" role="menu">
          {totalCount > 0 && (
            <div className="model-effort-search">
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onSearchKeyDown}
                placeholder={`Search ${totalCount} models…`}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          )}
          <div className="model-effort-section">
            {totalCount === 0 && (
              <div className="model-effort-empty">
                No models — set base URL &amp; key in Settings → API Keys
              </div>
            )}
            {ranked.length === 0 && totalCount > 0 && (
              <div className="model-effort-empty">No models match “{query}”.</div>
            )}
            {rankedCloud.map((r, i) => renderItem(r, i))}
            {rankedLocal.length > 0 && (
              <>
                {rankedCloud.length > 0 && <div className="model-effort-divider" />}
                <div className="model-effort-section-label">Local models</div>
                {rankedLocal.map((r, j) => renderItem(r, rankedCloud.length + j, true))}
              </>
            )}
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
              onClick={() => setEffortOpen(true)}
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
                {provider === "local_gguf" && onLocalCtxChange && (
                  <>
                    <div className="model-effort-divider" />
                    <div className="model-effort-ctx">
                      <div className="model-effort-ctx-head">
                        <span>Context</span>
                        <span className="model-effort-current">
                          {localCtx ? `${Math.round(localCtx / 1024)}k` : "Auto"}
                        </span>
                      </div>
                      <div className="model-effort-ctx-controls">
                        <button
                          type="button"
                          className={`model-effort-ctx-auto${localCtx ? "" : " selected"}`}
                          onClick={() => onLocalCtxChange(0)}
                        >
                          Auto
                        </button>
                        <input
                          type="range"
                          min={4096}
                          max={131072}
                          step={4096}
                          value={localCtx || 16384}
                          onChange={(e) => onLocalCtxChange(Number(e.target.value))}
                          aria-label="Context size in tokens"
                        />
                      </div>
                      {/* Manual entry so an exact context size can be typed
                          instead of dragged to. Sits below the slider, full
                          width of the controls row. Keeps a local draft so a
                          multi-digit value can be typed without the clamp
                          snapping mid-entry; commits on blur/Enter. 0/Auto =
                          inherit the default. Spinner arrows are hidden. */}
                      <LocalContextInput
                        localCtx={localCtx}
                        onLocalCtxChange={onLocalCtxChange!}
                      />
                      <div className="model-effort-ctx-hint">
                        Reloads the local model — context is fixed when the server starts.
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
