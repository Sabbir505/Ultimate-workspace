// Compact toolbar indicator for model downloads from the Hugging Face market.
// Shows a spinner + progress when any download is active; clickable tooltip
// with per-model details. Terminal states (done/error/cancelled) are auto-
// removed after 3s by the UI store, and this indicator then FADES out rather
// than blinking out of the toolbar between frames.
import { useEffect, useMemo, useRef, useState } from "react";
import { formatBytes, formatRate } from "../../lib/format";
import { downloadDisplayName } from "../../hooks/useModelDownloadEvents";
import { useUiStore, type ModelDownloadProgress } from "../../state/ui";

/** Must be >= the opacity transition below so the element is still on screen
 *  while it fades. */
const FADE_MS = 300;

export function ModelDownloadIndicator() {
  const downloads = useUiStore((s) => s.modelDownloads);
  // Stable identity while the store slice is unchanged — the fade effect keys
  // off this, and a fresh array on every render would restart it forever.
  const entries = useMemo(() => Object.values(downloads), [downloads]);

  // The last non-empty frame, held on screen through the fade. The store
  // deletes terminal entries on a 3s timer; without this the indicator would
  // be removed from the DOM mid-transition and the fade would never play.
  const [shown, setShown] = useState<ModelDownloadProgress[]>(entries);
  const [fading, setFading] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (entries.length > 0) {
      setShown(entries);
      setFading(false);
      return;
    }
    if (shown.length === 0) return;
    setFading(true);
    timerRef.current = window.setTimeout(() => {
      setShown([]);
      setFading(false);
      timerRef.current = null;
    }, FADE_MS);
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    // `shown.length` is read, not tracked as identity — the guard is only
    // there to avoid re-fading an already-empty indicator.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  if (shown.length === 0) return null;

  const active = shown.filter(
    (d) => d.state === "starting" || d.state === "downloading" || d.state === "verifying",
  );

  // Aggregate progress across all active downloads.
  const totalDown = active.reduce((s, d) => s + d.downloaded, 0);
  const totalSize = active.reduce((s, d) => s + (d.total ?? 0), 0);
  const totalBps = active.reduce((s, d) => s + d.bps, 0);
  const pct = totalSize > 0 ? Math.min(100, Math.round((totalDown / totalSize) * 100)) : null;

  // Short label for the downloading item: a friendly build name for runtime
  // builds (CUDA/whisper), the repo name for model ids (`repo::file`).
  const label =
    shown.length === 1
      ? downloadDisplayName(shown[0].id) ??
        shown[0].id.split("::")[0]?.split("/").pop() ??
        shown[0].id
      : `${shown.length} downloads`;

  const tooltip = shown
    .map((d) => {
      const name = downloadDisplayName(d.id) ?? d.id.split("::")[0]?.split("/").pop() ?? d.id;
      const pctItem = d.total ? `${Math.round((d.downloaded / d.total) * 100)}%` : "";
      return `${name}: ${d.state} ${pctItem} ${formatBytes(d.downloaded)}${d.total ? ` / ${formatBytes(d.total)}` : ""} ${formatRate(d.bps)}`;
    })
    .join("\n");

  return (
    <span
      className="model-download-indicator"
      title={tooltip}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        color: "var(--accent)",
        padding: "2px 10px",
        borderRadius: "var(--radius-xs)",
        background: "var(--accent-soft)",
        maxWidth: 220,
        overflow: "hidden",
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
        cursor: "default",
        opacity: fading ? 0 : 1,
        transform: fading ? "translateY(-3px)" : "none",
        transition: "opacity 300ms ease, transform 300ms ease",
        pointerEvents: fading ? "none" : undefined,
      }}
    >
      <span
        style={{
          width: 10,
          height: 10,
          flex: "none",
          border: "2px solid var(--accent-soft)",
          borderTopColor: "var(--accent)",
          borderRadius: "50%",
          animation: "browser-spin 0.8s linear infinite",
        }}
      />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
        {label}
        {pct !== null ? ` ${pct}%` : ""}
        {totalBps > 0 ? ` · ${formatRate(totalBps)}` : ""}
      </span>
      {pct !== null && totalSize > 0 && (
        <span
          style={{
            width: 40,
            height: 3,
            flex: "none",
            background: "var(--surface-2)",
            borderRadius: 2,
            overflow: "hidden",
          }}
        >
          <span
            style={{
              display: "block",
              height: "100%",
              width: `${pct}%`,
              background: "var(--accent)",
              borderRadius: 2,
              transition: "width 0.3s ease",
            }}
          />
        </span>
      )}
    </span>
  );
}
