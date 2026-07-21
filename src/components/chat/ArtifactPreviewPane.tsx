// Right-side preview pane for a generated artifact (file/code/document).
// Auto-opened when the model generates a file. Text-like artifacts render
// inline (markdown/code/csv/json/html); images and PDFs render via a data
// URI; binary Office formats show a file card with an "Open" button.
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
  downloadArtifact,
  openArtifact,
  readArtifactPreview,
  type ArtifactPreview,
} from "../../lib/ipc";
import type { ChatArtifact } from "../../state/chat";

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
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    );
  }
  if (kind === "office" && text != null) {
    const cls =
      ext === "pptx"
        ? "artifact-preview-office pptx"
        : ext === "xlsx"
          ? "artifact-preview-office xlsx"
          : "artifact-preview-office docx";
    return <div className={cls} dangerouslySetInnerHTML={{ __html: text }} />;
  }
  if (kind === "html" && text != null) {
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

export function ArtifactPreviewPane({
  artifact,
  onClose,
}: {
  artifact: ChatArtifact;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
  }, [artifact.path]);

  return (
    <div className="artifact-preview-pane">
      <div className="artifact-preview-header">
        <span className="artifact-preview-title" title={artifact.filename}>
          {artifact.filename}
        </span>
        <div className="artifact-preview-header-actions">
          <button
            type="button"
            className="artifact-preview-header-btn"
            title="Download"
            aria-label="Download"
            onClick={() => void downloadArtifact(artifact.path, artifact.filename)}
          >
            <DownloadIcon />
          </button>
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
          <PreviewBody preview={preview} />
        )}
      </div>
    </div>
  );
}
