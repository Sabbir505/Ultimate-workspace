// PDF viewer for vault assets — pdfjs renders pages into a continuous
// scroll with a REAL text layer, so sentences are selectable. Selecting
// text and pressing the highlighter creates persistent highlights (stored
// per vault+file in localStorage as page-fraction rects, so they survive
// zoom/resize). Full editing stays with "Open in system app".

import { useEffect, useRef, useState } from "react";
import { Eraser, ExternalLink, Highlighter, Loader2 } from "lucide-react";
import * as pdfjs from "pdfjs-dist";
import { PDFJS_WASM_URL, PDFJS_WORKER_URL } from "../../lib/pdfjsAssets";
import { openArtifact } from "../../lib/ipc/harnessChat";
import { useVaultStore } from "../../state/vault";

pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;

interface PdfHighlight {
  id: string;
  page: number;
  color: string;
  /** Rects as fractions of the page box (x/y/w/h in 0..1). */
  rects: { x: number; y: number; w: number; h: number }[];
}

const HIGHLIGHT_COLORS = ["#ffd54d", "#7ad97a", "#ff8f8f", "#8fc2ff"];

/** Per-document view state (zoom + page), remembered across tab switches.
 *  The viewer unmounts when the user switches asset tabs, and without this
 *  every switch dumped them back at page 1 / 100%. Session-scoped, like the
 *  note pane's per-note mode memory — not persisted to disk. */
const viewState = new Map<string, { zoom: number; page: number }>();

/** Record a document's view state. Kept top-level (not a hook) so the
 *  zoom/page setters can call it without threading a dependency. */
function rememberView(path: string, next: { zoom: number; page: number }) {
  viewState.set(path, next);
}

/** pdf.js rejects a render task with RenderingCancelledException when a newer
 *  render supersedes it or the document is destroyed — the normal outcome of
 *  zooming, resizing the split, or closing the note mid-draw. A text-layer
 *  request that outlives its worker reports the same thing more prosaically
 *  ("Worker task was terminated"). Both are expected aborts, not faults.
 *  Match on name/message so this doesn't depend on pdf.js re-exporting
 *  classes or keeping its wording. */
function isRenderCancelled(e: unknown): boolean {
  const err = e as { name?: string; message?: string } | null;
  if (err?.name === "RenderingCancelledException") return true;
  return typeof err?.message === "string" && err.message.includes("Worker task was terminated");
}

function highlightsKey(root: string | null, path: string): string {
  return `relay.vault.pdfhl:${root ?? ""}:${path}`;
}

function loadHighlights(key: string): PdfHighlight[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as PdfHighlight[]) : [];
  } catch {
    return [];
  }
}

function saveHighlights(key: string, items: PdfHighlight[]) {
  try {
    localStorage.setItem(key, JSON.stringify(items));
  } catch {
    // storage unavailable — highlights won't persist this session
  }
}

