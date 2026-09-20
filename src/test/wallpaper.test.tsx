// Wallpaper tests: the store resolves preset vs. custom-upload images, the
// panel previews the wallpaper, picks presets, runs the upload flow (backend
// owns the native file dialog) → read → store update, tunes the dim slider,
// and the useWallpaper hook mirrors the store onto <html> (data-wallpaper +
// --app-wallpaper). IPC is stubbed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const importWallpaperMock = vi.fn();
const readWallpaperMock = vi.fn();
const clearWallpaperMock = vi.fn();
const setWallpaperPresetMock = vi.fn();
const getSettingMock = vi.fn();
const setSettingMock = vi.fn();
const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock("../lib/ipc", () => ({
  importAppWallpaper: (...a: unknown[]) => importWallpaperMock(...a),
  readAppWallpaperData: () => readWallpaperMock(),
  clearAppWallpaper: () => clearWallpaperMock(),
  setAppWallpaperPreset: (...a: unknown[]) => setWallpaperPresetMock(...a),
  getSetting: (...a: unknown[]) => getSettingMock(...a),
  setSetting: (...a: unknown[]) => setSettingMock(...a),
  readSidebarArtData: vi.fn().mockResolvedValue(null),
  sidebarArtPresetUrl: (id: string) => `/sideart/${id}.jpg`,
  WALLPAPER_PRESETS: [
    { id: "aurora", label: "Aurora" },
    { id: "ember", label: "Ember" },
  ],
  toastError: (...a: unknown[]) => toastErrorMock(...a),
  toastSuccess: (...a: unknown[]) => toastSuccessMock(...a),
}));

import { WallpaperPanel } from "../components/settings/WallpaperPanel";
import { useWallpaper } from "../hooks/useWallpaper";
import { useAppearanceStore } from "../state/appearance";

const DATA_URL = "data:image/png;base64,AAAA";

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  readWallpaperMock.mockResolvedValue(null);
  getSettingMock.mockResolvedValue(null);
  setSettingMock.mockResolvedValue(undefined);
  importWallpaperMock.mockResolvedValue("C:\\data\\app-wallpaper.png");
  clearWallpaperMock.mockResolvedValue(undefined);
  setWallpaperPresetMock.mockResolvedValue(undefined);
  useAppearanceStore.setState({
    artData: null,
    artPreset: null,
    wallpaperData: null,
    wallpaperPreset: null,
    wallpaperDim: 50,
    loaded: false,
  });
  delete document.documentElement.dataset.wallpaper;
  document.documentElement.style.removeProperty("--app-wallpaper");
  document.documentElement.style.removeProperty("--wallpaper-scrim-a");
});

describe("appearance store wallpaper state", () => {
  it("resolves a stored preset to its bundle URL on refresh", async () => {
    getSettingMock.mockImplementation((key: string) =>
      Promise.resolve(key === "app.wallpaperPreset" ? "ember" : null),
    );
    await useAppearanceStore.getState().refresh();
    expect(useAppearanceStore.getState().wallpaperData).toBe("/sideart/ember.jpg");
    expect(useAppearanceStore.getState().wallpaperPreset).toBe("ember");
  });

  it("prefers the custom upload's data URL when no preset is stored", async () => {
    getSettingMock.mockResolvedValue(null);
    readWallpaperMock.mockResolvedValue(DATA_URL);
    await useAppearanceStore.getState().refresh();
    expect(useAppearanceStore.getState().wallpaperData).toBe(DATA_URL);
    expect(useAppearanceStore.getState().wallpaperPreset).toBeNull();
  });

  it("reads the stored dim level and clamps the setter's range", async () => {
    getSettingMock.mockImplementation((key: string) =>
      Promise.resolve(key === "app.wallpaperDim" ? "72" : null),
    );
    await useAppearanceStore.getState().refresh();
    expect(useAppearanceStore.getState().wallpaperDim).toBe(72);

    useAppearanceStore.getState().setWallpaperDim(500);
    expect(useAppearanceStore.getState().wallpaperDim).toBe(100);
    expect(setSettingMock).toHaveBeenCalledWith("app.wallpaperDim", "100");
  });
});

