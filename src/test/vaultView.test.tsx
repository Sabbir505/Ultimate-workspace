// Vault view + file tree integration tests: the sidebar entry renders the
// binder when nothing is bound and the workspace when bound; the tree opens
// notes and drives create/rename/delete through the store.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const vaultGetStateMock = vi.fn();
const vaultTreeMock = vi.fn();
const vaultStatsMock = vi.fn();
const vaultBindMock = vi.fn();
const pickMock = vi.fn();

vi.mock("../lib/ipc", async (importOriginal) => {
  // Reuse the real store-facing surface but stub the network edge.
  const mod = await importOriginal<Record<string, unknown>>();
  return {
    ...mod,
    vaultGetState: (...a: unknown[]) => vaultGetStateMock(...a),
    vaultTree: (...a: unknown[]) => vaultTreeMock(...a),
    vaultStats: (...a: unknown[]) => vaultStatsMock(...a),
    vaultBind: (...a: unknown[]) => vaultBindMock(...a),
    listenVaultChanged: vi.fn().mockResolvedValue(() => {}),
    listenVaultScanned: vi.fn().mockResolvedValue(() => {}),
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...a: unknown[]) => pickMock(...a),
}));

import { VaultView } from "../components/vault/VaultView";
import { VaultFileTree } from "../components/vault/VaultFileTree";
import { useVaultStore } from "../state/vault";
import { useConfirmStore } from "../state/confirm";

const TREE = [
  {
    name: "Journal",
    path: "Journal",
    kind: "folder",
    children: [
      { name: "2026-09-19.md", path: "Journal/2026-09-19.md", kind: "note", children: [] },
    ],
  },
  { name: "Home.md", path: "Home.md", kind: "note", children: [] },
];

beforeEach(() => {
  vi.clearAllMocks();
  useVaultStore.setState({
    root: null,
    stats: null,
    tree: [],
    activePath: null,
    assetPath: null,
    content: "",
    savedContent: "",
    meta: null,
    graphOpen: false,
    switcherOpen: false,
  });
});

describe("VaultView", () => {
  it("shows the binder when no vault is bound", async () => {
    vaultGetStateMock.mockResolvedValue({ root: null, stats: null });
    render(<VaultView />);
    await waitFor(() => expect(screen.getByText("Bind a vault")).toBeTruthy());
    expect(screen.queryByText(/notes · /)).toBeNull();
  });

  it("binds through the folder dialog", async () => {
    vaultGetStateMock.mockResolvedValue({ root: null, stats: null });
    pickMock.mockResolvedValue("C:/newvault");
    vaultBindMock.mockResolvedValue("C:/newvault");
    vaultTreeMock.mockResolvedValue(TREE);
    render(<VaultView />);
    await waitFor(() => expect(screen.getByText("Choose folder…")).toBeTruthy());
    fireEvent.click(screen.getByText("Choose folder…"));
    await waitFor(() => expect(vaultBindMock).toHaveBeenCalledWith("C:/newvault"));
    expect(useVaultStore.getState().root).toBe("C:/newvault");
  });

  it("renders the workspace (header, rails, stats) when bound", async () => {
    vaultGetStateMock.mockResolvedValue({
      root: "C:/myvault",
      stats: { notes: 3, files: 4, links: 5, unresolved: 1 },
    });
    vaultTreeMock.mockResolvedValue(TREE);
    render(<VaultView />);
    await waitFor(() => expect(screen.getByText("myvault")).toBeTruthy());
    expect(screen.getByText(/3 notes · 5 links/)).toBeTruthy();
    expect(screen.getByText("Files")).toBeTruthy();
    expect(screen.getByText("Search")).toBeTruthy();
    expect(screen.getByText("Tags")).toBeTruthy();
  });
});

