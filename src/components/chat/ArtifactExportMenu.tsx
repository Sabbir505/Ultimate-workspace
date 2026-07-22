// Per-artifact export menu shown in the ArtifactPreviewPane header. Provides
// Copy-to-clipboard, Download PNG, and Download SVG actions, gated by what
// the artifact kind actually supports:
//   • diagram / html — Copy + PNG + SVG. PNG/Copy rasterize the rendered HTML
//     via html-to-image. SVG prefers extracting the diagram's own root <svg>
//     (true vector, when the diagram was authored as inline SVG); otherwise it
//     falls back to html-to-image's foreignObject-based toSvg().
//   • image          — Copy + Download (the existing raw-file download path;
//     no re-rasterization needed).
//   • other kinds    — no export menu (they use the pane's Download/Open buttons).
//
// PNG/Copy of an HTML diagram rasterizes a freshly-built off-DOM node holding
// the diagram's HTML. We deliberately do NOT reach into the sandboxed display
// iframe's contentDocument (sandbox="" makes it cross-origin / null) — instead
// we render the same self-contained HTML string into a hidden node that
// html-to-image can walk. The diagram HTML is inline-styled and dependency-free,
// so it renders identically off-DOM.
import { useState, type ReactNode } from "react";
import { toPng, toSvg } from "html-to-image";
import { downloadArtifact } from "../../lib/ipc";
import type { ArtifactPreview } from "../../lib/ipc";

interface Props {
  preview: ArtifactPreview;
  /** The on-disk path + filename, for raw-file download fallback. */
  path: string;
  filename: string;
}

/** Whether a kind supports the raster export menu at all. */
function supportsRasterExport(kind: ArtifactPreview["kind"]): boolean {
  return kind === "diagram" || kind === "html" || kind === "image";
}

function CopyIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </svg>
  );
}

function SvgIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 17l6-6 4 4 8-8" />
      <path d="M14 7h7v7" />
    </svg>
  );
}

/** Build an off-DOM node holding the diagram HTML, rasterize it, and return a
 *  PNG data URL. Used by both Copy and Download PNG. Throws on failure (e.g.
 *  tainted canvas) — caller surfaces a friendly error. */
async function rasterizeHtml(html: string): Promise<string> {
  const holder = document.createElement("div");
  holder.style.position = "fixed";
  holder.style.left = "-99999px";
  holder.style.top = "0";
  holder.style.background = "#0b0b12"; // matches the skill's default dark canvas
  holder.style.padding = "24px";
  holder.innerHTML = html;
  document.body.appendChild(holder);
  try {
    // Give the browser a frame to lay out / paint before capture.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const dataUrl = await toPng(holder, {
      pixelRatio: 2,
      cacheBust: true,
      backgroundColor: "#0b0b12",
    });
    return dataUrl;
  } finally {
    document.body.removeChild(holder);
  }
}

/** Extract the diagram's own root <svg> as a standalone, namespaced SVG string,
 *  or null when the diagram isn't authored as inline SVG. */
