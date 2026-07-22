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
// so it renders identically off-DOM. The capture uses a white canvas (EXPORT_BG)
// to match the preview iframe — diagrams are authored for a light page, so a
// dark canvas would produce an unreadable near-black export.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toPng, toSvg } from "html-to-image";
import { downloadArtifact } from "../../lib/ipc";
import type { ArtifactPreview } from "../../lib/ipc";

interface Props {
  preview: ArtifactPreview;
  /** The on-disk path + filename, for raw-file download fallback. */
  path: string;
  filename: string;
  /** "toolbar" (default) shows inline icon buttons; "kebab" shows a single
   *  vertical three-dot button that opens a text menu (used inline on a
   *  chat diagram, revealed on hover). */
  variant?: "toolbar" | "kebab";
}

/** Canvas background for rasterized exports. Kept in sync with the preview
 *  iframe's white background so a downloaded PNG/SVG looks exactly like what
 *  the user saw in the pane (and isn't rendered as a dark, unreadable image). */
const EXPORT_BG = "#ffffff";

/** Whether a kind supports the raster export menu at all. */
function supportsRasterExport(kind: ArtifactPreview["kind"]): boolean {
  return kind === "diagram" || kind === "html" || kind === "image";
}

function KebabIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="12" cy="19" r="1.8" />
    </svg>
  );
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
  // Match the preview iframe (`.artifact-preview-html { background: #fff }`):
  // diagrams are authored assuming a light page, so a dark canvas would render
  // dark-stroked/dark-text diagrams as an unreadable near-black image.
  holder.style.background = EXPORT_BG;
  holder.style.padding = "24px";
  holder.innerHTML = html;
  document.body.appendChild(holder);
  try {
    // Give the browser a frame to lay out / paint before capture.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const dataUrl = await toPng(holder, {
      pixelRatio: 2,
      cacheBust: true,
      backgroundColor: EXPORT_BG,
    });
    return dataUrl;
  } finally {
    document.body.removeChild(holder);
  }
}

/** Intrinsic pixel size of a standalone SVG string, from its width/height or
 *  viewBox. Returns 0s when neither is present (caller falls back to the
 *  loaded image's natural size). */
function svgPixelSize(svg: string): { w: number; h: number } {
  const tag = svg.match(/<svg\b[^>]*>/i)?.[0] ?? "";
  const w = tag.match(/\bwidth="([\d.]+)(?:px)?"/i);
  const h = tag.match(/\bheight="([\d.]+)(?:px)?"/i);
  if (w && h) return { w: parseFloat(w[1]), h: parseFloat(h[1]) };
  const vb = tag.match(/viewBox="([^"]+)"/i);
  if (vb) {
    const p = vb[1].split(/[\s,]+/).map(Number);
    if (p.length === 4 && p.every(Number.isFinite)) return { w: p[2], h: p[3] };
  }
  return { w: 0, h: 0 };
}

/** Rasterize a standalone <svg> string to a PNG data URL via an <img> + canvas.
 *  This is reliable in the WebKitGTK/Tauri webview where html-to-image's
 *  foreignObject capture produces a blank image. Throws on failure. */
async function svgToPng(svg: string, scale = 2): Promise<string> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("could not load SVG for rasterization"));
      img.src = url;
    });
    let { w, h } = svgPixelSize(svg);
    if (!w || !h) {
      w = img.naturalWidth || 1200;
      h = img.naturalHeight || 800;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d canvas context");
    ctx.fillStyle = EXPORT_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Produce a PNG data URL for a diagram/html artifact. Prefers rasterizing the
 *  diagram's own root <svg> (reliable everywhere); falls back to html-to-image
 *  for HTML/CSS diagrams that aren't authored as inline SVG. */
async function diagramToPng(html: string): Promise<string> {
  const rootSvg = extractRootSvg(html);
  if (rootSvg) {
    try {
      return await svgToPng(rootSvg);
    } catch {
      // Fall through to the html-to-image path below.
    }
  }
  return rasterizeHtml(html);
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
  // Paint an opaque white backdrop behind the diagram so the exported file
  // isn't transparent (which viewers with a dark backdrop show as near-black,
  // the same "dark PNG" symptom). Insert as the first child so it sits behind.
  if (!svg.querySelector('rect[data-export-bg="1"]')) {
    const bg = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("data-export-bg", "1");
    bg.setAttribute("x", "0");
    bg.setAttribute("y", "0");
    bg.setAttribute("width", "100%");
    bg.setAttribute("height", "100%");
    bg.setAttribute("fill", EXPORT_BG);
    svg.insertBefore(bg, svg.firstChild);
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
  holder.style.background = EXPORT_BG;
  holder.style.padding = "24px";
  holder.innerHTML = html;
  document.body.appendChild(holder);
  try {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    return await toSvg(holder, { cacheBust: true, backgroundColor: EXPORT_BG });
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

export function ArtifactExportMenu({ preview, path, filename, variant = "toolbar" }: Props) {
  const [busy, setBusy] = useState<null | "copy" | "png" | "svg">(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const kebabRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (kebabRef.current && !kebabRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

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
        const dataUrl = await diagramToPng(preview.text);
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
        dataUrl = await diagramToPng(preview.text);
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

  if (variant === "kebab") {
    const runAndClose = (fn: () => Promise<void>) => {
      setMenuOpen(false);
      void fn();
    };
    return (
      <div className="artifact-kebab" ref={kebabRef}>
        <button
          type="button"
          className="artifact-kebab-btn"
          title="Diagram actions"
          aria-label="Diagram actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
        >
          <KebabIcon />
        </button>
        {menuOpen && (
          <div className="artifact-kebab-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              className="artifact-kebab-item"
              disabled={busy !== null}
              onClick={() => runAndClose(handleDownloadPng)}
            >
              Download as PNG
            </button>
            <button
              type="button"
              role="menuitem"
              className="artifact-kebab-item"
              disabled={svgDisabled || busy !== null}
              onClick={() => runAndClose(handleDownloadSvg)}
            >
              Download as SVG
            </button>
            <button
              type="button"
              role="menuitem"
              className="artifact-kebab-item"
              disabled={busy !== null}
              onClick={() => runAndClose(handleCopy)}
            >
              Copy image
            </button>
          </div>
        )}
      </div>
    );
  }

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
