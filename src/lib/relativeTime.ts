// Relative timestamp formatting for sidebar session rows (wireframe §12.5).
export function relativeTime(epochSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const delta = Math.max(0, nowSeconds - epochSeconds);
  if (delta < 60) return "just now";
  const minutes = Math.floor(delta / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
