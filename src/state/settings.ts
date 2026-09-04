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

// Cloud/API context-compaction (advanced). Same pin+summarize engine as the
// local path, triggered by an ESTIMATED request size against the model
// registry's window; the summarizer is the session's own provider. Defaults
// mirror the Rust loader in chat/cloud_compact.rs.
const K_CLOUD_COMPACTION_ENABLED = "chat.cloud.compaction_enabled";
const K_CLOUD_COMPACTION_THRESHOLD = "chat.cloud.compaction_threshold";
const K_CLOUD_PIN_EXCHANGES = "chat.cloud.compaction_pin_exchanges";
export const DEFAULT_CLOUD_COMPACTION_THRESHOLD = 0.75;
export const DEFAULT_CLOUD_PIN_EXCHANGES = 6;

// Cloud context-limit override: cap the EFFECTIVE window below what the
// model advertises (cost control, or a remapped backend that serves less
// than the model id suggests). 0 = auto (the model's own window). Mirrors
// chat/context_windows.rs::load_context_limit_override.
const K_CLOUD_CONTEXT_LIMIT = "chat.cloud.context_limit";

// Chat text zoom. A multiplier on the chat message/composer/code font sizes
// via the --chat-zoom CSS var. (The Ctrl +/-/0 shortcuts now drive the
// app-wide zoom below; this one persists as a fine-tune multiplier.)
const K_CHAT_ZOOM = "chat.textZoom";
export const DEFAULT_CHAT_ZOOM = 1;
export const CHAT_ZOOM_MIN = 0.7;
export const CHAT_ZOOM_MAX = 1.6;

// App-wide UI zoom (Ctrl + / Ctrl - to scale, Ctrl + 0 to reset). Applied as
// the CSS `zoom` property on the document element — native Chromium zoom that
// scales every surface (sidebar, panes, composer, settings), unlike
// --chat-zoom which only scales chat text.
const K_APP_ZOOM = "app.zoom";
export const DEFAULT_APP_ZOOM = 1;
export const APP_ZOOM_MIN = 0.6;
export const APP_ZOOM_MAX = 2;

// Per-provider curated model lists: provider id -> ordered entries with an
// optional per-model context-window pin (0 = auto). A non-empty list IS the
// provider's model picker content; absent/empty = show everything the
// /v1/models fetch returns. Key shape mirrors the backend's
// chat.<provider>.selected_models.
export interface ProviderModelEntry {
  id: string;
  contextWindow: number;
}
const selectedModelsKey = (provider: string) => `chat.${provider}.selected_models`;
/** Index of providers that HAVE a curated list (stored lists are never
 *  deleted — an empty list is the cleared signal the backend's
 *  load_selected_models already treats as "nothing curated"). */
const SELECTED_MODELS_INDEX_KEY = "chat.selected_models_index";

