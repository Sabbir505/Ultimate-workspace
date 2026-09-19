// Vault view + file tree integration tests: the sidebar entry renders the
// binder when nothing is bound and the workspace when bound; the tree opens
// notes and drives create/rename/delete through the store.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

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
  it("renders folders collapsed and expands on click", () => {
    render(<VaultFileTree tree={TREE as never} />);
    // Collapsed: the child note is not in the DOM yet.
    expect(screen.queryByText("2026-09-19.md")).toBeNull();
    fireEvent.click(screen.getByText("Journal"));
    expect(screen.getByText("2026-09-19.md")).toBeTruthy();
    expect(screen.getByText("Home.md")).toBeTruthy();
  });

  it("opens a note through the store", async () => {
    const openNote = vi.fn().mockResolvedValue(undefined);
    useVaultStore.setState({ openNote: openNote as never });
    render(<VaultFileTree tree={TREE as never} />);
    fireEvent.click(screen.getByText("Home.md"));
    expect(openNote).toHaveBeenCalledWith("Home.md");
  });

  it("delete asks for confirmation and calls the store", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const deleteNote = vi.fn().mockResolvedValue(undefined);
    useVaultStore.setState({ deleteNote: deleteNote as never });
    render(<VaultFileTree tree={TREE as never} />);
    // Find the row whose label is Home.md and click ITS delete button.
    const homeRow = screen.getByText("Home.md").closest(".vault-tree-row") as HTMLElement;
    const deleteBtn = homeRow.querySelector("[title='Delete note (to .trash)']") as HTMLElement;
    fireEvent.click(deleteBtn);
    expect(confirmSpy).toHaveBeenCalled();
    expect(deleteNote).toHaveBeenCalledWith("Home.md");
    confirmSpy.mockRestore();
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
