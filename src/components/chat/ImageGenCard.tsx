// The in-message "Creating image" block: a dot-matrix canvas with a
// traveling light wave while the diffusion server renders, turning into the
// finished image once done. The finished image carries two quiet controls
// INSIDE it (copy · download, revealed on hover); the assistant message's
// own hover bar stays on its text — the image has no bar of its own.
// Rendered by ChatView as a timeline row. Two modes: LIVE (state from the
// app-wide image-generation store) and STATIC (an `entry` from the store's
// history — past renders, so previews survive restarts). Backend contract:
// src-tauri/src/commands/image_gen.rs (emit_update).
import { useEffect, useState } from "react";
import { useImageGenStore, type ImageGenHistoryEntry } from "../../state/imageGenStore";
import { readArtifactPreview } from "../../lib/ipc";
import { CopyIcon, iconProps } from "./ActivitySteps";

const DOT_COLS = 18;
const DOT_ROWS = 18;
const DOT_COUNT = DOT_COLS * DOT_ROWS;
const WAVE_BAND = 26;

/** While rendering (the server API exposes no step counts), a light wave
 *  sweeps the grid so the block is visibly alive. */
function useWave(active: boolean) {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setPhase((p) => (p + 1) % (DOT_COUNT + WAVE_BAND)), 40);
    return () => window.clearInterval(t);
  }, [active]);
  return phase;
}

function DotMatrix({ phase, elapsed }: { phase: number; elapsed: number }) {
  const dots = Array.from({ length: DOT_COUNT }, (_, i) => i);
  return (
    <div
      style={{
        width: 300,
        height: 300,
        background: "#0b0b0d",
        borderRadius: 12,
        padding: 12,
        display: "grid",
        gridTemplateColumns: `repeat(${DOT_COLS}, 1fr)`,
        gridTemplateRows: `repeat(${DOT_ROWS}, 1fr)`,
        placeItems: "center",
        position: "relative",
        overflow: "hidden",
      }}
      role="status"
      aria-label="Creating image"
    >
      {dots.map((i) => {
        const dist = (i - phase + DOT_COUNT * 2) % (DOT_COUNT + WAVE_BAND);
        const intensity = dist < WAVE_BAND ? 1 - dist / WAVE_BAND : 0;
        return (
          <span
            key={i}
            style={{
              width: 3,
              height: 3,
              borderRadius: "50%",
              background:
                intensity > 0
                  ? `rgba(110, 168, 254, ${0.12 + 0.75 * intensity})`
                  : "rgba(110, 168, 254, 0.13)",
              boxShadow: intensity > 0.4 ? "0 0 4px rgba(110, 168, 254, 0.8)" : "none",
              transition: "background 80ms linear",
            }}
          />
        );
      })}
      <span
        style={{
          position: "absolute",
          right: 10,
          bottom: 10,
          fontSize: 11,
          fontWeight: 600,
          color: "var(--accent, #6ea8fe)",
          background: "rgba(20, 22, 28, 0.85)",
          borderRadius: 999,
          padding: "2px 9px",
        }}
      >
        {elapsed}s
      </span>
    </div>
  );
}

/** Download glyph in the message-bar icon language (15px, stroke 2, round). */
function SaveIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M4 21h16" />
    </svg>
  );
}

/** The finished image with two quiet controls INSIDE it (copy · download,
 *  revealed on hover over the picture). The message's own hover bar lives on
 *  the assistant text above — the image carries no bar of its own. */
function GenImageDone({
  dataUri,
  filename,
}: {
  dataUri: string;
  filename?: string;
}) {
  const copyImage = async () => {
    try {
      const blob = await (await fetch(dataUri)).blob();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    } catch {
      /* clipboard permission denied — the save button still works */
    }
  };

  const saveImage = () => {
    const a = document.createElement("a");
    a.href = dataUri;
    a.download = filename ?? `image-${Date.now()}.png`;
    a.click();
  };

  return (
    <div className="chat-img-wrap" style={{ maxWidth: 300 }}>
      <img
        src={dataUri}
        alt="Generated image"
        style={{
          width: "100%",
          borderRadius: 12,
          display: "block",
          border: "1px solid var(--border, rgba(255,255,255,0.08))",
        }}
      />
      <div className="chat-img-overlay-actions">
        <button
          type="button"
          className="chat-msg-action"
          title="Copy image"
          aria-label="Copy image"
          onClick={() => void copyImage()}
        >
          <CopyIcon />
        </button>
        <button
          type="button"
          className="chat-msg-action"
          title="Save image"
          aria-label="Save image"
          onClick={saveImage}
        >
          <SaveIcon />
        </button>
      </div>
    </div>
  );
}

