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

interface PullRequestsState {
  /** projectId → PR list (undefined = never loaded). */
  lists: Record<string, PullRequestSummary[]>;
  /** projectId → error string from the last list fetch (null = ok). */
  listErrors: Record<string, string | null>;
  /** projectId → prNumber → detail bundle. */
  details: Record<string, Record<number, PrDetailBundle>>;
  /** projectId → prNumber → error from the last detail fetch. */
  detailErrors: Record<string, Record<number, string | null>>;
  /** In-flight guards so a refresh loop can't stack duplicate fetches. */
  listLoading: Record<string, boolean>;
  detailLoading: Record<string, Record<number, boolean>>;

  refreshList: (projectId: string, state?: "open" | "closed" | "all") => Promise<void>;
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
    if (get().listLoading[projectId]) return;
    set((s) => ({ listLoading: { ...s.listLoading, [projectId]: true } }));
    try {
      const prs = await githubListPrs(projectId, state);
      set((s) => ({
        lists: { ...s.lists, [projectId]: prs },
        listErrors: { ...s.listErrors, [projectId]: null },
        listLoading: { ...s.listLoading, [projectId]: false },
      }));
    } catch (err) {
      set((s) => ({
        listErrors: { ...s.listErrors, [projectId]: String(err) },
        listLoading: { ...s.listLoading, [projectId]: false },
      }));
    }
  },

  loadDetail: async (projectId, number) => {
    if (get().detailLoading[projectId]?.[number]) return;
    set((s) => ({
      detailLoading: {
        ...s.detailLoading,
        [projectId]: { ...s.detailLoading[projectId], [number]: true },
      },
    }));
    try {
      const [detail, files, checks] = await Promise.all([
        githubGetPr(projectId, number),
        githubPrFiles(projectId, number),
        githubPrChecks(projectId, number).catch(() => null), // checks are best-effort
      ]);
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
          [projectId]: { ...s.detailLoading[projectId], [number]: false },
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
          [projectId]: { ...s.detailLoading[projectId], [number]: false },
        },
      }));
    }
  },

  invalidate: (projectId) =>
    set((s) => {
      const lists = { ...s.lists };
      const listErrors = { ...s.listErrors };
      const details = { ...s.details };
      const detailErrors = { ...s.detailErrors };
      delete lists[projectId];
      delete listErrors[projectId];
      delete details[projectId];
      delete detailErrors[projectId];
      return { lists, listErrors, details, detailErrors };
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