// Local compaction quality knobs (P4 of the compaction redesign): route the
// summary call through a configured cloud provider instead of the (small)
// sidecar model, and re-derive each new summary from the ORIGINAL turns a
// prior summary folded away (rebuild-from-raw) instead of stacking
// summary-on-summary. Keys mirror chat/compaction.rs's loader.
const K_LOCAL_COMPACTION_SUMMARIZER = "chat.local_gguf.compaction_summarizer";
const K_LOCAL_COMPACTION_REBUILD_FROM_RAW = "chat.local_gguf.compaction_rebuild_from_raw";

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
  /** Local-GGUF: which model writes the summary — the sidecar itself or the
   *  first configured cloud provider ("sidecar" | "cloud"). */
  localCompactionSummarizer: "sidecar" | "cloud";
  /** Local-GGUF: re-derive each new summary from the original folded turns. */
  localCompactionRebuildFromRaw: boolean;
  /** Cloud/API: compaction master switch (overflow retry always stays on). */
  cloudCompactionEnabled: boolean;
  /** Cloud/API: fraction of the model window that triggers compaction. */
  cloudCompactionThreshold: number;
  /** Cloud/API: recent exchanges pinned verbatim. */
  cloudPinExchanges: number;
  /** Cloud/API: user cap on the effective context window, tokens. 0 = auto
   *  (the model's own — dynamic where the API publishes it, registry else).
   *  A cap only SHRINKS; it never raises a model above its real window. */
  cloudContextLimit: number;
  /** Per-provider curated model lists with per-model window pins. */
  providerModels: Record<string, ProviderModelEntry[]>;
  /** Chat text zoom multiplier (0.7–1.6). Scales chat message text, the
   *  composer and code blocks via the --chat-zoom CSS variable. */
  chatZoom: number;
  /** App-wide UI zoom multiplier (0.6–2). Applied as CSS zoom on the root
   *  element so every surface scales — driven by the Ctrl +/-/0 shortcuts. */
  appZoom: number;

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
  setCloudCompactionEnabled: (enabled: boolean) => void;
  setCloudCompactionThreshold: (threshold: number) => void;
  setCloudPinExchanges: (exchanges: number) => void;
  setCloudContextLimit: (limit: number) => void;
  /** Replace a provider's curated model list (persisted + in-memory). */
  setProviderModels: (provider: string, models: ProviderModelEntry[]) => void;
  /** The pinned window for a specific provider+model, 0 when unset. */
  modelWindowFor: (provider: string, model: string | null | undefined) => number;
  setLocalCompactionSummarizer: (which: "sidecar" | "cloud") => void;
  setLocalCompactionRebuildFromRaw: (on: boolean) => void;
  /** Set the chat text zoom (clamped to CHAT_ZOOM_MIN–MAX) and persist it. */
  setChatZoom: (zoom: number) => void;
  /** Set the app-wide UI zoom (clamped to APP_ZOOM_MIN–MAX) and persist it. */
  setAppZoom: (zoom: number) => void;
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
  cloudCompactionEnabled: true,
  cloudCompactionThreshold: DEFAULT_CLOUD_COMPACTION_THRESHOLD,
  cloudPinExchanges: DEFAULT_CLOUD_PIN_EXCHANGES,
  cloudContextLimit: 0,
  providerModels: {},
  localCompactionSummarizer: "sidecar",
  localCompactionRebuildFromRaw: true,
  chatZoom: DEFAULT_CHAT_ZOOM,
  appZoom: DEFAULT_APP_ZOOM,

  load: async () => {
    const [theme, dnd, notifySound, watchMode, kbJson, urlsJson, paneStateJson, threshold, pin, themesJson, customThemeId, worktreeDefault, checkpointsEnabled, cloudEnabled, cloudThreshold, cloudPin, summarizer, rebuildRaw, cloudContextLimit, chatZoomRaw, appZoomRaw] = await Promise.all([
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
      getSetting(K_CLOUD_COMPACTION_ENABLED),
      getSetting(K_CLOUD_COMPACTION_THRESHOLD),
      getSetting(K_CLOUD_PIN_EXCHANGES),
      getSetting(K_LOCAL_COMPACTION_SUMMARIZER),
      getSetting(K_LOCAL_COMPACTION_REBUILD_FROM_RAW),
      getSetting(K_CLOUD_CONTEXT_LIMIT),
      getSetting(K_CHAT_ZOOM),
      getSetting(K_APP_ZOOM),
    ]);
    // Per-provider curated model lists: the index names the providers that
    // have one; each list is then read from its own key. A missing or
    // malformed list simply doesn't populate the map (the UI then shows
    // everything the /v1/models fetch returns).
    const providerModels: Record<string, ProviderModelEntry[]> = {};
    try {
      // The index names providers with a curated list, but lists saved
      // before an index write (or by older builds) still exist under their
      // provider key — probe the known cloud ids as well so they self-heal.
      const indexRaw = await getSetting(SELECTED_MODELS_INDEX_KEY);
      const indexed: string[] = indexRaw ? JSON.parse(indexRaw) : [];
      const known = [
        "anthropic",
        "openai",
        "openrouter",
        "anthropic_compatible",
        "openai_compatible",
      ];
      const providers = Array.from(new Set([...indexed, ...known]));
      for (const p of providers) {
        if (typeof p !== "string" || !p) continue;
        try {
          const raw = await getSetting(selectedModelsKey(p));
          if (!raw) continue;
          const parsed = JSON.parse(raw) as ProviderModelEntry[];
          if (Array.isArray(parsed) && parsed.length > 0) {
            providerModels[p] = parsed.filter((e) => e && typeof e.id === "string");
          }
        } catch { /* skip malformed list */ }
      }
    } catch { /* no index — nothing curated */ }
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
      // Cloud context-limit override (0 = auto).
      if (cloudContextLimit) {
        const v = Number(cloudContextLimit);
        if (Number.isFinite(v) && v >= 0) next.cloudContextLimit = Math.floor(v);
      }
      // Per-provider curated model lists (fetched above, before set()).
      next.providerModels = providerModels;
      // Local compaction quality knobs.
      if (summarizer === "cloud" || summarizer === "sidecar") next.localCompactionSummarizer = summarizer;
      if (rebuildRaw === "true" || rebuildRaw === "false") next.localCompactionRebuildFromRaw = rebuildRaw === "true";
      // Cloud compaction: same clamps as the local knobs; enabled parses
      // anything not in the off-list as on (mirrors the Rust loader).
      if (cloudEnabled != null) next.cloudCompactionEnabled = !["false", "0", "off"].includes(cloudEnabled.trim());
      if (cloudThreshold) {
        const v = Number(cloudThreshold);
        if (Number.isFinite(v) && v >= 0.25 && v <= 0.99) next.cloudCompactionThreshold = v;
      }
      if (cloudPin) {
        const v = Number(cloudPin);
        if (Number.isInteger(v) && v >= 1 && v <= 50) next.cloudPinExchanges = v;
      }
      if (chatZoomRaw) {
        const v = Number(chatZoomRaw);
        if (Number.isFinite(v) && v >= CHAT_ZOOM_MIN && v <= CHAT_ZOOM_MAX) next.chatZoom = v;
      }
      if (appZoomRaw) {
        const v = Number(appZoomRaw);
        if (Number.isFinite(v) && v >= APP_ZOOM_MIN && v <= APP_ZOOM_MAX) next.appZoom = v;
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

  setCloudCompactionEnabled: (enabled) => {
    set({ cloudCompactionEnabled: enabled });
    void setSetting(K_CLOUD_COMPACTION_ENABLED, String(enabled));
  },

  setCloudCompactionThreshold: (threshold) => {
    if (!Number.isFinite(threshold) || threshold < 0.25 || threshold > 0.99) return;
    set({ cloudCompactionThreshold: threshold });
    void setSetting(K_CLOUD_COMPACTION_THRESHOLD, String(threshold));
  },

  setCloudPinExchanges: (exchanges) => {
    if (!Number.isInteger(exchanges) || exchanges < 1 || exchanges > 50) return;
    set({ cloudPinExchanges: exchanges });
    void setSetting(K_CLOUD_PIN_EXCHANGES, String(exchanges));
  },

  setCloudContextLimit: (limit) => {
    if (!Number.isFinite(limit) || limit < 0) return;
    const v = Math.floor(limit);
    set({ cloudContextLimit: v });
    void setSetting(K_CLOUD_CONTEXT_LIMIT, String(v));
  },

  setProviderModels: (provider, models) => {
    const cleaned = models
      .filter((e) => e && typeof e.id === "string" && e.id.trim())
      .map((e) => ({
        id: e.id.trim(),
        contextWindow: Math.max(0, Math.floor(e.contextWindow || 0)),
      }));
    set((s) => ({
      providerModels: { ...s.providerModels, [provider]: cleaned },
    }));
    // An empty list persists as [] — the backend's load_selected_models
    // treats that as "nothing curated" (picker shows all fetched models).
    void setSetting(selectedModelsKey(provider), JSON.stringify(cleaned));
    // Maintain the index so load() knows which keys exist.
    void (async () => {
      try {
        const indexRaw = await getSetting(SELECTED_MODELS_INDEX_KEY);
        const providers: string[] = indexRaw ? JSON.parse(indexRaw) : [];
        if (!providers.includes(provider)) {
          providers.push(provider);
          void setSetting(SELECTED_MODELS_INDEX_KEY, JSON.stringify(providers));
        }
      } catch { /* index write is best-effort; the list itself still lands */ }
    })();
  },

  modelWindowFor: (provider, model) => {
    if (!model) return 0;
    const list = get().providerModels[provider];
    if (!list) return 0;
    const m = model.trim().toLowerCase();
    return list.find((e) => e.id.trim().toLowerCase() === m)?.contextWindow ?? 0;
  },

  setLocalCompactionSummarizer: (which) => {
    set({ localCompactionSummarizer: which });
    void setSetting(K_LOCAL_COMPACTION_SUMMARIZER, which);
  },

  setLocalCompactionRebuildFromRaw: (on) => {
    set({ localCompactionRebuildFromRaw: on });
    void setSetting(K_LOCAL_COMPACTION_REBUILD_FROM_RAW, String(on));
  },

  setChatZoom: (zoom) => {
    const clamped = Math.max(CHAT_ZOOM_MIN, Math.min(CHAT_ZOOM_MAX, zoom));
    set({ chatZoom: clamped });
    void setSetting(K_CHAT_ZOOM, String(clamped));
  },

  setAppZoom: (zoom) => {
    const clamped = Math.max(APP_ZOOM_MIN, Math.min(APP_ZOOM_MAX, zoom));
    set({ appZoom: clamped });
    void setSetting(K_APP_ZOOM, String(clamped));
  },
}));
