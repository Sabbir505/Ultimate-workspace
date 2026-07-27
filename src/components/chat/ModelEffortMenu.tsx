// Combined model + effort selector for the chat composer. A single pill
// trigger ("kimi-k2.6 · Medium ▾") opens an upward glass menu listing the
// fetched models, with a search box to filter them (fuzzy, same matcher as the
// command palette) and an "Effort" row that expands a side submenu.
import { useEffect, useMemo, useRef, useState } from "react";
import { fuzzyFilter, type FuzzyResult } from "../../lib/fuzzy";

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

  // Fuzzy-filter each section by the search query (empty query shows all).
  // Keyboard navigation spans the concatenation: cloud items first, local after.
  const rankedCloud = useMemo(() => {
    if (query.trim().length === 0) {
      return cloudItems.map((m) => ({ item: m, matches: [] as number[], score: 0 }));
    }
    const hits = fuzzyFilter(query, cloudItems, (m) => m);
    return hits.map((h) => ({ item: h.item, matches: h.matches, score: h.score }));
  }, [query, models, localModels]);

  const rankedLocal = useMemo(() => {
    if (query.trim().length === 0) {
      return localItems.map((m) => ({ item: m, matches: [] as number[], score: 0 }));
    }
    const hits = fuzzyFilter(query, localItems, (m) => m);
    return hits.map((h) => ({ item: h.item, matches: h.matches, score: h.score }));
  }, [query, models, localModels]);

  const ranked = useMemo(
    () => [...rankedCloud, ...rankedLocal],
    [rankedCloud, rankedLocal],
  );

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
      if (pick) chooseModel(pick.item);
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
  const renderItem = (
    r: { item: string; matches: number[]; score: number },
    i: number,
    local = false,
  ) => (
    <button
      key={`${local ? "local:" : ""}${r.item}`}
      ref={(el) => {
        itemRefs.current[i] = el;
      }}
      type="button"
      role="menuitemradio"
      aria-checked={r.item === model}
      className={`model-effort-item${r.item === model ? " selected" : ""}${
        i === activeIndex ? " active" : ""
      }`}
      onClick={() => chooseModel(r.item)}
      onPointerEnter={() => setActiveIndex(i)}
    >
      <span>
        {query.trim().length > 0
          ? highlight(r.item, {
              score: r.score,
              matches: r.matches,
            })
          : r.item}
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        {local && <span className="model-effort-local-badge">Local</span>}
        {r.item === model && <span className="model-effort-check">✓</span>}
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
            model || "Select model"
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
