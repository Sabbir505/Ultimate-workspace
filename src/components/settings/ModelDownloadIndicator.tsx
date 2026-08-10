// Compact toolbar indicator for model downloads from the Hugging Face market.
// Shows a spinner + progress when any download is active; clickable tooltip
// with per-model details. Terminal states (done/error/cancelled) are auto-
// removed after 3s by the UI store.
import { useUiStore } from "../../state/ui";

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

function formatRate(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "";
  return `${formatBytes(bps)}/s`;
}

export function ModelDownloadIndicator() {
  const downloads = useUiStore((s) => s.modelDownloads);
  const entries = Object.values(downloads);

  if (entries.length === 0) return null;

  const active = entries.filter(
    (d) => d.state === "starting" || d.state === "downloading" || d.state === "verifying",
  );

  // Aggregate progress across all active downloads.
  const totalDown = active.reduce((s, d) => s + d.downloaded, 0);
  const totalSize = active.reduce((s, d) => s + (d.total ?? 0), 0);
  const totalBps = active.reduce((s, d) => s + d.bps, 0);
  const pct = totalSize > 0 ? Math.min(100, Math.round((totalDown / totalSize) * 100)) : null;

  // Short label for the model being downloaded (repo name).
  const label =
    entries.length === 1
      ? entries[0].id.split("::")[0]?.split("/").pop() ?? entries[0].id
      : `${entries.length} models`;

  const tooltip = entries
    .map((d) => {
      const name = d.id.split("::")[0]?.split("/").pop() ?? d.id;
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
