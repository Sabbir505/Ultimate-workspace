// Renders a generated vector diagram artifact inline in the chat message.
//
// The diagram is a self-contained HTML file (authored by `generate_diagram`
// as inline <svg>). We render it in a sandboxed iframe — identical to the
// preview pane, so it matches the PNG/SVG export exactly — but size the frame
// to the diagram's intrinsic height so it takes only the vertical space it
// truly needs (tall diagrams are capped and scroll). A compact toolbar carries
// the same Copy / PNG / SVG export controls the pane offered.
import { useEffect, useMemo, useState } from "react";
import { readArtifactPreview, type ArtifactPreview } from "../../lib/ipc";
import type { ChatArtifact } from "../../state/chat";
import { ArtifactExportMenu } from "./ArtifactExportMenu";

/** Intrinsic pixel size of the diagram's root <svg>, from width/height or the
 *  viewBox. Used to fit the inline frame to the diagram's real dimensions. */
function svgDims(html: string): { w: number; h: number } | null {
  const tag = html.match(/<svg\b[^>]*>/i)?.[0];
  if (!tag) return null;
  const w = tag.match(/\bwidth="([\d.]+)"/i);
  const h = tag.match(/\bheight="([\d.]+)"/i);
  if (w && h) return { w: parseFloat(w[1]), h: parseFloat(h[1]) };
  const vb = tag.match(/viewBox="([^"]+)"/i);
  if (vb) {
    const p = vb[1].split(/[\s,]+/).map(Number);
    if (p.length === 4 && p.every(Number.isFinite)) return { w: p[2], h: p[3] };
  }
  return null;
}

export function InlineDiagram({
  artifact,
  onFallback,
}: {
  artifact: ChatArtifact;
  /** Rendered when the artifact turns out not to be a diagram/html file. */
  onFallback: () => JSX.Element;
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

  const height = useMemo(() => {
    if (!preview?.text) return 320;
    const d = svgDims(preview.text);
    if (!d) return 320;
    // Fit to the diagram's own height so it takes the full space it needs and
    // renders in one piece (no inner scroller).
    return Math.max(Math.round(d.h) + 8, 120);
  }, [preview]);

  if (error) {
    return <div className="chat-diagram-error">Could not load diagram: {error}</div>;
  }
  if (!preview) {
    return <div className="chat-diagram-loading">Loading diagram…</div>;
  }
  // Not actually a diagram/html file — fall back to the download chip.
  if ((preview.kind !== "diagram" && preview.kind !== "html") || preview.text == null) {
    return onFallback();
  }

  return (
    <div className="chat-diagram-block">
      <div className="chat-diagram-actions">
        <ArtifactExportMenu
          preview={preview}
          path={artifact.path}
          filename={artifact.filename}
          variant="kebab"
        />
      </div>
      <iframe
        className="chat-diagram-frame"
        title={artifact.filename}
        sandbox=""
        srcDoc={preview.text}
        style={{ height }}
      />
    </div>
  );
}
