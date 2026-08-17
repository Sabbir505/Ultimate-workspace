// Settings store (PRD §7.2 theme, §7.6 keybinding overrides, §7.13 DND,
// §4.6 per-project last browser URL, §4.6 multi-tab browser pane state).
// Everything persists through the get_setting/set_setting contract commands.
import { create } from "zustand";
import { getSetting, setSetting } from "../lib/ipc";
import { DEFAULT_KEYBINDINGS, type KeybindingAction, type KeybindingMap } from "../lib/keybindings";
import { DEFAULT_BROWSER_URL } from "../lib/browserHistory";
import { parseThemeList, type CustomTheme } from "../lib/themes";

export type ThemeSetting = "light" | "dark" | "system";

const K_THEME = "theme";
const K_THEMES = "themes.custom"; // JSON: CustomTheme[]
const K_CUSTOM_THEME_ID = "themes.customThemeId"; // active custom theme id ("" = none)
const K_DND = "doNotDisturb";
const K_NOTIFY_SOUND = "notifySound";
const K_WATCH_MODE = "watchMode";
/** Worktree-per-session default (roadmap P0 §3.1.1): "true" (default) gives
 *  every new chat on a git project its own isolated worktree. Any value other
 *  than the literal "false" reads as enabled — mirrors `checkpoints.enabled`. */
const K_WORKTREE_DEFAULT = "worktrees.defaultEnabled";
/** Per-turn git checkpoints (roadmap P0 §3.1.2): "false" disables snapshots,
 *  baselines and restores entirely; anything else (or missing) = enabled.
 *  Mirrors the backend `checkpoints.rs` gate exactly. */
const K_CHECKPOINTS_ENABLED = "checkpoints.enabled";
const K_KEYBINDINGS = "keybindingOverrides";
const K_BROWSER_URLS = "browserLastUrls"; // JSON: { global: string, perProject: Record<string, string> }
const K_BROWSER_PANE_STATE = "browserPaneState"; // JSON: { paneTabs: Record<string, BrowserPaneTabState> }

