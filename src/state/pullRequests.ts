// Pull Requests store: per-project caches for the Pulls tab. Small and
// pull-based (no push events from GitHub) — the panel refreshes on mount,
// on demand, and every 30s while visible.
import { create } from "zustand";
import {
  githubGetPr,
  githubListPrs,
  githubPrChecks,
  githubPrFiles,
  type PullRequestChecks,
  type PullRequestDetail,
  type PullRequestFile,
  type PullRequestSummary,
} from "../lib/ipc";

interface PrDetailBundle {
  detail: PullRequestDetail;
  files: PullRequestFile[];
  checks: PullRequestChecks | null;
}

export type PrListState = "open" | "closed" | "all";

/** List caches are per project AND per filter, so switching filters can show
 * a spinner for the new filter instead of another filter's rows. */
export function prListCacheKey(projectId: string, state: PrListState): string {
  return `${projectId}:${state}`;
}

// An IPC call can vanish without settling (webview reloaded while Rust was
// mid-flight → Tauri drops the callback). Time requests out and treat locks
// older than LOCK_STALE_MS as abandoned so a wedged spinner can always recover.
const IPC_TIMEOUT_MS = 20_000;
const LOCK_STALE_MS = 30_000;

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out — hit refresh to retry`)), IPC_TIMEOUT_MS);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/** True if a fetch for this lock start time is fresh enough to keep its lock. */
function lockIsFresh(startedAt: number | undefined): boolean {
  return typeof startedAt === "number" && startedAt > 0 && Date.now() - startedAt < LOCK_STALE_MS;
}

interface PullRequestsState {
  /** prListCacheKey(projectId, state) → PR list (undefined = never loaded). */
  lists: Record<string, PullRequestSummary[]>;
  /** prListCacheKey(projectId, state) → error string from the last list fetch (null = ok). */
  listErrors: Record<string, string | null>;
  /** projectId → prNumber → detail bundle. */
  details: Record<string, Record<number, PrDetailBundle>>;
  /** projectId → prNumber → error from the last detail fetch. */
  detailErrors: Record<string, Record<number, string | null>>;
  /** In-flight locks (fetch start timestamp; 0/undefined = idle) so a refresh
   * loop can't stack duplicate fetches. Stale locks are taken over. */
  listLoading: Record<string, number>;
  detailLoading: Record<string, Record<number, number>>;

  refreshList: (projectId: string, state?: PrListState) => Promise<void>;
  loadDetail: (projectId: string, number: number) => Promise<void>;
  /** Drop a project's caches (project switch away + back = fresh data). */
  invalidate: (projectId: string) => void;
}

export const usePullRequestsStore = create<PullRequestsState>((set, get) => ({
  lists: {},
  listErrors: {},
  details: {},
  detailErrors: {},
  listLoading: {},
  detailLoading: {},

  refreshList: async (projectId, state = "open") => {
    const key = prListCacheKey(projectId, state);
    if (lockIsFresh(get().listLoading[key])) return;
    const start = Date.now();
    set((s) => ({ listLoading: { ...s.listLoading, [key]: start } }));
    try {
      const prs = await withTimeout(githubListPrs(projectId, state), "GitHub list PRs");
      set((s) => ({
        lists: { ...s.lists, [key]: prs },
        listErrors: { ...s.listErrors, [key]: null },
        listLoading: { ...s.listLoading, [key]: 0 },
      }));
    } catch (err) {
      set((s) => ({
        listErrors: { ...s.listErrors, [key]: String(err) },
        listLoading: { ...s.listLoading, [key]: 0 },
      }));
    }
  },

  loadDetail: async (projectId, number) => {
    if (lockIsFresh(get().detailLoading[projectId]?.[number])) return;
    const start = Date.now();
    set((s) => ({
      detailLoading: {
        ...s.detailLoading,
        [projectId]: { ...s.detailLoading[projectId], [number]: start },
      },
    }));
    try {
      const [detail, files, checks] = await withTimeout(
        Promise.all([
          githubGetPr(projectId, number),
          githubPrFiles(projectId, number),
          githubPrChecks(projectId, number).catch(() => null), // checks are best-effort
        ]),
        "PR detail",
      );
      set((s) => ({
        details: {
          ...s.details,
          [projectId]: { ...s.details[projectId], [number]: { detail, files, checks } },
        },
        detailErrors: {
          ...s.detailErrors,
          [projectId]: { ...s.detailErrors[projectId], [number]: null },
        },
        detailLoading: {
          ...s.detailLoading,
          [projectId]: { ...s.detailLoading[projectId], [number]: 0 },
        },
      }));
    } catch (err) {
      set((s) => ({
        detailErrors: {
          ...s.detailErrors,
          [projectId]: { ...s.detailErrors[projectId], [number]: String(err) },
        },
        detailLoading: {
          ...s.detailLoading,
          [projectId]: { ...s.detailLoading[projectId], [number]: 0 },
        },
      }));
    }
  },

  invalidate: (projectId) =>
    set((s) => {
      const drop = <T,>(rec: Record<string, T>): Record<string, T> => {
        const next: Record<string, T> = {};
        for (const [k, v] of Object.entries(rec)) {
          if (k !== projectId && !k.startsWith(`${projectId}:`)) next[k] = v;
        }
        return next;
      };
      return {
        lists: drop(s.lists),
        listErrors: drop(s.listErrors),
        details: drop(s.details),
        detailErrors: drop(s.detailErrors),
      };
    }),
}));

/** Test-only: reset all caches between tests. */
export function _resetPullRequestsForTests(): void {
  usePullRequestsStore.setState({
    lists: {},
    listErrors: {},
    details: {},
    detailErrors: {},
    listLoading: {},
    detailLoading: {},
  });
}
