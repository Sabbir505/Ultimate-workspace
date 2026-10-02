// Project wiki surfaces (§6.15): the overlay reader (page tree, evidence
// ledger, stale banner, build/update/cancel controls, empty state) and the
// tool-panel tab (status line, page list, Open disabled without pages). The
// wiki IPC module and the heavy MermaidDiagram renderer are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useProjectsStore } from "../state/projects";
import { useWikiStore } from "../state/wiki";
import type { WikiStatus, WikiPageFull } from "../lib/ipc/wiki";

const wikiGetMock = vi.fn();
const wikiReadPageMock = vi.fn();
const wikiBuildStartMock = vi.fn();
const wikiUpdateMock = vi.fn();
const wikiCancelMock = vi.fn();
const wikiRemoveMock = vi.fn();
const wikiListAllMock = vi.fn();

vi.mock("../lib/ipc/wiki", () => ({
  wikiListAll: (...a: unknown[]) => wikiListAllMock(...a),
  wikiGet: (...a: unknown[]) => wikiGetMock(...a),
  wikiReadPage: (...a: unknown[]) => wikiReadPageMock(...a),
  wikiBuildStart: (...a: unknown[]) => wikiBuildStartMock(...a),
  wikiUpdate: (...a: unknown[]) => wikiUpdateMock(...a),
  wikiCancel: (...a: unknown[]) => wikiCancelMock(...a),
  wikiRemove: (...a: unknown[]) => wikiRemoveMock(...a),
  onWikiBuildProgress: vi.fn().mockReturnValue(Promise.resolve(() => {})),
}));

vi.mock("../lib/ipc", () => ({
  toastError: vi.fn(),
}));

vi.mock("../components/chat/MermaidDiagram", () => ({
  MermaidDiagram: ({ code }: { code: string }) => (
    <div data-testid="mermaid-stub">{code}</div>
  ),
}));

import { WikiView } from "../components/wiki/WikiView";

// Typed, so a drift between the fixture and the real WikiStatus contract is a
// COMPILE error rather than something only a test happens to exercise.
const STATUS: WikiStatus = {
  project: {
    id: "w1",
    path: "/repo",
    headSha: "abc123",
    schemaVersion: 1,
    builtAt: 1_700_000_000,
    lastUpdateAt: 1_700_000_000,
    buildModel: "openrouter:stealth/space-bunny-alpha",
  },
  pages: [
    {
      id: "p1",
      slug: "overview",
      title: "Overview",
      kind: "overview",
      summary: "The big picture",
      status: "fresh",
      staleReason: null,
      generatedAt: 1_700_000_000,
      generatedBy: "openrouter:stealth/space-bunny-alpha",
    },
    {
      id: "p2",
      slug: "mesh",
      title: "Mesh",
      kind: "module",
      summary: "Peer messaging",
      status: "stale",
      staleReason: "src/mesh.rs",
      generatedAt: 1_700_000_000,
      generatedBy: "openrouter:stealth/space-bunny-alpha",
    },
  ],
  autoUpdate: true,
  layerIndex: true,
  hasModel: true,
  // Required by the WikiStatus contract; drives the reload-mid-build case.
  jobRunning: false,
};

const PAGES: Record<string, WikiPageFull> = {
  overview: {
    ...STATUS.pages[0],
    body: "# Overview\nThe mesh routes messages.\n\n```mermaid\nflowchart TD\n  A --> B\n```",
    brief: "b",
    files: ["README.md"],
    claims: [
      {
        claim: "The mesh routes messages.",
        evidencePath: "src/mesh.rs",
        lineStart: 1,
        lineEnd: 2,
        blobSha: "deadbeef1234",
      },
    ],
  },
  mesh: { ...STATUS.pages[1], body: "# Mesh", brief: "b", files: [], claims: [] },
};

