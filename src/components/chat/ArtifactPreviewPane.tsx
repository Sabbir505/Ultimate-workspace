// Right-side preview pane for a generated artifact (file/code/document).
// Auto-opened when the model generates a file. Text-like artifacts render
// inline (markdown/code/csv/json/html); images and PDFs render via a data
// URI; binary Office formats show a file card with an "Open" button.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
// NOTE: katex.min.css is imported at app entry (src/main.tsx) so this file
// does NOT re-import it — see PERFORMANCE_AUDIT.md C8. Doing it twice would
// ship two copies in the lazy ArtifactPreviewPane chunk.
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { useSyntaxTheme } from "../../hooks/useSyntaxTheme";
import {
  downloadArtifact,
  getFileMtime,
  isLibreofficeAvailable,
  openArtifact,
  readArtifactPreview,
  type ArtifactPreview,
} from "../../lib/ipc";
import type { ChatArtifact } from "../../state/chat";
import { ArtifactExportMenu } from "./ArtifactExportMenu";
import { JsxPreview } from "./JsxPreview";
import { MermaidDiagram } from "./MermaidDiagram";
import { sanitizeHtml } from "../../lib/sanitize";
import { isInteractiveHtml } from "../../lib/interactiveHtml";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function CsvTable({ text }: { text: string }) {
  const rows = useMemo(
    () =>
      text
        .trim()
        .split(/\r?\n/)
        .map((line) => line.split(",")),
    [text],
  );
  if (rows.length === 0) return null;
  const [head, ...body] = rows;
  return (
    <div className="artifact-preview-table-wrap">
      <table className="artifact-preview-table">
        <thead>
          <tr>
            {head.map((c, i) => (
              <th key={i}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One-line notice shown above an office preview (pptx/docx/doc) that fell
 *  back to the built-in HTML converter because LibreOffice isn't installed.
 *  Renders nothing when soffice IS available (in which case the backend would
 *  have sent a PDF instead of this fallback anyway). */
function LibreOfficeHint() {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let stale = false;
    void isLibreofficeAvailable()
      .then((v) => {
        if (!stale) setAvailable(v ?? false);
      })
      .catch(() => {
        if (!stale) setAvailable(false);
      });
    return () => {
      stale = true;
    };
  }, []);
  if (available !== false) return null;
  return (
    <div className="artifact-preview-hint">
      Simplified preview — install LibreOffice for a full-fidelity PDF render.
    </div>
  );
}

/** HTML diagram frame sized to its CONTENT, not the pane: with a pane-sized
 *  iframe any overflow is clipped inside the iframe viewport where canvas
 *  pan/zoom can never reach it. After load we measure the document and set
 *  explicit pixel dimensions, so the whole diagram exists in the layout and
 *  the canvas can pan/zoom to every corner.
 *  Sandbox keeps scripts blocked; allow-same-origin is required for the
 *  parent to read contentDocument measurements (no allow-scripts, so nothing
 *  inside can execute). */
function DiagramFrame({ html, title }: { html: string; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  const measure = useCallback(() => {
    const doc = ref.current?.contentDocument;
    if (!doc) return;
    const w = Math.max(doc.documentElement.scrollWidth, doc.body?.scrollWidth ?? 0);
    const h = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0);
    if (w > 0 && h > 0) setSize({ w, h });
  }, []);

  return (
    <iframe
      ref={ref}
      className="artifact-preview-diagram-frame"
      title={title}
      sandbox="allow-same-origin"
      srcDoc={sanitizeHtml(html)}
      onLoad={measure}
      style={size ? { width: size.w, height: size.h } : undefined}
    />
  );
}

function PreviewBody({ preview }: { preview: ArtifactPreview }) {
  const { kind, text, dataUri, ext } = preview;

  if (kind === "image" && dataUri) {
    return <img className="artifact-preview-image" src={dataUri} alt={preview.filename} />;
  }
  if (kind === "pdf" && dataUri) {
    return <embed className="artifact-preview-pdf" src={dataUri} type="application/pdf" />;
  }
  if (kind === "markdown" && text != null) {
    return (
      <div className="chat-markdown artifact-preview-md">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex]}
          components={{
            // ```mermaid fences render as diagrams, not code blocks — the
            // same pipeline chat messages use (MermaidDiagram).
            code({ node: _node, className, children, ...props }) {
              if (/language-mermaid\b/.test(className ?? "")) {
                return <MermaidDiagram code={String(children).replace(/\n$/, "")} />;
              }
              return <code className={className} {...props}>{children}</code>;
            },
          }}
        >{text}</ReactMarkdown>
      </div>
    );
  }
  if (kind === "office" && text != null) {
    return (
      <>
        {(ext === "pptx" || ext === "docx" || ext === "doc") && <LibreOfficeHint />}
        <iframe
          className={`artifact-preview-html office ${ext}`}
          title={preview.filename}
          sandbox=""
          srcDoc={sanitizeHtml(text)}
        />
      </>
    );
  }
  // SVG diagrams render as an <img> (not the sandboxed iframe) so the canvas
  // pan/zoom gestures reach the container — an iframe would swallow every
  // pointer/wheel event. <img> keeps the safety property too: embedded
  // scripts in SVG never execute in an image context.
  if (kind === "diagram" && text != null && ext.toLowerCase() === "svg") {
    return (
      <img
        className="artifact-preview-image artifact-preview-diagram"
        src={`data:image/svg+xml;utf8,${encodeURIComponent(text)}`}
        alt={preview.filename}
        draggable={false}
      />
    );
  }
  // Mermaid sources (.mmd/.mermaid): render as a themed diagram via the same
  // pipeline chat fences use.
  if (kind === "mermaid" && text != null) {
    return <MermaidDiagram code={text} />;
  }
  // JSX/TSX files: render a live React preview with the same Preview/Code
  // toggle the inline chip uses. JsxPreview handles its own toolbar.
  if (kind === "jsx" && text != null) {
    const lang = ext === "tsx" ? "tsx" : "jsx";
    return <JsxPreview code={text} lang={lang} variant="pane" />;
  }
  // Plain HTML (non-diagram): live iframe preview by default, with a toggle to
  // view the raw source. Scripts/buttons/forms run inside the sandboxed frame
  // (full fidelity, same model as the JSX live preview).
  if (kind === "html" && text != null) {
    return <HtmlPreview html={text} title={preview.filename} />;
  }
  // Diagram-authored HTML: static diagrams keep the content-measured
  // sanitized frame; interactive ones (scripts/buttons — the model sometimes
  // authors webapps via generate_diagram) render LIVE, otherwise their
  // controls silently do nothing in the scripts-blocked frame.
  if (kind === "diagram" && text != null) {
    if (isInteractiveHtml(text)) {
      return <HtmlPreview html={text} title={preview.filename} />;
    }
    return <DiagramFrame html={text} title={preview.filename} />;
  }
  if (kind === "csv" && text != null) {
    return <CsvTable text={text} />;
  }
  if ((kind === "code" || kind === "json" || kind === "text") && text != null) {
    const lang = kind === "json" ? "json" : kind === "text" ? "text" : ext;
    if (kind === "text") {
      return <pre className="artifact-preview-text">{text}</pre>;
    }
    return <ArtifactCodeBlock code={text} language={lang} />;
  }

  // Binary (docx/pptx/xlsx) or unsupported: file card.
  return (
    <div className="artifact-preview-card">
      <div className="artifact-preview-card-ext">{ext.toUpperCase() || "FILE"}</div>
      <div className="artifact-preview-card-name">{preview.filename}</div>
      <div className="artifact-preview-card-size">{formatSize(preview.size)}</div>
      <p className="artifact-preview-card-note">
        This file type can’t be previewed inline. Open it in your default app.
      </p>
      <button
        type="button"
        className="artifact-preview-open"
        onClick={() => void openArtifact(preview.path)}
      >
        Open file
      </button>
    </div>
  );
}

/** HTML artifact preview: toggle between a live iframe and the raw source.
 *  The iframe sandbox allows scripts/forms/modals/popups (NO allow-same-origin)
 *  so the page is fully interactive — inline <script> tags execute, buttons
 *  work, forms submit — while the frame stays isolated from the parent window,
 *  cookies, and Tauri APIs. External resources (CDN fonts, images via https)
 *  load normally since the sandbox doesn't block network. */
function HtmlPreview({ html, title }: { html: string; title: string }) {
  const [tab, setTab] = useState<"preview" | "code">("preview");
  return (
    <div className="artifact-html-block">
      <div className="artifact-html-tabs">
        <button
          type="button"
          className={`artifact-html-tab${tab === "preview" ? " active" : ""}`}
          onClick={() => setTab("preview")}
          title="Rendered preview"
          aria-label="Rendered preview"
        >
          <PreviewIcon />
        </button>
        <button
          type="button"
          className={`artifact-html-tab${tab === "code" ? " active" : ""}`}
          onClick={() => setTab("code")}
          title="Source code"
          aria-label="Source code"
        >
          <CodeIcon />
        </button>
      </div>
      <div className="artifact-html-body">
        {tab === "preview" ? (
          <iframe
            className="artifact-preview-html"
            title={title}
            sandbox="allow-scripts allow-forms allow-modals allow-popups"
            srcDoc={html}
          />
        ) : (
          <ArtifactCodeBlock code={html} language="html" />
        )}
      </div>
    </div>
  );
}

function PreviewIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function CodeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

/** Code-block renderer for artifact previews — uses the current theme's
 *  syntax tokens (--syntax-*) so colors track data-theme. */
function ArtifactCodeBlock({ code, language }: { code: string; language: string }) {
  const theme = useSyntaxTheme();
  return (
    <SyntaxHighlighter
      style={theme}
      language={language}
      PreTag="div"
      customStyle={{
        margin: 0,
        background: "transparent",
        padding: "12px 16px",
        fontSize: "12px",
        fontFamily: "var(--font-mono)",
        lineHeight: 1.5,
        overflowX: "auto",
      }}
      codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
    >
      {code}
    </SyntaxHighlighter>
  );
}

function DownloadIcon() {
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.1;
const MIN_PANE_WIDTH = 320;

/** Zoom controls shown in the preview header. */
function ZoomControls({
  zoom,
  setZoom,
}: {
  zoom: number;
  setZoom: (fn: (z: number) => number) => void;
}) {
  const clamp = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  return (
    <div className="artifact-preview-zoom-ctrls">
      <button
        type="button"
        className="artifact-preview-header-btn"
        title="Zoom out"
        aria-label="Zoom out"
        onClick={() => setZoom((z) => clamp(z - ZOOM_STEP))}
      >
        −
      </button>
      <button
        type="button"
        className="artifact-preview-zoom-level"
        title="Reset zoom"
        aria-label="Reset zoom"
        onClick={() => setZoom(() => 1)}
      >
        {Math.round(zoom * 100)}%
      </button>
      <button
        type="button"
        className="artifact-preview-header-btn"
        title="Zoom in"
        aria-label="Zoom in"
        onClick={() => setZoom((z) => clamp(z + ZOOM_STEP))}
      >
        +
      </button>
    </div>
  );
}

export function ArtifactPreviewPane({
  artifact,
  onClose,
}: {
  artifact: ChatArtifact;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [paneWidth, setPaneWidth] = useState<number | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const inline = artifact.inline;

  // Canvas gestures (scroll-wheel zoom + left-drag pan) apply to visual
  // artifacts — diagrams and images — and use a transform-based canvas
  // (translate + scale), independent of scroll ranges: the iframe/html
  // sizing quirks never leave a reliable scrollable overflow to pan with.
  // Text-like previews keep normal scroll and the CSS-zoom reflow.
  // INTERACTIVE diagrams are excluded: their live iframe needs the pointer
  // events the gesture layer would swallow.
  const liveDiagram = !!preview && preview.kind === "diagram" && preview.text != null && isInteractiveHtml(preview.text);
  const pannable =
    !!preview &&
    (preview.kind === "image" || (preview.kind === "diagram" && !liveDiagram));
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const panRef = useRef(pan);
  panRef.current = pan;
  const wheelZoomed = useRef(false);
  const prevZoom = useRef(1);
  const panDrag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  // Scroll-wheel zoom, anchored at the cursor: the content point under the
  // pointer stays put. Attached non-passively so preventDefault works.
  //
  // NOTE (PERFORMANCE_AUDIT.md F4): unlike TerminalPane (where wheel only
  // acts while Ctrl is held, so the listener can stay passive until then),
  // here wheel IS the zoom gesture — every wheel event must be cancelable
  // to suppress native scroll while zooming. The cost is contained: the
  // listener only attaches while `pannable` (diagram/image previews).
  useEffect(() => {
    const el = contentRef.current;
    if (!el || !pannable) return;
    const clamp = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const z1 = zoomRef.current;
      const z2 = clamp(z1 * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
      wheelZoomed.current = true;
      setPan((p) => ({
        x: cx - (cx - p.x) * (z2 / z1),
        y: cy - (cy - p.y) * (z2 / z1),
      }));
      setZoom(z2);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [pannable]);

  // Button zooms (± / reset) have no cursor anchor — re-anchor at the pane
  // center instead. Wheel zooms set their own anchor and skip this pass.
  useEffect(() => {
    const el = contentRef.current;
    const z1 = prevZoom.current;
    prevZoom.current = zoom;
    if (!el || !pannable || z1 === zoom) return;
    if (wheelZoomed.current) {
      wheelZoomed.current = false;
      return;
    }
    const rect = el.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    setPan((p) => ({
      x: cx - (cx - p.x) * (zoom / z1),
      y: cy - (cy - p.y) * (zoom / z1),
    }));
  }, [zoom, pannable]);

  // Left-drag pan: translate the canvas with the pointer.
  const onPanStart = useCallback(
    (e: React.PointerEvent) => {
      const el = contentRef.current;
      if (!el || !pannable || e.button !== 0) return;
      e.preventDefault();
      panDrag.current = { x: e.clientX, y: e.clientY, px: panRef.current.x, py: panRef.current.y };
      el.setPointerCapture(e.pointerId);
      el.classList.add("panning");
    },
    [pannable],
  );
  const onPanMove = useCallback((e: React.PointerEvent) => {
    const d = panDrag.current;
    if (!d) return;
    setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) });
  }, []);
  const onPanEnd = useCallback((e: React.PointerEvent) => {
    panDrag.current = null;
    const el = contentRef.current;
    if (!el) return;
    el.classList.remove("panning");
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  }, []);

  // Reset zoom + pan when switching to a different artifact.
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [artifact.path, artifact.filename]);

  // Drag the left edge to resize the pane, mirroring the browser pane.
  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      // Pane is docked right, so width grows as the pointer moves left.
      const next = window.innerWidth - ev.clientX;
      const max = window.innerWidth - 360;
      setPaneWidth(Math.min(max, Math.max(MIN_PANE_WIDTH, next)));
    };
    const onUp = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }, []);

  const paneStyle = paneWidth != null ? { flex: `0 0 ${paneWidth}px` } : undefined;
  // CSS zoom reflows the document so the scroll area grows/shrinks naturally;
  // the header and pane chrome stay fixed because they are siblings, not
  // descendants, of the zoomed wrapper.
  const zoomStyle = { zoom } as React.CSSProperties;

  const resizer = (
    <div
      className="artifact-preview-resizer"
      onPointerDown={startResize}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize preview pane"
      title="Drag to resize"
    />
  );

  useEffect(() => {
    // Inline previews (e.g. a JSX code block) have no file on disk.
    if (inline) return;
    let stale = false;
    setPreview(null);
    setError(null);
    void readArtifactPreview(artifact.path)
      .then((p) => {
        if (!stale) setPreview(p);
      })
      .catch((e: unknown) => {
        if (!stale) setError(String(e));
      });
    return () => {
      stale = true;
    };
  }, [artifact.path, inline]);

  // Hot-reload (Claude-style refine loop): the model can edit an open
  // artifact file (write_file / edit_file, or the harness CLI writing it
  // directly), so poll the file's mtime and re-read the preview when it
  // changes. A cheap stat every 2s; the re-read only fires on actual change.
  // A missing file (deleted mid-preview) keeps the last good render.
  const [fileMtime, setFileMtime] = useState<number | null>(null);
  useEffect(() => {
    if (inline) return;
    let stale = false;
    setFileMtime(null); // reset when switching artifacts — first poll re-baselines
    const tick = () => {
      void getFileMtime(artifact.path)
        .then((t) => {
          if (!stale && t != null) setFileMtime(t);
        })
        .catch(() => {});
    };
    tick();
    const iv = window.setInterval(tick, 2_000);
    return () => {
      stale = true;
      window.clearInterval(iv);
    };
  }, [artifact.path, inline]);
  useEffect(() => {
    if (inline || fileMtime == null) return;
    let stale = false;
    void readArtifactPreview(artifact.path)
      .then((p) => {
        if (!stale) setPreview(p);
      })
      .catch(() => {}); // a mid-write read failing keeps the last good preview
    return () => {
      stale = true;
    };
  }, [fileMtime, artifact.path, inline]);

  if (inline) {
    // Inline mermaid SVG (```mermaid "Open in tab"): sanitized at render time
    // by MermaidDiagram, so direct injection is safe. No header — the pane
    // tabs above already show the filename + close.
    if (inline.kind === "svg") {
      return (
        <div className="artifact-preview-pane" ref={paneRef} style={paneStyle}>
          {resizer}
          <div className="artifact-preview-content artifact-preview-content-svg">
            <div
              className="chat-mermaid-svg"
              style={{ padding: "20px" }}
              dangerouslySetInnerHTML={{ __html: inline.code }}
            />
          </div>
        </div>
      );
    }
    // Inline JSX/TSX: no extra header — the pane tabs above already show the
    // filename + close, and JsxPreview brings its own Preview/Code toggle.
    // Zoom controls are omitted for JSX (they don't apply to live React).
    return (
      <div className="artifact-preview-pane" ref={paneRef} style={paneStyle}>
        {resizer}
        <div className="artifact-preview-content artifact-preview-content-jsx">
          <JsxPreview code={inline.code} lang={inline.kind} variant="pane" />
        </div>
      </div>
    );
  }

  // JSX/HTML/mermaid/live-diagram: skip the full header (zoom/download/close) — the tab chip above
  // already shows the filename + close, and the Preview/Code toggle lives inside
  // the JsxPreview/HtmlPreview component. Only show the "open in default app" + a
  // download button for non-JSX/HTML.
  const isJsxOrHtml =
    preview?.kind === "jsx" ||
    preview?.kind === "html" ||
    preview?.kind === "mermaid" ||
    (preview?.kind === "diagram" && preview.text != null && isInteractiveHtml(preview.text));

  return (
    <div className="artifact-preview-pane" ref={paneRef} style={paneStyle}>
      {resizer}
      {!isJsxOrHtml && (
        <div className="artifact-preview-header">
          <div className="artifact-preview-header-actions">
            {preview && (preview.kind === "diagram" || preview.kind === "html" || preview.kind === "image") ? (
              <ArtifactExportMenu
                preview={preview}
                path={artifact.path}
                filename={artifact.filename}
              />
            ) : (
              <button
                type="button"
                className="artifact-preview-download-btn"
                title="Download"
                aria-label="Download"
                onClick={() => void downloadArtifact(artifact.path, artifact.filename)}
              >
                <DownloadIcon />
                <span>Download</span>
              </button>
            )}
            <button
              type="button"
              className="artifact-preview-header-btn"
              title="Open in default app"
              aria-label="Open in default app"
              onClick={() => void openArtifact(artifact.path)}
            >
              ↗
            </button>
            <button
              type="button"
              className="artifact-preview-header-btn"
              title="Close preview"
              aria-label="Close preview"
              onClick={onClose}
            >
              ✕
            </button>
          </div>
        </div>
      )}
      <div
        className={`artifact-preview-content${pannable ? " pannable" : ""}`}
        ref={contentRef}
        onPointerDown={onPanStart}
        onPointerMove={onPanMove}
        onPointerUp={onPanEnd}
        onPointerCancel={onPanEnd}
      >
        {error ? (
          <div className="artifact-preview-error">
            {/cannot stat|os error\s*2|no such file/i.test(error) ? (
              <>
                This file is no longer on disk — it may have been moved or
                deleted since the turn that created it.
              </>
            ) : (
              <>Could not open preview: {error}</>
            )}
          </div>
        ) : !preview ? (
          <div className="artifact-preview-loading">Loading preview…</div>
        ) : pannable ? (
          <div
            className="artifact-canvas"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
          >
            <PreviewBody preview={preview} />
            {/* Iframe-rendered diagrams (HTML kind) swallow pointer/wheel
                events — this layer catches them for the pan/zoom handlers. */}
            {preview.kind === "diagram" && preview.ext.toLowerCase() !== "svg" && (
              <div className="artifact-preview-gesture-layer" aria-hidden="true" />
            )}
          </div>
        ) : (
          <div className="artifact-preview-zoom" style={zoomStyle}>
            <PreviewBody preview={preview} />
          </div>
        )}
      </div>
    </div>
  );
}
