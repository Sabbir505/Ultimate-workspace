// Browser trust layer (Phase 2): user-facing state for agent browsing —
// gate confirmations, credential takeover, pause/stop, the user-owned action
// timeline, and the agent-active indicator.
//
// The backend (browser_mcp.rs dispatch) classifies every op, asks here for
// confirmation on gated actions, and streams timeline entries as they happen.
// This store holds the UI projection; the authoritative log lives in the
// backend (the agent can neither write nor delete it — Brave's principle).
import { create } from "zustand";

export interface BrowserConfirmRequest {
  reqId: number;
  paneId: string;
  op: string;
  target: string;
  url: string;
  riskClass: string;
  reason: string;
}

export interface BrowserTakeoverRequest {
  paneId: string;
  reason: string;
  url: string;
  target: string;
}

export interface BrowserTimelineEntry {
  tsMs: number;
  op: string;
  target: string;
  outcome: string;
  riskClass?: string;
  detail?: string;
}

interface BrowserTrustState {
  confirm: BrowserConfirmRequest | null;
  takeover: BrowserTakeoverRequest | null;
  /** Per-pane agent control state (backend mirrors it authoritatively). */
  paused: Record<string, boolean>;
  /** Per-pane action timeline (projection of the backend's log). */
  timeline: Record<string, BrowserTimelineEntry[]>;
  timelineOpen: Record<string, boolean>;
  /** Per-pane timestamp of the last agent activity — drives the "agent
   *  working" strip. 0 = idle. */
  lastAgentActivity: Record<string, number>;

  setConfirm: (req: BrowserConfirmRequest | null) => void;
  setTakeover: (req: BrowserTakeoverRequest | null) => void;
  setPaused: (paneId: string, paused: boolean) => void;
  appendTimeline: (paneId: string, entry: BrowserTimelineEntry) => void;
  setTimeline: (paneId: string, entries: BrowserTimelineEntry[]) => void;
  toggleTimeline: (paneId: string) => void;
  markAgentActivity: (paneId: string | null | undefined) => void;
}

const MAX_CLIENT_TIMELINE = 200;
const ACTIVITY_TTL_MS = 4000;

export const useBrowserTrustStore = create<BrowserTrustState>((set) => ({
  confirm: null,
  takeover: null,
  paused: {},
  timeline: {},
  timelineOpen: {},
  lastAgentActivity: {},

  setConfirm: (req) => set({ confirm: req }),
  setTakeover: (req) => set({ takeover: req }),
  setPaused: (paneId, paused) =>
    set((s) => ({ paused: { ...s.paused, [paneId]: paused } })),
  appendTimeline: (paneId, entry) =>
    set((s) => {
      const list = [...(s.timeline[paneId] ?? []), entry];
      return {
        timeline: {
          ...s.timeline,
          [paneId]: list.length > MAX_CLIENT_TIMELINE
            ? list.slice(list.length - MAX_CLIENT_TIMELINE)
            : list,
        },
      };
    }),
  setTimeline: (paneId, entries) =>
    set((s) => ({ timeline: { ...s.timeline, [paneId]: entries } })),
  toggleTimeline: (paneId) =>
    set((s) => ({
      timelineOpen: { ...s.timelineOpen, [paneId]: !s.timelineOpen[paneId] },
    })),
  markAgentActivity: (paneId) => {
    if (!paneId) return;
    set((s) => ({
      lastAgentActivity: { ...s.lastAgentActivity, [paneId]: Date.now() },
    }));
  },
}));

/** Is the agent currently active on this pane (activity within the TTL)? */
export function agentActiveWithin(
  ts: number | undefined,
  now: number,
  ttlMs = ACTIVITY_TTL_MS,
): boolean {
  return !!ts && now - ts < ttlMs;
}
