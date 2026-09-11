// Documents library — dedicated full-page view of every file/diagram Relay
// has generated, persisted across restarts (the backend artifacts table has
// 30-day retention). The sidebar's "Artifacts" button opens a modal with the
// same content; this is the always-one-click-away version, like the Browser
// MCP pane or the Skills Library.
import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useArtifactsStore, type ArtifactsState } from "../../state/artifacts";
import { useChatStore, type ChatState } from "../../state/chat";
import { useUiStore, type UiState } from "../../state/ui";
import {
  downloadArtifact,
  downloadArtifactsZip,
  readArtifactPreview,
  toastInfo,
  type ArtifactPreview,
  type ArtifactRecord,
} from "../../lib/ipc";
import { relativeTime } from "../../lib/relativeTime";

const TEXT_KINDS = new Set(["text", "markdown", "code", "json", "csv"]);

function OutlineIcon({ kind }: { kind: string }) {
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
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
      );
  }
}

function DocumentCardThumb({ artifact }: { artifact: ArtifactRecord }) {
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  useEffect(() => {
    let stale = false;
    void readArtifactPreview(artifact.path)
      .then((p: ArtifactPreview | null) => {
        if (!stale) setPreview(p);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [artifact.path]);

  if (!preview) {
    return (
      <div className="doc-card-icon">
        <OutlineIcon kind={artifact.kind} />
      </div>
    );
  }
  const { kind, text } = preview;
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
  return (
    <div className="doc-card-icon">
      <OutlineIcon kind={artifact.kind} />
    </div>
  );
}

function displayTitle(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/** The grid is 3 lanes ≥721px viewport, 2 ≤720px, 1 ≤480px (same
 *  .doc-card-grid media queries the sidebar's ArtifactLibrary uses) — the
 *  virtualizer chunks documents into rows of this many cards. */
function laneCount(): number {
  if (typeof window === "undefined") return 3;
  if (window.innerWidth <= 480) return 1;
  if (window.innerWidth <= 720) return 2;
  return 3;
}

export function DocumentsLibrary() {
  const items = useArtifactsStore((s: ArtifactsState) => s.items);
  const loaded = useArtifactsStore((s: ArtifactsState) => s.loaded);
  const load = useArtifactsStore((s: ArtifactsState) => s.load);
  const remove = useArtifactsStore((s: ArtifactsState) => s.remove);
  const setPreviewArtifact = useChatStore((s: ChatState) => s.setPreviewArtifact);
  const selectSession = useChatStore((s: ChatState) => s.selectSession);
  const setActiveView = useUiStore((s: UiState) => s.setActiveView);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  // Newest first.
  const sorted = useMemo(
    () => [...items].sort((a, b) => b.createdAt - a.createdAt),
    [items],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(
      (a) =>
        a.filename.toLowerCase().includes(q) ||
        a.kind.toLowerCase().includes(q),
    );
  }, [sorted, query]);

  // PERF (PERFORMANCE_AUDIT.md #70): virtualize the card grid — every card
  // mounts a preview-fetching thumbnail (one IPC round-trip each), so
  // rendering ALL documents at once made the full page expensive. Same
  // row-chunked useVirtualizer pattern as the sidebar's ArtifactLibrary.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [lanes, setLanes] = useState(laneCount);
  useEffect(() => {
    const onResize = () => setLanes(laneCount());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const rows = useMemo(() => {
    const out: ArtifactRecord[][] = [];
    for (let i = 0; i < filtered.length; i += lanes) {
      out.push(filtered.slice(i, i + lanes));
    }
    return out;
  }, [filtered, lanes]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 240,
    overscan: 3,
  });

  // Same contract as the sidebar ArtifactLibrary: open the preview and jump to
  // the owning chat. The preview goes FIRST — it is app-global (the tool panel
  // is not session-scoped), so a slow or wedged session switch can no longer
  // make the click a no-op; the switch still reports a deleted source chat.
  const openArtifact = (a: ArtifactRecord) => {
    setActiveView("chat");
    setPreviewArtifact({ path: a.path, filename: a.filename });
    // Local const: `a.chatSessionId`'s null-check does not narrow inside the
    // async closure below (the parameter is re-widened there).
    const sessionId = a.chatSessionId;
    if (!sessionId) return;
    void (async () => {
      try {
        await selectSession(sessionId);
      } catch {
        /* fall through — the file itself is still viewable */
      }
      if (useChatStore.getState().activeChatSessionId !== sessionId) {
        toastInfo("The chat that created this file no longer exists");
      }
    })();
  };

  // Bulk export — the sidebar's small Artifacts modal has no room for this,
  // but the full-page library does. Lets the user grab every selected doc
  // (or the whole library) as a single zip when they need to share a batch.
  const exportAll = async () => {
    if (sorted.length === 0) return;
    const paths = sorted.map((a) => a.path);
    // Pick a default save location: the user's Downloads folder, with a
    // timestamped zip name. save() is a Tauri dialog — we let it prompt.
    const { save } = await import("@tauri-apps/plugin-dialog");
    const dest = await save({
      defaultPath: `relay-documents-${Date.now()}.zip`,
      filters: [{ name: "Zip archive", extensions: ["zip"] }],
    });
    if (!dest) return;
    await downloadArtifactsZip(paths, dest);
  };

  return (
    <div
      className="view-overlay modal-centered"
      onPointerDown={(e) => e.target === e.currentTarget && setActiveView("chat")}
    >
      <div className="view-panel documents-panel">
        <div className="view-header">
          <h2>Documents</h2>
          <div className="view-header-actions">
            <button
              type="button"
              className="ghost"
              onClick={() => void exportAll()}
              disabled={sorted.length === 0}
              title="Download all documents as a single zip"
            >
              Export all
            </button>
            <button className="ghost" onClick={() => setActiveView("chat")}>
              ✕
            </button>
          </div>
        </div>
        <div className="view-body" ref={scrollRef}>
          <div className="documents-toolbar">
            <input
              type="search"
              className="documents-search"
              placeholder="Search by filename or kind…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className="documents-count">
              {filtered.length}
              {filtered.length !== sorted.length && ` of ${sorted.length}`} document
              {filtered.length === 1 ? "" : "s"}
            </span>
          </div>

          {sorted.length === 0 ? (
            <div className="empty-reserved">
              <span className="empty-icon">📄</span>
              <span className="empty-text">
                Generated files &amp; diagrams appear here (kept 30 days). Ask the
                model to create a document, diagram, or spreadsheet and it will
                show up here.
              </span>
            </div>
          ) : (
            <div
              style={{
                height: virtualizer.getTotalSize(),
                position: "relative",
              }}
            >
              {virtualizer.getVirtualItems().map((vrow) => (
                <div
                  key={vrow.key}
                  data-index={vrow.index}
                  ref={virtualizer.measureElement}
                  className="doc-card-grid documents-grid"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vrow.start}px)`,
                  }}
                >
                  {rows[vrow.index].map((a) => (
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
                      <div className="doc-card-actions">
                        <button
                          className="doc-card-action"
                          title="Download"
                          aria-label="Download"
                          onClick={(e) => {
                            e.stopPropagation();
                            // M24: pass the FILENAME as the suggested save name —
                            // the full path pre-filled the dialog with the
                            // artifact's own location (overwrite-in-place). The
                            // anchor hack below did nothing in the Tauri webview
                            // and is gone.
                            void downloadArtifact(a.path, a.filename).catch(() => {});
                          }}
                        >
                          ⬇
                        </button>
                        <button
                          className="doc-card-del"
                          title="Delete document"
                          aria-label="Delete document"
                          onClick={(e) => {
                            e.stopPropagation();
                            void remove(a.id);
                          }}
                        >
                          ×
                        </button>
                      </div>
                      <div className="doc-card-thumb">
                        <DocumentCardThumb artifact={a} />
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
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
