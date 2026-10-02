// Project wiki store (§6.15): load/select flows, the stale-response guard on
// project switches, progress application (running → reload on terminal
// states), and the update-note wording per report status. The IPC layer is
// mocked; the store logic is what's under test.
import { beforeEach, describe, expect, it, vi } from "vitest";

const wikiGetMock = vi.fn();
const wikiReadPageMock = vi.fn();
const wikiBuildStartMock = vi.fn();
const wikiUpdateMock = vi.fn();
const wikiCancelMock = vi.fn();
const wikiRemoveMock = vi.fn();
const wikiListAllMock = vi.fn();
const onWikiBuildProgressMock = vi.fn();

vi.mock("../lib/ipc/wiki", () => ({
  wikiGet: (...a: unknown[]) => wikiGetMock(...a),
  wikiReadPage: (...a: unknown[]) => wikiReadPageMock(...a),
  wikiBuildStart: (...a: unknown[]) => wikiBuildStartMock(...a),
  wikiUpdate: (...a: unknown[]) => wikiUpdateMock(...a),
  wikiCancel: (...a: unknown[]) => wikiCancelMock(...a),
  wikiRemove: (...a: unknown[]) => wikiRemoveMock(...a),
  wikiListAll: (...a: unknown[]) => wikiListAllMock(...a),
  onWikiBuildProgress: (...a: unknown[]) => onWikiBuildProgressMock(...a),
}));

import { useWikiStore } from "./wiki";
import type { WikiStatus, WikiPageFull } from "../lib/ipc/wiki";

// Typed: an untyped fixture silently drifts from the real contract, which is
// how `jobRunning` went missing from these tests and left the reload-mid-build
// path uncovered.
const STATUS_A: WikiStatus = {
  project: {
    id: "w1",
    path: "/repo",
    headSha: "abc",
    schemaVersion: 1,
    builtAt: 100,
    lastUpdateAt: 100,
    buildModel: "test:model",
  },
  pages: [
    {
      id: "p1",
      slug: "overview",
      title: "Overview",
      kind: "overview",
      summary: "big picture",
      status: "fresh",
      staleReason: null,
      generatedAt: 100,
      generatedBy: "test:model",
    },
    {
      id: "p2",
      slug: "mesh",
      title: "Mesh",
      kind: "module",
      summary: "peer messaging",
      status: "stale",
      staleReason: "src/mesh.rs changed",
      generatedAt: 100,
      generatedBy: "test:model",
    },
  ],
  autoUpdate: true,
  layerIndex: true,
  hasModel: true,
  jobRunning: false,
};

