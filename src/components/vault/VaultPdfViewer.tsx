// PDF viewer for vault assets — pdfjs renders pages into a continuous
// scroll with a REAL text layer, so sentences are selectable. Selecting
// text and pressing the highlighter creates persistent highlights (stored
// per vault+file in localStorage as page-fraction rects, so they survive
// zoom/resize). Full editing stays with "Open in system app".

import { useEffect, useRef, useState } from "react";
import { Eraser, ExternalLink, Highlighter, Loader2 } from "lucide-react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { openArtifact } from "../../lib/ipc/harnessChat";
import { useVaultStore } from "../../state/vault";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

interface PdfHighlight {
  id: string;
  page: number;
  color: string;
  /** Rects as fractions of the page box (x/y/w/h in 0..1). */
  rects: { x: number; y: number; w: number; h: number }[];
}

const HIGHLIGHT_COLORS = ["#ffd54d", "#7ad97a", "#ff8f8f", "#8fc2ff"];

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
  const highlightsRef = useRef<PdfHighlight[]>([]);
  const [numPages, setNumPages] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [color, setColor] = useState(HIGHLIGHT_COLORS[0]);
  const [erase, setErase] = useState(false);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState(1);
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
        const task = pdfjs.getDocument({ data: bytes });
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
      void taskRef.current?.destroy();
      taskRef.current = null;
    };
  }, [path]);

  // Lazy page rendering: an IntersectionObserver renders each page's canvas
  // + text layer the first time it scrolls near the viewport. A zoom or
  // PANE-WIDTH change remounts every page (key) — reset the rendered set and
  // re-observe, so pages always fit the space they actually have (opening a
  // note beside the pdf shrinks the pane; the pages must follow).
  useEffect(() => {
    if (!ready) return;
    const wrap = wrapRef.current;
    const doc = docRef.current;
    if (!wrap || !doc) return;
    renderedRef.current = new Set();
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const n = Number((entry.target as HTMLElement).dataset.page);
          if (n && !renderedRef.current.has(n)) void renderPage(n);
        }
      },
      { root: wrap, rootMargin: "600px 0px" },
    );
    for (const [, el] of pageRefs.current) io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, numPages, zoom, paneWidth]);

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
    renderedRef.current.add(n);
    const page = await doc.getPage(n);
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
    host.querySelector(".pdf-canvas-slot")?.replaceChildren(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    await page.render({ canvas, viewport }).promise;
    // Text layer at CSS-px scale (NOT dpr-scaled) so spans align with the
    // canvas box and the browser can offer native text selection.
    const cssViewport = page.getViewport({ scale });
    const text = await page.getTextContent();
    const layer = host.querySelector(".pdf-text-layer") as HTMLElement | null;
    if (layer) {
      layer.replaceChildren();
      layer.style.setProperty("--scale-factor", String(scale));
      const tl = new pdfjs.TextLayer({ textContentSource: text, container: layer, viewport: cssViewport });
      await tl.render();
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
    setPage((p) => (p === current ? p : current));
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
      setZoom((z) =>
        Math.min(3, Math.max(0.4, Number((z * (e.deltaY < 0 ? 1.1 : 0.9)).toFixed(2)))),
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const goToPage = (n: number) => {
    const clamped = Math.min(numPages || 1, Math.max(1, n));
    const el = pageRefs.current.get(clamped);
    if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
    setPage(clamped);
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
          onClick={() => setZoom(1)}
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
              key={`${zoom}-${paneWidth}-${n}`}
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
