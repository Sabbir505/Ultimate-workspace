// Usage & limits store: the Cost dashboard's Usage & limits panel and the
// composer warning notch read from here.
//
// Sources: `get_usage_meters` (rolling local windows + configured caps +
// provider/CLI-reported plan windows) and `check_usage_limits` (the current
// warn/crit set). Refreshed on boot, on every `cost:updated` event, when the
// dashboard opens, and after a manual provider refresh.
//
// Dismissal is per target+window and records the TIER and the window's reset
// time it was dismissed at, so a dismissed warn reappears when it escalates
// to crit or when the window rolls over — but not on every re-render.
import { create } from "zustand";
import {
  checkUsageLimits,
  getUsageMeters,
  refreshUsageWindows,
  type UsageLimitAlert,
  type UsageMeterPayload,
  type UsageRefreshReport,
} from "../lib/ipc";

/** Alerts shown on the notch exclude `ok` by construction (backend only
 *  returns warn/crit). */
export interface UsageLimitsState {
  meters: Record<string, UsageMeterPayload>;
  alerts: UsageLimitAlert[];
  loading: boolean;
  loadedAt: number | null;
  error: string | null;
  /** `target|window|windowLabel` → `${tier}|${resetsAt ?? ""}` at dismissal. */
  dismissed: Record<string, string>;
  /** Fetch meters (and optionally re-run the alert check). */
  refresh: (opts?: { check?: boolean }) => Promise<void>;
  /** Refresh the provider/CLI plan sources, then reload the meters. `force`
   *  defaults to true; the Cost dashboard's open passes false to respect the
   *  backend's 10-minute throttle. */
  refreshProviderData: (opts?: { force?: boolean }) => Promise<UsageRefreshReport | null>;
  dismiss: (alert: UsageLimitAlert) => void;
}

export function usageAlertKey(a: Pick<UsageLimitAlert, "target" | "window" | "windowLabel">): string {
  return `${a.target}|${a.window}|${a.windowLabel}`;
}

function dismissalStamp(a: UsageLimitAlert): string {
  return `${a.tier}|${a.resetsAt ?? ""}`;
}

/** The alert the composer notch should show for this target, if any. */
export function visibleAlertFor(
  state: Pick<UsageLimitsState, "alerts" | "dismissed">,
  target: string | null | undefined,
): UsageLimitAlert | null {
  if (!target) return null;
  const hit = state.alerts
    .filter((a) => a.target === target)
    // Crit outranks warn when a target has several windows over.
    .sort((a, b) => (b.tier === "crit" ? 1 : 0) - (a.tier === "crit" ? 1 : 0))
    .find((a) => state.dismissed[usageAlertKey(a)] !== dismissalStamp(a));
  return hit ?? null;
}

/** The meter target for a chat session's currently-selected engine. */
export function usageTargetFor(
  session: { provider?: string | null; agent?: string | null } | null | undefined,
): string | null {
  if (!session) return null;
  const agent = (session.agent ?? "").trim();
  if (agent.startsWith("harness:")) return agent.slice("harness:".length);
  if (agent.startsWith("acp:")) return agent;
  const provider = (session.provider ?? "").trim();
  // Auto-routed sessions resolve per turn; the stored provider is a default,
  // not a fact — showing its meter could point at the wrong provider.
  if (!provider || provider === "auto") return null;
  return provider.startsWith("chat:") ? provider : `chat:${provider}`;
}

/** Compact "resets in 2h 10m" label for a window's reset time (epoch secs). */
function usageResetLabel(resetsAt: number | null | undefined): string | null {
  if (!resetsAt) return null;
  const secs = resetsAt - Math.floor(Date.now() / 1000);
  if (secs <= 0) return "resetting";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(1, m)}m`;
}

/** Full reset phrase for a window ("resets in 2h 10m" / "resetting"), or null
 *  when the source reports no reset. Single-sourced so a stale (already
 *  elapsed) timestamp can never compose as "resets in resetting". */
export function usageResetSuffix(resetsAt: number | null | undefined): string | null {
  const label = usageResetLabel(resetsAt);
  if (!label) return null;
  return label === "resetting" ? "resetting" : `resets in ${label}`;
}

export const useUsageLimitsStore = create<UsageLimitsState>((set, get) => ({
  meters: {},
  alerts: [],
  loading: false,
  loadedAt: null,
  error: null,
  dismissed: {},

  refresh: async (opts) => {
    set({ loading: true });
    try {
      const [rows, alerts] = await Promise.all([
        getUsageMeters(),
        opts?.check ? checkUsageLimits() : Promise.resolve(null),
      ]);
      if (!rows) return;
      set((s) => ({
        meters: Object.fromEntries(rows.map((m) => [m.target, m])),
        alerts: alerts ?? s.alerts,
        loadedAt: Date.now(),
        error: null,
      }));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },

  refreshProviderData: async (opts) => {
    try {
      const report = await refreshUsageWindows(opts?.force ?? true);
      await get().refresh({ check: true });
      return report;
    } catch (e) {
      // Surfaced on the panel's error line instead of vanishing — a failed
      // provider fetch is exactly what the user must not read as "no data".
      set({ error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },

  dismiss: (alert) =>
    set((s) => ({
      dismissed: { ...s.dismissed, [usageAlertKey(alert)]: dismissalStamp(alert) },
    })),
}));
