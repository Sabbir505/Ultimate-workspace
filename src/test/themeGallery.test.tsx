// Custom theme gallery (roadmap #19) — parse/validate helpers in lib/themes.ts
// plus the ThemeGalleryPanel (import → persist, apply via useTheme, delete,
// export). Mocks ipc getSetting/setSetting/readFileText + the tauri dialog/fs
// plugins, following the promptTemplates test pattern (importOriginal spread).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useTheme } from "../hooks/useTheme";
import { useSettingsStore } from "../state/settings";
import { ThemeGalleryPanel } from "../components/settings/ThemeGalleryPanel";
import { parseThemeJson, themeJson, KNOWN_THEME_TOKENS } from "../lib/themes";

const getSettingMock = vi.fn();
const setSettingMock = vi.fn();
const nordThemeJson = JSON.stringify({ name: "Nord", base: "dark", colors: { "bg-tint": "#2e3440", accent: "#88c0d0", bogus: "#000" } });

async function importThemeViaInput(themeContent: string, fileName = "nord.json") {
  const input = document.getElementById("theme-import") as HTMLInputElement | null;
  if (!input) throw new Error("theme-import input missing");
  const file = new File([themeContent], fileName, { type: "application/json" });
  // In jsdom the FileList is read-only; define the property for this element only.
  Object.defineProperty(input, "files", { value: [file], writable: false });
  fireEvent.change(input);
}


vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...actual,
    getSetting: (...a: unknown[]) => getSettingMock(...a),
    setSetting: (...a: unknown[]) => setSettingMock(...a),
  };
});

const openMock = vi.fn();
const saveMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...a: unknown[]) => openMock(...a),
  save: (...a: unknown[]) => saveMock(...a),
}));

const writeTextFileMock = vi.fn();
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: (...a: unknown[]) => writeTextFileMock(...a),
}));

// jsdom lacks matchMedia; useTheme reads it during apply().
beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
  }
});

// useTheme() must run for style application; ThemeGalleryPanel provides the UI.
function Harness() {
  useTheme();
  return <ThemeGalleryPanel />;
}

