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
  vaultMoveFile: vi.fn().mockResolvedValue("moved"),
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

import { useVaultStore, VAULT_SAVE_DEBOUNCE_MS, VAULT_SEARCH_DEBOUNCE_MS } from "../state/vault";
import { useUiStore } from "../state/ui";

const NOTE = { path: "Notes/Idea.md" };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useVaultStore.setState({
    root: "C:/vault",
    tree: [],
    activePath: null,
    assetPath: null,
    content: "",
    savedContent: "",
    meta: null,
    searchQuery: "",
    searchHits: [],
    saveGeneration: 0,
    // Tab/pin/recent state persists (via the layout blob) — reset it too so
    // earlier tests' opens can't bleed into later assertions.
    openNotes: [],
    pinnedPaths: [],
    recentPaths: [],
    templatePickerOpen: false,
  });
  useUiStore.setState({ toasts: [] });
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

describe("vault store — asset (non-note) opens", () => {
  it("openFile shows the asset WITHOUT touching the note reader", () => {
    useVaultStore.getState().openFile("Attachments/Inference Engineering.pdf");
    expect(useVaultStore.getState().assetPath).toBe("Attachments/Inference Engineering.pdf");
    expect(vaultReadNoteMock).not.toHaveBeenCalled();
  });

  it("openNote keeps the asset open — the two sit side by side", async () => {
    vaultReadNoteMock.mockResolvedValue("body");
    useVaultStore.getState().openFile("a.pdf");
    await useVaultStore.getState().openNote("B.md");
    expect(useVaultStore.getState().assetPath).toBe("a.pdf");
    expect(useVaultStore.getState().activePath).toBe("B.md");
    expect(useVaultStore.getState().content).toBe("body");
  });

  it("openFile does NOT disturb the open note's editor buffer", async () => {
    vaultReadNoteMock.mockResolvedValue("note body");
    await useVaultStore.getState().openNote("A.md");
    useVaultStore.getState().openFile("a.pdf");
    expect(useVaultStore.getState().activePath).toBe("A.md");
    expect(useVaultStore.getState().content).toBe("note body");
  });

  it("closeAsset clears only the asset; closeNote clears only the note", async () => {
    vaultReadNoteMock.mockResolvedValue("note body");
    await useVaultStore.getState().openNote("A.md");
    useVaultStore.getState().openFile("a.pdf");
    useVaultStore.getState().closeAsset();
    expect(useVaultStore.getState().assetPath).toBeNull();
    expect(useVaultStore.getState().activePath).toBe("A.md");
    // closeNote closes the ACTIVE TAB: the last tab clears the surface and
    // leaves no stray tab behind.
    useVaultStore.getState().closeNote();
    expect(useVaultStore.getState().activePath).toBeNull();
    expect(useVaultStore.getState().openNotes).toEqual([]);
  });

  it("renameNote refuses non-note paths instead of renaming to .pdf.md", async () => {
    await useVaultStore.getState().renameNote("Inference Engineering.pdf", "Renamed.pdf");
    expect(vaultRenameNoteMock).not.toHaveBeenCalled();
    expect(
      useUiStore.getState().toasts.some((t) => t.message.includes("Only notes")),
    ).toBe(true);
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

  it("does NOT toast when the event is our own autosave echoing back", async () => {
    // The watcher fires for the app's own writes: disk still equals the
    // last SAVED text, so the dirty buffer is purely newer local typing.
    vaultReadNoteMock.mockResolvedValue("saved text");
    await useVaultStore.getState().openNote(NOTE.path);
    useVaultStore.getState().setContent("saved text and more typing");
    useVaultStore.getState().onVaultChanged([NOTE.path]);
    await new Promise((r) => setTimeout(r, 10));
    expect(useUiStore.getState().toasts.filter((t) => t.message.includes("changed on disk"))).toHaveLength(0);
  });

  it("DOES toast when a dirty buffer's note genuinely changed on disk", async () => {
    vaultReadNoteMock.mockResolvedValue("saved text");
    await useVaultStore.getState().openNote(NOTE.path);
    useVaultStore.getState().setContent("my local edits");
    vaultReadNoteMock.mockResolvedValue("externally rewritten");
    useVaultStore.getState().onVaultChanged([NOTE.path]);
    await new Promise((r) => setTimeout(r, 10));
    expect(useUiStore.getState().toasts.filter((t) => t.message.includes("changed on disk"))).toHaveLength(1);
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

describe("vault store — wikilink resolution", () => {
  it("resolves an extensionless target through the index before reading", async () => {
    vaultSearchMock.mockResolvedValue([
      { path: "Daily 2026.md", title: null, basename: "Daily 2026.md", snippet: "" },
      { path: "Daily.md", title: null, basename: "Daily.md", snippet: "" },
    ]);
    vaultReadNoteMock.mockResolvedValue("daily body");
    await useVaultStore.getState().openNote("Daily");
    // Exact stem beats the alphabetically-first substring hit.
    expect(vaultReadNoteMock).toHaveBeenCalledWith("Daily.md");
    expect(useVaultStore.getState().activePath).toBe("Daily.md");
    expect(useVaultStore.getState().content).toBe("daily body");
  });

  it("creates + opens the note when a link target matches nothing (click-to-create)", async () => {
    // The search finds nothing for "Missing" — openNote CREATES Missing.md
    // (Obsidian's unresolved-link behavior) and opens it. The extensioned
    // re-open bypasses resolution (resolveNotePath short-circuits .md), so
    // the flow terminates even with the search still returning nothing.
    vaultSearchMock.mockResolvedValue([]);
    vaultCreateNoteMock.mockResolvedValue("Missing.md");
    vaultTreeMock.mockResolvedValue([]);
    vaultReadNoteMock.mockResolvedValue("");
    await useVaultStore.getState().openNote("Missing");
    expect(vaultCreateNoteMock).toHaveBeenCalledWith("Missing.md", "");
    expect(useVaultStore.getState().activePath).toBe("Missing.md");
    expect(useVaultStore.getState().mode).toBe("edit");
  });

  it("a slow read for note A cannot clobber a fast open of note B", async () => {
    let releaseA: (v: string) => void = () => {};
    vaultReadNoteMock.mockImplementation((p: unknown) =>
      p === "A.md"
        ? new Promise<string>((res) => {
            releaseA = res;
          })
        : Promise.resolve("B body"),
    );
    const pA = useVaultStore.getState().openNote("A.md");
    const pB = useVaultStore.getState().openNote("B.md");
    await pB;
    releaseA("stale A body");
    await pA;
    const s = useVaultStore.getState();
    expect(s.activePath).toBe("B.md");
    expect(s.content).toBe("B body");
    expect(s.savedContent).toBe("B body");
  });
});

describe("vault store — drag & drop moves", () => {
  it("moves a NOTE via renameNote (links are rewritten), keeping .md", async () => {
    vaultRenameNoteMock.mockResolvedValue(["Journal/2026-09-19.md", 2]);
    await useVaultStore.getState().moveEntry("2026-09-19.md", "Journal");
    expect(vaultRenameNoteMock).toHaveBeenCalledWith("2026-09-19.md", "Journal/2026-09-19.md");
  });

  it("moves an ASSET via vault_move_file, never the .md rename path", async () => {
    const { vaultMoveFile } = await import("../lib/ipc");
    const moveMock = vaultMoveFile as Mock;
    moveMock.mockResolvedValue("Journal/report.pdf");
    await useVaultStore.getState().moveEntry("report.pdf", "Journal");
    expect(moveMock).toHaveBeenCalledWith("report.pdf", "Journal/report.pdf");
    expect(vaultRenameNoteMock).not.toHaveBeenCalled();
  });

  it("no-ops when dropped on the folder it already lives in", async () => {
    await useVaultStore.getState().moveEntry("Journal/note.md", "Journal");
    expect(vaultRenameNoteMock).not.toHaveBeenCalled();
  });
});

describe("vault store — note modes and tab order", () => {
  it("opens a never-toggled note in preview mode", async () => {
    vaultReadNoteMock.mockResolvedValue("body");
    await useVaultStore.getState().openNote("Fresh.md");
    expect(useVaultStore.getState().mode).toBe("preview");
  });

  it("re-opens a note in the mode the user last chose for it", async () => {
    vaultReadNoteMock.mockResolvedValue("body");
    await useVaultStore.getState().openNote("A.md");
    useVaultStore.getState().setMode("edit");
    await useVaultStore.getState().openNote("B.md");
    expect(useVaultStore.getState().mode).toBe("preview");
    await useVaultStore.getState().openNote("A.md");
    expect(useVaultStore.getState().mode).toBe("edit");
  });

  it("createNote still lands in the editor (recorded per-note)", async () => {
    vaultSearchMock.mockResolvedValue([]);
    vaultCreateNoteMock.mockResolvedValue("New.md");
    vaultReadNoteMock.mockResolvedValue("");
    await useVaultStore.getState().createNote("New.md");
    expect(useVaultStore.getState().mode).toBe("edit");
  });

  it("reorderNoteTab moves a tab and clamps the index", () => {
    useVaultStore.setState({ openNotes: ["A.md", "B.md", "C.md"] });
    useVaultStore.getState().reorderNoteTab("C.md", 0);
    expect(useVaultStore.getState().openNotes).toEqual(["C.md", "A.md", "B.md"]);
    // Out-of-range target clamps instead of throwing / dropping the tab.
    useVaultStore.getState().reorderNoteTab("A.md", 99);
    expect(useVaultStore.getState().openNotes).toEqual(["C.md", "B.md", "A.md"]);
  });
});

describe("vault store — back/forward navigation", () => {
  it("openNote records a vault snapshot in the shell nav timeline", async () => {
    vaultReadNoteMock.mockResolvedValue("body");
    const before = useUiStore.getState().viewHistory.length;
    await useVaultStore.getState().openNote("A.md");
    const history = useUiStore.getState().viewHistory;
    expect(history.length).toBe(before + 1);
    const top = history[history.length - 1];
    expect(top.view).toBe("vault");
    expect(top.vault?.activePath).toBe("A.md");
  });

  it("restoreSnapshot swaps back to the old note WITHOUT a new nav step", async () => {
    // Reads in order: open A, open B, then restore → A again.
    vaultReadNoteMock.mockReset();
    vaultReadNoteMock
      .mockResolvedValueOnce("A body")
      .mockResolvedValueOnce("B body")
      .mockResolvedValue("A body");
    await useVaultStore.getState().openNote("A.md");
    await useVaultStore.getState().openNote("B.md");
    const before = useUiStore.getState().viewHistory.length;
    await useVaultStore.getState().restoreSnapshot({
      graphOpen: false,
      assetPath: null,
      activePath: "A.md",
    });
    expect(useVaultStore.getState().activePath).toBe("A.md");
    expect(useVaultStore.getState().content).toBe("A body");
    expect(useUiStore.getState().viewHistory.length).toBe(before);
    vaultReadNoteMock.mockResolvedValue("body");
  });

  it("a slow restoreSnapshot cannot clobber a newer open's buffer", async () => {
    let releaseRestore: (v: string) => void = () => {};
    vaultReadNoteMock.mockImplementation((p: unknown) =>
      p === "Slow.md"
        ? new Promise<string>((res) => {
            releaseRestore = res;
          })
        : Promise.resolve("B body"),
    );
    await useVaultStore.getState().openNote("B.md");
    const pRestore = useVaultStore.getState().restoreSnapshot({
      graphOpen: false,
      assetPath: null,
      activePath: "Slow.md",
    });
    // A newer navigation supersedes the restore mid-load…
    await useVaultStore.getState().openNote("B2.md");
    // …then the stale restore's read lands — it must be discarded, or the
    // next autosave would write the old text into the new file.
    releaseRestore("stale restore body");
    await pRestore;
    const s = useVaultStore.getState();
    expect(s.activePath).toBe("B2.md");
    expect(s.content).toBe("B body");
    expect(s.savedContent).toBe("B body");
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

  it("renameNote flushes a pending edit to the OLD path BEFORE the rename", async () => {
    // Firing the pending autosave after the move would recreate the old
    // file with the fresh edits — two divergent copies, silently.
    vi.useFakeTimers();
    vaultReadNoteMock.mockResolvedValue("old body");
    await useVaultStore.getState().openNote("Old.md");
    useVaultStore.getState().setContent("fresh edits");
    useVaultStore.getState().scheduleSave();
    vaultRenameNoteMock.mockResolvedValue(["New.md", 0]);
    vaultReadNoteMock.mockResolvedValue("fresh edits");
    await useVaultStore.getState().renameNote("Old.md", "New.md");
    expect(vaultWriteNoteMock).toHaveBeenCalledWith("Old.md", "fresh edits");
    const writeOrder = (vaultWriteNoteMock as Mock).mock.invocationCallOrder[0];
    const renameOrder = (vaultRenameNoteMock as Mock).mock.invocationCallOrder[0];
    expect(writeOrder).toBeLessThan(renameOrder);
    expect(useVaultStore.getState().activePath).toBe("New.md");
  });

  it("renameNote surfaces failures instead of failing silently", async () => {
    vaultReadNoteMock.mockResolvedValue("x");
    await useVaultStore.getState().openNote("Old.md");
    vaultRenameNoteMock.mockRejectedValue("disk error");
    await useVaultStore.getState().renameNote("Old.md", "New.md");
    expect(useUiStore.getState().toasts.some((t) => t.kind === "error")).toBe(true);
    expect(useVaultStore.getState().activePath).toBe("Old.md");
  });

  it("deleteNote closes the deleted note's tab (neighbor activates)", async () => {
    vaultReadNoteMock.mockResolvedValue("x");
    await useVaultStore.getState().openNote("Old.md");
    await useVaultStore.getState().openNote("Doomed.md");
    await useVaultStore.getState().deleteNote("Doomed.md");
    expect(vaultDeleteNoteMock).toHaveBeenCalledWith("Doomed.md");
    // Tab-aware close: the previous tab activates, the deleted path leaves
    // the strip entirely.
    expect(useVaultStore.getState().activePath).toBe("Old.md");
    expect(useVaultStore.getState().openNotes).toEqual(["Old.md"]);
  });

  it("deleteNote with a pending autosave never writes the doomed path", async () => {
    // Flushing the pending autosave to the deleted path would resurrect
    // the file — a delete must never trigger a write.
    vi.useFakeTimers();
    vaultReadNoteMock.mockResolvedValue("doomed body");
    await useVaultStore.getState().openNote("Doomed.md");
    useVaultStore.getState().setContent("unsaved edits");
    useVaultStore.getState().scheduleSave();
    await useVaultStore.getState().deleteNote("Doomed.md");
    await vi.advanceTimersByTimeAsync(VAULT_SAVE_DEBOUNCE_MS + 100);
    expect(vaultWriteNoteMock).not.toHaveBeenCalled();
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

  it("setSearchQuery debounces the round-trip instead of firing per keystroke", async () => {
    vi.useFakeTimers();
    vaultSearchMock.mockResolvedValue([]);
    useVaultStore.getState().setSearchQuery("hello");
    expect(vaultSearchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(VAULT_SEARCH_DEBOUNCE_MS + 50);
    expect(vaultSearchMock).toHaveBeenCalledWith("hello", 40);
  });

  it("a stale search response cannot land after a newer query's results", async () => {
    let releaseOld: (v: unknown) => void = () => {};
    vaultSearchMock.mockImplementation((q: unknown) =>
      q === "old"
        ? new Promise((res) => {
            releaseOld = res;
          })
        : Promise.resolve([{ path: "New.md", title: null, basename: "New", snippet: "" }]),
    );
    useVaultStore.getState().setSearchQuery("old");
    const staleRun = useVaultStore.getState().runSearch();
    useVaultStore.getState().setSearchQuery("new");
    await useVaultStore.getState().runSearch();
    expect(useVaultStore.getState().searchHits.map((h) => h.path)).toEqual(["New.md"]);
    // The old query's late response is discarded — the newer results stay.
    releaseOld([{ path: "Old.md", title: null, basename: "Old", snippet: "" }]);
    await staleRun;
    expect(useVaultStore.getState().searchHits.map((h) => h.path)).toEqual(["New.md"]);
    expect(useVaultStore.getState().searchLoading).toBe(false);
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

  it("bind clears the previous vault's tabs, pins, recents and modes", async () => {
    vaultReadNoteMock.mockResolvedValue("body");
    await useVaultStore.getState().openNote("Old.md");
    useVaultStore.getState().setMode("edit");
    useVaultStore.setState({ pinnedPaths: ["Old.md"], recentPaths: ["Old.md"] });
    vaultBindMock.mockResolvedValue("C:/other");
    await useVaultStore.getState().bind("C:/other");
    const s = useVaultStore.getState();
    expect(s.root).toBe("C:/other");
    expect(s.activePath).toBeNull();
    // The previous vault's rails must not resolve against the new vault.
    expect(s.openNotes).toEqual([]);
    expect(s.pinnedPaths).toEqual([]);
    expect(s.recentPaths).toEqual([]);
    expect(s.noteModes).toEqual({});
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

describe("vault store — persisted layout restore", () => {
  it("restores path lists, dropping invalid entries and capping recents", async () => {
    // Earlier tests schedule the store's debounced layout persist (250ms
    // real timer on the module instance this file imported). Under suite
    // load that timer can fire between our setItem below and the fresh
    // module's evaluation, overwriting the blob with the OLD instance's
    // (empty) state — a nondeterministic [] instead of the seeded lists.
    // Wait it out first: nothing can still be pending past 250ms + a tick.
    await new Promise((r) => setTimeout(r, 300));
    const recents = Array.from({ length: 20 }, (_, i) => `R${i}.md`);
    localStorage.setItem(
      "relay.vault.layout",
      JSON.stringify({
        leftWidth: 300,
        rightWidth: 300,
        leftCollapsed: false,
        assetSplitPct: 58,
        openNotes: ["A.md", 42, null, "", "B.md"],
        pinnedPaths: ["P.md", { nope: 1 }, 7],
        recentPaths: recents,
      }),
    );
    // loadLayout runs at store creation — re-import the module to re-read it.
    vi.resetModules();
    const { useVaultStore: fresh } = await import("../state/vault");
    const s = fresh.getState();
    expect(s.openNotes).toEqual(["A.md", "B.md"]);
    expect(s.pinnedPaths).toEqual(["P.md"]);
    // Recents keep the same 12-entry cap openNote applies on refresh.
    expect(s.recentPaths).toEqual(recents.slice(0, 12));
  });
});
