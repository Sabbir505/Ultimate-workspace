// Persistent artifact library shown in the chat sidebar: every file/diagram
// the model generated, kept for 30 days. Clicking one opens it in the preview
// pane; the trash button deletes it (row + file).
import { useEffect } from "react";
import { useArtifactsStore } from "../../state/artifacts";
import { useChatStore } from "../../state/chat";
import { useUiStore } from "../../state/ui";
import type { ArtifactRecord } from "../../lib/ipc";

/** A small glyph per artifact kind. */
function kindIcon(kind: string): string {
  switch (kind) {
    case "docx":
      return "📄";
    case "pdf":
      return "📕";
    case "pptx":
      return "📊";
    case "xlsx":
    case "csv":
      return "📈";
    case "html":
    case "svg":
      return "🖼";
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
      return "🖼";
    default:
      return "📎";
  }
}

/** Days remaining before the artifact is auto-deleted (30-day retention). */
function daysLeft(expiresAt: number): number {
  const secs = expiresAt - Math.floor(Date.now() / 1000);
  return Math.max(0, Math.ceil(secs / 86400));
}

export function ArtifactLibrary() {
  const items = useArtifactsStore((s) => s.items);
  const loaded = useArtifactsStore((s) => s.loaded);
  const load = useArtifactsStore((s) => s.load);
  const remove = useArtifactsStore((s) => s.remove);
  const setPreviewArtifact = useChatStore((s) => s.setPreviewArtifact);
  const setActiveView = useUiStore((s) => s.setActiveView);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const openArtifact = (a: ArtifactRecord) => {
    setPreviewArtifact({ path: a.path, filename: a.filename });
    setActiveView("chat");
  };

  return (
    <>
      <div className="sidebar-section-label">ARTIFACTS</div>
      {items.length === 0 ? (
        <div className="artifact-lib-empty">
          Generated files &amp; diagrams appear here (kept 30 days).
        </div>
      ) : (
        items.map((a) => (
          <div
            key={a.id}
            className="artifact-lib-row"
            role="button"
            tabIndex={0}
            title={`${a.filename} · ${daysLeft(a.expiresAt)}d left`}
            onClick={() => openArtifact(a)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") openArtifact(a);
            }}
          >
            <span className="artifact-lib-icon">{kindIcon(a.kind)}</span>
            <span className="artifact-lib-name">{a.filename}</span>
            <button
              className="artifact-lib-del"
              title="Delete artifact"
              aria-label="Delete artifact"
              onClick={(e) => {
                e.stopPropagation();
                void remove(a.id);
              }}
            >
              ×
            </button>
          </div>
        ))
      )}
    </>
  );
}