describe("theme helpers (lib/themes.ts)", () => {
  it("parses a valid override theme and drops unknown tokens", () => {
    const res = parseThemeJson(
      JSON.stringify({ name: "Nord", base: "dark", colors: { "bg-tint": "#2e3440", accent: "#88c0d0", "evil-prop": "#000" } }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.theme.name).toBe("Nord");
    expect(res.theme.base).toBe("dark");
    expect(res.theme.colors).toEqual({ "bg-tint": "#2e3440", accent: "#88c0d0" });
    expect(res.theme.id).toMatch(/^theme-nord-/);
  });

  it("rejects missing name / empty colors / bad base", () => {
    expect(parseThemeJson(JSON.stringify({ colors: { accent: "#fff" } })).ok).toBe(false);
    expect(parseThemeJson(JSON.stringify({ name: "X", colors: {} })).ok).toBe(false);
    const badBase = parseThemeJson(JSON.stringify({ name: "X", base: "neon", colors: { accent: "#fff" } }));
    expect(badBase.ok).toBe(false);
  });

  it("rejects malformed JSON and non-objects", () => {
    expect(parseThemeJson("{ not json").ok).toBe(false);
    expect(parseThemeJson("[1,2]").ok).toBe(false);
  });

  it("round-trips through themeJson", () => {
    const res = parseThemeJson(JSON.stringify({ name: "Mono", colors: { text: "#eee" } }));
    if (!res.ok) throw new Error("expected parse");
    expect(JSON.parse(themeJson(res.theme))).toEqual({ name: "Mono", colors: { text: "#eee" } });
  });

  it("knows the real token surface from tokens.css", () => {
    expect(KNOWN_THEME_TOKENS.has("bg-tint")).toBe(true);
    expect(KNOWN_THEME_TOKENS.has("syntax-keyword")).toBe(true);
    expect(KNOWN_THEME_TOKENS.has("font-ui")).toBe(false); // structural, not a color
  });
});

describe("ThemeGalleryPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettingMock.mockResolvedValue(null);
    setSettingMock.mockResolvedValue(undefined);
    openMock.mockResolvedValue(null);
    saveMock.mockResolvedValue(null);
    writeTextFileMock.mockResolvedValue(undefined);
    useSettingsStore.setState({ loaded: true, theme: "dark", customThemes: [], customThemeId: null });
  });
  afterEach(cleanup);

  it("imports a valid theme, persists it, and drops unknown tokens", async () => {
    render(<Harness />);
    await importThemeViaInput(nordThemeJson);

    // Wait on the persisted write, not on card text: a built-in preset is
    // also named "Nord", so a text query can resolve before the import lands.
    let saved: string | undefined;
    await waitFor(() => {
      saved = setSettingMock.mock.calls.find((c) => c[0] === "themes.custom")?.[1] as string;
      expect(saved).toBeTruthy();
    });
    const themes = JSON.parse(saved!);
    expect(themes).toHaveLength(1);
    expect(themes[0].name).toBe("Nord");
    expect(themes[0].colors).toEqual({ "bg-tint": "#2e3440", accent: "#88c0d0" });
  });

  it("rejects invalid JSON with an error and persists nothing", async () => {
    render(<Harness />);
    await importThemeViaInput("{ not json");

    expect(await screen.findByText(/not valid JSON/)).toBeTruthy();
    expect(setSettingMock).not.toHaveBeenCalledWith("themes.custom", expect.anything());
  });

  it("applies a selected theme to <html> (data-theme + custom properties)", async () => {
    const content = JSON.stringify({ name: "Nord", base: "dark", colors: { accent: "#88c0d0", text: "#eceff4" } });
    render(<Harness />);
    await importThemeViaInput(content);

    expect(await screen.findByText(/Nord/)).toBeTruthy();
    // importCustomTheme adds the theme but doesn't select it — need to set active.
    // A built-in preset is also named "Nord", so the text query above can
    // resolve before the async import lands in the store — wait on the
    // store itself before reading the theme back.
    await waitFor(() => {
      expect(useSettingsStore.getState().customThemes.some((t) => t.name === "Nord")).toBe(true);
    });
    useSettingsStore.getState().setCustomTheme(
      useSettingsStore.getState().customThemes.find((t) => t.name === "Nord")!.id,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#88c0d0");
      expect(document.documentElement.style.getPropertyValue("--text")).toBe("#eceff4");
    });
    // The active selection persisted.
    const savedId = setSettingMock.mock.calls.find((c) => c[0] === "themes.customThemeId")?.[1];
    expect(savedId).toBeTruthy();
  });

  it("clears the overlay when the active card is deselected", async () => {
    useSettingsStore.setState({
      customThemes: [{ id: "t1", name: "Nord", base: "dark", colors: { accent: "#88c0d0" } }],
      customThemeId: "t1",
    });
    render(<Harness />);

    // Mounted with the theme active → overlay applied on first effect run.
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#88c0d0"),
    );
    // A built-in preset is also named "Nord", so text queries are ambiguous —
    // only the active custom card carries the "deselect" title.
    fireEvent.click(screen.getByTitle("Click to deselect"));

    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--accent")).toBe(""),
    );
    expect(setSettingMock).toHaveBeenCalledWith("themes.customThemeId", "");
  });

  it("deletes a theme and clears the active id", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    useSettingsStore.setState({
      customThemes: [{ id: "t1", name: "Nord", colors: { accent: "#88c0d0" } }],
      customThemeId: "t1",
    });
    render(<Harness />);

    fireEvent.click(await screen.findByTitle("Delete theme"));
    await waitFor(() => {
      const saved = setSettingMock.mock.calls.find((c) => c[0] === "themes.custom")?.[1];
      expect(JSON.parse(saved)).toHaveLength(0);
    });
    // The custom card (and its Delete control) is gone; the built-in Nord
    // preset card legitimately remains, so absence must be asserted via the
    // delete control, not the name text.
    expect(screen.queryByTitle("Delete theme")).toBeNull();
    expect(screen.getAllByText(/Nord/)).toHaveLength(1);
    expect(useSettingsStore.getState().customThemeId).toBeNull();
    confirmSpy.mockRestore();
  });

  it("exports a theme through the save dialog", async () => {
    useSettingsStore.setState({
      customThemes: [{ id: "t1", name: "Nord", base: "dark", colors: { accent: "#88c0d0", "bg-tint": "#2e3440" } }],
      customThemeId: null,
    });
    saveMock.mockResolvedValue("C:\\out\\nord.json");
    render(<Harness />);

    fireEvent.click(await screen.findByTitle("Export theme"));
    await waitFor(() => expect(writeTextFileMock).toHaveBeenCalled());
    expect(writeTextFileMock.mock.calls[0][0]).toBe("C:\\out\\nord.json");
    const written = JSON.parse(writeTextFileMock.mock.calls[0][1]);
    expect(written.name).toBe("Nord");
    expect(written.base).toBe("dark");
    expect(written.colors["bg-tint"]).toBe("#2e3440");
  });
});

describe("settings store theme integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSettingMock.mockResolvedValue(undefined);
    useSettingsStore.setState({ theme: "system", customThemes: [], customThemeId: null });
  });

  it("switching the base mode deselects the custom overlay", () => {
    useSettingsStore.setState({ customThemeId: "t1" });
    useSettingsStore.getState().setTheme("light");
    expect(useSettingsStore.getState().theme).toBe("light");
    expect(useSettingsStore.getState().customThemeId).toBeNull();
    expect(setSettingMock).toHaveBeenCalledWith("theme", "light");
    expect(setSettingMock).toHaveBeenCalledWith("themes.customThemeId", "");
  });
});
