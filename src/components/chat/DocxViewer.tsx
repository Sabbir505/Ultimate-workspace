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
  const naturalPageWidth = useRef(0);
  const naturalPageHeight = useRef(0);
  // Render epoch: bumped at the start of every render attempt; after each
  // await the epoch must still be current or the render is abandoned. Without
  // this, switching documents quickly lets two overlapping `renderAsync`
  // calls interleave pages from both files into the same container.
  const renderEpoch = useRef(0);
  const [failed, setFailed] = useState(false);

  // docx-preview renders pages at the document's real paper size (Letter ≈
  // 816px), and its centered .docx-wrapper overflows BOTH pane edges when the
  // pane is narrower — the left overflow is unreachable via scroll. Scale the
  // wrapper down to fit the pane width (fit-to-width, never above 100%).
  //
  // The scale is a `transform`, not CSS `zoom`: zoom re-lays-out at a
  // fractional pixel grid (e.g. 0.63 × a 125% Windows display scale), where
  // every glyph/edge lands off the device-pixel grid and the document reads
  // slightly blurry. A static transform is rasterized at its FINAL device
  // scale, so text stays crisp. Transform doesn't affect layout, so the
  // wrapper gets an explicit scaled height — otherwise the scroll area keeps
  // the unscaled size and the page bottom is unreachable blank space.
  const fitToWidth = useCallback(() => {
    const container = containerRef.current;
    const wrapper = container?.querySelector<HTMLElement>(".docx-wrapper");
    if (!container || !wrapper) return;
    if (!naturalPageWidth.current) {
      wrapper.style.transform = "";
      wrapper.style.height = "";
      naturalPageWidth.current =
        wrapper.querySelector<HTMLElement>("section.docx")?.offsetWidth ?? 0;
      naturalPageHeight.current = wrapper.scrollHeight;
    }
    if (!naturalPageWidth.current) return;
    const scale = Math.min(1, (container.clientWidth - 12) / naturalPageWidth.current);
    if (scale < 0.999) {
      // Keep the scaled page horizontally centered in the pane.
      const offsetX = Math.max(0, (container.clientWidth - naturalPageWidth.current * scale) / 2);
      wrapper.style.transformOrigin = "top left";
      wrapper.style.transform = `translateX(${offsetX.toFixed(1)}px) scale(${scale.toFixed(4)})`;
      wrapper.style.height = `${Math.ceil(naturalPageHeight.current * scale)}px`;
    } else {
      wrapper.style.transform = "";
      wrapper.style.height = "";
    }
  }, []);

  const render = useCallback(async () => {
    const container = containerRef.current;
    if (!container) return;
    const epoch = ++renderEpoch.current;
    naturalPageWidth.current = 0;
    naturalPageHeight.current = 0;
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
      // A newer render took over the container — abandon this stale one
      // rather than scaling/failing state off mixed content.
      if (epoch !== renderEpoch.current) return;
      fitToWidth();
      setFailed(false);
    } catch (err) {
      if (epoch !== renderEpoch.current) return;
      console.warn(`[DocxViewer] docx-preview failed for ${filename}`, err);
      setFailed(true);
    }
  }, [dataUri, filename, fitToWidth]);

  useEffect(() => {
    void render();
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => fitToWidth());
    ro.observe(container);
    return () => ro.disconnect();
  }, [render, fitToWidth]);

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