export function VaultPdfViewer({ path }: { path: string }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const docRef = useRef<pdfjs.PDFDocumentProxy | null>(null);
  const taskRef = useRef<pdfjs.PDFDocumentLoadingTask | null>(null);
  const renderedRef = useRef<Set<number>>(new Set());
  /** In-flight render task per page. A zoom or pane-width change remounts
   *  every page element (see the `key` below) and re-observes, which starts
   *  a second render for pages already drawing. pdf.js cancels the older one
   *  implicitly and its promise REJECTS with RenderingCancelledException —
   *  holding the task lets the supersede cancel it deliberately (and lets
   *  unmount cancel everything) instead of leaving it to reject on its own. */
  const renderTasksRef = useRef(new Map<number, { cancel: () => void }>());
  const highlightsRef = useRef<PdfHighlight[]>([]);
  const [numPages, setNumPages] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [color, setColor] = useState(HIGHLIGHT_COLORS[0]);
  const [erase, setErase] = useState(false);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [zoom, setZoom] = useState(() => viewState.get(path)?.zoom ?? 1);
  const [page, setPage] = useState(() => viewState.get(path)?.page ?? 1);
  /** Live width of the pages container — when the note pane opens/closes
   *  or rails resize, pages re-render at the new fit scale. */
  const [paneWidth, setPaneWidth] = useState(0);
  /** While the user is typing a page number, scroll tracking must not
   *  rewrite the input (it fires on the smooth-scroll the jump triggers —
   *  that fight is what made selection/typing impossible). */
  const [pageDraft, setPageDraft] = useState<string | null>(null);
  const [, forceRender] = useState(0);
  const root = useVaultStore((s) => s.root);
  const key = highlightsKey(root, path);

  // Load highlights for THIS file whenever it changes.
  useEffect(() => {
    highlightsRef.current = loadHighlights(key);
    forceRender((n) => n + 1);
  }, [key]);

  // Load + dispose the document.
  useEffect(() => {
    let alive = true;
    setReady(false);
    setError(null);
    setNumPages(0);
    renderedRef.current = new Set();
    void (async () => {
      try {
        const { vaultReadBinary } = await import("../../lib/ipc");
        const [, b64] = await vaultReadBinary(path);
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        // wasmUrl is REQUIRED for JBIG2 images (scanned PDFs): without it
        // pdf.js tries to resolve "nulljbig2_nowasm_fallback.js" and every
        // scanned page paints with empty image boxes.
        const task = pdfjs.getDocument({ data: bytes, wasmUrl: PDFJS_WASM_URL });
        taskRef.current = task;
        const doc = await task.promise;
        if (!alive) return;
        docRef.current = doc;
        setNumPages(doc.numPages);
        setReady(true);
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => {
      alive = false;
      docRef.current = null;
      renderedRef.current = new Set();
      // Stop anything still drawing before the document goes away — these
      // tasks would otherwise reject with RenderingCancelledException.
      for (const t of renderTasksRef.current.values()) t.cancel();
      renderTasksRef.current.clear();
      void taskRef.current?.destroy();
      taskRef.current = null;
    };
  }, [path]);

  // Return to the page this document was on last time it was open (tab
  // switches unmount the viewer, so the scroll position would otherwise be
  // lost). Runs once the pages are laid out and the remembered page exists.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!ready || !numPages) return;
    if (restoredRef.current) return;
    const saved = viewState.get(path);
    if (!saved || saved.page <= 1) {
      restoredRef.current = true;
      return;
    }
    restoredRef.current = true;
    const el = pageRefs.current.get(saved.page);
    if (el) el.scrollIntoView({ block: "start" });
  }, [ready, numPages, path]);

  // Lazy page rendering: an IntersectionObserver renders each page's canvas
  // + text layer the first time it scrolls near the viewport.
  //
  // Page elements are STABLE across zoom and pane-width changes (key is just
  // the page number). Re-keying them on zoom/width used to remount the whole
  // set on every change: the old canvas was destroyed before the new one
  // painted (a visible flash per change), and any render in flight was left
  // holding a detached element — which is where "Node cannot be found in the
  // current page" came from, a DOM Range API handed a node no longer in the
  // document. Instead, a zoom/width change cancels in-flight work, clears the
  // rendered set, and re-renders the pages currently in view into the SAME
  // elements; renderPage paints each new canvas offscreen and swaps it in, so
  // the old image stays on screen until the new one is ready.
  useEffect(() => {
    if (!ready) return;
    const wrap = wrapRef.current;
    const doc = docRef.current;
    if (!wrap || !doc) return;
    renderedRef.current = new Set();
    for (const t of renderTasksRef.current.values()) t.cancel();
    renderTasksRef.current.clear();
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const n = Number((entry.target as HTMLElement).dataset.page);
          if (n && !renderedRef.current.has(n)) {
            // Never let a render rejection escape as an unhandled promise:
            // renderPage already treats cancellation as normal, so anything
            // arriving here is a genuine failure worth logging.
            void renderPage(n).catch((e) => {
              console.error(`[vault-pdf] page ${n} failed to render`, e);
            });
          }
        }
      },
      { root: wrap, rootMargin: "600px 0px" },
    );
    for (const [, el] of pageRefs.current) io.observe(el);
    // The observer only fires on CHANGES, and these elements were already
    // observed — so after clearing the rendered set, the pages currently in
    // view must be re-rendered explicitly or a zoom would leave them stale.
    renderVisible();
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, numPages, zoom, paneWidth]);

  /** Render every page whose element sits inside the viewport plus the
   *  observer's margin. Mirrors the IO's geometry so the manual pass and the
   *  scroll-driven pass agree on what "visible" means. */
  const renderVisible = () => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const wrapRect = wrap.getBoundingClientRect();
    const margin = 600;
    for (const [n, el] of pageRefs.current) {
      if (renderedRef.current.has(n)) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom >= wrapRect.top - margin && r.top <= wrapRect.bottom + margin) {
        void renderPage(n).catch((e) => {
          console.error(`[vault-pdf] page ${n} failed to render`, e);
        });
      }
    }
  };

  // Watch the container width (note pane split, rail resize, window resize).
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      setPaneWidth((prev) => (Math.abs(prev - w) > 2 ? w : prev));
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  const renderPage = async (n: number) => {
    const doc = docRef.current;
    const host = pageRefs.current.get(n);
    if (!doc || !host || renderedRef.current.has(n)) return;
    // Page elements are keyed on zoom + pane width, so any zoom or split
    // resize REMOUNTS them mid-render and leaves `host` detached. Everything
    // below is async, so by the time we reach the text layer this closure can
    // be holding a dead subtree — building a TextLayer into it wastes work and
    // trips pdf.js ("Node cannot be found in the current page"). Re-check
    // liveness after every await and bail if this page is no longer the live
    // element; the re-render that replaced it is already under way.
    const stillLive = () => pageRefs.current.get(n) === host && host.isConnected;
    // A render of this page may still be in flight (the pages remount on
    // zoom/width change). Cancel it explicitly rather than letting pdf.js
    // cancel it implicitly from under us.
    renderTasksRef.current.get(n)?.cancel();
    renderTasksRef.current.delete(n);
    const page = await doc.getPage(n);
    // The document can be destroyed (note closed, another file opened) while
    // getPage was in flight — drawing into it now would throw.
    if (docRef.current !== doc || !stillLive()) return;
    const base = page.getViewport({ scale: 1 });
    const dpr = window.devicePixelRatio || 1;
    const fitScale = Math.max(0.2, (wrapRef.current?.clientWidth ?? 800) - 32) / base.width;
    const scale = fitScale * zoom;
    const viewport = page.getViewport({ scale: scale * dpr });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = `${Math.round(viewport.width / dpr)}px`;
    canvas.style.height = `${Math.round(viewport.height / dpr)}px`;
    canvas.style.display = "block";
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const task = page.render({ canvas, viewport });
    renderTasksRef.current.set(n, task);
    try {
      await task.promise;
    } catch (e) {
      // A cancelled render is the NORMAL outcome of a supersede or a
      // destroyed document, not a fault. Un-mark the page so it can be drawn
      // again — but ONLY if no newer render has taken over the slot: a
      // superseded render must not un-mark the page its successor just
      // painted (that un-mark was a re-render feedback loop waiting to
      // happen).
      if (renderTasksRef.current.get(n) === task) renderedRef.current.delete(n);
      if (!isRenderCancelled(e)) throw e;
      return;
    } finally {
      // Only clear our own entry: a superseding render may already have
      // stored its task under this page number.
      if (renderTasksRef.current.get(n) === task) renderTasksRef.current.delete(n);
    }
    if (!stillLive()) return;
    // Swap the painted canvas in atomically. Painting offscreen first means
    // the previous image stays on screen for the whole redraw — replacing the
    // canvas BEFORE the await is what made every zoom/resize flash blank.
    host.querySelector(".pdf-canvas-slot")?.replaceChildren(canvas);
    // Marked only once the canvas is actually painted.
    renderedRef.current.add(n);
    // Text layer at CSS-px scale (NOT dpr-scaled) so spans align with the
    // canvas box and the browser can offer native text selection.
    const cssViewport = page.getViewport({ scale });
    const text = await page.getTextContent().catch((e) => {
      // A worker torn down under us (note closed, file switched) is an abort,
      // not a failure; the canvas above is already painted.
      if (isRenderCancelled(e)) return null;
      throw e;
    });
    if (!text || !stillLive()) return;
    const layer = host.querySelector(".pdf-text-layer") as HTMLElement | null;
    if (layer) {
      layer.replaceChildren();
      layer.style.setProperty("--scale-factor", String(scale));
      const tl = new pdfjs.TextLayer({ textContentSource: text, container: layer, viewport: cssViewport });
      // TextLayer walks up from `container` to find its page, so it throws if
      // the layer was detached between the liveness check above and here (a
      // zoom landing mid-render). The canvas is already painted, so a failed
      // text layer costs selection on that page, not the page itself — and
      // the re-render that replaced it will rebuild both.
      await tl.render().catch((e) => {
        if (!isRenderCancelled(e)) console.warn(`[vault-pdf] text layer for page ${n} failed`, e);
      });
      if (!stillLive()) return;
      // The official viewer's selection sentinel: without it a drag that
      // touches the layer's empty edge selects the whole page (the classic
      // "I picked two words and got the entire document" bug).
      const eoc = document.createElement("div");
      eoc.className = "endOfContent";
      layer.appendChild(eoc);
    }
  };

  // Selection → highlight: pointerup inside a page converts the browser
  // selection's client rects into page-fraction rects. The raw range rects
  // are SANITY-FILTERED: a selection that grazed the layer's edge (or the
  // endOfContent sentinel) reports container-sized boxes — those are
  // dropped so a two-word selection can never paint the whole page.
  const onPointerUp = () => {
    if (erase) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const anchor = range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    const host = anchor?.closest(".pdf-page") as HTMLElement | null;
    const layer = anchor?.closest(".pdf-text-layer") as HTMLElement | null;
    if (!host || !layer) return; // selection leaked outside the text layer
    const pageNum = Number(host.dataset.page);
    const base = host.getBoundingClientRect();
    if (!base.width || !base.height) return;
    let rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 2);
    if (rects.length === 0) return;
    // Line-height filter: keep rects near the median text height (drops
    // whole-page/container boxes), then drop rects wider than the page.
    const heights = rects.map((r) => r.height).sort((a, b) => a - b);
    const median = heights[Math.floor(heights.length / 2)] || 0;
    const maxH = Math.max(28, median * 2.5);
    rects = rects.filter((r) => r.height <= maxH && r.width <= base.width * 0.98);
    if (rects.length === 0) return;
    const items: PdfHighlight["rects"] = rects.map((r) => ({
      x: (r.left - base.left) / base.width,
      y: (r.top - base.top) / base.height,
      w: r.width / base.width,
      h: r.height / base.height,
    }));
    const item: PdfHighlight = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      page: pageNum,
      color,
      rects: items,
    };
    highlightsRef.current = [...highlightsRef.current, item];
    saveHighlights(key, highlightsRef.current);
    forceRender((n) => n + 1);
    sel.removeAllRanges();
  };

  const removeHighlight = (id: string) => {
    highlightsRef.current = highlightsRef.current.filter((h) => h.id !== id);
    saveHighlights(key, highlightsRef.current);
    forceRender((n) => n + 1);
  };

  // Track the page nearest the viewport top while scrolling.
  const onPagesScroll = () => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const wrapTop = wrap.getBoundingClientRect().top;
    let current = 1;
    for (const [n, el] of pageRefs.current) {
      if (el.getBoundingClientRect().top - wrapTop <= 60) current = Math.max(current, n);
    }
    setPage((p) => {
      if (p !== current) rememberView(path, { zoom, page: current });
      return current;
    });
  };

  // Ctrl/Cmd + wheel zooms (pinch on trackpads sends the same event). Plain
  // wheel keeps scrolling pages. A native non-passive listener is required:
  // React's onWheel is passive and couldn't preventDefault the webview's
  // own page-zoom.
  const pagesRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = pagesRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setZoom((z) => {
        const next = Math.min(3, Math.max(0.4, Number((z * (e.deltaY < 0 ? 1.1 : 0.9)).toFixed(2))));
        rememberView(path, { zoom: next, page });
        return next;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const goToPage = (n: number) => {
    const clamped = Math.min(numPages || 1, Math.max(1, n));
    const el = pageRefs.current.get(clamped);
    if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
    setPage(clamped);
    rememberView(path, { zoom, page: clamped });
  };

  const pages = Array.from({ length: numPages }, (_, i) => i + 1);

  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar">
        {/* Highlighter pen — hover opens the color picker popover; the pen
            is tinted with the active color. */}
        <div
          className="pdf-tool-group"
          onMouseEnter={() => setColorPickerOpen(true)}
          onMouseLeave={() => setColorPickerOpen(false)}
        >
          <button
            className={`pdf-tool-btn${!erase ? " active" : ""}`}
            title={`Highlighter (color: ${color})`}
            onClick={() => {
              setColorPickerOpen((v) => !v);
              setErase(false);
            }}
          >
            <Highlighter size={14} style={{ color: erase ? undefined : color }} />
          </button>
          {colorPickerOpen ? (
            <div className="pdf-color-pop">
              {HIGHLIGHT_COLORS.map((c) => (
                <button
                  key={c}
                  className={`pdf-color-dot${color === c ? " active" : ""}`}
                  style={{ background: c }}
                  title="Highlight color"
                  onClick={() => {
                    setColor(c);
                    setErase(false);
                    setColorPickerOpen(false);
                  }}
                />
              ))}
            </div>
          ) : null}
        </div>
        {/* Eraser: click a highlight to remove it. */}
        <button
          className={`pdf-tool-btn${erase ? " active" : ""}`}
          title="Eraser — click a highlight to remove it"
          onClick={() => setErase((v) => !v)}
        >
          <Eraser size={14} />
        </button>
        {/* Zoom + page navigation. */}
        <span className="pdf-toolbar-sep" />
        <button className="pdf-tool-btn" title="Zoom out" onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.15).toFixed(2)))}>
          −
        </button>
        <button
          className="pdf-tool-btn pdf-zoom-label"
          title="Reset zoom"
          onClick={() => {
            setZoom(1);
            rememberView(path, { zoom: 1, page });
          }}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button className="pdf-tool-btn" title="Zoom in" onClick={() => setZoom((z) => Math.min(3, +(z + 0.15).toFixed(2)))}>
          +
        </button>
        <span className="pdf-toolbar-sep" />
        <input
          className="pdf-page-input"
          type="number"
          min={1}
          max={numPages || 1}
          value={pageDraft ?? page}
          onChange={(e) => setPageDraft(e.target.value)}
          onBlur={() => {
            if (pageDraft != null) goToPage(Number(pageDraft) || page);
            setPageDraft(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              if (pageDraft != null) goToPage(Number(pageDraft) || page);
              setPageDraft(null);
              e.currentTarget.blur();
            }
            if (e.key === "Escape") {
              setPageDraft(null);
              e.currentTarget.blur();
            }
          }}
          title="Page number — type and press Enter"
        />
        <span className="pdf-page-total">/ {numPages || "…"}</span>
        <span className="pdf-toolbar-pages">{ready ? `${numPages} pages` : ""}</span>
        <button
          className="pdf-tool-btn"
          title="Open in system app"
          onClick={() => {
            const r = useVaultStore.getState().root;
            if (r) void openArtifact(`${r}/${path}`);
          }}
        >
          <ExternalLink size={14} />
        </button>
      </div>
      <div className="pdf-pages" ref={(el) => { wrapRef.current = el; pagesRef.current = el; }} onPointerUp={onPointerUp} onScroll={onPagesScroll}>
        {!ready && !error ? (
          <div className="vault-center-placeholder"><Loader2 className="spin" size={16} /> Opening PDF…</div>
        ) : error ? (
          <div className="vault-center-placeholder">Could not open the PDF: {error}</div>
        ) : (
          pages.map((n) => (
            <div
              key={n}
              className="pdf-page"
              data-page={n}
              ref={(el) => {
                if (el) pageRefs.current.set(n, el);
                else pageRefs.current.delete(n);
              }}
            >
              <div className="pdf-canvas-slot" />
              <div className="pdf-text-layer" />
              {highlightsRef.current
                .filter((h) => h.page === n)
                .map((h) => (
                  <div
                    key={h.id}
                    className={`pdf-highlight${erase ? " erasable" : ""}`}
                    title={erase ? "Click to remove" : undefined}
                    style={{ pointerEvents: erase ? "auto" : "none" }}
                    onClick={erase ? () => removeHighlight(h.id) : undefined}
                  >
                    {h.rects.map((r, i) => (
                      <span
                        key={i}
                        style={{
                          left: `${r.x * 100}%`,
                          top: `${r.y * 100}%`,
                          width: `${r.w * 100}%`,
                          height: `${r.h * 100}%`,
                          background: h.color,
                        }}
                      />
                    ))}
                  </div>
                ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