describe("WallpaperPanel", () => {
  it("shows the preview, the gallery, and upload when unset", () => {
    render(<WallpaperPanel />);
    expect(document.querySelector(".wallpaper-preview")).toBeTruthy();
    expect(document.querySelectorAll(".wallpaper-thumb").length).toBe(2);
    expect(screen.getByText("Upload your own")).toBeTruthy();
    expect(screen.queryByText("Remove")).toBeNull();
    // No dim slider until a wallpaper is set.
    expect(document.querySelector(".wallpaper-dim-row")).toBeNull();
  });

  it("marks the selected preset and picks a new one through the backend", async () => {
    useAppearanceStore.setState({ wallpaperData: "/sideart/aurora.jpg", wallpaperPreset: "aurora", loaded: true });
    render(<WallpaperPanel />);
    expect(document.querySelector(".wallpaper-thumb.active")!.textContent).toContain("Aurora");
    fireEvent.click(screen.getByTitle("Use Ember"));
    await waitFor(() => expect(setWallpaperPresetMock).toHaveBeenCalledWith("ember"));
    await waitFor(() =>
      expect(useAppearanceStore.getState().wallpaperData).toBe("/sideart/ember.jpg"),
    );
    expect(useAppearanceStore.getState().wallpaperPreset).toBe("ember");
  });

  it("uploads: backend import → read → store update (no renderer-supplied path)", async () => {
    readWallpaperMock.mockResolvedValue(DATA_URL);
    render(<WallpaperPanel />);
    fireEvent.click(screen.getByText("Upload your own"));
    await waitFor(() => expect(importWallpaperMock).toHaveBeenCalledWith());
    await waitFor(() => expect(useAppearanceStore.getState().wallpaperData).toBe(DATA_URL));
    expect(useAppearanceStore.getState().wallpaperPreset).toBeNull();
    expect(toastSuccessMock).toHaveBeenCalledWith("Wallpaper updated");
    expect(screen.getByText("Remove")).toBeTruthy();
  });

  it("cancelling the backend dialog surfaces the error and imports nothing", async () => {
    importWallpaperMock.mockRejectedValue("no image picked");
    render(<WallpaperPanel />);
    fireEvent.click(screen.getByText("Upload your own"));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(useAppearanceStore.getState().wallpaperData).toBeNull();
  });

  it("remove clears the store and the backend entry", async () => {
    useAppearanceStore.setState({ wallpaperData: DATA_URL, wallpaperPreset: null, loaded: true });
    render(<WallpaperPanel />);
    fireEvent.click(screen.getByText("Remove"));
    await waitFor(() => expect(clearWallpaperMock).toHaveBeenCalled());
    await waitFor(() => expect(useAppearanceStore.getState().wallpaperData).toBeNull());
    expect(toastSuccessMock).toHaveBeenCalledWith("Wallpaper removed");
  });

  it("the dim slider updates the store", () => {
    useAppearanceStore.setState({ wallpaperData: DATA_URL, wallpaperPreset: null, loaded: true });
    render(<WallpaperPanel />);
    const slider = document.querySelector<HTMLInputElement>(".wallpaper-dim-row input[type='range']")!;
    expect(slider).toBeTruthy();
    fireEvent.change(slider, { target: { value: "30" } });
    expect(useAppearanceStore.getState().wallpaperDim).toBe(30);
  });
});

describe("useWallpaper hook", () => {
  it("sets data-wallpaper + --app-wallpaper when a wallpaper is active", () => {
    useAppearanceStore.setState({ wallpaperData: DATA_URL, wallpaperDim: 65, loaded: true });
    render(<div />, { wrapper: HookHost });
    const root = document.documentElement;
    expect(root.dataset.wallpaper).toBe("on");
    expect(root.style.getPropertyValue("--app-wallpaper")).toBe(`url("${DATA_URL}")`);
    expect(root.style.getPropertyValue("--wallpaper-scrim-a")).toBe("0.65");
  });

  it("clears the attribute + variable when the wallpaper is removed", () => {
    document.documentElement.dataset.wallpaper = "on";
    document.documentElement.style.setProperty("--app-wallpaper", `url("${DATA_URL}")`);
    useAppearanceStore.setState({ wallpaperData: null, loaded: true });
    render(<div />, { wrapper: HookHost });
    const root = document.documentElement;
    expect(root.dataset.wallpaper).toBeUndefined();
    expect(root.style.getPropertyValue("--app-wallpaper")).toBe("");
  });
});

/** Renders children inside a component that runs the hook. */
function HookHost({ children }: { children?: ReactNode }) {
  useWallpaper();
  return <>{children}</>;
}
