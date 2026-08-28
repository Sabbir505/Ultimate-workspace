// PDF viewer for the artifact preview pane, built on pdf.js (Mozilla,
// Apache-2.0). Replaces the native <embed> viewer: identical rendering on
// WebView2 / WKWebView / WebKitGTK (the GTK webview has NO built-in PDF
// viewer), plus in-app search, page navigation and text selection the
// native plugin never exposed programmatically.
//
// Architecture: continuous vertical scroll; each page renders lazily when
// it scrolls near the viewport (IntersectionObserver) and re-renders on
// zoom changes. A DOM text layer sits over each canvas so selection/copy
// work. If pdf.js fails on a pathological file, the component falls back
// to the native <embed> so previews never regress.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 4;
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

function dataUriToBytes(dataUri: string): Uint8Array {
  const b64 = dataUri.slice(dataUri.indexOf(",") + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

type ZoomMode =
  | { mode: "fit" }
  | { mode: "manual"; scale: number };

interface SearchHit {
  page: number;
  index: number;
}

/** One lazy-rendered page: canvas + text layer. */
function PageView({
  pdf,
  pageNumber,
  zoom,
  fitScale,
  renderEpoch,
}: {
  pdf: pdfjs.PDFDocumentProxy;
  pageNumber: number;
  zoom: ZoomMode;
  fitScale: number;
  renderEpoch: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [cssSize, setCssSize] = useState<{ w: number; h: number } | null>(null);

  const scale = zoom.mode === "fit" ? fitScale : zoom.scale;

  // Visibility gate: render only pages near the viewport.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setVisible(true);
          else setVisible(false);
        }
      },
      // Render slightly before entering the viewport to avoid flashes.
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null;

    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        setCssSize({ w: viewport.width, h: viewport.height });

        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        // Backing store at devicePixelRatio; the dpr transform maps the
        // viewport's CSS-unit drawing onto it (same as the pdf.js viewer).
        const task = page.render({
          // Backwards-compat context path (v6 types: canvas must be null
          // when the context is used directly).
          canvas: null,
          canvasContext: ctx,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        renderTask = task as unknown as { cancel: () => void; promise: Promise<unknown> };
        await task.promise;

        // Text layer for selection/copy — rendered after the canvas so the
        // spans never flash before the page bitmap.
        const textDivs = textRef.current;
        if (cancelled || !textDivs) return;
        textDivs.innerHTML = "";
        const textContent = await page.getTextContent();
        if (cancelled || !textRef.current) return;
        const layer = new pdfjs.TextLayer({
          textContentSource: textContent,
          container: textRef.current,
          viewport: page.getViewport({ scale }),
        });
        await layer.render();
      } catch (err) {
        // Cancelled renders throw — ignore those; real errors show a blank
        // page rather than killing the whole document view.
        if (!cancelled && !/cancel/i.test(String(err))) {
          console.warn(`[PdfViewer] page ${pageNumber} render failed`, err);
        }
      }
    })();

    return () => {
      cancelled = true;
      try {
        renderTask?.cancel();
      } catch {
        // already settled
      }
    };
  }, [pdf, pageNumber, scale, visible, renderEpoch]);

  return (
    <div
      ref={wrapRef}
      className="pdf-page"
      data-page={pageNumber}
      style={cssSize ? { width: cssSize.w, height: cssSize.h } : undefined}
    >
      <canvas ref={canvasRef} />
      <div ref={textRef} className="pdf-text-layer" />
    </div>
  );
}

