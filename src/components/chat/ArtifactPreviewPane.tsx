// Right-side preview pane for a generated artifact (file/code/document).
// Auto-opened when the model generates a file. Text-like artifacts render
// inline (markdown/code/csv/json/html); images and PDFs render via a data
// URI; binary Office formats show a file card with an "Open" button.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
  downloadArtifact,
  openArtifact,
  readArtifactPreview,
  type ArtifactPreview,
} from "../../lib/ipc";
import type { ChatArtifact } from "../../state/chat";
import { ArtifactExportMenu } from "./ArtifactExportMenu";
import { JsxPreview } from "./JsxPreview";

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
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{text}</ReactMarkdown>
      </div>
    );
  }
  if (kind === "office" && text != null) {
    return (
      <iframe
        className={`artifact-preview-html office ${ext}`}
        title={preview.filename}
        sandbox=""
        srcDoc={text}
      />
    );
  }
  if ((kind === "html" || kind === "diagram") && text != null) {
    return (
      <iframe
        className="artifact-preview-html"
        title={preview.filename}
        sandbox=""
        srcDoc={text}
      />
    );
  }
  if (kind === "csv" && text != null) {
    return <CsvTable text={text} />;
  }
  if ((kind === "code" || kind === "json" || kind === "text") && text != null) {
    const lang = kind === "json" ? "json" : kind === "text" ? "text" : ext;
    if (kind === "text") {
      return <pre className="artifact-preview-text">{text}</pre>;
    }
    return (
      <SyntaxHighlighter
        style={{}}
        language={lang}
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
        {text}
      </SyntaxHighlighter>
    );
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
  const inline = artifact.inline;

  // Reset zoom when switching to a different artifact.
  useEffect(() => {
    setZoom(1);
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

  if (inline) {
    return (
      <div className="artifact-preview-pane" ref={paneRef} style={paneStyle}>
        {resizer}
        <div className="artifact-preview-header">
          <span className="artifact-preview-title" title={artifact.filename}>
            {artifact.filename}
          </span>
          <div className="artifact-preview-header-actions">
            <ZoomControls zoom={zoom} setZoom={setZoom} />
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
        <div className="artifact-preview-content">
          <div className="artifact-preview-zoom" style={zoomStyle}>
            <JsxPreview code={inline.code} lang={inline.kind} variant="pane" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="artifact-preview-pane" ref={paneRef} style={paneStyle}>
      {resizer}
      <div className="artifact-preview-header">
        <span className="artifact-preview-title" title={artifact.filename}>
          {artifact.filename}
        </span>
        <div className="artifact-preview-header-actions">
          <ZoomControls zoom={zoom} setZoom={setZoom} />
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
      <div className="artifact-preview-content">
        {error ? (
          <div className="artifact-preview-error">Could not open preview: {error}</div>
        ) : !preview ? (
          <div className="artifact-preview-loading">Loading preview…</div>
        ) : (
          <div className="artifact-preview-zoom" style={zoomStyle}>
            <PreviewBody preview={preview} />
          </div>
        )}
      </div>
    </div>
  );
}
