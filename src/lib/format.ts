// Shared display formatting helpers. Every formatting helper that appears in
// more than one component lives here so units, rounding, and placeholders stay
// consistent across the app.

/** Human-readable byte count, e.g. "512 B", "9.5 KB", "12 MB", "1.2 GB".
 *  Non-finite or non-positive input renders the placeholder ("—" by default);
 *  pass e.g. "0 B" when a literal zero byte count should be shown. */
export function formatBytes(n: number, placeholder = "—"): string {
  if (!Number.isFinite(n) || n <= 0) return placeholder;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

/** Byte-per-second download rate, e.g. "1.2 MB/s". Empty while idle. */
export function formatRate(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "";
  return `${formatBytes(bps)}/s`;
}

/** Human-readable worked duration: "1s", "45s", "2m 05s"-style "2m 5s",
 *  "1h 07m"-style "1h 7m". */
export function formatDuration(sec: number): string {
  if (sec < 1) return "1s";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** "Sep 7, 2026" from an ISO string or epoch-seconds number. Empty when
 *  absent or unparseable. */
export function formatDate(input: string | number | null | undefined): string {
  if (input == null || input === "") return "";
  const d = typeof input === "number" ? new Date(input * 1000) : new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** "Sep 7, 2:31 PM" from epoch seconds. Em-dash placeholder when absent. */
export function formatDateTime(epochSeconds: number | null): string {
  if (!epochSeconds) return "—";
  return new Date(epochSeconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Show the last two path segments only if the full path is too long;
 *  otherwise keep the full path so users can disambiguate siblings. */
export function shortName(path: string): string {
  if (path.length <= 56) return path;
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}