beforeEach(() => {
  vi.clearAllMocks();
  wikiGetMock.mockResolvedValue(STATUS);
  wikiReadPageMock.mockImplementation(async (_p: string, slug: string) =>
    (PAGES as Record<string, unknown>)[slug] ?? null,
  );
  wikiBuildStartMock.mockResolvedValue(undefined);
  wikiUpdateMock.mockResolvedValue({ status: "up_to_date", pagesRefreshed: 0, changedPaths: 0 });
  wikiCancelMock.mockResolvedValue(true);
  wikiListAllMock.mockResolvedValue([
    {
      path: "/repo",
      pageCount: 2,
      staleCount: 1,
      builtAt: 1_700_000_000,
      buildModel: "openrouter:stealth/space-bunny-alpha",
    },
  ]);
  useProjectsStore.setState({
    projects: [{ id: "prj1", path: "/repo", name: "repo", isGitRepo: true, createdAt: 0, lastOpenedAt: 0 }],
    selectedProjectId: "prj1",
  } as never);
  useWikiStore.setState({
    allSummaries: [],
    status: null,
    statusLoading: false,
    loadedPath: null,
    selectedSlug: null,
    pageDetail: null,
    pageLoading: false,
    progress: null,
    updating: false,
    updateNote: null,
  });
});

afterEach(() => cleanup());

