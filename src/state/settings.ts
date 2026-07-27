// Settings store (PRD §7.2 theme, §7.6 keybinding overrides, §7.13 DND,
// §4.6 per-project last browser URL, §4.6 multi-tab browser pane state).
// Everything persists through the get_setting/set_setting contract commands.
import { create } from "zustand";
import { getSetting, setSetting } from "../lib/ipc";
import { DEFAULT_KEYBINDINGS, type KeybindingAction, type KeybindingMap } from "../lib/keybindings";

export type ThemeSetting = "light" | "dark" | "system";

const K_THEME = "theme";
const K_DND = "doNotDisturb";
const K_WATCH_MODE = "watchMode";
const K_KEYBINDINGS = "keybindingOverrides";
const K_BROWSER_URLS = "browserLastUrls"; // JSON: { global: string, perProject: Record<string, string> }
const K_BROWSER_PANE_STATE = "browserPaneState"; // JSON: { paneTabs: Record<string, BrowserPaneTabState> }

interface BrowserUrlState {
  global: string;
  perProject: Record<string, string>;
}

/** Per-pane tab state persisted across app restarts. */
export interface PersistedTabData {
  tabId: string;
  url: string;
  title: string;
  faviconUrl?: string;
}

export interface PersistedBrowserPaneState {
  /** paneId -> persisted tabs + active index */
  paneTabs: Record<string, { tabs: PersistedTabData[]; activeTabIndex: number }>;
}

interface SettingsState {
  loaded: boolean;
  theme: ThemeSetting;
  dnd: boolean;
  watchMode: boolean;
  keybindings: KeybindingMap;
  browserUrls: BrowserUrlState;
  browserPaneState: PersistedBrowserPaneState;

  load: () => Promise<void>;
  setTheme: (theme: ThemeSetting) => void;
  setDnd: (dnd: boolean) => void;
  setWatchMode: (watchMode: boolean) => void;
  setKeybinding: (action: KeybindingAction, accelerator: string) => void;
  resetKeybindings: () => void;
  lastBrowserUrl: (projectId: string | null) => string;
  rememberBrowserUrl: (projectId: string | null, url: string) => void;
  /** Persist the full tab state for a browser pane (on app close / pane close). */
  persistBrowserPaneTabs: (paneId: string, tabs: PersistedTabData[], activeTabIndex: number) => void;
  /** Restore saved tab state for a browser pane (returns null if nothing saved). */
  restoreBrowserPaneTabs: (paneId: string) => { tabs: PersistedTabData[]; activeTabIndex: number } | null;
}

function persistKeybindings(map: KeybindingMap) {
  // Only persist overrides that differ from defaults, keeping the stored blob small.
  const overrides: Partial<KeybindingMap> = {};
  (Object.keys(map) as KeybindingAction[]).forEach((action) => {
    if (map[action] !== DEFAULT_KEYBINDINGS[action]) overrides[action] = map[action];
  });
  void setSetting(K_KEYBINDINGS, JSON.stringify(overrides));
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  loaded: false,
  theme: "system",
  dnd: false,
  watchMode: false,
  keybindings: { ...DEFAULT_KEYBINDINGS },
  browserUrls: { global: "https://www.google.com", perProject: {} },
  browserPaneState: { paneTabs: {} },

  load: async () => {
    const [theme, dnd, watchMode, kbJson, urlsJson, paneStateJson] = await Promise.all([
      getSetting(K_THEME),
      getSetting(K_DND),
      getSetting(K_WATCH_MODE),
      getSetting(K_KEYBINDINGS),
      getSetting(K_BROWSER_URLS),
      getSetting(K_BROWSER_PANE_STATE),
    ]);
    set((state) => {
      const next = { ...state, loaded: true };
      if (theme === "light" || theme === "dark" || theme === "system") next.theme = theme;
      if (dnd === "true" || dnd === "false") next.dnd = dnd === "true";
      if (watchMode === "true" || watchMode === "false") next.watchMode = watchMode === "true";
      if (kbJson) {
        try {
          const overrides = JSON.parse(kbJson) as Partial<KeybindingMap>;
          next.keybindings = { ...DEFAULT_KEYBINDINGS, ...overrides };
        } catch {
          /* corrupt setting — keep defaults */
        }
      }
      if (urlsJson) {
        try {
          const parsed = JSON.parse(urlsJson) as BrowserUrlState;
          next.browserUrls = {
            global: parsed.global || "https://www.google.com",
            perProject: parsed.perProject ?? {},
          };
        } catch {
          /* keep defaults */
        }
      }
      if (paneStateJson) {
        try {
          const parsed = JSON.parse(paneStateJson) as PersistedBrowserPaneState;
          next.browserPaneState = {
            paneTabs: parsed.paneTabs ?? {},
          };
        } catch {
          /* keep defaults */
        }
      }
      return next;
    });
  },

  setTheme: (theme) => {
    set({ theme });
    void setSetting(K_THEME, theme);
  },

  setDnd: (dnd) => {
    set({ dnd });
    void setSetting(K_DND, String(dnd));
  },

  setWatchMode: (watchMode) => {
    set({ watchMode });
    void setSetting(K_WATCH_MODE, String(watchMode));
  },

  setKeybinding: (action, accelerator) => {
    const keybindings = { ...get().keybindings, [action]: accelerator };
    set({ keybindings });
    persistKeybindings(keybindings);
  },

  resetKeybindings: () => {
    const keybindings = { ...DEFAULT_KEYBINDINGS };
    set({ keybindings });
    persistKeybindings(keybindings);
  },

  lastBrowserUrl: (projectId) => {
    const { browserUrls } = get();
    if (projectId && browserUrls.perProject[projectId]) return browserUrls.perProject[projectId];
    return browserUrls.global || "https://www.google.com";
  },

  rememberBrowserUrl: (projectId, url) => {
    const browserUrls: BrowserUrlState = {
      global: url,
      perProject: projectId
        ? { ...get().browserUrls.perProject, [projectId]: url }
        : get().browserUrls.perProject,
    };
    set({ browserUrls });
    void setSetting(K_BROWSER_URLS, JSON.stringify(browserUrls));
  },

  persistBrowserPaneTabs: (paneId, tabs, activeTabIndex) => {
    const paneTabs = {
      ...get().browserPaneState.paneTabs,
      [paneId]: { tabs, activeTabIndex },
    };
    const state: PersistedBrowserPaneState = { paneTabs };
    set({ browserPaneState: state });
    void setSetting(K_BROWSER_PANE_STATE, JSON.stringify(state));
  },

  restoreBrowserPaneTabs: (paneId) => {
    const entry = get().browserPaneState.paneTabs[paneId];
    return entry ?? null;
  },
}));
