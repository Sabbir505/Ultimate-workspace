// Vault store tests — the CRUD path, dirty/autosave lifecycle, and the
// watcher-event behaviors (external reload of a clean buffer vs. the
// dirty-buffer-wins rule). All IPC is mocked; no Tauri runtime.
import { beforeEach, afterEach, describe, expect, it, vi, type Mock } from "vitest";

const vaultReadNoteMock = vi.fn();
const vaultWriteNoteMock = vi.fn();
const vaultNoteMetaMock = vi.fn();
const vaultGetStateMock = vi.fn();
const vaultTreeMock = vi.fn();
const vaultStatsMock = vi.fn();
const vaultBindMock = vi.fn();
const vaultSearchMock = vi.fn();
const vaultCreateNoteMock = vi.fn();
const vaultRenameNoteMock = vi.fn();
const vaultDeleteNoteMock = vi.fn();

vi.mock("../lib/ipc", () => ({
  vaultGetState: (...a: unknown[]) => vaultGetStateMock(...a),
  vaultBind: (...a: unknown[]) => vaultBindMock(...a),
  vaultUnbind: vi.fn().mockResolvedValue(undefined),
  vaultRescan: vi.fn().mockResolvedValue(undefined),
  vaultTree: (...a: unknown[]) => vaultTreeMock(...a),
  vaultReadNote: (...a: unknown[]) => vaultReadNoteMock(...a),
  vaultReadBinary: vi.fn().mockResolvedValue(["image/png", ""]),
  vaultCreateNote: (...a: unknown[]) => vaultCreateNoteMock(...a),
  vaultWriteNote: (...a: unknown[]) => vaultWriteNoteMock(...a),
  vaultDeleteNote: (...a: unknown[]) => vaultDeleteNoteMock(...a),
  vaultRenameNote: (...a: unknown[]) => vaultRenameNoteMock(...a),
  vaultCreateFolder: vi.fn().mockResolvedValue(undefined),
  vaultDeleteFolder: vi.fn().mockResolvedValue(undefined),
  vaultSearch: (...a: unknown[]) => vaultSearchMock(...a),
  vaultNoteMeta: (...a: unknown[]) => vaultNoteMetaMock(...a),
  vaultGraph: vi.fn().mockResolvedValue([[], []]),
  vaultAllTags: vi.fn().mockResolvedValue([]),
  vaultStats: (...a: unknown[]) => vaultStatsMock(...a),
  listenVaultChanged: vi.fn().mockResolvedValue(() => {}),
  listenVaultScanned: vi.fn().mockResolvedValue(() => {}),
}));

import { useVaultStore, VAULT_SAVE_DEBOUNCE_MS } from "../state/vault";

const NOTE = { path: "Notes/Idea.md" };

