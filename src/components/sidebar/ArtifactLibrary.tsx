// Persistent artifact library entry shown in the chat sidebar, directly below
// the "New Chat" button. It renders only a title row ("Artifacts") — clicking
// it opens a modal listing every file/diagram the model generated (kept 30
// days) as a uniform grid of sleek "folded page / dog-eared" document cards.
// Each card shows a faint text-snippet thumbnail (for text-like artifacts) or
// a minimalist outline icon (for everything else), a bold title, and a muted
// "Edited … ago" footer. Selecting a card jumps to the chat that produced it
// and opens it in that chat's preview pane; the trash button deletes it.
import { useEffect, useMemo, useState } from "react";
import { useArtifactsStore } from "../../state/artifacts";
import { useChatStore } from "../../state/chat";
import { useUiStore } from "../../state/ui";
import { Modal } from "../common/Modal";
import { readArtifactPreview, type ArtifactPreview, type ArtifactRecord } from "../../lib/ipc";
import { relativeTime } from "../../lib/relativeTime";

/** Kinds (the normalized preview kind returned by readArtifactPreview) whose
 *  content is text we can show as a faint snippet preview. The file's
 *  extension (ArtifactRecord.kind) is NOT used here — the backend normalizes
 *  extensions to these kinds, so we branch on the returned preview.kind to
 *  avoid duplicating the backend's extension table. */
const TEXT_KINDS = new Set(["text", "markdown", "code", "json", "csv"]);

/** A minimalist outline icon for artifacts that have no text preview. */
function OutlineIcon({ kind }: { kind: string }) {
  // Pick an icon shape from the artifact's kind. All share the same stroke
  // style so the grid reads as one set.
  const common = {
    width: 28,
    height: 28,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (kind) {
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "svg":
    case "html":
    case "diagram":
      // image / rendered
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="m21 15-5-5L5 21" />
        </svg>
      );
    case "pdf":
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M9 13h6M9 17h4" />
        </svg>
      );
    case "xlsx":
    case "csv":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
        </svg>
      );
    case "pptx":
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="13" rx="2" />
          <path d="M12 17v4M8 21h8" />
        </svg>
      );
    case "docx":
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M8 13h8M8 17h6" />
        </svg>
      );
    default:
      // generic file / binary / app
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
      );
  }
}

/** The upper thumbnail area. For text-like artifacts it shows a faint,
 *  formatted text snippet; for everything else a centered outline icon. Always
 *  fetches the artifact preview via readArtifactPreview (the backend
 *  normalizes the file extension to a `kind`); branches on the returned kind
 *  rather than the record's extension so we don't duplicate the backend's
 *  extension table. Exported for unit testing each branch without a live
 *  artifact. */
export function ArtifactCardThumb({ artifact }: { artifact: ArtifactRecord }) {
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);

  useEffect(() => {
    let stale = false;
    void readArtifactPreview(artifact.path)
      .then((p) => {
        if (!stale) setPreview(p);
      })
      .catch(() => {
        /* leave null → icon fallback */
      });
    return () => {
      stale = true;
    };
  }, [artifact.path]);

  // Still loading: show the icon so the card isn't empty.
  if (!preview) {
    return (
      <div className="doc-card-icon">
        <OutlineIcon kind={artifact.kind} />
      </div>
    );
  }

  const { kind, text } = preview;

  // Text-like artifact with readable content: faint formatted snippet.
  if (TEXT_KINDS.has(kind) && text != null) {
    const snippet = text
      .replace(/\r/g, "")
      .split("\n")
      .slice(0, 7)
      .join("\n")
      .trim();
    return (
      <div className="doc-card-snippet" aria-hidden="true">
        <pre>{snippet}</pre>
      </div>
    );
  }

  // image / pdf / html / diagram / office / binary, or text with no content:
  // minimalist outline icon. No live iframe/img/pdf embed per the card design.
  return (
    <div className="doc-card-icon">
      <OutlineIcon kind={artifact.kind} />
    </div>
  );
}

