// Shared state and helpers for AgentModelPicker — extracted from the picker
// component so the caches, warm-up fetch, and small utilities live in one
// place. AgentModelPicker.tsx imports everything from here.
import type { FuzzyResult } from "../../lib/fuzzy";
import { listAcpAgents, listHarnesses } from "../../lib/ipc";
import type { AcpAgentStatus, HarnessStatus } from "../../types";

// ---- shared caches (stale-while-revalidate) -------------------------------

/** Harness/ACP install statuses — the backend probes each CLI with
 *  --version (spawning real processes), so a cold fetch takes seconds.
 *  Cached at module level: reopening the picker paints instantly while a
 *  background refresh updates, and one prefetch per app run warms the cache
 *  before the user's first click. */
let agentStatusCache: {
  harnesses: HarnessStatus[];
  acpAgents: AcpAgentStatus[];
} | null = null;

/** Direct read of the cached statuses (null before the first fetch lands). */
export function getCachedAgentStatuses() {
  return agentStatusCache;
}

export function fetchAgentStatuses(
  onDone: (harnesses: HarnessStatus[], acpAgents: AcpAgentStatus[]) => void,
): () => void {
  let stale = false;
  void listHarnesses()
    .then((list) => {
      if (!stale && list) setCached(list, undefined);
    })
    .catch(() => {
      /* probe failures keep whatever is cached */
    });
  void listAcpAgents()
    .then((list) => {
      if (!stale && list) setCached(undefined, list);
    })
    .catch(() => {
      /* probe failures keep whatever is cached */
    });
  function setCached(h?: HarnessStatus[], a?: AcpAgentStatus[]) {
    agentStatusCache = {
      harnesses: h ?? agentStatusCache?.harnesses ?? [],
      acpAgents: a ?? agentStatusCache?.acpAgents ?? [],
    };
    if (agentStatusCache.harnesses.length > 0 || agentStatusCache.acpAgents.length > 0 || h || a) {
      onDone(agentStatusCache.harnesses, agentStatusCache.acpAgents);
    }
  }
  return () => {
    stale = true;
  };
}

/** Per-rail model lists fetched during this app run — switching rail entries
 *  back and forth is instant, and a provider's list survives popup closes. */
export interface PaneData {
  status: "loading" | "ready" | "error";
  /** Rows in list order; label is what's rendered/searched. `thinking` is
   *  the model's own supported effort tiers (omp) — narrows the pane's
   *  effort slider when present. */
  rows: { id: string; label: string; thinking?: string[] }[];
  /** Custom endpoint footnote (harness config relay / provider base URL). */
  endpoint?: string | null;
  /** Harness-derived reasoning effort (read-only — the CLI's own config owns
   *  it; only Claude Code publishes one). Harness panes only. */
  effort?: string | null;
  /** Effort tiers the harness can be spawned with (weakest → strongest).
   *  Empty/undefined = no knob — the pane stays slider-free. */
  effortOptions?: string[];
  error?: string;
}
export const paneCache = new Map<string, PaneData>();
/** Panes with a fetch currently in flight — guards double fetches when the
 *  open-time warm-up and the pane effect (or a fast rail switch) race. */
export const paneInFlight = new Set<string>();

// ---- helpers ---------------------------------------------------------------

export function harnessIdOf(agent: string | null | undefined): string | null {
  return agent?.startsWith("harness:") ? agent.slice("harness:".length) : null;
}
export function acpIdOf(agent: string | null | undefined): string | null {
  return agent?.startsWith("acp:") ? agent.slice("acp:".length) : null;
}

/** Case-insensitive id dedupe (aggregators sometimes list a model twice). */
export function dedupeIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const key = id.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

/** Host part of a base URL for the endpoint footnote — "relay.example.com"
 *  reads better than the full URL in the narrow pane (title has the full). */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Render `text` with the matched indices from `res` wrapped in <mark>. */
export function highlight(text: string, res: FuzzyResult | null): JSX.Element {
  if (!res || res.matches.length === 0) return <>{text}</>;
  const set = new Set(res.matches);
  const out: Array<string | JSX.Element> = [];
  let key = 0;
  let chunk = "";
  for (let i = 0; i < text.length; i++) {
    if (set.has(i)) {
      if (chunk) {
        out.push(chunk);
        chunk = "";
      }
      out.push(
        <mark key={key++} className="model-effort-match">
          {text[i]}
        </mark>,
      );
    } else {
      chunk += text[i];
    }
  }
  if (chunk) out.push(chunk);
  return <>{out}</>;
}
