// Tests for the Pulls tab: the pullRequests store reducers (list cache,
// detail bundle, error paths) and the PullsPanel component states
// (no project / not a repo / list / error / create-form validation).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const githubListPrsMock = vi.fn();
const githubGetPrMock = vi.fn();
const githubPrFilesMock = vi.fn();
const githubPrChecksMock = vi.fn();
const githubCreatePrMock = vi.fn();
const githubSubmitReviewMock = vi.fn();
const githubDraftPrTextMock = vi.fn();
const githubLocalBranchesMock = vi.fn();
const gitPushMock = vi.fn();

vi.mock("../lib/ipc", () => ({
  githubListPrs: (...a: unknown[]) => githubListPrsMock(...a),
  githubGetPr: (...a: unknown[]) => githubGetPrMock(...a),
  githubPrFiles: (...a: unknown[]) => githubPrFilesMock(...a),
  githubPrChecks: (...a: unknown[]) => githubPrChecksMock(...a),
  githubCreatePr: (...a: unknown[]) => githubCreatePrMock(...a),
  githubSubmitReview: (...a: unknown[]) => githubSubmitReviewMock(...a),
  githubDraftPrText: (...a: unknown[]) => githubDraftPrTextMock(...a),
  githubLocalBranches: (...a: unknown[]) => githubLocalBranchesMock(...a),
  gitPush: (...a: unknown[]) => gitPushMock(...a),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("../lib/openBrowserPane", () => ({ openInBrowserPane: vi.fn() }));

// PullsPanel reads project/branch/chat state from these stores — mock them as
// plain selector-callables over a mutable fixture object.
const projectsState = {
  projects: [] as { id: string; name: string; path: string }[],
  selectedProjectId: null as string | null,
  gitStatuses: {} as Record<string, { isRepo: boolean; branch: string | null; ahead: number }>,
};
const chatState = {
  activeChatSessionId: null as string | null,
  sessionProjects: {} as Record<string, string>,
};
vi.mock("../state/projects", () => ({
  useProjectsStore: (sel: (s: typeof projectsState) => unknown) => sel(projectsState),
}));
vi.mock("../state/chat", () => ({
  useChatStore: (sel: (s: typeof chatState) => unknown) => sel(chatState),
}));

import { _resetPullRequestsForTests, prListCacheKey, usePullRequestsStore } from "../state/pullRequests";
import { PullsPanel } from "../components/panes/PullsPanel";

const PR = {
  number: 42,
  title: "feat: add the thing",
  author: "octocat",
  authorAvatar: null,
  headBranch: "feat/thing",
  baseBranch: "main",
  draft: false,
  state: "open",
  htmlUrl: "https://github.com/o/r/pull/42",
  createdAt: "2026-08-01T10:00:00Z",
  updatedAt: "2026-08-02T10:00:00Z",
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  _resetPullRequestsForTests();
  projectsState.projects = [];
  projectsState.selectedProjectId = null;
  projectsState.gitStatuses = {};
  chatState.activeChatSessionId = null;
  chatState.sessionProjects = {};
  githubListPrsMock.mockResolvedValue([PR]);
  githubGetPrMock.mockResolvedValue({ ...PR, body: "body", headSha: "abc", additions: 3, deletions: 1, changedFiles: 2, mergeable: true });
  githubPrFilesMock.mockResolvedValue([]);
  githubPrChecksMock.mockResolvedValue({ state: "success", total: 2, failing: 0, pending: 0 });
  githubLocalBranchesMock.mockResolvedValue([
    { name: "main", isCurrent: false, isRemote: false },
    { name: "feat/thing", isCurrent: true, isRemote: false },
  ]);
});

function setupGitProject() {
  projectsState.projects = [{ id: "p1", name: "Repo", path: "C:\\repo" }];
  projectsState.selectedProjectId = "p1";
  projectsState.gitStatuses = { p1: { isRepo: true, branch: "feat/thing", ahead: 0 } };
}

describe("pullRequests store", () => {
  it("refreshList populates the list cache and clears errors", async () => {
    await usePullRequestsStore.getState().refreshList("p1");
    expect(githubListPrsMock).toHaveBeenCalledWith("p1", "open");
    expect(usePullRequestsStore.getState().lists[prListCacheKey("p1", "open")]).toEqual([PR]);
    expect(usePullRequestsStore.getState().listErrors[prListCacheKey("p1", "open")]).toBeNull();
  });

  it("caches each filter state separately", async () => {
    const closed = { ...PR, number: 7, state: "closed" };
    githubListPrsMock.mockImplementation((_projectId: string, state: string) =>
      state === "closed" ? Promise.resolve([closed]) : Promise.resolve([PR]),
    );
    await usePullRequestsStore.getState().refreshList("p1", "open");
    await usePullRequestsStore.getState().refreshList("p1", "closed");
    expect(usePullRequestsStore.getState().lists[prListCacheKey("p1", "open")]).toEqual([PR]);
    expect(usePullRequestsStore.getState().lists[prListCacheKey("p1", "closed")]).toEqual([closed]);
  });

  it("refreshList records the error string on failure", async () => {
    githubListPrsMock.mockRejectedValueOnce(new Error("no connector"));
    await usePullRequestsStore.getState().refreshList("p1");
    expect(usePullRequestsStore.getState().listErrors[prListCacheKey("p1", "open")]).toContain("no connector");
    expect(usePullRequestsStore.getState().lists[prListCacheKey("p1", "open")]).toBeUndefined();
  });

  it("dedupes a truly fresh in-flight fetch", async () => {
    let resolveFirst: (prs: unknown[]) => void = () => {};
    githubListPrsMock.mockReturnValue(new Promise((resolve) => { resolveFirst = resolve; }));
    const p1 = usePullRequestsStore.getState().refreshList("p1");
    const p2 = usePullRequestsStore.getState().refreshList("p1");
    resolveFirst([PR]);
    await Promise.all([p1, p2]);
    expect(githubListPrsMock).toHaveBeenCalledTimes(1);
  });

  it("takes over a stale (wedged) lock instead of dropping the refresh", async () => {
    const key = prListCacheKey("p1", "open");
    usePullRequestsStore.setState({ listLoading: { [key]: Date.now() - 60_000 } });
    await usePullRequestsStore.getState().refreshList("p1");
    expect(githubListPrsMock).toHaveBeenCalledTimes(1);
    expect(usePullRequestsStore.getState().lists[key]).toEqual([PR]);
  });

  it("releases the lock and records an error when a request never settles", async () => {
    vi.useFakeTimers();
    githubListPrsMock.mockReturnValue(new Promise(() => {}));
    const p = usePullRequestsStore.getState().refreshList("p1");
    await vi.advanceTimersByTimeAsync(20_000);
    await p;
    const key = prListCacheKey("p1", "open");
    expect(usePullRequestsStore.getState().listLoading[key]).toBe(0);
    expect(usePullRequestsStore.getState().listErrors[key]).toContain("timed out");
    vi.useRealTimers();
  });

  it("loadDetail bundles detail + files + checks; checks failure degrades to null", async () => {
    githubPrChecksMock.mockRejectedValueOnce(new Error("boom"));
    await usePullRequestsStore.getState().loadDetail("p1", 42);
    const bundle = usePullRequestsStore.getState().details.p1[42];
    expect(bundle.detail.number).toBe(42);
    expect(bundle.files).toEqual([]);
    expect(bundle.checks).toBeNull();
  });

  it("invalidate drops a project's caches", async () => {
    await usePullRequestsStore.getState().refreshList("p1");
    usePullRequestsStore.getState().invalidate("p1");
    expect(usePullRequestsStore.getState().lists[prListCacheKey("p1", "open")]).toBeUndefined();
  });
});

describe("PullsPanel", () => {
  it("shows the no-project empty state", () => {
    render(<PullsPanel />);
    expect(screen.getByText("No project selected")).toBeTruthy();
  });

  it("shows the not-a-repo empty state", () => {
    projectsState.projects = [{ id: "p1", name: "Plain", path: "C:\\plain" }];
    projectsState.selectedProjectId = "p1";
    projectsState.gitStatuses = { p1: { isRepo: false, branch: null, ahead: 0 } };
    render(<PullsPanel />);
    expect(screen.getByText("Not a git repository")).toBeTruthy();
  });

  it("renders PR rows from the list fetch", async () => {
    setupGitProject();
    render(<PullsPanel />);
    expect(await screen.findByText("feat: add the thing")).toBeTruthy();
    expect(screen.getByText("#42")).toBeTruthy();
  });

  it("renders the error state when the list fetch fails", async () => {
    setupGitProject();
    githubListPrsMock.mockRejectedValue(new Error("GitHub is not connected"));
    render(<PullsPanel />);
    expect(await screen.findByText("Couldn't load pull requests")).toBeTruthy();
    expect(screen.getByText(/GitHub is not connected/)).toBeTruthy();
  });

  it("shows the empty-list hint when there are no PRs", async () => {
    setupGitProject();
    githubListPrsMock.mockResolvedValue([]);
    render(<PullsPanel />);
    expect(await screen.findByText("No open pull requests")).toBeTruthy();
  });

  it("shows a spinner while a filter switch loads, then renders that filter's rows", async () => {
    setupGitProject();
    let resolveClosed: (prs: unknown[]) => void = () => {};
    githubListPrsMock.mockImplementation((_projectId: string, state: string) =>
      state === "closed"
        ? new Promise((resolve) => { resolveClosed = resolve; })
        : Promise.resolve([PR]),
    );
    render(<PullsPanel />);
    expect(await screen.findByText("feat: add the thing")).toBeTruthy();
    // The filter is a custom glass dropdown: open it, pick "Closed".
    fireEvent.click(screen.getByLabelText("Filter by state"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Closed" }));
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(document.querySelector(".pulls-spinner")).toBeTruthy();
    resolveClosed([{ ...PR, number: 7, state: "closed", title: "closed: fix the bug" }]);
    expect(await screen.findByText("closed: fix the bug")).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("keeps cached rows visible and spins the refresh button during a background refresh", async () => {
    setupGitProject();
    render(<PullsPanel />);
    expect(await screen.findByText("feat: add the thing")).toBeTruthy();
    let resolveSecond: (prs: unknown[]) => void = () => {};
    githubListPrsMock.mockImplementation(
      () => new Promise((resolve) => { resolveSecond = resolve; }),
    );
    fireEvent.click(screen.getByTitle("Refresh"));
    expect(screen.getByTitle("Refresh").querySelector(".pulls-spinner")).toBeTruthy();
    expect(screen.getByText("feat: add the thing")).toBeTruthy();
    resolveSecond([{ ...PR, title: "second: new title" }]);
    expect(await screen.findByText("second: new title")).toBeTruthy();
  });

  it("create form keeps submit disabled until a title is entered", async () => {
    setupGitProject();
    render(<PullsPanel />);
    fireEvent.click(await screen.findByText("New PR"));
    const submit = await screen.findByText("Create PR");
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("feat: add the thing"), {
      target: { value: "my PR" },
    });
    expect((screen.getByText("Create PR") as HTMLButtonElement).disabled).toBe(false);
  });

  it("opens the detail view when a row is clicked", async () => {
    setupGitProject();
    render(<PullsPanel />);
    fireEvent.click(await screen.findByText("feat: add the thing"));
    expect(await screen.findByText(/#42 feat: add the thing/)).toBeTruthy();
    expect(githubGetPrMock).toHaveBeenCalledWith("p1", 42);
  });
});
