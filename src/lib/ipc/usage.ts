// Usage & limits (commands/usage.rs + chat/plan_usage.rs): rolling
// per-provider/harness meters, user-configured caps, provider/CLI-reported
// plan windows (CommandCode, OpenCode Go, OpenRouter), and the 80%/100%
// alerts behind the composer warning notch. Command names and payload shapes
// are binding (CONTRACT.md).
import { safeInvoke, safeListen } from "../ipcCore";

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  requests: number;
  costUsd: number;
}

/** Rolling windows: last 1h / 24h / 7d / 30d (cumulative — a row inside the
 *  last hour counts in all four). */
export interface MeterWindows {
  lastHour: UsageTotals;
  lastDay: UsageTotals;
  lastWeek: UsageTotals;
  lastMonth: UsageTotals;
}

export interface UsageCapState {
  window: "hour" | "day" | "week" | "month";
  usedPct: number;
  usedUsd: number | null;
  capUsd: number | null;
  usedTokens: number | null;
  capTokens: number | null;
  usedRequests: number | null;
  capRequests: number | null;
  thresholdPct: number;
  tier: "ok" | "warn" | "crit";
}

/** A provider/CLI-REPORTED limit window (plan_usage.rs). */
export interface RateWindowPayload {
  target: string;
  window: string;
  label: string;
  /** `headers` | `claude_code` | `commandcode` | `opencode_go` | `openrouter`. */
  source: string;
  usedPct: number | null;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  /** `usd` | `requests` | `tokens` | `percent`. */
  unit: string;
  resetsAt: number | null;
  status: string | null;
  observedAt: number;
}

export interface PlanSnapshotPayload {
  target: string;
  planName: string | null;
  planId: string | null;
  status: string | null;
  periodStart: number | null;
  periodEnd: number | null;
  creditsRemaining: number | null;
  creditsTotal: number | null;
  creditsUnit: string;
  /** Account-wide period totals the SOURCE reported (CommandCode's usage
   *  summary) — the numbers the vendor's own dashboard shows; Relay's local
   *  measurement can't match them (other machines count too). */
  tokensTotal: number | null;
  requestsTotal: number | null;
  costTotalUsd: number | null;
  source: string;
  observedAt: number;
}

export interface UsageMeterPayload {
  /** `chat:<provider>` or a bare harness id. */
  target: string;
  label: string;
  windows: MeterWindows;
  caps: UsageCapState[];
  reported: RateWindowPayload[];
  plan: PlanSnapshotPayload | null;
  health: string | null;
}

export interface UsageLimitConfig {
  target: string;
  window: "hour" | "day" | "week" | "month";
  capUsd: number | null;
  capTokens: number | null;
  capRequests: number | null;
  thresholdPct: number;
}

export interface UsageLimitAlert {
  target: string;
  label: string;
  tier: "warn" | "crit";
  window: string;
  windowLabel: string;
  usedPct: number;
  usedUsd: number | null;
  capUsd: number | null;
  usedTokens: number | null;
  capTokens: number | null;
  usedRequests: number | null;
  capRequests: number | null;
  resetsAt: number | null;
  message: string;
}

export interface UsageRefreshReport {
  updated: string[];
  errors: string[];
}

export const getUsageMeters = () =>
  safeInvoke<UsageMeterPayload[] | null>("get_usage_meters");

/** Upsert a cap; all cap fields unset/zero clears the entry. */
export const setUsageLimit = (
  target: string,
  window: string,
  capUsd?: number | null,
  capTokens?: number | null,
  capRequests?: number | null,
  thresholdPct?: number | null,
) =>
  safeInvoke<UsageLimitConfig | null>("set_usage_limit", {
    target,
    window,
    capUsd: capUsd ?? null,
    capTokens: capTokens ?? null,
    capRequests: capRequests ?? null,
    thresholdPct: thresholdPct ?? null,
  });

export const removeUsageLimit = (target: string, window: string) =>
  safeInvoke<void>("remove_usage_limit", { target, window });

/** Current alerts (warn/crit per target); returns the full current set. */
export const checkUsageLimits = () =>
  safeInvoke<UsageLimitAlert[] | null>("check_usage_limits");

/** Refresh provider/CLI plan sources (CommandCode / OpenCode Go / OpenRouter
 *  credits). Forced by default (an explicit user refresh); pass
 *  `force: false` for an open-time pull that respects the backend's
 *  10-minute throttle. */
export const refreshUsageWindows = (force?: boolean) =>
  safeInvoke<UsageRefreshReport | null>("refresh_usage_windows", { force: force ?? null });

/** Stream `usage:limit-alert` events (tier escalations only). */
export const onUsageLimitAlert = (handler: (p: UsageLimitAlert) => void) =>
  safeListen<UsageLimitAlert>("usage:limit-alert", handler);