const PAGE_OVERVIEW: WikiPageFull = {
  ...STATUS_A.pages[0],
  body: "# Overview\nBody",
  brief: "brief",
  files: ["README.md"],
  claims: [
    { claim: "c", evidencePath: "README.md", lineStart: 1, lineEnd: 2, blobSha: "ff" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  wikiGetMock.mockResolvedValue(STATUS_A);
  wikiReadPageMock.mockImplementation(async (_path: string, slug: string) =>
    slug === "overview" ? PAGE_OVERVIEW : null,
  );
  wikiUpdateMock.mockResolvedValue({ status: "up_to_date", pagesRefreshed: 0, changedPaths: 0 });
  wikiListAllMock.mockResolvedValue([]);
  useWikiStore.setState({
    viewProjectPath: null,
    allSummaries: [],
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
  });
});

describe("wiki store", () => {
  it("loads status, defaults the selection to the first page, and fetches it", async () => {
    await useWikiStore.getState().load("/repo");
    expect(useWikiStore.getState().loadedPath).toBe("/repo");
    expect(useWikiStore.getState().selectedSlug).toBe("overview");
    await vi.waitFor(() => {
      expect(useWikiStore.getState().pageDetail?.slug).toBe("overview");
    });
    expect(useWikiStore.getState().pageLoading).toBe(false);
  });

  it("keeps the selection across a reload when the page still exists", async () => {
    const store = useWikiStore.getState();
    await store.load("/repo");
    await store.select("/repo", "mesh");
    expect(useWikiStore.getState().selectedSlug).toBe("mesh");
    await useWikiStore.getState().load("/repo");
    expect(useWikiStore.getState().selectedSlug).toBe("mesh");
    expect(wikiReadPageMock).toHaveBeenLastCalledWith("/repo", "mesh");
  });

  it("applies running progress without reloading, then reloads on a terminal state", async () => {
    await useWikiStore.getState().load("/repo");
    wikiGetMock.mockClear();
    useWikiStore.getState().applyProgress({
      path: "/repo",
      mode: "build",
      state: "running",
      phase: "pages",
      pageSlug: "overview",
      pagesDone: 1,
      pagesTotal: 4,
      error: null,
      step: "Wrote page: Overview (1/4)",
    });
    expect(useWikiStore.getState().progress?.pagesDone).toBe(1);
    expect(wikiGetMock).not.toHaveBeenCalled();
    useWikiStore.getState().applyProgress({
      path: "/repo",
      mode: "build",
      state: "done",
      phase: "finalizing",
      pageSlug: null,
      pagesDone: 4,
      pagesTotal: 4,
      error: null,
      step: "Wiki ready — 4 pages",
    });
    await vi.waitFor(() => {
      expect(wikiGetMock).toHaveBeenCalled();
    });
  });

  it("folds progress events into a done/running step feed", () => {
    const store = useWikiStore.getState();
    store.applyProgress({
      path: "/repo", mode: "build", state: "running", phase: "analysis",
      pageSlug: null, pagesDone: 0, pagesTotal: 0, error: null,
      step: "Exploring the project structure",
    });
    store.applyProgress({
      path: "/repo", mode: "build", state: "running", phase: "pages",
      pageSlug: "overview", pagesDone: 1, pagesTotal: 2, error: null,
      step: "Wrote page: Overview (1/2)",
    });
    const steps = useWikiStore.getState().steps;
    expect(steps.map((s) => s.state)).toEqual(["done", "running"]);
    // Same step text twice = one row, still running (no duplicates).
    store.applyProgress({
      path: "/repo", mode: "build", state: "running", phase: "pages",
      pageSlug: "overview", pagesDone: 1, pagesTotal: 2, error: null,
      step: "Wrote page: Overview (1/2)",
    });
    expect(useWikiStore.getState().steps).toHaveLength(2);
    store.applyProgress({
      path: "/repo", mode: "build", state: "error", phase: "pages",
      pageSlug: "mesh", pagesDone: 1, pagesTotal: 2,
      error: "boom", step: "boom",
    });
    const after = useWikiStore.getState().steps;
    expect(after[after.length - 1].state).toBe("failed");
    expect(after.slice(0, -1).every((s) => s.state === "done")).toBe(true);
  });

  it("starts a clean feed when a fresh build announces itself", () => {
    const store = useWikiStore.getState();
    store.applyProgress({
      path: "/repo", mode: "build", state: "running", phase: "analysis",
      pageSlug: null, pagesDone: 0, pagesTotal: 0, error: null,
      step: "Exploring the project structure",
    });
    store.applyProgress({
      path: "/repo", mode: "build", state: "running", phase: "pages",
      pageSlug: "overview", pagesDone: 1, pagesTotal: 2, error: null,
      step: "Wrote page: Overview (1/2)",
    });
    expect(useWikiStore.getState().steps).toHaveLength(2);
    // A second build's analysis event wipes the previous job's rows.
    store.applyProgress({
      path: "/repo", mode: "build", state: "running", phase: "analysis",
      pageSlug: null, pagesDone: 0, pagesTotal: 0, error: null,
      step: "Exploring the project structure",
    });
    expect(useWikiStore.getState().steps).toHaveLength(1);
  });

  it("words the update note per report status", async () => {
    const store = useWikiStore.getState();
    await store.load("/repo");
    await store.update("/repo");
    expect(useWikiStore.getState().updateNote).toContain("up to date");
    wikiUpdateMock.mockResolvedValue({ status: "updated", pagesRefreshed: 2, changedPaths: 1 });
    await store.update("/repo");
    expect(useWikiStore.getState().updateNote).toContain("Updated 2 page(s) from 1 changed");
    expect(useWikiStore.getState().updating).toBe(false);
  });

  it("drops a deleted project from the summaries the rail renders", async () => {
    const store = useWikiStore.getState();
    await store.openProject("/repo");
    wikiListAllMock.mockResolvedValue([
      { path: "/repo", pageCount: 2, staleCount: 0, builtAt: 100, buildModel: "test:model" },
    ]);
    await store.loadAll();
    expect(useWikiStore.getState().allSummaries).toHaveLength(1);

    // Deleting used to reload only this path's status, so the rail (which
    // renders from allSummaries) kept showing the project until app restart.
    wikiRemoveMock.mockResolvedValue(true);
    wikiListAllMock.mockResolvedValue([]);
    await store.remove("/repo");

    expect(useWikiStore.getState().allSummaries).toEqual([]);
    expect(useWikiStore.getState().viewProjectPath).toBeNull();
    expect(useWikiStore.getState().status).toBeNull();
    expect(useWikiStore.getState().pageDetail).toBeNull();
  });

  it("build/remove/cancel delegate to the IPC layer", async () => {
    const store = useWikiStore.getState();
    await store.build("/repo");
    expect(wikiBuildStartMock).toHaveBeenCalledWith("/repo");
    await store.cancel("/repo");
    expect(wikiCancelMock).toHaveBeenCalledWith("/repo");
    wikiRemoveMock.mockResolvedValue(true);
    await store.remove("/repo");
    expect(wikiRemoveMock).toHaveBeenCalledWith("/repo");
  });

  // ── races ────────────────────────────────────────────────────────────────

  it("ignores a slow load for the previous project", async () => {
    // The regression: `load("/repo-a")` is in flight, the user switches to
    // "/repo-b", and A's reply lands last. A's status must NOT win — the old
    // guard required `status == null`, so a response CARRYING a real status
    // (the common case: A has pages) sailed straight through and re-pointed
    // the whole reader at A while the header said B.
    const statusB = { ...STATUS_A, pages: [{ ...STATUS_A.pages[0], id: "pb", slug: "overview" }] };
    let resolveA: (v: unknown) => void = () => {};
    wikiGetMock.mockImplementation(async (path: string) => {
      if (path === "/repo-a") {
        return new Promise((r) => {
          resolveA = r;
        });
      }
      return statusB;
    });
    wikiReadPageMock.mockImplementation(async (path: string) => ({
      ...PAGE_OVERVIEW,
      id: path,
    }));

    const aLoad = useWikiStore.getState().load("/repo-a");
    await useWikiStore.getState().load("/repo-b");
    expect(useWikiStore.getState().loadedPath).toBe("/repo-b");

    // A's reply finally arrives, carrying a real status.
    resolveA(STATUS_A);
    await aLoad;

    expect(useWikiStore.getState().loadedPath).toBe("/repo-b");
    expect(useWikiStore.getState().status).toEqual(statusB);
  });

  it("keeps a page body from the wrong project out of the reader", async () => {
    // Both wikis have an `overview` page, so the old slug-only guard could
    // not tell the two in-flight reads apart: A's body landed in B's reader.
    const detailA = { ...PAGE_OVERVIEW, body: "BODY FROM A" };
    const detailB = { ...PAGE_OVERVIEW, body: "BODY FROM B" };
    let resolveA: (v: unknown) => void = () => {};
    wikiReadPageMock.mockImplementation(async (path: string) =>
      path === "/repo-a"
        ? new Promise((r) => {
            resolveA = r;
          })
        : detailB,
    );
    useWikiStore.setState({ loadedPath: "/repo-b", selectedSlug: "overview" });

    const aSelect = useWikiStore.getState().select("/repo-a", "overview");
    await useWikiStore.getState().select("/repo-b", "overview");
    resolveA(detailA);
    await aSelect;

    expect(useWikiStore.getState().pageDetail?.body).toBe("BODY FROM B");
  });

  it("does not let another project's progress drive this view", async () => {
    // A build running on /repo-a put A's progress into a store showing
    // /repo-b: B's header flipped to "running", B's Cancel button then
    // cancelled "/repo-b" (a no-op, so A kept building), and A's percentage
    // rendered in B's title bar. The write had no path filter — only the
    // reload branch below it did.
    await useWikiStore.getState().load("/repo");
    useWikiStore.getState().applyProgress({
      path: "/repo", mode: "build", state: "running", phase: "analysis",
      pageSlug: null, pagesDone: 0, pagesTotal: 0, error: null,
      step: "Exploring",
    });
    expect(useWikiStore.getState().progress).not.toBeNull();

    useWikiStore.getState().applyProgress({
      path: "/OTHER-REPO", mode: "build", state: "running", phase: "pages",
      pageSlug: "overview", pagesDone: 3, pagesTotal: 9, error: null,
      step: "Wrote page: Overview (3/9)",
    });

    expect(useWikiStore.getState().progress?.path).toBe("/repo");
    expect(useWikiStore.getState().progress?.pagesTotal).toBe(0);
  });

  it("clears the previous project's pages while the next one loads", async () => {
    // Otherwise the old project's page tree AND full body rendered under the
    // new project's header for the whole round trip.
    let resolveB: (v: unknown) => void = () => {};
    wikiGetMock.mockImplementation(async (path: string) =>
      path === "/repo-b"
        ? new Promise((r) => {
            resolveB = r;
          })
        : STATUS_A,
    );
    await useWikiStore.getState().load("/repo");
    await vi.waitFor(() => {
      expect(useWikiStore.getState().pageDetail?.slug).toBe("overview");
    });

    const bLoad = useWikiStore.getState().load("/repo-b");
    expect(useWikiStore.getState().status).toBeNull();
    expect(useWikiStore.getState().pageDetail).toBeNull();
    expect(useWikiStore.getState().statusLoading).toBe(true);

    resolveB(STATUS_A);
    await bLoad;
    expect(useWikiStore.getState().statusLoading).toBe(false);
  });

  it("clears pageLoading when a page read rejects", async () => {
    // No try/finally meant a rejected read left the flag true forever, so the
    // reader rendered a permanent "Loading…".
    await useWikiStore.getState().load("/repo");
    wikiReadPageMock.mockRejectedValue("boom");
    await expect(useWikiStore.getState().select("/repo", "mesh")).rejects.toThrow("boom");
    expect(useWikiStore.getState().pageLoading).toBe(false);
  });

  it("clears statusLoading when the status read rejects", async () => {
    // Same class of bug on the outer load: a failed wikiGet left the
    // "Loading…" state up forever.
    wikiGetMock.mockRejectedValue("nope");
    await expect(useWikiStore.getState().load("/repo")).rejects.toThrow("nope");
    expect(useWikiStore.getState().statusLoading).toBe(false);
  });

  it("re-reads the status when cancel finds no job to cancel", async () => {
    // The deadlock the `jobRunning` snapshot exists to cover: the app
    // reloaded mid-build, so we hold `jobRunning: true` but no registry entry
    // exists and NO event will ever arrive. Left alone, the surface stayed
    // stuck in "running" with a Cancel button that could never do anything —
    // the only exit was an app restart.
    await useWikiStore.getState().load("/repo");
    wikiCancelMock.mockResolvedValue(false);
    wikiGetMock.mockClear();
    await useWikiStore.getState().cancel("/repo");
    await vi.waitFor(() => {
      expect(wikiGetMock).toHaveBeenCalledWith("/repo");
    });
  });

  it("does not re-read the status when cancel actually signalled a job", async () => {
    await useWikiStore.getState().load("/repo");
    wikiCancelMock.mockResolvedValue(true);
    wikiGetMock.mockClear();
    await useWikiStore.getState().cancel("/repo");
    // The job is still winding down; the terminal event is what reloads.
    expect(wikiGetMock).not.toHaveBeenCalled();
  });

  it("surfaces the update note after a build has run", async () => {
    // The store deliberately keeps a terminal `progress` object, and the view
    // gates the note on `!progress` — so once ANY build had run, Update
    // reported nothing at all for the rest of the session.
    await useWikiStore.getState().load("/repo");
    useWikiStore.getState().applyProgress({
      path: "/repo", mode: "build", state: "done", phase: "finalizing",
      pageSlug: null, pagesDone: 2, pagesTotal: 2, error: null,
      step: "Wiki ready",
    });
    expect(useWikiStore.getState().progress).not.toBeNull();

    wikiUpdateMock.mockResolvedValue({ status: "updated", pagesRefreshed: 2, changedPaths: 1 });
    await useWikiStore.getState().update("/repo");
    expect(useWikiStore.getState().updateNote).toContain("Updated 2 page(s)");
  });

  it("does not clobber the current project when an update finishes elsewhere", async () => {
    await useWikiStore.getState().load("/repo-b");
    wikiUpdateMock.mockResolvedValue({ status: "updated", pagesRefreshed: 1, changedPaths: 1 });
    const loadsForB: string[] = [];
    wikiGetMock.mockImplementation(async (path: string) => {
      loadsForB.push(path);
      return STATUS_A;
    });
    // An update for /repo-a is in flight while the view moved to /repo-b.
    await useWikiStore.getState().update("/repo-a");
    expect(useWikiStore.getState().loadedPath).toBe("/repo-b");
    expect(loadsForB).not.toContain("/repo-a");
  });
});
