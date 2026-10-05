// Project wiki (§6.15) store: status + pages for the selected project, the
// page under the reader, and live build/update progress. One module-level
// `wiki:build:progress` subscription feeds both surfaces (the overlay reader
// and the tool-panel tab) regardless of which is mounted.
import { create } from "zustand";
import {
  onWikiBuildProgress,
  wikiBuildStart,
  wikiCancel,
  wikiGet,
  wikiListAll,
  wikiReadPage,
  wikiRemove,
  wikiUpdate,
  type WikiPage,
  type WikiPageFull,
  type WikiProgress,
  type WikiProjectSummary,
  type WikiStatus,
} from "../lib/ipc/wiki";

/** One row of the live build feed: the step text and whether it has
 *  finished (a later event arrived) or is the current one. */
export interface WikiStep {
  text: string;
  state: "running" | "done" | "failed";
}

interface WikiState {
  /** Per-wiki rollups for the sidebar's project list. */
  allSummaries: WikiProjectSummary[];
  /** The project whose wiki the VIEW shows — set by the sidebar's wiki
   *  project entries; falls back to the sidebar's selected project. */
  viewProjectPath: string | null;
  status: WikiStatus | null;
  /** True while `status` is being fetched. Without it, "still loading" and
   *  "this project has no wiki" render the same empty state, so a failed or
   *  in-flight load told the user to build a wiki that already existed. */
  statusLoading: boolean;
  /** The project root the current status/page belong to. */
  loadedPath: string | null;
  selectedSlug: string | null;
  pageDetail: WikiPageFull | null;
  pageLoading: boolean;
  progress: WikiProgress | null;
  /** Accumulated step feed for the running/last job (cap 60). */
  steps: WikiStep[];
  updating: boolean;
  updateNote: string | null;