describe("VaultFileTree", () => {
  it("highlights an ASSET row once it is opened in the asset pane", () => {
    // Assets are tracked in `assetPath`, not `activePath`. Selection used to
    // compare against `activePath` alone, so a clicked PDF row never lit up
    // and opening one looked like a no-op.
    const tree = [
      { name: "spec.pdf", path: "Journal/spec.pdf", kind: "file" as const, children: [] },
    ];
    const row = () => document.querySelector(".vault-tree-row")!;
    useVaultStore.setState({ activePath: null, assetPath: null });
    const { unmount } = render(<VaultFileTree tree={tree as never} />);
    expect(row().classList.contains("selected")).toBe(false);
    unmount();

    useVaultStore.setState({ activePath: null, assetPath: "Journal/spec.pdf" });
    render(<VaultFileTree tree={tree as never} />);
    expect(row().classList.contains("selected")).toBe(true);
  });

  it("renders folders collapsed and expands on click", () => {
    render(<VaultFileTree tree={TREE as never} />);
    // Collapsed: the child is mounted (for the height animation) but its
    // container is shut (grid-rows 0fr).
    const container = () => document.querySelector(".vault-tree-children")!;
    expect(container()).toBeTruthy();
    expect(container().classList.contains("open")).toBe(false);
    fireEvent.click(screen.getByText("Journal"));
    expect(container().classList.contains("open")).toBe(true);
    expect(screen.getByText("2026-09-19.md")).toBeTruthy();
    expect(screen.getByText("Home.md")).toBeTruthy();
  });

  it("lets nested folders expand and collapse INDEPENDENTLY", () => {
    // Regression: the recursive Row used to thread the parent's expanded
    // boolean down, so nested folders were force-expanded and their
    // chevrons did nothing.
    const NESTED = [
      {
        name: "A",
        path: "A",
        kind: "folder",
        children: [
          {
            name: "B",
            path: "A/B",
            kind: "folder",
            children: [{ name: "deep.md", path: "A/B/deep.md", kind: "note", children: [] }],
          },
        ],
      },
    ];
    render(<VaultFileTree tree={NESTED as never} />);
    fireEvent.click(screen.getByText("A"));
    expect(screen.getByText("B")).toBeTruthy();
    // A's container is open; B's (nested inside) stays shut…
    const containers = document.querySelectorAll(".vault-tree-children");
    expect(containers.length).toBe(2);
    expect(containers[0].classList.contains("open")).toBe(true);
    expect(containers[1].classList.contains("open")).toBe(false);
    fireEvent.click(screen.getByText("B"));
    expect(containers[1].classList.contains("open")).toBe(true);
    // …and collapses again on the second click.
    fireEvent.click(screen.getByText("B"));
    expect(containers[1].classList.contains("open")).toBe(false);
  });

  it("opens a note through the store", async () => {
    const openNote = vi.fn().mockResolvedValue(undefined);
    useVaultStore.setState({ openNote: openNote as never });
    render(<VaultFileTree tree={TREE as never} />);
    fireEvent.click(screen.getByText("Home.md"));
    expect(openNote).toHaveBeenCalledWith("Home.md");
  });

  it("routes a non-note asset to openFile, not openNote", () => {
    const openNote = vi.fn().mockResolvedValue(undefined);
    const openFile = vi.fn().mockResolvedValue(undefined);
    useVaultStore.setState({ openNote: openNote as never, openFile: openFile as never });
    const WITH_ASSET = [
      ...TREE,
      { name: "Inference Engineering.pdf", path: "Inference Engineering.pdf", kind: "file", children: [] },
    ];
    render(<VaultFileTree tree={WITH_ASSET as never} />);
    fireEvent.click(screen.getByText("Inference Engineering.pdf"));
    expect(openFile).toHaveBeenCalledWith("Inference Engineering.pdf");
    expect(openNote).not.toHaveBeenCalled();
  });

  it("hides rename for assets but still offers delete", async () => {
    // Delete now opens the in-app confirm (state/confirm.ts) — accept it.
    useConfirmStore.setState({ current: null });
    const deleteNote = vi.fn().mockResolvedValue(undefined);
    useVaultStore.setState({ deleteNote: deleteNote as never });
    const WITH_ASSET = [{ name: "report.pdf", path: "report.pdf", kind: "file", children: [] }];
    render(<VaultFileTree tree={WITH_ASSET as never} />);
    const row = screen.getByText("report.pdf").closest(".vault-tree-row") as HTMLElement;
    // Rename would push the file through the .md-only path ("report.pdf.md").
    expect(row.querySelector("[title='Rename']")).toBeNull();
    fireEvent.click(row.querySelector("[title='Delete file (to .trash)']") as HTMLElement);
    await waitFor(() => expect(useConfirmStore.getState().current).toBeTruthy());
    act(() => useConfirmStore.getState().settle(true));
    await waitFor(() => expect(deleteNote).toHaveBeenCalledWith("report.pdf"));
  });

  it("renders the asset view (not the editor) when a file is active", () => {
    useVaultStore.setState({
      root: "C:/myvault",
      stats: { notes: 3, files: 4, links: 5, unresolved: 1 },
      tree: TREE as never,
      assetPath: "report.docx",
      activePath: null,
    });
    render(<VaultView />);
    expect(document.querySelector(".vault-asset-card")).toBeTruthy();
    expect(screen.getByText("Open in system app")).toBeTruthy();
    expect(document.querySelector(".vault-editor")).toBeNull();
    // The backlinks rail is note-only.
    expect(screen.queryByText(/Backlinks/)).toBeNull();
  });

  it("shows the asset and the note side by side when both are open", () => {
    useVaultStore.setState({
      root: "C:/myvault",
      stats: { notes: 3, files: 4, links: 5, unresolved: 1 },
      tree: TREE as never,
      assetPath: "Inference Engineering.pdf",
      activePath: "Home.md",
      content: "# home",
      savedContent: "# home",
    });
    render(<VaultView />);
    expect(document.querySelector(".vault-asset-pane")).toBeTruthy();
    expect(document.querySelector(".vault-note-split")).toBeTruthy();
    // Closing the asset keeps the note (and vice versa is covered in the store tests).
    fireEvent.click(screen.getAllByTitle("Close")[0]);
    expect(useVaultStore.getState().assetPath).toBeNull();
    expect(useVaultStore.getState().activePath).toBe("Home.md");
  });

  it("delete asks for confirmation and calls the store", async () => {
    useConfirmStore.setState({ current: null });
    const deleteNote = vi.fn().mockResolvedValue(undefined);
    useVaultStore.setState({ deleteNote: deleteNote as never });
    render(<VaultFileTree tree={TREE as never} />);
    // Find the row whose label is Home.md and click ITS delete button.
    const homeRow = screen.getByText("Home.md").closest(".vault-tree-row") as HTMLElement;
    const deleteBtn = homeRow.querySelector("[title='Delete note (to .trash)']") as HTMLElement;
    fireEvent.click(deleteBtn);
    // Nothing deleted until the in-app confirm is accepted.
    await waitFor(() => expect(useConfirmStore.getState().current).toBeTruthy());
    expect(deleteNote).not.toHaveBeenCalled();
    act(() => useConfirmStore.getState().settle(true));
    await waitFor(() => expect(deleteNote).toHaveBeenCalledWith("Home.md"));
  });

  it("delete does nothing when the confirm is denied", async () => {
    useConfirmStore.setState({ current: null });
    const deleteNote = vi.fn().mockResolvedValue(undefined);
    useVaultStore.setState({ deleteNote: deleteNote as never });
    render(<VaultFileTree tree={TREE as never} />);
    const homeRow = screen.getByText("Home.md").closest(".vault-tree-row") as HTMLElement;
    fireEvent.click(homeRow.querySelector("[title='Delete note (to .trash)']") as HTMLElement);
    await waitFor(() => expect(useConfirmStore.getState().current).toBeTruthy());
    act(() => useConfirmStore.getState().settle(false));
    expect(deleteNote).not.toHaveBeenCalled();
  });

  it("shows the empty state for an empty vault", () => {
    render(<VaultFileTree tree={[]} />);
    expect(screen.getByText(/Empty vault/)).toBeTruthy();
  });
});

describe("VaultQuickSwitcher fuzzy scorer", () => {
  it("ranks prefix and consecutive matches above scattered ones", async () => {
    const { fuzzyScore } = await import("../components/vault/VaultQuickSwitcher");
    expect(fuzzyScore("ho", "Home")).toBeGreaterThan(fuzzyScore("hm", "Home"));
    expect(fuzzyScore("", "Home")).toBe(0);
    expect(fuzzyScore("xyz", "Home")).toBe(0);
  });
});