function extractRootSvg(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const svg = doc.querySelector("svg");
  if (!svg) return null;
  if (!svg.getAttribute("xmlns")) {
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  }
  if (!svg.getAttribute("xmlns:xlink")) {
    svg.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n${svg.outerHTML}`;
}

/** Build an off-DOM node holding the diagram HTML and serialize it to an SVG
 *  data URL via html-to-image (wraps the DOM in a <foreignObject>). Fallback
 *  for diagrams that are HTML/CSS rather than pure SVG. */
async function rasterizeToSvg(html: string): Promise<string> {
  const holder = document.createElement("div");
  holder.style.position = "fixed";
  holder.style.left = "-99999px";
  holder.style.top = "0";
  holder.style.background = "#0b0b12";
  holder.style.padding = "24px";
  holder.innerHTML = html;
  document.body.appendChild(holder);
  try {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    return await toSvg(holder, { cacheBust: true, backgroundColor: "#0b0b12" });
  } finally {
    document.body.removeChild(holder);
  }
}

function triggerDownload(href: string, filename: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function copyDataUrlToClipboard(dataUrl: string): Promise<void> {
  const resp = await fetch(dataUrl);
  const blob = await resp.blob();
  await navigator.clipboard.write([
    new ClipboardItem({ [blob.type]: blob }),
  ]);
}

export function ArtifactExportMenu({ preview, path, filename }: Props) {
  const [busy, setBusy] = useState<null | "copy" | "png" | "svg">(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (!supportsRasterExport(preview.kind)) return null;

  const flash = (msg: string) => {
    setDone(msg);
    setTimeout(() => setDone(null), 1800);
  };

  // For `image` kinds we already have a data URI — copy/download that directly.
  const hasImageUri = preview.kind === "image" && !!preview.dataUri;
  const isHtmlDiagram = preview.kind === "diagram" || preview.kind === "html";

  const handleCopy = async () => {
    setBusy("copy");
    setError(null);
    try {
      if (hasImageUri && preview.dataUri) {
        await copyDataUrlToClipboard(preview.dataUri);
      } else if (isHtmlDiagram && preview.text) {
        const dataUrl = await rasterizeHtml(preview.text);
        await copyDataUrlToClipboard(dataUrl);
      } else {
        throw new Error("nothing rasterizable to copy");
      }
      flash("Copied image");
    } catch (e) {
      setError(`Copy failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const handleDownloadPng = async () => {
    setBusy("png");
    setError(null);
    try {
      let dataUrl: string;
      if (hasImageUri && preview.dataUri) {
        dataUrl = preview.dataUri;
      } else if (isHtmlDiagram && preview.text) {
        dataUrl = await rasterizeHtml(preview.text);
      } else {
        throw new Error("nothing rasterizable to export");
      }
      // Download via an anchor (Tauri webview supports blob downloads).
      triggerDownload(dataUrl, `${preview.filename.replace(/\.[^.]+$/, "")}.png`);
      flash("Saved PNG");
    } catch (e) {
      setError(`PNG export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  // SVG export: prefer the diagram's own inline <svg> (true vector); if the
  // diagram is HTML/CSS instead, fall back to a foreignObject-wrapped SVG.
  // Only offered for diagram/html kinds (an `image` file's raw Download button
  // already covers SVG files).
  const svgDisabled = !isHtmlDiagram;
  const svgTooltip = isHtmlDiagram
    ? "Download as SVG (vector when the diagram is authored as SVG)"
    : "SVG export applies to diagrams only.";

  const handleDownloadSvg = async () => {
    if (!isHtmlDiagram || !preview.text) return;
    setBusy("svg");
    setError(null);
    try {
      const base = preview.filename.replace(/\.[^.]+$/, "");
      const rootSvg = extractRootSvg(preview.text);
      if (rootSvg) {
        const blob = new Blob([rootSvg], { type: "image/svg+xml" });
        const url = URL.createObjectURL(blob);
        triggerDownload(url, `${base}.svg`);
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      } else {
        const dataUrl = await rasterizeToSvg(preview.text);
        triggerDownload(dataUrl, `${base}.svg`);
      }
      flash("Saved SVG");
    } catch (e) {
      setError(`SVG export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const Btn = ({
    onClick,
    title,
    disabled,
    children,
  }: {
    onClick: () => void;
    title: string;
    disabled?: boolean;
    children: ReactNode;
  }) => (
    <button
      type="button"
      className="artifact-export-btn"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={() => void onClick()}
    >
      {children}
    </button>
  );

  return (
    <div className="artifact-export-menu">
      <Btn
        onClick={handleCopy}
        title="Copy image to clipboard"
        disabled={busy !== null}
      >
        <CopyIcon />
      </Btn>
      <Btn
        onClick={handleDownloadPng}
        title="Download as PNG"
        disabled={busy !== null}
      >
        <ImageIcon />
      </Btn>
      <Btn
        onClick={handleDownloadSvg}
        title={svgTooltip}
        disabled={svgDisabled || busy !== null}
      >
        <SvgIcon />
      </Btn>
      {busy && (
        <span className="artifact-export-status">
          {busy === "copy" ? "Copying…" : busy === "svg" ? "Rendering SVG…" : "Rendering PNG…"}
        </span>
      )}
      {done && !error && <span className="artifact-export-status ok">{done}</span>}
      {error && <span className="artifact-export-status err" title={error}>{error}</span>}
      {/* Raw-file download still available via the pane's main Download button. */}
      <span className="artifact-export-sep" />
      <button
        type="button"
        className="artifact-export-btn"
        title="Download original file"
        aria-label="Download original file"
        onClick={() => void downloadArtifact(path, filename)}
      >
        ↓
      </button>
    </div>
  );
}