// Local-GGUF context-compaction (advanced). Threshold is a 0.25–0.99 fraction
// of the model's context window at which older turns get summarized; pin is
// the number of recent *exchanges* (user+assistant pairs) kept verbatim.
// Defaults mirror the Rust `compaction.rs` constants.
const K_LOCAL_COMPACTION_THRESHOLD = "chat.local_gguf.compaction_threshold";
const K_LOCAL_PIN_EXCHANGES = "chat.local_gguf.compaction_pin_exchanges";
export const DEFAULT_LOCAL_COMPACTION_THRESHOLD = 0.75;
export const DEFAULT_LOCAL_PIN_EXCHANGES = 6;

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
  /** Custom themes (roadmap #19): importable JSON override maps layered on
   *  top of the built-in light/dark palette. */
  customThemes: CustomTheme[];
  /** Active custom theme id (null = built-in theme only). */
  customThemeId: string | null;
  dnd: boolean;
  /** Play a subtle sound when a PTY notification fires (alongside the OS toast). */
  notifySound: boolean;
  watchMode: boolean;
  /** Worktree-per-session default: give every new chat on a git project its
   *  own isolated worktree. Default true; off skips auto-creation (per-chat
   *  isolation stays available via the toggle). */
  worktreeDefault: boolean;
  /** Per-turn git checkpoints (hidden-ref snapshots + restore chip on
   *  changed messages). Default true; "false" turns the whole feature off. */
  checkpointsEnabled: boolean;
  keybindings: KeybindingMap;
  browserUrls: BrowserUrlState;
  browserPaneState: PersistedBrowserPaneState;
  /** Local-GGUF: fraction of the context window that triggers compaction. */
  localCompactionThreshold: number;
  /** Local-GGUF: recent exchanges (user+assistant pairs) pinned verbatim. */
  localPinExchanges: number;

  load: () => Promise<void>;
  setTheme: (theme: ThemeSetting) => void;
  setCustomTheme: (id: string | null) => void;
  importCustomTheme: (theme: CustomTheme) => void;
  deleteCustomTheme: (id: string) => void;
  setDnd: (dnd: boolean) => void;
  setNotifySound: (on: boolean) => void;
  setWatchMode: (watchMode: boolean) => void;
  setWorktreeDefault: (enabled: boolean) => void;
  setCheckpointsEnabled: (enabled: boolean) => void;
  setKeybinding: (action: KeybindingAction, accelerator: string) => void;
  resetKeybindings: () => void;
  lastBrowserUrl: (projectId: string | null) => string;
  rememberBrowserUrl: (projectId: string | null, url: string) => void;
  /** Persist the full tab state for a browser pane (on app close / pane close). */
  persistBrowserPaneTabs: (paneId: string, tabs: PersistedTabData[], activeTabIndex: number) => void;
  /** Restore saved tab state for a browser pane (returns null if nothing saved). */
  restoreBrowserPaneTabs: (paneId: string) => { tabs: PersistedTabData[]; activeTabIndex: number } | null;
  setLocalCompactionThreshold: (threshold: number) => void;
  setLocalPinExchanges: (exchanges: number) => void;
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
  customThemes: [],
  customThemeId: null,
  dnd: false,
  notifySound: true,
  watchMode: false,
  worktreeDefault: true,
  checkpointsEnabled: true,
  keybindings: { ...DEFAULT_KEYBINDINGS },
  browserUrls: { global: "https://www.google.com", perProject: {} },
  browserPaneState: { paneTabs: {} },
  localCompactionThreshold: DEFAULT_LOCAL_COMPACTION_THRESHOLD,
  localPinExchanges: DEFAULT_LOCAL_PIN_EXCHANGES,

  load: async () => {
    const [theme, dnd, notifySound, watchMode, kbJson, urlsJson, paneStateJson, threshold, pin, themesJson, customThemeId, worktreeDefault, checkpointsEnabled] = await Promise.all([
      getSetting(K_THEME),
      getSetting(K_DND),
      getSetting(K_NOTIFY_SOUND),
      getSetting(K_WATCH_MODE),
      getSetting(K_KEYBINDINGS),
      getSetting(K_BROWSER_URLS),
      getSetting(K_BROWSER_PANE_STATE),
      getSetting(K_LOCAL_COMPACTION_THRESHOLD),
      getSetting(K_LOCAL_PIN_EXCHANGES),
      getSetting(K_THEMES),
      getSetting(K_CUSTOM_THEME_ID),
      getSetting(K_WORKTREE_DEFAULT),
      getSetting(K_CHECKPOINTS_ENABLED),
    ]);
    set((state) => {
      const next = { ...state, loaded: true };
      if (theme === "light" || theme === "dark" || theme === "system") next.theme = theme;
      if (customThemeId) next.customThemeId = customThemeId;
      if (themesJson) {
        next.customThemes = parseThemeList(themesJson);
        // A dangling active id (theme deleted while off) is dropped so
        // useTheme never resolves an overlay that no longer exists. Runs
        // AFTER the stored id is applied so it validates the just-loaded
        // value, not the previous state's (audit L2 — it was dead code).
        if (next.customThemeId && !next.customThemes.some((t) => t.id === next.customThemeId)) {
          next.customThemeId = null;
        }
      }
      if (dnd === "true" || dnd === "false") next.dnd = dnd === "true";
      if (notifySound === "true" || notifySound === "false") next.notifySound = notifySound === "true";
      if (watchMode === "true" || watchMode === "false") next.watchMode = watchMode === "true";
      // Default ON: only the literal "false" disables (mirrors the backend's
      // `checkpoints.enabled` convention — any other value reads as enabled).
      if (worktreeDefault === "false") next.worktreeDefault = false;
      // Same convention for per-turn checkpoints (backend gate in checkpoints.rs).
      if (checkpointsEnabled === "false") next.checkpointsEnabled = false;
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
      // Compaction: parse + clamp to the same band the Rust loader enforces;
      // a bad stored value falls back to the default rather than breaking chat.
      if (threshold) {
        const v = Number(threshold);
        if (Number.isFinite(v) && v >= 0.25 && v <= 0.99) next.localCompactionThreshold = v;
      }
      if (pin) {
        const v = Number(pin);
        if (Number.isInteger(v) && v >= 1 && v <= 50) next.localPinExchanges = v;
      }
      return next;
    });
  },

  setTheme: (theme) => {
    // Switching the base mode deselects the custom overlay (the user
    // explicitly picked a built-in theme).
    set({ theme, customThemeId: null });
    void setSetting(K_THEME, theme);
    void setSetting(K_CUSTOM_THEME_ID, "");
  },

  setCustomTheme: (id) => {
    set({ customThemeId: id });
    void setSetting(K_CUSTOM_THEME_ID, id ?? "");
  },

  importCustomTheme: (theme) => {
    const customThemes = [...get().customThemes.filter((t) => t.id !== theme.id), theme];
    set({ customThemes });
    void setSetting(K_THEMES, JSON.stringify(customThemes));
  },

  deleteCustomTheme: (id) => {
    const customThemes = get().customThemes.filter((t) => t.id !== id);
    const wasActive = get().customThemeId === id;
    set({ customThemes, customThemeId: wasActive ? null : get().customThemeId });
    void setSetting(K_THEMES, JSON.stringify(customThemes));
    if (wasActive) void setSetting(K_CUSTOM_THEME_ID, "");
  },

  setDnd: (dnd) => {
    set({ dnd });
    void setSetting(K_DND, String(dnd));
  },

  setNotifySound: (on) => {
    set({ notifySound: on });
    void setSetting(K_NOTIFY_SOUND, String(on));
  },

  setWatchMode: (watchMode) => {
    set({ watchMode });
    void setSetting(K_WATCH_MODE, String(watchMode));
  },

  setWorktreeDefault: (enabled) => {
    set({ worktreeDefault: enabled });
    void setSetting(K_WORKTREE_DEFAULT, String(enabled));
  },

  setCheckpointsEnabled: (enabled) => {
    set({ checkpointsEnabled: enabled });
    void setSetting(K_CHECKPOINTS_ENABLED, String(enabled));
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
    // Older builds persisted "http://localhost:3000" as the global URL; treat
    // that legacy value as unset so the default (google.com) wins instead.
    const global = browserUrls.global;
    if (!global || /^https?:\/\/localhost(:\d+)?\/?$/.test(global)) return DEFAULT_BROWSER_URL;
    return global;
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

  setLocalCompactionThreshold: (threshold) => {
    if (!Number.isFinite(threshold) || threshold < 0.25 || threshold > 0.99) return;
    set({ localCompactionThreshold: threshold });
    void setSetting(K_LOCAL_COMPACTION_THRESHOLD, String(threshold));
  },

  setLocalPinExchanges: (exchanges) => {
    if (!Number.isInteger(exchanges) || exchanges < 1 || exchanges > 50) return;
    set({ localPinExchanges: exchanges });
    void setSetting(K_LOCAL_PIN_EXCHANGES, String(exchanges));
  },
}));
