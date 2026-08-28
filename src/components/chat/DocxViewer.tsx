// DOCX preview via docx-preview (docxjs, Apache-2.0): parses the real
// OOXML package and renders document styles, numbering, headers/footers,
// footnotes and images with page wrappers — a large fidelity upgrade over
// the backend's tolerant DOCX→HTML string scanner, which stays as the
// runtime fallback when parsing fails.
import { useCallback, useEffect, useRef, useState } from "react";
import { renderAsync } from "docx-preview";

function dataUriToBuffer(dataUri: string): ArrayBuffer {
  const b64 = dataUri.slice(dataUri.indexOf(",") + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export function DocxViewer({
  dataUri,
  fallbackHtml,
  filename,
}: {
  dataUri: string;
  /** Sanitized backend HTML shown when docx-preview cannot parse the file. */
  fallbackHtml: string;
  filename: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  const render = useCallback(async () => {
    const container = containerRef.current;
    if (!container) return;
    try {
      container.innerHTML = "";
      await renderAsync(dataUriToBuffer(dataUri), container, container, {
        // Real page wrappers with breaks; base64URL keeps images offline-safe.
        inWrapper: true,
        breakPages: true,
        ignoreLastRenderedPageBreak: false,
        useBase64URL: true,
        renderHeaders: true,
        renderFooters: true,
        renderFootnotes: true,
        renderEndnotes: true,
        experimental: true,
      });
      setFailed(false);
    } catch (err) {
      console.warn(`[DocxViewer] docx-preview failed for ${filename}`, err);
      setFailed(true);
    }
  }, [dataUri, filename]);

  useEffect(() => {
    void render();
  }, [render]);

  if (failed) {
    return (
      <iframe
        className="artifact-preview-html office docx"
        title={filename}
        sandbox=""
        srcDoc={fallbackHtml}
      />
    );
  }
  return <div className="docx-viewer-wrap" ref={containerRef} />;
}
