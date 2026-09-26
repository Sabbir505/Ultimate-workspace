/**
 * Shared display formatters — one implementation for the relative-time and
 * money/token abbreviations that four screens (and the chat usage line) used
 * to hand-copy with drifting output styles.
 */

/**
 * Relative time for a past timestamp. Accepts SECONDS or MILLISECONDS
 * (auto-detected by magnitude: real timestamps are ~1.7e9 s or ~1.7e12 ms)
 * and null/undefined → 'never' (AutomationsScreen's "never ran" row).
 *
 * Two output conventions exist in the app, selected with `style`:
 *   'bare' — "now" / "5m" / "3h" / "2d"   (AppDrawer history, Notifications)
 *   'ago'  — "now" / "5m ago" / "3h ago"  (Automations, Artifacts)
 */
export type RelativeTimeStyle = 'bare' | 'ago';

/** One-second timestamps stop around 1e11 (year ~5138); ms are ~1e12+. */
const MS_THRESHOLD = 1e11;

export function timeAgo(
  input: number | null | undefined,
  style: RelativeTimeStyle = 'bare',
): string {
  if (input == null) return 'never';
  const ms = Math.abs(input) >= MS_THRESHOLD ? input : input * 1000;
  const s = Math.floor((Date.now() - ms) / 1000);
  const suffix = style === 'ago' ? ' ago' : '';
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m${suffix}`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${suffix}`;
  return `${Math.floor(s / 86400)}d${suffix}`;
}

/** USD abbreviation (CostScreen hero/tables): 2 decimals once double-digit,
 *  4 below that so sub-cent spend stays visible. */
export function formatUsd(n: number): string {
  return `$${n.toFixed(n >= 10 ? 2 : 4)}`;
}

/** Token abbreviation (CostScreen tables/stats): 12480 → "12.5k",
 *  1_234_567 → "1.2M", below 1000 unchanged. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