export function PdfViewer({
  dataUri,
  filename,
  fallback,
}: {
  dataUri: string;
  filename: string;
  /** Rendered when pdf.js cannot open the document (e.g. native <embed>). */
  fallback?: React.ReactNode;
}) {
  const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState<ZoomMode>({ mode: "fit" });
  const [fitScale, setFitScale] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [hitIdx, setHitIdx] = useState(0);
  const [searching, setSearching] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const renderEpoch = useMemo(() => Date.now(), [zoom]);

  // Open the document once.
  useEffect(() => {
    let cancelled = false;
    const task = pdfjs.getDocument({ data: dataUriToBytes(dataUri) });
    void task.promise
      .then((doc) => {
        if (!cancelled) setPdf(doc);
      })
      .catch((err: unknown) => {
        console.warn("[PdfViewer] failed to open document", err);
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [dataUri]);

  // Fit-width scale tracks the container size.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const compute = () => {
      // A4 width in CSS points at scale 1 ≈ 595; derive from page 1 once
      // loaded, else keep the previous value.
      if (pdf) {
        void pdf.getPage(1).then((page) => {
          const w = page.getViewport({ scale: 1 }).width;
          setFitScale(Math.max(0.2, (el.clientWidth - 32) / w));
        });
      }
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pdf]);

  // Track which page the viewport is on.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pdf) return;
    const io = new IntersectionObserver(
      (entries) => {
        let best: { page: number; ratio: number } | null = null;
        for (const e of entries) {
          const n = Number((e.target as HTMLElement).dataset.page);
          if (!n) continue;
          if (!best || e.intersectionRatio > best.ratio) best = { page: n, ratio: e.intersectionRatio };
        }
        if (best && best.ratio > 0) setCurrentPage(best.page);
      },
      { threshold: [0.1, 0.3, 0.6] },
    );
    for (const child of Array.from(el.querySelectorAll(".pdf-page"))) io.observe(child);
    return () => io.disconnect();
  }, [pdf, fitScale, zoom, renderEpoch]);

  const jumpToPage = useCallback((page: number) => {
    const el = scrollRef.current?.querySelector(`[data-page="${page}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // Search: full-document text scan, hits jump between pages.
  const runSearch = useCallback(async () => {
    if (!pdf || !query.trim()) {
      setHits(null);
      return;
    }
    setSearching(true);
    try {
      const needle = query.trim().toLowerCase();
      const found: SearchHit[] = [];
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        const text = content.items
          .map((it) => ("str" in it ? it.str : ""))
          .join(" ")
          .toLowerCase();
        let idx = text.indexOf(needle);
        while (idx !== -1 && found.length < 500) {
          found.push({ page: p, index: idx });
          idx = text.indexOf(needle, idx + needle.length);
        }
      }
      setHits(found);
      setHitIdx(0);
      if (found.length > 0) jumpToPage(found[0].page);
    } finally {
      setSearching(false);
    }
  }, [pdf, query, jumpToPage]);

  const stepHit = useCallback(
    (dir: 1 | -1) => {
      if (!hits || hits.length === 0) return;
      const next = (hitIdx + dir + hits.length) % hits.length;
      setHitIdx(next);
      jumpToPage(hits[next].page);
    },
    [hits, hitIdx, jumpToPage],
  );

  // Ctrl+F focuses the search box.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, []);

  const stepZoom = useCallback(
    (dir: 1 | -1) => {
      setZoom((z) => {
        const current = z.mode === "fit" ? fitScale : z.scale;
        let target = current;
        if (dir === 1) target = ZOOM_STEPS.find((s) => s > current + 0.01) ?? ZOOM_MAX;
        else target = [...ZOOM_STEPS].reverse().find((s) => s < current - 0.01) ?? ZOOM_MIN;
        return { mode: "manual", scale: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, target)) };
      });
    },
    [fitScale],
  );

  if (error) {
    return <>{fallback ?? <div className="artifact-preview-error">This PDF could not be rendered.</div>}</>;
  }

  const effectiveScale = zoom.mode === "fit" ? fitScale : zoom.scale;

  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar">
        <button
          type="button"
          className="pdf-toolbar-btn"
          title="Previous page"
          aria-label="Previous page"
          disabled={!pdf || currentPage <= 1}
          onClick={() => jumpToPage(currentPage - 1)}
        >
          ↑
        </button>
        <span className="pdf-page-indicator">
          {pdf ? (
            <input
              className="pdf-page-input"
              type="number"
              min={1}
              max={pdf.numPages}
              value={currentPage}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (n >= 1 && pdf && n <= pdf.numPages) jumpToPage(n);
              }}
            />
          ) : (
            "–"
          )}
          {pdf ? ` / ${pdf.numPages}` : ""}
        </span>
        <button
          type="button"
          className="pdf-toolbar-btn"
          title="Next page"
          aria-label="Next page"
          disabled={!pdf || !pdf.numPages || currentPage >= pdf.numPages}
          onClick={() => jumpToPage(currentPage + 1)}
        >
          ↓
        </button>
        <span className="pdf-toolbar-sep" />
        <button
          type="button"
          className="pdf-toolbar-btn"
          title="Zoom out"
          aria-label="Zoom out"
          disabled={!pdf}
          onClick={() => stepZoom(-1)}
        >
          −
        </button>
        <button
          type="button"
          className="pdf-toolbar-btn pdf-zoom-label"
          title="Fit to width"
          onClick={() => setZoom({ mode: "fit" })}
        >
          {Math.round(effectiveScale * 100)}%
        </button>
        <button
          type="button"
          className="pdf-toolbar-btn"
          title="Zoom in"
          aria-label="Zoom in"
          disabled={!pdf}
          onClick={() => stepZoom(1)}
        >
          +
        </button>
        <span className="pdf-toolbar-spacer" />
        <input
          ref={searchInputRef}
          className="pdf-search-input"
          type="text"
          placeholder="Search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runSearch();
          }}
        />
        <button
          type="button"
          className="pdf-toolbar-btn"
          title="Search"
          aria-label="Search"
          disabled={!pdf || !query.trim() || searching}
          onClick={() => void runSearch()}
        >
          ⌕
        </button>
        {hits && (
          <span className="pdf-search-count">
            {hits.length === 0 ? "no hits" : `${hitIdx + 1}/${hits.length}`}
          </span>
        )}
        {hits && hits.length > 1 && (
          <>
            <button type="button" className="pdf-toolbar-btn" title="Previous match" onClick={() => stepHit(-1)}>
              ∧
            </button>
            <button type="button" className="pdf-toolbar-btn" title="Next match" onClick={() => stepHit(1)}>
              ∨
            </button>
          </>
        )}
      </div>
      <div className="pdf-scroll" ref={scrollRef} tabIndex={0}>
        {!pdf ? (
          <div className="artifact-preview-loading">Opening PDF…</div>
        ) : (
          <div className="pdf-pages">
            {Array.from({ length: pdf.numPages }, (_, i) => (
              <PageView
                key={`${filename}-${i + 1}`}
                pdf={pdf}
                pageNumber={i + 1}
                zoom={zoom}
                fitScale={fitScale}
                renderEpoch={renderEpoch}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