describe("WikiView overlay", () => {
  it("renders the page tree and the selected page with its evidence ledger", async () => {
    render(<WikiView />);
    await waitFor(() => {
      expect(screen.getByTestId("wiki-page-overview")).toBeTruthy();
      expect(screen.getByTestId("wiki-page-mesh")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByTestId("wiki-claims")).toBeTruthy();
    });
    // Mermaid fences render as diagrams, not raw code. The markdown parser
    // loads lazily and its first compile under full-suite parallel load can
    // exceed the default 1s waitFor — give it room.
    await waitFor(
        () => {
          expect(screen.getByTestId("mermaid-stub")).toBeTruthy();
        },
        { timeout: 10_000 },
    );
    await waitFor(
        () => {
          // The sentence renders in the body AND in its evidence row.
          expect(screen.getAllByText(/The mesh routes messages\./).length).toBeGreaterThanOrEqual(2);
        },
        { timeout: 10_000 },
    );
    // Selecting the stale page shows its reason banner.
    fireEvent.click(screen.getByTestId("wiki-page-mesh"));
    await waitFor(() => {
      expect(screen.getByText(/Stale — its cited sources changed/)).toBeTruthy();
    });
  });

  it("empty state explains the feature and disables Build without a model", async () => {
    wikiGetMock.mockResolvedValue({ ...STATUS, project: null, pages: [], hasModel: false });
    render(<WikiView />);
    await waitFor(() => {
      expect(screen.getByText("No wiki yet")).toBeTruthy();
    });
    const build = screen.getByText("Build the wiki") as HTMLButtonElement;
    expect(build.disabled).toBe(true);
    expect(screen.getByText(/No build model configured/)).toBeTruthy();
  });

  it("wires the add menu, Update and Cancel to the IPC layer", async () => {
    // Two projects: /repo already has a wiki, /other does not. The menu has to
    // tell those two cases apart — open the first, build the second.
    useProjectsStore.setState({
      projects: [
        { id: "prj1", path: "/repo", name: "repo", isGitRepo: true, createdAt: 0, lastOpenedAt: 0 },
        { id: "prj2", path: "/other", name: "other", isGitRepo: true, createdAt: 0, lastOpenedAt: 0 },
      ],
      selectedProjectId: "prj1",
    } as never);
    render(<WikiView />);
    await waitFor(() => {
      expect(screen.getByTestId("wiki-page-overview")).toBeTruthy();
    });
    // The title bar's Build button is gone — the plus menu replaces it.
    expect(screen.queryByTestId("wiki-build")).toBeNull();
    // A project that already has a wiki opens it instead of rebuilding.
    fireEvent.click(screen.getByTestId("wiki-add"));
    fireEvent.click(screen.getByTestId("wiki-add-/repo"));
    await waitFor(() => {
      expect(wikiGetMock).toHaveBeenCalled();
    });
    expect(wikiBuildStartMock).not.toHaveBeenCalled();
    // A project without one starts a build.
    fireEvent.click(screen.getByTestId("wiki-add"));
    fireEvent.click(screen.getByTestId("wiki-add-/other"));
    await waitFor(() => {
      expect(wikiBuildStartMock).toHaveBeenCalledWith("/other");
    });
    fireEvent.click(screen.getByTestId("wiki-update"));
    await waitFor(() => {
      expect(wikiUpdateMock).toHaveBeenCalledWith("/repo");
    });
    act(() => {
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
    });
    await waitFor(() => {
      // Progress rides the window title bar now, not a panel at the foot.
      expect(screen.getByTestId("wiki-titlebar-progress")).toBeTruthy();
      expect(screen.queryByTestId("wiki-feed")).toBeNull();
    });
    expect(screen.getByText(/Building wiki/)).toBeTruthy();
    // Header (testid) and feed both expose Cancel — use the testid one.
    fireEvent.click(screen.getByTestId("wiki-cancel"));
    await waitFor(() => {
      expect(wikiCancelMock).toHaveBeenCalledWith("/repo");
    });
  });

  it("closes the add menu on Escape", async () => {
    render(<WikiView />);
    fireEvent.click(screen.getByTestId("wiki-add"));
    expect(screen.getByTestId("wiki-add-/repo")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("wiki-add-/repo")).toBeNull();
    });
  });

  it("renders as a real view (no overlay backdrop, no Settings button)", async () => {
    render(<WikiView />);
    await waitFor(() => {
      expect(screen.getByTestId("wiki-view")).toBeTruthy();
    });
    // No view-overlay wrapper: the wiki swaps the grid like automations/vault.
    expect(screen.queryByTestId("wiki-view-overlay")).toBeNull();
    expect(document.querySelector(".wiki-view")?.className).not.toContain("view-overlay");
    expect(screen.queryByText("Settings")).toBeNull();
    expect(screen.queryByText("Close")).toBeNull();
  });

  it("shows the stale page's banner and the update note after an update", async () => {
    render(<WikiView />);
    await waitFor(() => {
      expect(screen.getByTestId("wiki-reader")).toBeTruthy();
    });
    wikiUpdateMock.mockResolvedValue({ status: "updated", pagesRefreshed: 2, changedPaths: 1 });
    fireEvent.click(screen.getByTestId("wiki-update"));
    await waitFor(() => {
      expect(screen.getByText(/Updated 2 page\(s\) from 1 changed/)).toBeTruthy();
    });
  });

  it("splits the rails: projects on the left, that project's pages on the right", async () => {
    render(<WikiView />);
    await waitFor(() => {
      expect(screen.getByTestId("wiki-page-overview")).toBeTruthy();
    });
    const projectRail = screen.getByLabelText("Wiki projects");
    const pageRail = screen.getByLabelText("Wiki pages");
    // The project list is its own rail, and it does not carry pages.
    await waitFor(() => {
      expect(projectRail.querySelector(".wiki-rail-project")).toBeTruthy();
    });
    expect(projectRail.querySelector(".wiki-page-row")).toBeNull();
    // The pages of the selected project sit in the right-hand rail.
    expect(pageRail.querySelector(".wiki-page-row")).toBeTruthy();
    expect(pageRail.contains(screen.getByTestId("wiki-page-overview"))).toBe(true);
  });

  it("keeps the project rail but hides the page rail until a project is selected", async () => {
    useProjectsStore.setState({ projects: [], selectedProjectId: null } as never);
    wikiGetMock.mockResolvedValue({ ...STATUS, project: null, pages: [], hasModel: true });
    render(<WikiView />);
    await waitFor(() => {
      expect(screen.getByText("No wiki yet")).toBeTruthy();
    });
    // The projects rail is always there; the pages rail needs a selection.
    expect(screen.getByLabelText("Wiki projects")).toBeTruthy();
    expect(screen.queryByLabelText("Wiki pages")).toBeNull();
  });

  it("deletes a project wiki from its rail row: first click arms, second deletes", async () => {
    render(<WikiView />);
    const del = await screen.findByTestId("wiki-remove-/repo");
    // The title bar no longer carries a delete control — it lives on the row.
    expect(screen.queryByLabelText("Delete the wiki")).toBeNull();
    fireEvent.click(del);
    expect(wikiRemoveMock).not.toHaveBeenCalled();
    expect(del.className).toContain("is-armed");
    fireEvent.click(del);
    await waitFor(() => {
      expect(wikiRemoveMock).toHaveBeenCalledWith("/repo");
    });
  });

  // ── regressions ──────────────────────────────────────────────────────────

  it("still reports the update note after a build has run", async () => {
    // The store deliberately keeps the terminal `progress` object (the title
    // pill fades out on it), and the view gated the note on `!progress` — so
    // once ANY build had run in the session, Update reported nothing at all.
    render(<WikiView />);
    await waitFor(() => {
      expect(screen.getByTestId("wiki-reader")).toBeTruthy();
    });
    act(() => {
      useWikiStore.getState().applyProgress({
        path: "/repo", mode: "build", state: "done", phase: "finalizing",
        pageSlug: null, pagesDone: 2, pagesTotal: 2, error: null,
        step: "Wiki ready — 2 pages",
      });
    });
    expect(useWikiStore.getState().progress).not.toBeNull();
    // A terminal event kicks off a reload, which briefly disables Update
    // (it needs `status.project`); wait for it like a user would.
    await waitFor(() => {
      expect(useWikiStore.getState().statusLoading).toBe(false);
    });

    wikiUpdateMock.mockResolvedValue({ status: "updated", pagesRefreshed: 3, changedPaths: 2 });
    fireEvent.click(screen.getByTestId("wiki-update"));
    await waitFor(() => {
      expect(screen.getByText(/Updated 3 page\(s\) from 2 changed/)).toBeTruthy();
    });
  });

  it("disables Build while a build is already running", async () => {
    // A build leaves `status.pages` empty until the terminal event reloads it,
    // so the empty-state Build button stayed live for the whole run and a
    // second click died on the Rust registry's "already running" guard.
    useWikiStore.setState({ status: null, loadedPath: null, pageDetail: null });
    let resolveGet: (v: unknown) => void = () => {};
    wikiGetMock.mockImplementation(
      () =>
        new Promise((r) => {
          resolveGet = r;
        }),
    );
    render(<WikiView />);
    await waitFor(() => {
      expect(screen.getByText("Loading…")).toBeTruthy();
    });

    await act(async () => {
      resolveGet({ ...STATUS, pages: [] });
    });
    await waitFor(() => {
      expect(screen.getByText("No wiki yet")).toBeTruthy();
    });
    const buildBtn = screen.getByRole("button", { name: "Build the wiki" }) as HTMLButtonElement;
    expect(buildBtn.disabled).toBe(false);

    act(() => {
      useWikiStore.setState({
        status: { ...STATUS, pages: [] },
        loadedPath: "/repo",
        progress: {
          path: "/repo",
          mode: "build",
          state: "running",
          phase: "pages",
          pageSlug: null,
          pagesDone: 0,
          pagesTotal: 3,
          error: null,
          step: "Writing",
        },
      });
    });
    expect((screen.getByRole("button", { name: "Build the wiki" }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it("escapes the running state when Cancel finds no job", async () => {
    // The reload-mid-build case: `jobRunning: true` from the status snapshot,
    // but no registry entry — so no event will ever arrive and the Cancel
    // button could never do anything. The only exit used to be an app restart.
    render(<WikiView />);
    await waitFor(() => {
      expect(screen.getByTestId("wiki-reader")).toBeTruthy();
    });
    await act(async () => {
      useWikiStore.setState({
        status: { ...STATUS, jobRunning: true },
        progress: null,
        loadedPath: "/repo",
      });
    });
    expect(screen.getByTestId("wiki-cancel")).toBeTruthy();

    wikiCancelMock.mockResolvedValue(false);
    wikiGetMock.mockResolvedValue({ ...STATUS, jobRunning: false });
    fireEvent.click(screen.getByTestId("wiki-cancel"));

    await waitFor(() => {
      expect(screen.queryByTestId("wiki-cancel")).toBeNull();
    });
    expect(screen.getByTestId("wiki-reader")).toBeTruthy();
  });

  it("distinguishes loading from a project that genuinely has no wiki", async () => {
    // Both rendered the same "No wiki yet" + live Build button, so a failed
    // or in-flight load told the user to build a wiki that already existed.
    let resolveGet: (v: unknown) => void = () => {};
    wikiGetMock.mockImplementation(
      () =>
        new Promise((r) => {
          resolveGet = r;
        }),
    );
    render(<WikiView />);
    await waitFor(() => {
      expect(screen.getByText("Loading…")).toBeTruthy();
    });
    expect(screen.queryByText("No wiki yet")).toBeNull();
    expect(screen.queryByRole("button", { name: "Build the wiki" })).toBeNull();

    // A real "no wiki" answer does show the empty state and its button.
    await act(async () => {
      resolveGet({ ...STATUS, pages: [] });
    });
    await waitFor(() => {
      expect(screen.getByText("No wiki yet")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "Build the wiki" })).toBeTruthy();
  });
});