beforeEach(() => {
  vi.clearAllMocks();
  useVaultStore.setState({
    root: "C:/vault",
    tree: [],
    activePath: null,
    content: "",
    savedContent: "",
    meta: null,
    searchQuery: "",
    searchHits: [],
    saveGeneration: 0,
  });
  vaultTreeMock.mockResolvedValue([]);
  vaultStatsMock.mockResolvedValue({ notes: 1, files: 1, links: 1, unresolved: 0 });
  vaultNoteMetaMock.mockResolvedValue({
    path: NOTE.path,
    title: null,
    basename: "Idea",
    backlinks: [],
    unresolved_mentions: [],
    outgoing: [],
    tags: [],
    headings: [],
    aliases: [],
    word_count: 3,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("vault store — open/save lifecycle", () => {
  it("openNote loads content and marks it saved", async () => {
    vaultReadNoteMock.mockResolvedValue("# Hello\nworld");
    await useVaultStore.getState().openNote(NOTE.path);
    const s = useVaultStore.getState();
    expect(s.activePath).toBe(NOTE.path);
    expect(s.content).toBe("# Hello\nworld");
    expect(s.savedContent).toBe(s.content);
    expect(vaultReadNoteMock).toHaveBeenCalledWith(NOTE.path);
    expect(vaultNoteMetaMock).toHaveBeenCalledWith(NOTE.path);
  });

  it("setContent makes it dirty; scheduleSave writes after the debounce", async () => {
    vi.useFakeTimers();
    vaultReadNoteMock.mockResolvedValue("v1");
    await useVaultStore.getState().openNote(NOTE.path);
    expect(useVaultStore.getState().content === useVaultStore.getState().savedContent).toBe(true);

    useVaultStore.getState().setContent("v2");
    expect(useVaultStore.getState().content).not.toBe(useVaultStore.getState().savedContent);

    useVaultStore.getState().scheduleSave();
    expect(vaultWriteNoteMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(VAULT_SAVE_DEBOUNCE_MS + 30);
    expect(vaultWriteNoteMock).toHaveBeenCalledWith(NOTE.path, "v2");
    expect(useVaultStore.getState().savedContent).toBe("v2");
  });

  it("a no-edit scheduleSave never writes", async () => {
    vi.useFakeTimers();
    vaultReadNoteMock.mockResolvedValue("same");
    await useVaultStore.getState().openNote(NOTE.path);
    useVaultStore.getState().scheduleSave();
    await vi.advanceTimersByTimeAsync(VAULT_SAVE_DEBOUNCE_MS + 30);
    expect(vaultWriteNoteMock).not.toHaveBeenCalled();
  });

  it("saveNow writes immediately", async () => {
    vaultReadNoteMock.mockResolvedValue("a");
    await useVaultStore.getState().openNote(NOTE.path);
    useVaultStore.getState().setContent("b");
    await useVaultStore.getState().saveNow();
    expect(vaultWriteNoteMock).toHaveBeenCalledWith(NOTE.path, "b");
    expect(useVaultStore.getState().savedContent).toBe("b");
  });

  it("switching notes flushes the pending edit first", async () => {
    vi.useFakeTimers();
    vaultReadNoteMock.mockResolvedValueOnce("draft-note");
    await useVaultStore.getState().openNote("A.md");
    useVaultStore.getState().setContent("A edited");
    useVaultStore.getState().scheduleSave();
    vaultReadNoteMock.mockResolvedValueOnce("b content");
    await useVaultStore.getState().openNote("B.md");
    expect(vaultWriteNoteMock).toHaveBeenCalledWith("A.md", "A edited");
    expect(useVaultStore.getState().activePath).toBe("B.md");
  });
});

describe("vault store — watcher events", () => {
  it("reloads a CLEAN buffer that changed on disk", async () => {
    vaultReadNoteMock.mockResolvedValue("disk v1");
    await useVaultStore.getState().openNote(NOTE.path);
    vaultReadNoteMock.mockResolvedValue("disk v2");
    useVaultStore.getState().onVaultChanged([NOTE.path, "Other.md"]);
    await vi.waitFor(() => {
      expect(useVaultStore.getState().content).toBe("disk v2");
      expect(useVaultStore.getState().savedContent).toBe("disk v2");
    });
  });

  it("keeps the DIRTY buffer when the same note changes on disk", async () => {
    vaultReadNoteMock.mockResolvedValue("disk v1");
    await useVaultStore.getState().openNote(NOTE.path);
    useVaultStore.getState().setContent("my local edits");
    vaultReadNoteMock.mockResolvedValue("disk v2");
    useVaultStore.getState().onVaultChanged([NOTE.path]);
    // The reload must NOT clobber the editor buffer.
    await new Promise((r) => setTimeout(r, 10));
    expect(useVaultStore.getState().content).toBe("my local edits");
  });

  it("refreshes the tree on any change", async () => {
    vaultTreeMock.mockResolvedValue([
      { name: "Home.md", path: "Home.md", kind: "note", children: [] },
    ]);
    useVaultStore.getState().onVaultChanged(["Home.md"]);
    await vi.waitFor(() => {
      expect(useVaultStore.getState().tree).toHaveLength(1);
    });
  });
});

describe("vault store — mutations", () => {
  it("createNote appends .md, reloads the tree, opens the note", async () => {
    vaultCreateNoteMock.mockResolvedValue("New.md");
    vaultReadNoteMock.mockResolvedValue("");
    await useVaultStore.getState().createNote("New");
    expect(vaultCreateNoteMock).toHaveBeenCalledWith("New.md", "");
    expect(useVaultStore.getState().activePath).toBe("New.md");
  });

  it("renameNote reopens the renamed note", async () => {
    vaultReadNoteMock.mockResolvedValue("x");
    await useVaultStore.getState().openNote("Old.md");
    vaultRenameNoteMock.mockResolvedValue(["New.md", 2]);
    await useVaultStore.getState().renameNote("Old.md", "New.md");
    expect(vaultRenameNoteMock).toHaveBeenCalledWith("Old.md", "New.md");
    expect(useVaultStore.getState().activePath).toBe("New.md");
  });

  it("deleteNote closes the active note", async () => {
    vaultReadNoteMock.mockResolvedValue("x");
    await useVaultStore.getState().openNote("Doomed.md");
    await useVaultStore.getState().deleteNote("Doomed.md");
    expect(vaultDeleteNoteMock).toHaveBeenCalledWith("Doomed.md");
    expect(useVaultStore.getState().activePath).toBeNull();
  });
});

describe("vault store — search", () => {
  it("empty query clears hits without a round-trip", async () => {
    useVaultStore.getState().setSearchQuery("");
    await useVaultStore.getState().runSearch();
    expect(vaultSearchMock).not.toHaveBeenCalled();
    expect(useVaultStore.getState().searchHits).toEqual([]);
  });

  it("search populates hits", async () => {
    vaultSearchMock.mockResolvedValue([
      { path: "Home.md", title: "Home", basename: "Home", snippet: "hello ⟨world⟩" },
    ]);
    useVaultStore.getState().setSearchQuery("hello");
    await useVaultStore.getState().runSearch();
    expect(vaultSearchMock).toHaveBeenCalledWith("hello", 40);
    expect(useVaultStore.getState().searchHits).toHaveLength(1);
  });
});

describe("vault store — deep-link scroll", () => {
  it("openNote with a heading subpath dispatches vault:scroll-text after load", async () => {
    vi.useFakeTimers();
    const texts: string[] = [];
    const handler = (e: Event) => texts.push((e as CustomEvent<{ text: string }>).detail.text);
    window.addEventListener("vault:scroll-text", handler);
    vaultReadNoteMock.mockResolvedValue("body");
    await useVaultStore.getState().openNote("Guide.md", "#Setup");
    await vi.advanceTimersByTimeAsync(1000);
    window.removeEventListener("vault:scroll-text", handler);
    // Two dispatches (350ms + 900ms) — the preview's handler is idempotent;
    // the second covers slow first renders.
    expect(texts).toEqual(["Setup", "Setup"]);
    vi.useRealTimers();
  });

  it("block-ref subpaths dispatch their id (preview no-ops if unmatched)", async () => {
    vi.useFakeTimers();
    const texts: string[] = [];
    const handler = (e: Event) => texts.push((e as CustomEvent<{ text: string }>).detail.text);
    window.addEventListener("vault:scroll-text", handler);
    vaultReadNoteMock.mockResolvedValue("body");
    await useVaultStore.getState().openNote("Guide.md", "#^abc123");
    await vi.advanceTimersByTimeAsync(1000);
    window.removeEventListener("vault:scroll-text", handler);
    expect(texts).toEqual(["abc123", "abc123"]);
    vi.useRealTimers();
  });
});

describe("vault store — bind flow", () => {
  it("bind sets the root and loads the tree", async () => {
    vaultBindMock.mockResolvedValue("C:/myvault");
    await useVaultStore.getState().bind("C:/myvault");
    expect(useVaultStore.getState().root).toBe("C:/myvault");
    expect(vaultTreeMock).toHaveBeenCalled();
  });

  it("init picks up a persisted root", async () => {
    vaultGetStateMock.mockResolvedValue({
      root: "C:/persisted",
      stats: { notes: 2, files: 2, links: 2, unresolved: 0 },
    });
    await useVaultStore.getState().init();
    expect(useVaultStore.getState().root).toBe("C:/persisted");
    expect(useVaultStore.getState().stats?.notes).toBe(2);
  });

  it("init with no vault stays unbound", async () => {
    vaultGetStateMock.mockResolvedValue({ root: null, stats: null });
    await useVaultStore.getState().init();
    expect(useVaultStore.getState().root).toBeNull();
  });
});
