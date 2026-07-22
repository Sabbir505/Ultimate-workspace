// Persistent artifact library entry shown in the chat sidebar, directly below
// the "New Chat" button. It renders only a title row ("Artifacts") — clicking
// it opens a modal listing every file/diagram the model generated (kept 30
// days). Rich artifacts (diagrams, documents, images) show as cards; plain
// source/data files show as a normal list. A search box filters both.
// Selecting one jumps to the chat that produced it and opens it in that chat's
// preview pane; the trash button deletes it (row + file).
import { useEffect, useMemo, useState } from "react";
import { useArtifactsStore } from "../../state/artifacts";
import { useChatStore } from "../../state/chat";
import { useUiStore } from "../../state/ui";
import { Modal } from "../common/Modal";
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

/** Rich artifacts (diagrams / documents / images) render as visual cards; every
 *  other kind (code, text, data) is a plain file in the list below. */
const CARD_KINDS = new Set([
  "html",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "pdf",
  "docx",
  "pptx",
  "xlsx",
]);

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
  const selectSession = useChatStore((s) => s.selectSession);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  // Open the artifact in the preview pane of the chat that produced it: switch
  // to that session first so the pane belongs to the right conversation.
  const openArtifact = (a: ArtifactRecord) => {
    if (a.chatSessionId) void selectSession(a.chatSessionId);
    setPreviewArtifact({ path: a.path, filename: a.filename });
    setActiveView("chat");
    setOpen(false);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((a) => a.filename.toLowerCase().includes(q)) : items;
  }, [items, query]);

  const cards = filtered.filter((a) => CARD_KINDS.has(a.kind));
  const files = filtered.filter((a) => !CARD_KINDS.has(a.kind));

  return (
    <>
      <button
        type="button"
        className="artifact-lib-title"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span className="artifact-lib-title-label">ARTIFACTS</span>
        {items.length > 0 && (
          <span className="artifact-lib-title-count">{items.length}</span>
        )}
      </button>

      {open && (
        <Modal
          title="Artifacts"
          className="modal-artifacts"
          onClose={() => setOpen(false)}
          actions={
            <button type="button" className="ghost" onClick={() => setOpen(false)}>
              Close
            </button>
          }
        >
          <div className="artifact-lib-modal">
            <div className="artifact-lib-search">
              <span className="artifact-lib-search-icon" aria-hidden="true">
                ⌕
              </span>
              <input
                type="text"
                placeholder="Search artifacts…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
            </div>

            {items.length === 0 ? (
              <div className="artifact-lib-empty">
                Generated files &amp; diagrams appear here (kept 30 days).
              </div>
            ) : filtered.length === 0 ? (
              <div className="artifact-lib-empty">No artifacts match “{query}”.</div>
            ) : (
              <>
                {cards.length > 0 && (
                  <div className="artifact-lib-grid">
                    {cards.map((a) => (
                      <div
                        key={a.id}
                        className="artifact-card"
                        role="button"
                        tabIndex={0}
                        title={`${a.filename} · ${daysLeft(a.expiresAt)}d left`}
                        onClick={() => openArtifact(a)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") openArtifact(a);
                        }}
                      >
                        <div className="artifact-card-preview">
                          <span className="artifact-card-glyph">{kindIcon(a.kind)}</span>
                          <button
                            className="artifact-card-del"
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
                        <div className="artifact-card-name">{a.filename}</div>
                        <div className="artifact-card-meta">
                          {a.kind.toUpperCase()} · {daysLeft(a.expiresAt)}d left
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {files.length > 0 && (
                  <div className="artifact-lib-files">
                    <div className="artifact-lib-section-label">Files</div>
                    {files.map((a) => (
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
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