  loadAll: () => Promise<void>;
  /** Sidebar entry → open the view on this project's wiki. */
  openProject: (path: string) => Promise<void>;
  load: (path: string) => Promise<void>;
  select: (path: string, slug: string) => Promise<void>;
  build: (path: string) => Promise<void>;
  update: (path: string) => Promise<void>;
  cancel: (path: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  applyProgress: (p: WikiProgress) => void;
  clearProgress: () => void;
  resetFeed: () => void;
}

/** Monotonic token identifying the newest load/select. Any response whose
 *  token is stale is dropped: project switching and rapid page clicks both
 *  produce out-of-order IPC replies, and the old ones used to overwrite the
 *  new state (a slow `load("/a")` landing after `load("/b")` re-pointed the
 *  whole reader at A while the header said B). */
let requestSeq = 0;
const nextToken = () => ++requestSeq;
/** True when no newer load/select has started since `token` was minted. */
const isCurrent = (token: number) => token === requestSeq;

/** Rate-limits the select-on-missing-page status re-sync (one per second,
 *  so a pathological backend can't turn a null read into a reload loop). */
let lastPageResyncAt = 0;
/** Rate-limits the jobRunning snapshot refresh (one per 3s while a live
 *  build streams events that contradict the cached snapshot). */
let lastJobFlagRefreshAt = 0;


export const useWikiStore = create<WikiState>((set, get) => ({
  allSummaries: [],
  viewProjectPath: null,
  status: null,
  statusLoading: false,
  loadedPath: null,
  selectedSlug: null,
  pageDetail: null,
  pageLoading: false,
  progress: null,
  steps: [],
  updating: false,
  updateNote: null,

  openProject: async (path) => {
    set({ viewProjectPath: path });
    await get().load(path);
  },

  loadAll: async () => {
    const all = await wikiListAll();
    set({ allSummaries: all ?? [] });
  },

  load: async (path) => {
    const token = nextToken();
    const prev = get();
    // Only a genuine project SWITCH discards the current selection. A plain
    // reload of the same project must keep the page the reader was on (and
    // must not blank the reader mid-reload).
    const sameProject = prev.loadedPath === path;
    const prevSlug = sameProject ? prev.selectedSlug : null;
    // Drop the previous project's status/detail immediately: between the
    // click and the `wikiGet` reply, `status` still held the OLD project, so
    // its page tree and full page body rendered under the NEW project's
    // header for the whole round trip.
    set({
      statusLoading: true,
      status: null,
      pageDetail: null,
      pageLoading: false,
      selectedSlug: null,
      loadedPath: null,
    });
    let status: WikiStatus | null;
    try {
      status = await wikiGet(path);
    } finally {
      // A failure still has to clear the spinner, else the surface sits in
      // "Loading…" forever. `load`'s rejection propagates to the caller.
      if (isCurrent(token)) set({ statusLoading: false });
    }
    // A newer load/select started while this one was in flight.
    if (!isCurrent(token)) return;
    const keepSlug = prevSlug != null && (status?.pages.some((p) => p.slug === prevSlug) ?? false);
    set({
      status,
      statusLoading: false,
      loadedPath: path,
      selectedSlug: keepSlug ? prevSlug : (status?.pages[0]?.slug ?? null),
    });
    const slug = get().selectedSlug;
    if (path && slug) {
      await get().select(path, slug);
    } else {
      set({ pageDetail: null });
    }
  },

  select: async (path, slug) => {
    const token = nextToken();
    set({ selectedSlug: slug, pageLoading: true, pageDetail: null });
    let detail: WikiPageFull | null;
    try {
      detail = await wikiReadPage(path, slug);
    } finally {
      // `pageLoading` stuck at true rendered a permanent "Loading…" in the
      // reader whenever the read rejected.
      if (isCurrent(token)) set({ pageLoading: false });
    }
    // The guard must be (path, slug)-keyed, not slug-keyed: every project's
    // wiki has an `overview` page, so switching A→B left both selects with
    // the SAME slug and A's body won the race into B's reader.
    if (!isCurrent(token)) return;
    if (get().selectedSlug !== slug || get().loadedPath !== path) return;
    // A null read means the wiki (or that page) vanished under the reader —
    // the project row was deleted, or the list on screen is stale. Sitting
    // on "Select a page." with a dead list while every click returned null
    // read as "clicking does nothing". Re-sync the status once (bounded, so
    // a genuinely broken pair can't loop) instead of swallowing the null.
    if (!detail) {
      const listed = get().status?.pages.some((p) => p.slug === slug) ?? false;
      if (listed && Date.now() - lastPageResyncAt > 1_000) {
        lastPageResyncAt = Date.now();
        await get().load(path);
      }
      return;
    }
    set({ pageDetail: detail });
  },

  build: async (path) => {
    // The view FOLLOWS whatever it starts building — the Add menu and the
    // empty-state list start builds for projects other than the one on
    // screen, and the view used to stay behind on the old project (whose
    // wiki row might not even exist anymore), so page clicks after the build
    // hit the wrong path and silently returned nothing.
    set({ progress: null, steps: [], updateNote: null, viewProjectPath: path });
    try {
      await wikiBuildStart(path);
    } catch (e) {
      // A second Build click while one is already running used to die as a
      // red toast on the backend's registry guard. It isn't a failure — the
      // build the user asked for IS running — so reload the status instead:
      // `jobRunning` drives the title-bar progress pill and the Cancel
      // button, which is the whole ask.
      if (String(e).includes("already running")) {
        await get().load(path).catch(() => {});
        return;
      }
      throw e;
    }
  },

  update: async (path) => {
    set({ updating: true, updateNote: null });
    try {
      const report = await wikiUpdate(path);
      const note = report
        ? report.status === "updated"
          ? `Updated ${report.pagesRefreshed} page(s) from ${report.changedPaths} changed file(s).`
          : report.status === "up_to_date"
            ? "Wiki is up to date — no cited sources changed."
            : report.status === "rebuilt"
              ? "Rebuilt the wiki (page format or history changed)."
              : report.status === "not_git"
                ? "Not a git repository — updates are manual."
                : "No wiki yet — build one first."
        : null;
      // Clear the terminal progress object: `progress` is deliberately kept
      // after a job ends, and the view gates the update note on
      // `!progress` — so once ANY build had run, Update reported nothing at
      // all for the rest of the session.
      set({ updateNote: note, progress: null });
      // Only reload if the user is still looking at this project; otherwise
      // this writes the other project's state into a switched view.
      if (get().loadedPath === path || get().loadedPath === null) {
        await get().load(path);
      }
    } finally {
      set({ updating: false });
    }
  },

  cancel: async (path) => {
    const signalled = await wikiCancel(path);
    if (!signalled) {
      // Nothing to cancel — the job is already gone (the common case: the
      // user reloaded mid-build, so we hold `jobRunning: true` from the
      // status snapshot but no registry entry exists and NO event will ever
      // arrive). Left alone, the surface stayed stuck in "running" with a
      // Cancel button that could never do anything — the only exit was an
      // app restart. Re-read the status so the UI settles.
      if (get().loadedPath === path) await get().load(path);
    }
  },

  remove: async (path) => {
    await wikiRemove(path);
    // The project rail renders from allSummaries, so it MUST be refreshed
    // here — reloading only this path's status left the deleted project listed
    // until the app was restarted.
    await get().loadAll();
    // Drop the reading state when it pointed at the project just removed, so
    // the reader falls back to the selected project instead of showing the
    // dead one's last page.
    if (get().viewProjectPath === path) set({ viewProjectPath: null });
    if (get().loadedPath === path) {
      set({ status: null, loadedPath: null, selectedSlug: null, pageDetail: null });
    }
  },

  applyProgress: (p) => {
    // ONLY the loaded project's events may touch this store's view state. The
    // reload branch below was already path-checked, but the write was not — so
    // a build running on project A put A's progress into the store while the
    // view showed B: B's header flipped to "running", B's Cancel button then
    // cancelled "/b" (a no-op, so A kept building), and A's percentage
    // rendered in B's title bar.
    if (get().loadedPath !== null && get().loadedPath !== p.path) {
      // Still refresh the rail — another project's build finishing changes
      // the sidebar counts for everyone.
      if (p.state !== "running") void get().loadAll();
      return;
    }
    set((s) => {
      // Fold the event's step into the feed: every earlier row is done; the
      // newest text is the running row (or failed when the job errored).
      let steps = s.steps;
      // A fresh build announces itself with the analysis phase — start a
      // CLEAN feed instead of appending to the previous job's rows (a
      // restart after a failure used to stack look-alike cycles until the
      // feed read as an endless loop).
      if (p.mode === "build" && p.state === "running" && p.phase === "analysis") {
        steps = [];
      }
      const markDone = (rows: WikiStep[]) =>
        rows.map((r) => (r.state === "running" ? { ...r, state: "done" as const } : r));
      if (p.step) {
        steps = markDone(steps);
        const last = steps[steps.length - 1];
        if (!last || last.text !== p.step) {
          steps = [
            ...steps,
            {
              text: p.step,
              state: p.state === "error" ? ("failed" as const) : ("running" as const),
            },
          ];
        } else {
          steps[steps.length - 1] = {
            text: last.text,
            state: p.state === "error" ? ("failed" as const) : ("running" as const),
          };
        }
      } else if (p.state !== "running") {
        steps = markDone(steps);
      }
      if (steps.length > 60) steps = steps.slice(steps.length - 60);
      return { progress: p, steps };
    });
    // A live running event contradicted by the cached `jobRunning: false`
    // snapshot means the snapshot is STALE (taken before the build acquired
    // its registry slot). Refresh JUST the flag — a full `load` would flash
    // "Loading…" over the feed — so the view's dead-job reconciliation sees
    // current data and keeps the live feed visible. Throttled.
    if (
      p.state === "running" &&
      get().status?.jobRunning === false &&
      Date.now() - lastJobFlagRefreshAt > 3_000
    ) {
      lastJobFlagRefreshAt = Date.now();
      void wikiGet(p.path)
        .then((fresh) => {
          const cur = get();
          if (
            fresh &&
            cur.status &&
            cur.loadedPath === p.path &&
            cur.status.jobRunning !== fresh.jobRunning
          ) {
            useWikiStore.setState({
              status: { ...cur.status, jobRunning: fresh.jobRunning },
            });
          }
        })
        .catch(() => {});
    }
    if (p.state !== "running") {
      void get().loadAll();
      if (get().loadedPath === p.path) {
        void get().load(p.path);
      }
    }
  },

  clearProgress: () => set({ progress: null }),
  resetFeed: () => set({ progress: null, steps: [] }),
}));

// One listener for the app lifetime; both surfaces render from the store.
// The latch is set only on a SUCCESSFUL registration: `onWikiBuildProgress`
// resolves to null when the listen failed, and latching before the await
// meant one transient startup failure silently disabled ALL build progress
// for the rest of the session — builds kept running, the UI never heard.
let subscribed = false;
let subscribeAttempt: Promise<void> | null = null;
export function ensureWikiProgressSubscription(): Promise<void> {
  if (subscribed) return subscribeAttempt ?? Promise.resolve();
  subscribeAttempt = onWikiBuildProgress((p) =>
    useWikiStore.getState().applyProgress(p),
  )
    .then((unlisten) => {
      if (unlisten == null) {
        subscribed = false;
        subscribeAttempt = null;
        console.warn("[wiki] progress subscription unavailable; will retry on next mount");
        return;
      }
      subscribed = true;
    })
    .catch((e) => {
      subscribed = false;
      subscribeAttempt = null;
      console.warn("[wiki] progress subscription failed; will retry on next mount", e);
    });
  return subscribeAttempt;
}

/** Fresh/stale badge helpers shared by both surfaces. */
export function statusChip(status: WikiPage["status"]): string {
  switch (status) {
    case "fresh":
      return "fresh";
    case "stale":
      return "stale";
    default:
      return status;
  }
}