// Preview hydration cache: static entries re-read their PNG once per path
// per app run (the timeline rebuilds `items` on every render pass).
const previewCache = new Map<string, Promise<string | null>>();
// RESOLVED data URIs, kept synchronously beside the promise cache. The
// message list is virtualized: rows unmount/remount on every streaming
// flush and scroll — the exact remount-flash the mermaid render cache
// fixed (MermaidDiagram.tsx). Seeding state from this map in the useState
// initializer makes a remount paint the image on the FIRST render instead
// of flashing the "Loading image…" placeholder for the async window.
// Bounded like the other render caches.
const PREVIEW_SYNC_MAX = 24;
const previewSync = new Map<string, string>();

export function ImageGenCard({
  sessionScopesTo,
  entry,
}: {
  /** Only the pane whose session owns the anchored generation renders the
   *  card (split view: both panes subscribe to the same global events). */
  sessionScopesTo?: string | null;
  /** Static past render (restart persistence): hydrate from the file on
   *  disk instead of the live store. */
  entry?: ImageGenHistoryEntry;
}) {
  const update = useImageGenStore((s) => s.update);
  const anchorSessionId = useImageGenStore((s) => s.anchorSessionId);
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const active = update?.phase === "starting" || update?.phase === "rendering";
  const wave = useWave(active);

  // Static mode: read the PNG once (file lives in generated-images/; the
  // backend's read_artifact_preview base64s it for in-app display). A path
  // that no longer hydrates is pruned from the history so the dead row
  // doesn't come back every render. While the FIRST read is in flight a
  // quiet placeholder holds the row's space — but remounts seed
  // synchronously from previewSync (see above), so the placeholder only
  // ever shows once per image per app run, never flashing again.
  const entryPath = entry?.path;
  const [staticUri, setStaticUri] = useState<string | null>(() =>
    entryPath ? previewSync.get(entryPath) ?? null : null,
  );
  const [staticDone, setStaticDone] = useState<boolean>(
    () => entryPath != null && previewSync.has(entryPath),
  );
  useEffect(() => {
    if (!entryPath) return;
    const sync = previewSync.get(entryPath);
    if (sync != null) {
      setStaticUri(sync);
      setStaticDone(true);
      return;
    }
    setStaticUri(null);
    setStaticDone(false);
    let hit = previewCache.get(entryPath);
    if (!hit) {
      hit = readArtifactPreview(entryPath)
        .then((p) => p?.dataUri ?? null)
        .catch(() => null);
      previewCache.set(entryPath, hit);
    }
    void hit.then((uri) => {
      if (uri) {
        if (previewSync.size >= PREVIEW_SYNC_MAX) {
          const oldest = previewSync.keys().next().value;
          if (oldest != null) previewSync.delete(oldest);
        }
        previewSync.set(entryPath, uri);
        setStaticUri(uri);
        setStaticDone(true);
      } else {
        useImageGenStore.getState().pruneHistory(entryPath);
        setStaticDone(true);
      }
    });
  }, [entryPath]);

  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [active]);
  const elapsed = Math.max(0, Math.round((now - startedAt) / 1000));

  // Session scoping: a NEW chat (different session id) never shows another
  // session's image.
  if (anchorSessionId != null && sessionScopesTo != null && anchorSessionId !== sessionScopesTo) {
    return null;
  }

  if (entry) {
    if (staticUri) {
      return (
        <GenImageDone
          dataUri={staticUri}
          filename={entryPath?.split(/[\\/]/).pop()}
        />
      );
    }
    if (!staticDone) {
      return (
        <div
          style={{
            width: 300,
            height: 200,
            borderRadius: 12,
            border: "1px solid var(--border, rgba(255,255,255,0.08))",
            background: "rgba(255,255,255,0.02)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            fontSize: 12,
            color: "var(--text-dim)",
          }}
        >
          <span className="local-spinner" aria-hidden="true" />
          Loading image…
        </div>
      );
    }
    return null; // file gone or preview unavailable
  }

  if (!update) return null;

  if (active) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          maxWidth: 300,
          // Breathing room below the dot canvas: the card is the live edge
          // while the composer floats over the transcript, and without this
          // the canvas and its elapsed badge sit flush against the dock.
          paddingBottom: 28,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-dim)" }}>
          Creating image
        </div>
        <DotMatrix phase={wave} elapsed={elapsed} />
      </div>
    );
  }

  if (update.phase === "done" && update.dataUri) {
    return (
      <GenImageDone
        dataUri={update.dataUri}
        filename={update.path?.split(/[\\/]/).pop()}
      />
    );
  }

  if (update.phase === "done") {
    // File landed but the data URI didn't ride along (rare) — the static
    // hydration path covers it on the next timeline pass; say nothing now.
    return null;
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        fontSize: 12,
        color: "var(--warn, #d29922)",
        maxWidth: 300,
      }}
    >
      <span style={{ fontWeight: 600 }}>Image generation failed</span>
      <span>{update.error}</span>
    </div>
  );
}
