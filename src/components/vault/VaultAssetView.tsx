// Standalone view for a non-note vault file (the tree's kind:"file" rows:
// pdf, images, audio, docx, …). Previewable formats render inline via
// vault_read_binary (base64 → data/blob URL); everything else gets an
// "open in system app" card. Notes never reach this component — the store's
// openFile/openKind split keeps editor buffers note-only.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileQuestion, Loader2, X } from "lucide-react";
import { openArtifact } from "../../lib/ipc/harnessChat";
import { basenameOf } from "../../lib/vaultLinks";
import { useVaultStore } from "../../state/vault";
import { cachedVaultImage } from "./VaultPreview";

/** Extensions rendered inline (everything else → the open-externally card). */
const IMAGE_RE = /\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i;
const PDF_RE = /\.pdf$/i;
const MEDIA_RE = /\.(mp3|wav|ogg|m4a|flac|mp4|webm|mov)$/i;

function useAssetBlobUrl(path: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  // The created URL lives in a ref set SYNCHRONOUSLY at creation, so the
  // cleanup always sees (and revokes) it no matter when unmount lands — a
  // URL created after the `alive` check would otherwise leak.
  const madeRef = useRef<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    void (async () => {
      const { vaultReadBinary } = await import("../../lib/ipc");
      const res = await vaultReadBinary(path).catch(() => null);
      if (!alive || !res) return;
      const [mime, b64] = res;
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      madeRef.current = URL.createObjectURL(new Blob([bytes], { type: mime }));
      if (alive) setUrl(madeRef.current);
    })();
    return () => {
      alive = false;
      if (madeRef.current) {
        URL.revokeObjectURL(madeRef.current);
        madeRef.current = null;
      }
    };
  }, [path]);
  return url;
}

function AssetImage({ path }: { path: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setDataUrl(null);
    void cachedVaultImage(path)
      .then((url) => {
        if (alive) setDataUrl(url);
      })
      .catch(() => {
        if (alive) setDataUrl(null);
      });
    return () => {
      alive = false;
    };
  }, [path]);
  if (!dataUrl) return <Loader2 className="spin" size={16} />;
  return <img className="vault-asset-image" src={dataUrl} alt={basenameOf(path)} />;
}

function AssetPdf({ path }: { path: string }) {
  // Lazy: pdfjs is heavy — only downloads when a pdf is actually opened.
  const [Viewer, setViewer] = useState<null | ((p: { path: string }) => ReactNode)>(null);
  useEffect(() => {
    let alive = true;
    void import("./VaultPdfViewer").then((m) => {
      if (alive) setViewer(() => m.VaultPdfViewer);
    });
    return () => {
      alive = false;
    };
  }, []);
  if (!Viewer) return <Loader2 className="spin" size={16} />;
  // key={path}: switching PDF tabs must REMOUNT the viewer. Without it the
  // instance survives the path change — zoom/page state (initialized once at
  // mount from viewState) carry over from the previous document, the
  // restore-to-saved-page effect latches off after its first run, and
  // scrolling the new document then records the old document's zoom under
  // the new path.
  return <Viewer key={path} path={path} />;
}

function AssetMedia({ path, kind }: { path: string; kind: "audio" | "video" }) {
  const url = useAssetBlobUrl(path);
  if (!url) return <Loader2 className="spin" size={16} />;
  return kind === "audio" ? (
    <audio className="vault-asset-audio" src={url} controls />
  ) : (
    <video className="vault-asset-video" src={url} controls />
  );
}

function AssetFallback({ path }: { path: string }) {
  const root = useVaultStore((s) => s.root);
  const name = basenameOf(path);
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toUpperCase() : "?";
  return (
    <div className="vault-asset-card">
      <FileQuestion size={30} strokeWidth={1.4} />
      <h3 title={name}>{name}</h3>
      <p className="vault-asset-ext">{ext} file — no inline preview for this format.</p>
      <button
        className="primary"
        onClick={() => {
          if (root) void openArtifact(`${root}/${path}`);
        }}
        disabled={!root}
      >
        Open in system app
      </button>
      <p className="vault-asset-hint">Opens with your computer's default app for .{ext.toLowerCase()} files.</p>
    </div>
  );
}

export function VaultAssetView({ path }: { path: string }) {
  const closeAsset = useVaultStore((s) => s.closeAsset);
  let body: ReactNode;
  if (IMAGE_RE.test(path)) body = <AssetImage path={path} />;
  else if (PDF_RE.test(path)) body = <AssetPdf path={path} />;
  else if (MEDIA_RE.test(path))
    body = <AssetMedia path={path} kind={/\.(mp4|webm|mov)$/i.test(path) ? "video" : "audio"} />;
  else body = <AssetFallback path={path} />;
  return (
    <div className="vault-asset-view">
      <div className="vault-note-head">
        <span className="vault-note-path" title={path}>{path}</span>
        <button className="vault-rail-toggle" title="Close" onClick={closeAsset}>
          <X size={14} />
        </button>
      </div>
      <div className="vault-asset-body">{body}</div>
    </div>
  );
}