/** Maps an artifact to a clean display title (drops the extension). */
function displayTitle(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

export function ArtifactLibrary({
  externalOpen,
  onClose,
}: {
  externalOpen?: boolean;
  /** Called when the modal is dismissed while externalOpen controls it. */
  onClose?: () => void;
}) {
  const items = useArtifactsStore((s) => s.items);
  const loaded = useArtifactsStore((s) => s.loaded);
  const load = useArtifactsStore((s) => s.load);
  const remove = useArtifactsStore((s) => s.remove);
  const setPreviewArtifact = useChatStore((s) => s.setPreviewArtifact);
  const selectSession = useChatStore((s) => s.selectSession);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const setModalOpen = useUiStore((s) => s.setModalOpen);
  const [internalOpen, setInternalOpen] = useState(false);

  // When externalOpen is provided, it overrides the internal toggle state.
  // This lets the Dev-mode toolbar open the same modal without the sidebar trigger.
  const open = externalOpen != null ? externalOpen : internalOpen;
  const setOpen = externalOpen != null
    ? (_v: boolean) => { /* no-op: parent controls this */ }
    : setInternalOpen;

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  // Sync modal-open state into the UI store so native webviews know to hide.
  useEffect(() => {
    setModalOpen(open);
    return () => { setModalOpen(false); };
  }, [open, setModalOpen]);

  // Open the artifact in the preview pane of the chat that produced it: switch
  // to that session first so the pane belongs to the right conversation.
  const openArtifact = (a: ArtifactRecord) => {
    if (a.chatSessionId) void selectSession(a.chatSessionId);
    setPreviewArtifact({ path: a.path, filename: a.filename });
    setActiveView("chat");
    setOpen(false);
    onClose?.();
  };

  // Newest first — feels like a document recents list.
  const sorted = useMemo(
    () => [...items].sort((a, b) => b.createdAt - a.createdAt),
    [items],
  );

  return (
    <>
      <div className="chat-new-btn-row">
        <button
          type="button"
          className="artifact-lib-title"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          style={{ width: "100%" }}
        >
          <svg
            className="artifact-lib-title-icon"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <path d="M9 13h6M9 17h4" />
          </svg>
          <span className="artifact-lib-title-label">Artifacts</span>
          {items.length > 0 && (
            <span className="artifact-lib-title-count">{items.length}</span>
          )}
        </button>
      </div>

      {open && (
        <Modal
          title="Artifacts"
          className="modal-artifacts"
          onClose={() => {
            setOpen(false);
            onClose?.();
          }}
          actions={
            <button type="button" className="ghost" onClick={() => { setOpen(false); onClose?.(); }}>
              Close
            </button>
          }
        >
          <div className="artifact-lib-modal">
            {items.length === 0 ? (
              <div className="artifact-lib-empty">
                Generated files &amp; diagrams appear here (kept 30 days).
              </div>
            ) : (
              <div className="doc-card-grid">
                {sorted.map((a) => (
                  <div
                    key={a.id}
                    className="doc-card"
                    role="button"
                    tabIndex={0}
                    title={a.filename}
                    onClick={() => openArtifact(a)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") openArtifact(a);
                    }}
                  >
                    <button
                      className="doc-card-del"
                      title="Delete artifact"
                      aria-label="Delete artifact"
                      onClick={(e) => {
                        e.stopPropagation();
                        void remove(a.id);
                      }}
                    >
                      ×
                    </button>
                    <div className="doc-card-thumb">
                      <ArtifactCardThumb artifact={a} />
                    </div>
                    <div className="doc-card-body">
                      <div className="doc-card-title">{displayTitle(a.filename)}</div>
                      <div className="doc-card-divider" />
                      <div className="doc-card-meta">
                        <OutlineIcon kind={a.kind} />
                        <span>• Edited {relativeTime(a.createdAt)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
