// Settings view: theme (§7.2), remappable keybindings (§7.6), Do Not Disturb
// (§7.13), and harness install/auth status with "Run login" buttons (§9).
// Organised as a left-nav of four categories so the long pricing table does
// not bury the short appearance/shortcut sections. Every panel reserves a
// fixed min-height (see .settings-split / .empty-reserved) so switching
// categories — or an empty harness list — does not reflow the modal.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getSetting, setSetting, type ChatProvider, listChatModels, setChatDefaultModel, type SelectedModelEntry, scanLocalModels, startLocalModel, stopLocalModel, localModelStatus, type GgufModel, type StartedModel, type ActiveLocalModel, listConnectors, connectorConnect, connectorConnectFamily, connectorDisconnect, listenOAuthCallback, type ConnectorWithStatus, type OAuthCallbackPayload, deleteDownloadedModel, getDataPaths, setChatDbDir, type DataPaths, getChatConfig, type ChatConfigPayload, exportProjectZip, importChatZip, toastError, toastSuccess, getLocalModelOverrides, setLocalModelOverrides, type LlamaOverrides, installHarness, getLlamaServerPath, detectGpuPower } from "../../lib/ipc";
import { runLoginFlow } from "../../lib/sessionLauncher";
import type { HarnessId } from "../../types";
import { shortModelName } from "../../lib/modelLabel";
import { useProjectsStore } from "../../state/projects";
import { useSettingsStore, type ThemeSetting } from "../../state/settings";
import { useUiStore } from "../../state/ui";
import { GlassSelect } from "../common/GlassSelect";
import { useChatStore } from "../../state/chat";
import { useArtifactsStore } from "../../state/artifacts";
import { ModelMarket, FitBadge } from "./ModelMarket";
import { LlamaAdvancedFields } from "../chat/LlamaAdvancedFields";
import { KnowledgePanel } from "./KnowledgePanel";
import { MemoryPanel } from "./MemoryPanel";
import { ImprovementsPanel } from "./ImprovementsPanel";
import { SttPanel } from "./SttPanel";
import { PermissionRulesPanel } from "./PermissionRulesPanel";
import { ThemeGalleryPanel } from "./ThemeGalleryPanel";
import { FontSettingsPanel } from "./FontSettingsPanel";
import { AcpAgentsPanel } from "./AcpAgentsPanel";
import { McpGalleryPanel } from "./McpGalleryPanel";
import { RemotePanel } from "./RemotePanel";
import { ConnectorIcon, FamilyIcon, FAMILY_NAMES } from "./ConnectorIcon";
import { formatBytes } from "../../lib/format";
import { LocalModelsPanel, K_SYSTEM_PROMPT, K_COMMIT_PROVIDER, K_COMMIT_MODEL, PROMPT_PRESETS } from "./LocalModelsPanel";
import { ToggleSwitch } from "./ToggleSwitch";
import { Modal } from "../common/Modal";
import {
  Database,
  KeyRound,
  Palette,
  Plug,
  Bot,
  Blocks,
  Cpu,
  Coins,
  Globe,
  TerminalSquare,
  GitBranch,
  Pencil,
  Trash2,
  Eye,
  EyeOff,
  Plus,
  Library,
  Brain,
  Shield,
  ShieldOff,
  Smartphone,
  Bell,
  Sparkles,
  ChevronRight,
} from "lucide-react";

type Category =
  | "appearance"
  | "notifications"
  | "assistant"
  | "improvements"
  | "harnesses"
  | "localmodels"
  | "apikeys"
  | "websearch"
  | "connectors"
  | "knowledge"
  | "memory"
  | "mcpgallery"
  | "permissions"
  | "data"
  | "git"
  | "remote";

const CATEGORY_KEYS: Category[] = [
  "appearance",
  "notifications",
  "assistant",
  "improvements",
  "harnesses",
  "localmodels",
  "apikeys",
  "websearch",
  "connectors",
  "knowledge",
  "memory",
  "mcpgallery",
  "permissions",
  "data",
  "git",
  "remote",
];

function isCategory(v: string | null): v is Category {
  return v !== null && (CATEGORY_KEYS as string[]).includes(v);
}

/** Small icon beside each settings nav item. */
function SettingsNavIcon({ category }: { category: Category }) {
  const size = 13;
  const props = { size, strokeWidth: 1.8, "aria-hidden": true as const };
  switch (category) {
    case "appearance": return <Palette {...props} />;
    case "notifications": return <Bell {...props} />;
    case "assistant": return <Bot {...props} />;
    case "improvements": return <Sparkles {...props} />;
    case "apikeys": return <KeyRound {...props} />;
    case "websearch": return <Globe {...props} />;
    case "localmodels": return <Cpu {...props} />;
    case "harnesses": return <TerminalSquare {...props} />;
    case "connectors": return <Plug {...props} />;
    case "mcpgallery": return <Blocks {...props} />;
    case "knowledge": return <Library {...props} />;
    case "memory": return <Brain {...props} />;
    case "permissions": return <Shield {...props} />;
    case "data": return <Database {...props} />;
    case "git": return <GitBranch {...props} />;
    case "remote": return <Smartphone {...props} />;
    default: return null;
  }
}

interface CategoryDef {
  key: Category;
  label: string;
  sub: string;
}

/** Grouped nav sections: section header + its categories, in display order.
 *  IA follows desktop-app best practice (VS Code / Raycast / Windows 11):
 *  6 top-level groups, each with 1–4 items — broad enough to scan at a glance,
 *  narrow enough that related settings stay adjacent. */
const NAV_SECTIONS: Array<{ title: string; items: CategoryDef[] }> = [
  {
    title: "General",
    items: [
      { key: "appearance", label: "Appearance", sub: "Theme & colors" },
      { key: "notifications", label: "Notifications", sub: "DND & sound" },
      { key: "assistant", label: "Assistant", sub: "System prompt & skills" },
      { key: "improvements", label: "Improvements", sub: "Self-improving artifacts" },
    ],
  },
  {
    title: "Models & Providers",
    items: [
      { key: "apikeys", label: "API Keys", sub: "Chat provider keys" },
      { key: "websearch", label: "Web Search", sub: "Keyless or BYO-key engine" },
      { key: "localmodels", label: "Local Models", sub: "GGUF via llama-server" },
    ],
  },
  {
    title: "Agents",
    items: [
      { key: "harnesses", label: "Harnesses", sub: "CLI install & login" },
    ],
  },
  {
    title: "Workspace & Safety",
    items: [
      { key: "git", label: "Version control", sub: "Commits · worktrees · checkpoints" },
      { key: "permissions", label: "Approval rules", sub: "Always-allow tool+glob" },
    ],
  },
  {
    title: "Integrations",
    items: [
      { key: "connectors", label: "Connectors", sub: "Notion & more (OAuth)" },
      { key: "mcpgallery", label: "MCP Servers", sub: "Gallery + custom MCP" },
      { key: "knowledge", label: "Knowledge", sub: "Local folders (RAG)" },
      { key: "memory", label: "Memory", sub: "What the assistant remembers" },
      { key: "remote", label: "Remote", sub: "Mobile pairing + Tailscale" },
    ],
  },
  {
    title: "Storage",
    items: [
      { key: "data", label: "Data", sub: "Location & delete" },
    ],
  },
];

/** iOS-style toggle switch — replaces checkboxes for system-level prefs. */
/** Redesigned Appearance panel — visual theme cards, toggle switches, and
 *  the custom theme gallery in one clean scroll. */
function AppearancePanel() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const watchMode = useSettingsStore((s) => s.watchMode);
  const setWatchMode = useSettingsStore((s) => s.setWatchMode);

  const THEME_CARDS: Array<{ value: ThemeSetting; label: string; sub: string; preview: "dark" | "light" | "system" }> = [
    { value: "dark", label: "Dark", sub: "Always dark", preview: "dark" },
    { value: "light", label: "Light", sub: "Always light", preview: "light" },
    { value: "system", label: "System", sub: "Match OS", preview: "system" },
  ];

  return (
    <>
      <div className="panel-head">
        <h3>Appearance</h3>
        <span className="panel-count">Theme & colors</span>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Theme mode</div>
        <p className="settings-section-hint">Choose how the app looks. System follows your OS appearance setting.</p>
        <div className="theme-card-grid">
          {THEME_CARDS.map((t) => (
            <button
              key={t.value}
              type="button"
              className={`theme-preset-card${theme === t.value ? " active" : ""}`}
              onClick={() => setTheme(t.value)}
            >
              <div className={`theme-preset-preview theme-preset-${t.preview}`}>
                <div className="theme-preset-preview-sidebar" />
                <div className="theme-preset-preview-main">
                  <div className="theme-preset-preview-bar" />
                  <div className="theme-preset-preview-line" />
                  <div className="theme-preset-preview-line short" />
                </div>
              </div>
              <div className="theme-preset-label">{t.label}</div>
              <div className="theme-preset-sub">{t.sub}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Behavior</div>
        <div className="settings-toggle-row">
          <div className="settings-toggle-label">
            <span className="settings-toggle-name">Watch mode</span>
            <span className="settings-toggle-desc">Visual pacing for browser actions (~600ms delay) so you can follow what the agent is doing. Only applies when the browser pane is visible.</span>
          </div>
          <ToggleSwitch checked={watchMode} onChange={setWatchMode} />
        </div>
      </div>

      {/* Custom theme import/export + gallery (roadmap #19). */}
      <ThemeGalleryPanel />

      {/* UI + mono font pickers. */}
      <FontSettingsPanel />
    </>
  );
}

/** Notifications panel — DND and sound, moved out of Appearance for cleaner IA. */
function NotificationsPanel() {
  const dnd = useSettingsStore((s) => s.dnd);
  const notifySound = useSettingsStore((s) => s.notifySound);
  const setDnd = useSettingsStore((s) => s.setDnd);
  const setNotifySound = useSettingsStore((s) => s.setNotifySound);

  return (
    <>
      <div className="panel-head">
        <h3>Notifications</h3>
        <span className="panel-count">DND & sound</span>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">System notifications</div>
        <p className="settings-section-hint">Control how and when the app notifies you about agent activity.</p>

        <div className="settings-toggle-row">
          <div className="settings-toggle-label">
            <span className="settings-toggle-name">Do Not Disturb</span>
            <span className="settings-toggle-desc">Suppress OS notifications when agents finish. In-app badges still update so you can see results when you return.</span>
          </div>
          <ToggleSwitch checked={dnd} onChange={setDnd} />
        </div>

        <div className="settings-toggle-row">
          <div className="settings-toggle-label">
            <span className="settings-toggle-name">Notification sound</span>
            <span className="settings-toggle-desc">Play a subtle chime when a PTY notification fires.</span>
          </div>
          <ToggleSwitch checked={notifySound} onChange={setNotifySound} />
        </div>
      </div>
    </>
  );
}

export function SettingsView() {
  const setActiveView = useUiStore((s) => s.setActiveView);
  const harnesses = useProjectsStore((s) => s.harnesses);
  const harnessUpdates = useProjectsStore((s) => s.harnessUpdates);
  const projects = useProjectsStore((s) => s.projects);
  const refreshHarnesses = useProjectsStore((s) => s.refreshHarnesses);
  const refreshHarnessUpdates = useProjectsStore((s) => s.refreshHarnessUpdates);
  const markHarnessUpdated = useProjectsStore((s) => s.markHarnessUpdated);
  // One-click harness install/update (Harnesses panel): the id currently
  // running `npm install -g`, so its row button shows progress and stays
  // disabled.
  const [installingHarness, setInstallingHarness] = useState<string | null>(null);

  const handleInstallHarness = async (id: HarnessId, displayName: string) => {
    setInstallingHarness(id);
    try {
      // The backend verifies the CLI actually runs post-install and may add
      // a PATH-refresh/runtime warning to the confirmation line.
      const msg = await installHarness(id);
      // Flip the row to "current" now — the forced re-probe below takes
      // seconds (a --version spawn + registry GET per harness) and left the
      // stale Update button visible after the toast already said "ready".
      markHarnessUpdated(id);
      toastSuccess(msg || `${displayName} installed`);
    } catch (e) {
      toastError(`Couldn't install ${displayName}`, String(e));
    } finally {
      setInstallingHarness(null);
      // Forced probes: reconcile the optimistic flip and pick up any other
      // rows the install affected, regardless of the 30s/1h probe caches.
      void refreshHarnesses(true);
      void refreshHarnessUpdates(true);
    }
  };

  // "Re-check" must catch an out-of-band install/uninstall (done in a
  // terminal), so it force-bypasses the backend's 30s probe cache — and gives
  // feedback while the multi-second probe runs or when the backend errors.
  // The update check (registry latest vs installed version) is refreshed in
  // the same pass so an update that shipped out-of-band shows up too.
  const [rechecking, setRechecking] = useState(false);
  const handleRecheckHarnesses = async () => {
    setRechecking(true);
    try {
      await Promise.all([refreshHarnesses(true), refreshHarnessUpdates(true)]);
    } catch (e) {
      toastError("Couldn't re-check harnesses", String(e));
    } finally {
      setRechecking(false);
    }
  };

  // Category lives in the ui store so other views (sidebar "Manage
  // connectors") can deep-link into a specific Settings section; local state
  // mirrors it for instant nav clicks.
  const settingsCategory = useUiStore((s) => s.settingsCategory);
  const setSettingsCategory = useUiStore((s) => s.setSettingsCategory);
  const [category, setCategory] = useState<Category>("appearance");
  // Search filter for the nav (VS Code / Raycast pattern). Empty = grouped
  // nav; non-empty = flat filtered list hiding section titles.
  const [navQuery, setNavQuery] = useState("");
  const navQueryTrim = navQuery.trim().toLowerCase();
  const filteredItems = useMemo(() => {
    if (!navQueryTrim) return null;
    const all = NAV_SECTIONS.flatMap((s) => s.items);
    return all.filter(
      (c) =>
        c.label.toLowerCase().includes(navQueryTrim) ||
        c.sub.toLowerCase().includes(navQueryTrim) ||
        c.key.toLowerCase().includes(navQueryTrim),
    );
  }, [navQueryTrim]);

  useEffect(() => {
    if (settingsCategory && isCategory(settingsCategory)) {
      setCategory(settingsCategory as Category);
    }
  }, [settingsCategory]);
  const pickCategory = (c: Category) => {
    setCategory(c);
    setSettingsCategory(c);
  };

  // The boot-time check usually seeds harnessUpdates (and the backend caches
  // it for an hour); if it didn't run or failed, quietly refresh the first
  // time the Harnesses panel opens so the Update buttons are correct.
  const [updateCheckAttempted, setUpdateCheckAttempted] = useState(false);
  useEffect(() => {
    if (category !== "harnesses" || updateCheckAttempted) return;
    setUpdateCheckAttempted(true);
    if (Object.keys(harnessUpdates).length === 0) {
      refreshHarnessUpdates(false).catch(() => {});
    }
  }, [category, updateCheckAttempted, harnessUpdates, refreshHarnessUpdates]);

  return (
    <div className="view-overlay modal-centered" onPointerDown={(e) => e.target === e.currentTarget && setActiveView("chat")}>
      <div className="view-panel settings-modal">
        <div className="view-header">
          <div>
            <h2>Settings</h2>
            <span className="settings-header-sub">
              {NAV_SECTIONS.flatMap((s) => s.items).find((c) => c.key === category)?.sub}
            </span>
          </div>
          <button className="ghost" onClick={() => setActiveView("chat")}>
            ✕
          </button>
        </div>
        <div className="view-body">
          <div className="settings-split">
            <nav className={`settings-nav${filteredItems ? " filtered" : ""}`}>
              <div className="settings-search">
                <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  type="text"
                  value={navQuery}
                  onChange={(e) => setNavQuery(e.target.value)}
                  placeholder="Search settings…"
                  aria-label="Search settings"
                />
                {navQuery && (
                  <button
                    className="settings-search-clear"
                    onClick={() => setNavQuery("")}
                    aria-label="Clear search"
                  >
                    ✕
                  </button>
                )}
              </div>
              {filteredItems ? (
                <div className="settings-nav-section">
                  {filteredItems.length > 0 ? (
                    filteredItems.map((c) => (
                      <button
                        key={c.key}
                        className={`nav-item${category === c.key ? " active" : ""}`}
                        onClick={() => {
                          pickCategory(c.key);
                          setNavQuery("");
                        }}
                      >
                        <span className="nav-item-label">
                          <SettingsNavIcon category={c.key} />
                          {c.label}
                        </span>
                        <span className="nav-sub">{c.sub}</span>
                      </button>
                    ))
                  ) : (
                    <div className="settings-nav-empty">No matches</div>
                  )}
                </div>
              ) : (
                NAV_SECTIONS.map((section) => (
                  <div key={section.title} className="settings-nav-section">
                    <div className="settings-nav-section-title">{section.title}</div>
                    {section.items.map((c) => (
                      <button
                        key={c.key}
                        className={`nav-item${category === c.key ? " active" : ""}`}
                        onClick={() => pickCategory(c.key)}
                      >
                        <span className="nav-item-label">
                          <SettingsNavIcon category={c.key} />
                          {c.label}
                        </span>
                        <span className="nav-sub">{c.sub}</span>
                      </button>
                    ))}
                  </div>
                ))
              )}
            </nav>

            <div className="settings-panel">
              {category === "appearance" && <AppearancePanel />}
              {category === "notifications" && <NotificationsPanel />}

              {category === "assistant" && <AssistantPanel />}
              {category === "websearch" && <WebSearchPanel />}
              {category === "git" && <GitPanel />}

              {category === "harnesses" && (
                <>
                  <div className="panel-head">
                    <h3>Agent harnesses</h3>
                    <button
                      className="ghost"
                      onClick={() => void handleRecheckHarnesses()}
                      disabled={rechecking}
                      title="Re-probe every harness binary on PATH and re-check update availability (bypasses the probe caches)"
                      style={{ padding: "2px 8px" }}
                    >
                      {rechecking ? "Checking…" : "Re-check"}
                    </button>
                  </div>
                  {harnesses.length === 0 ? (
                    <div className="empty-reserved">
                      <span className="empty-icon">⏳</span>
                      <span className="empty-text">
                        Detecting harnesses… This requires the desktop backend to be running.
                      </span>
                    </div>
                  ) : (
                    <table className="kv">
                      <tbody>
                        {harnesses.map((h) => {
                          const upd = harnessUpdates[h.id];
                          const updatePending = Boolean(h.installed && upd?.updateAvailable && upd.latestVersion);
                          return (
                            <tr key={h.id}>
                              <td>{h.displayName}</td>
                              <td>
                                {h.installed ? (
                                  <span style={{ color: "var(--state-working)" }}>
                                    installed{upd?.installedVersion ? ` · v${upd.installedVersion}` : ""}
                                    {updatePending && (
                                      <span style={{ color: "var(--state-waiting)" }}> → v{upd.latestVersion}</span>
                                    )}
                                  </span>
                                ) : installingHarness === h.id ? (
                                  <span style={{ color: "var(--state-waiting)" }}>installing…</span>
                                ) : (
                                  <span style={{ color: "var(--text-dim)" }}>not installed</span>
                                )}
                              </td>
                              <td style={{ textAlign: "right" }}>
                                {h.installed ? (
                                  updatePending ? (
                                    // Newer npm release than the installed CLI — the
                                    // Update button takes the row until it's current.
                                    <button
                                      className="primary cta-strong"
                                      disabled={installingHarness !== null}
                                      title={`v${upd.installedVersion ?? "?"} → v${upd.latestVersion} — updates the copy this app launches`}
                                      onClick={() => void handleInstallHarness(h.id, h.displayName)}
                                    >
                                      {installingHarness === h.id ? "Updating…" : "Update"}
                                    </button>
                                  ) : (
                                    <button
                                      onClick={() => {
                                        const cwd = projects[0]?.path ?? ".";
                                        void runLoginFlow(h.id, cwd, `${h.displayName} login`);
                                        setActiveView("chat");
                                      }}
                                    >
                                      Run login
                                    </button>
                                  )
                                ) : (
                                  <button
                                    className="primary cta-strong"
                                    disabled={installingHarness !== null}
                                    title={`Runs npm install -g to install ${h.displayName}`}
                                    onClick={() => void handleInstallHarness(h.id, h.displayName)}
                                  >
                                    {installingHarness === h.id ? "Installing…" : "Install"}
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                  {/* ACP agents (roadmap #20): user-defined Zed/Devin-ecosystem
                      CLIs + the built-in registry. */}
                  <AcpAgentsPanel />
                </>
              )}

              {category === "localmodels" && <LocalModelsPanel />}

              {category === "apikeys" && <ApiKeysPanel />}

              {category === "connectors" && <ConnectorsPanel />}

              {category === "knowledge" && <KnowledgePanel />}
              {category === "memory" && <MemoryPanel />}

              {category === "improvements" && <ImprovementsPanel />}

              {category === "mcpgallery" && <McpGalleryPanel />}

              {category === "permissions" && <PermissionRulesPanel />}

              {category === "data" && <DataPanel />}

              {category === "remote" && <RemotePanel />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const MEMORY_LABELS: Record<string, { color: string; text: string }> = {
  fits: { color: "#4caf50", text: "Fits comfortably" },
  tight: { color: "#ff9800", text: "Fits tightly" },
  too_large: { color: "#f44336", text: "Likely too large" },
};

/** Local Models panel: scan folders for .gguf files, start/stop sidecars. */
function AssistantPanel() {
  const [systemPrompt, setSystemPrompt] = useState("");
  const [loaded, setLoaded] = useState(false);
  // idle → dirty (typing) → saving → saved. Drives the header status pill.
  const [saveState, setSaveState] = useState<"idle" | "dirty" | "saving" | "saved">("idle");

  useEffect(() => {
    let stale = false;
    void getSetting(K_SYSTEM_PROMPT).then((sp) => {
      if (stale) return;
      setSystemPrompt(sp ?? "");
      setLoaded(true);
    });
    return () => {
      stale = true;
    };
  }, []);

  // Debounce-persist the system prompt.
  useEffect(() => {
    if (!loaded || saveState !== "dirty") return;
    const t = setTimeout(() => {
      setSaveState("saving");
      void setSetting(K_SYSTEM_PROMPT, systemPrompt).then(() => setSaveState("saved"));
    }, 500);
    return () => clearTimeout(t);
  }, [systemPrompt, loaded, saveState]);

  const hasPrompt = systemPrompt.trim().length > 0;

  const edit = (text: string) => {
    setSystemPrompt(text);
    setSaveState("dirty");
  };

  return (
    <>
      <div className="panel-head">
        <h3>Assistant</h3>
        <span className={`assistant-save-pill${saveState === "saved" ? " done" : ""}`}>
          {saveState === "dirty" && "Saving…"}
          {saveState === "saving" && "Saving…"}
          {saveState === "saved" && "Saved ✓"}
        </span>
      </div>

      <div className="assistant-card">
        <div className="assistant-card-head">
          <span className="assistant-card-icon">
            <Sparkles size={18} strokeWidth={1.8} />
          </span>
          <div className="assistant-card-heading">
            <div className="assistant-card-title-row">
              <span className="assistant-card-title">Custom system prompt</span>
              <span className={`assistant-status${hasPrompt ? " active" : ""}`}>
                {hasPrompt ? "Active" : "Not set"}
              </span>
            </div>
            <div className="assistant-card-sub">
              Sent at the start of every chat turn to shape tone, format and behavior.
            </div>
          </div>
          {hasPrompt && (
            <button
              type="button"
              className="assistant-clear"
              onClick={() => edit("")}
              title="Remove the system prompt"
            >
              <Trash2 size={13} />
              Reset
            </button>
          )}
        </div>

        <textarea
          className="assistant-textarea"
          value={systemPrompt}
          onChange={(e) => edit(e.target.value)}
          placeholder={
            "e.g. You are a concise senior engineer. Answer directly, prefer minimal diffs, and call out risks before suggesting fixes."
          }
          rows={8}
          spellCheck={false}
          disabled={!loaded}
        />

        <div className="assistant-card-foot">
          {!hasPrompt ? (
            <div className="assistant-presets">
              <span className="assistant-presets-label">Quick start</span>
              {PROMPT_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className="assistant-preset-chip"
                  onClick={() => edit(p.text)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          ) : (
            <span />
          )}
          <span className="assistant-char-count">
            {systemPrompt.length.toLocaleString()} characters
          </span>
        </div>
      </div>
    </>
  );
}

/** Web Search panel: which engine powers `web_search` in chat/research mode.
 *  Keyless multi-engine (DuckDuckGo + Mojeek + Wikipedia) is the default and
 *  needs nothing; BYO-key options swap in a paid index. Keys persist via the
 *  generic settings store (the backend reads `search.provider` /
 *  `search.<provider>_key` at call time). */
const SEARCH_PROVIDERS = [
  { value: "", label: "Keyless (default)" },
  { value: "serper", label: "Serper (Google)" },
  { value: "tavily", label: "Tavily" },
  { value: "brave", label: "Brave" },
] as const;

const SEARCH_PROVIDER_HELP: Record<string, string> = {
  serper:
    "Google-quality SERP. 2,500 free queries, then ~$1 per 1,000 — get a key at serper.dev.",
  tavily:
    "Agent-native search with news/recency filters. 1,000 free credits monthly — get a key at tavily.com.",
  brave:
    "Independent web index. Metered (~$5/mo at hobby scale) — get a key at brave.com/search/api. Note: Brave's terms restrict caching, so Brave-only results are never stored locally.",
};

function WebSearchPanel() {
  const [provider, setProvider] = useState("");
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  // Debounced persists for the key inputs: they fire per keystroke, and
  // out-of-order backend writes could persist an intermediate (shorter)
  // value over the final one.
  const keyPersistTimers = useRef<Record<string, number>>({});
  useEffect(
    () => () => {
      for (const t of Object.values(keyPersistTimers.current)) window.clearTimeout(t);
    },
    [],
  );

  useEffect(() => {
    let stale = false;
    void Promise.all([
      getSetting("search.provider"),
      getSetting("search.serper_key"),
      getSetting("search.tavily_key"),
      getSetting("search.brave_key"),
    ]).then(([p, serper, tavily, brave]) => {
      if (stale) return;
      setProvider(p ?? "");
      setKeys({ serper: serper ?? "", tavily: tavily ?? "", brave: brave ?? "" });
      setLoaded(true);
    });
    return () => {
      stale = true;
    };
  }, []);

  const pickProvider = (v: string) => {
    setProvider(v);
    void setSetting("search.provider", v);
  };

  const setKey = (id: string, value: string) => {
    setKeys((k) => ({ ...k, [id]: value }));
    if (keyPersistTimers.current[id] !== undefined) window.clearTimeout(keyPersistTimers.current[id]);
    keyPersistTimers.current[id] = window.setTimeout(() => {
      delete keyPersistTimers.current[id];
      void setSetting(`search.${id}_key`, value);
    }, 400);
  };

  return (
    <>
      <div className="panel-head">
        <h3>Web Search</h3>
        <span className="panel-count">Chat & research mode</span>
      </div>
      <div className="settings-form-row settings-form-row-pair">
        <div className="settings-form-field">
          <label className="settings-form-label">Search engine</label>
          <div className="settings-form-control">
            <GlassSelect<string>
              value={provider}
              options={[...SEARCH_PROVIDERS]}
              onChange={pickProvider}
            />
          </div>
        </div>
      </div>
      <p className="settings-section-hint">
        Keyless search merges DuckDuckGo, Mojeek and Wikipedia — free, no setup,
        works offline of any account. A paid engine below upgrades the index
        quality for research mode; Wikipedia stays as a supplement either way.
      </p>
      {provider !== "" && (
        <div className="settings-form-row settings-form-row-pair">
          <div className="settings-form-field">
            <label className="settings-form-label">
              {provider === "serper" ? "Serper API key" : provider === "tavily" ? "Tavily API key" : "Brave API key"}
            </label>
            <div className="settings-form-control">
              <input
                type="password"
                value={keys[provider] ?? ""}
                placeholder={loaded ? "Paste your API key…" : ""}
                onChange={(e) => setKey(provider, e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
        </div>
      )}
      {provider !== "" && SEARCH_PROVIDER_HELP[provider] && (
        <p className="settings-section-hint">{SEARCH_PROVIDER_HELP[provider]}</p>
      )}
    </>
  );
}

/** Version control settings: the utility model used to auto-generate commit
 *  messages in the commit modal (a fast/cheap model, independent of the chat
 *  assistant). Stored as a provider+model pair because API keys resolve
 *  per-provider. */
function GitPanel() {
  const worktreeDefault = useSettingsStore((s) => s.worktreeDefault);
  const setWorktreeDefault = useSettingsStore((s) => s.setWorktreeDefault);
  const checkpointsEnabled = useSettingsStore((s) => s.checkpointsEnabled);
  const setCheckpointsEnabled = useSettingsStore((s) => s.setCheckpointsEnabled);
  const [cmProvider, setCmProvider] = useState<ChatProvider | "">("");
  const [cmModel, setCmModel] = useState("");
  const [cmModels, setCmModels] = useState<string[]>([]);
  const [cmModelsLoading, setCmModelsLoading] = useState(false);

  useEffect(() => {
    let stale = false;
    void getSetting(K_COMMIT_PROVIDER).then((p) => {
      if (!stale && p) setCmProvider(p as ChatProvider);
    });
    void getSetting(K_COMMIT_MODEL).then((m) => {
      if (!stale && m) setCmModel(m);
    });
    return () => {
      stale = true;
    };
  }, []);

  // Fetch the selected provider's available models (uses the stored API key +
  // base URL server-side). Native anthropic/openai don't expose /v1/models, so
  // the list stays empty and we fall back to a free-text input below.
  useEffect(() => {
    setCmModels([]);
    if (!cmProvider) return;
    let stale = false;
    setCmModelsLoading(true);
    void listChatModels(cmProvider).then((list) => {
      if (stale) return;
      if (list) {
        // Dedupe + sort model ids for a clean dropdown.
        const ids = Array.from(new Set(list.map((m) => m.id))).sort();
        setCmModels(ids);
      }
      setCmModelsLoading(false);
    });
    return () => {
      stale = true;
    };
  }, [cmProvider]);

  return (
    <>
      <div className="panel-head">
        <h3>Version control</h3>
        <span className="panel-count">Commits · worktrees · checkpoints</span>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Commit message model</div>
        <p className="settings-section-hint">
          Auto-generates commit messages in the commit modal. Pick a small/fast model
          (<code>gpt-4o-mini</code>, <code>claude-haiku</code>) — leave blank to use the active
          chat model.
        </p>
        <div className="settings-form-row settings-form-row-pair">
          <div className="settings-form-field">
            <label className="settings-form-label">Provider</label>
            <div className="settings-form-control">
              <GlassSelect<ChatProvider | "">
                value={cmProvider}
                options={[
                  { value: "", label: "Use active chat model" },
                  { value: "anthropic", label: "Anthropic" },
                  { value: "openai", label: "OpenAI" },
                  { value: "openrouter", label: "OpenRouter" },
                  { value: "anthropic_compatible", label: "Anthropic Compatible" },
                  { value: "openai_compatible", label: "OpenAI Compatible" },
                ]}
                onChange={(v) => {
                  setCmProvider(v);
                  if (v === "") {
                    void setSetting(K_COMMIT_PROVIDER, "");
                    void setSetting(K_COMMIT_MODEL, "");
                    setCmModel("");
                  } else {
                    void setSetting(K_COMMIT_PROVIDER, v);
                    // Clear the OLD provider's model id: keeping it would send
                    // e.g. Anthropic + gpt-4o-mini → HTTP 400, and the commit
                    // modal silently never pre-fills. The user picks a fresh
                    // model (or the blank input defaults to "use active chat
                    // model") from the new provider's list.
                    if (cmProvider !== "") {
                      void setSetting(K_COMMIT_MODEL, "");
                    }
                    setCmModel("");
                  }
                }}
              />
            </div>
          </div>
          {cmProvider !== "" && (
            <div className="settings-form-field">
              <label className="settings-form-label">Model</label>
              <div className="settings-form-control">
                {cmModels.length > 0 ? (
                  <GlassSelect<string>
                    value={cmModel}
                    options={cmModels.map((m) => ({ value: m, label: m }))}
                    onChange={(v) => {
                      setCmModel(v);
                      void setSetting(K_COMMIT_MODEL, v);
                    }}
                  />
                ) : (
                  <input
                    type="text"
                    className="settings-text-input"
                    value={cmModel}
                    onChange={(e) => setCmModel(e.target.value)}
                    onBlur={() => void setSetting(K_COMMIT_MODEL, cmModel)}
                    placeholder={
                      cmModelsLoading
                        ? "Loading models…"
                        : "e.g. gpt-4o-mini (type a model id)"
                    }
                    disabled={cmModelsLoading}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Worktree-per-session isolation</div>
        <p className="settings-section-hint">
          Each git-bound chat works in its own isolated worktree (branch{" "}
          <code>relay/&lt;id&gt;</code>), so agents never collide. Deleting a chat removes it
          best-effort — committed work is never lost.
        </p>
        <div className="settings-toggle-row">
          <div className="settings-toggle-label">
            <span className="settings-toggle-name">Isolate new chats by default</span>
          </div>
          <ToggleSwitch checked={worktreeDefault} onChange={setWorktreeDefault} />
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Per-turn checkpoints</div>
        <p className="settings-section-hint">
          Each file-changing turn gets a hidden git snapshot, shown as a restore chip under the
          reply. Restoring rolls files back and trims the chat to that turn, with one-click undo.
        </p>
        <div className="settings-toggle-row">
          <div className="settings-toggle-label">
            <span className="settings-toggle-name">Record checkpoints by default</span>
          </div>
          <ToggleSwitch checked={checkpointsEnabled} onChange={setCheckpointsEnabled} />
        </div>
      </div>
    </>
  );
}


/** API Keys panel: provider selector, key input with show/hide, base URL
 *  (for compatible providers), model input, Save + Clear buttons.
 *
 *  Note: the API key is NEVER returned from the backend — it lives in the OS
 *  keychain. The key field always starts empty; the user must re-enter their
 *  key to update it. The `hasKey` field (from get_chat_config) tells us
 *  whether a key already exists, so Save is enabled for model/baseUrl-only
 *  updates without re-entering the key. */
function ApiKeysPanel() {
  const config = useChatStore((s) => s.config);
  const saveApiKeyFn = useChatStore((s) => s.saveApiKey);
  const clearApiKeyFn = useChatStore((s) => s.clearApiKey);
  const loadConfigFn = useChatStore((s) => s.loadConfig);

  const [provider, setProvider] = useState<ChatProvider>("anthropic");
  // Latest selected provider for async closures (see handleFetchModels).
  const providerRef = useRef<ChatProvider>(provider);
  providerRef.current = provider;
  // Monotonic ticket for in-flight fetches (see handleFetchModels).
  const fetchTicketRef = useRef(0);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const formDirtyRef = useRef(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<Array<{ id: string; object: string; created: number; ownedBy: string; contextWindow?: number | null }>>([]);
  // Curated Model list (persisted per provider): the rows the composer's
  // model picker offers for this provider, each with an optional per-model
  // context-window pin (0 = auto: live API figure, else the registry).
  const [curatedModels, setCuratedModels] = useState<SelectedModelEntry[]>([]);
  const [editingWindow, setEditingWindow] = useState<string | null>(null);
  const [windowDraft, setWindowDraft] = useState("");
  const [addingRow, setAddingRow] = useState(false);
  const [addId, setAddId] = useState("");
  const [addWindow, setAddWindow] = useState("");
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [addingNew, setAddingNew] = useState(false);

  // Saved-providers summary: fetched once on mount, refreshed after save/clear.
  const [savedProviders, setSavedProviders] = useState<
    Record<string, ChatConfigPayload> | null
  >(null);
  const refreshSavedProviders = async () => {
    const ids: ChatProvider[] = [
      "anthropic",
      "openai",
      "openrouter",
      "anthropic_compatible",
      "openai_compatible",
    ];
    try {
      const results = await Promise.all(ids.map((id) => getChatConfig(id)));
      const out: Record<string, ChatConfigPayload> = {};
      ids.forEach((id, i) => {
        if (results[i]) out[id] = results[i]!;
      });
      setSavedProviders(out);
    } catch (e) {
      // Keep the previous summary rather than half-updating it.
      toastError("Couldn't load saved providers", String(e));
    }
  };

  const isCompatible = provider === "anthropic_compatible" || provider === "openai_compatible";
  // OpenRouter uses a fixed endpoint (no base-URL field) but still supports
  // fetching its model catalogue from `/v1/models`.
  const isOpenRouter = provider === "openrouter";
  const canFetchModels = isCompatible || isOpenRouter;
  const hasExistingKey = config?.provider === provider && config?.hasKey;

  // Bootstrap: load config for the currently selected provider.
  useEffect(() => {
    void loadConfigFn(provider);
  }, [loadConfigFn, provider]);

  // Load the saved-providers summary once on mount.
  useEffect(() => {
    void refreshSavedProviders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-fetch the model list once a base URL is set and a key is available
  // (typed in or already stored), debounced so we don't fire per keystroke.
  useEffect(() => {
    if (isCompatible && !baseUrl.trim()) return;
    if (!canFetchModels) return;
    if (!apiKey.trim() && !hasExistingKey) return;
    const t = setTimeout(() => {
      void handleFetchModels();
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canFetchModels, isCompatible, baseUrl, apiKey, hasExistingKey, provider]);

  // When config arrives (bootstrap or after save/clear), pre-fill fields
  // for the currently selected provider. Skip if the user has already
  // typed something — otherwise late config loads overwrite their input.
  useEffect(() => {
    if (config?.provider === provider) {
      if (!formDirtyRef.current) {
        setBaseUrl(config.baseUrl ?? "");
        setModel(config.model ?? "");
      }
    }
  }, [config, provider]);

  // Curated Model list: load the provider's persisted rows whenever the
  // selected provider changes.
  useEffect(() => {
    let cancelled = false;
    void getSetting(`chat.${provider}.selected_models`).then((raw) => {
      if (cancelled) return;
      try {
        const parsed = raw ? (JSON.parse(raw) as SelectedModelEntry[]) : [];
        setCuratedModels(Array.isArray(parsed) ? parsed.filter((e) => e && e.id) : []);
      } catch {
        setCuratedModels([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  // Persist the curated list (the backend's contract: [] = no curation) and
  // mirror it locally. The FIRST entry becomes the provider's default model
  // (what new chats seed with) — it replaces the removed standalone Model
  // field, so there's one source of truth for "which models this provider
  // offers".
  const persistCurated = (list: SelectedModelEntry[]) => {
    const cleaned = list
      .map((e) => ({ id: e.id.trim(), contextWindow: Math.max(0, Math.floor(e.contextWindow || 0)) }))
      .filter((e) => e.id);
    // Route through the settings STORE action — it persists the key AND
    // updates the in-memory providerModels map (which the composer's model
    // picker and the context meter read) and maintains the load-time index.
    // Writing only the DB key here used to leave the store stale: the picker
    // kept showing every fetched model and the meter ignored the pinned
    // window.
    useSettingsStore.getState().setProviderModels(provider, cleaned);
    setCuratedModels(cleaned);
    if (cleaned.length > 0) {
      setModel(cleaned[0].id);
      void setChatDefaultModel(provider, cleaned[0].id);
    }
  };

  const formatWindowBadge = (n: number | null | undefined): string | null => {
    if (!n || n <= 0) return null;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
    return `${Math.round(n / 1000)}K`;
  };

  const handleFetchModels = async () => {
    if (!canFetchModels) return;
    // Capture the provider at fetch start: the user can switch providers
    // while the request is in flight, and a late resolution must not land
    // another provider's models in the current panel (same stale-resolution
    // guard as the cancelled flag in the curated-list effect above).
    const reqProvider = provider;
    const ticket = ++fetchTicketRef.current;
    setFetchingModels(true);
    setFetchError(null);
    setFetchedModels([]);
    let stale = false;
    try {
      const models = await listChatModels(
        provider,
        baseUrl.trim() || undefined,
        apiKey.trim() || undefined,
      );
      if (providerRef.current !== reqProvider) {
        stale = true;
      } else if (models && models.length > 0) {
        setFetchedModels(models);
      } else {
        setFetchError("No models returned. The provider may not support model listing.");
      }
    } catch (e: any) {
      if (providerRef.current !== reqProvider) {
        stale = true;
      } else {
        setFetchError(e?.message || String(e));
      }
    }
    // A stale fetch still releases the spinner — unless a newer fetch has
    // started, whose own resolution owns the flag now.
    if (!stale || fetchTicketRef.current === ticket) setFetchingModels(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setFetchError(null);
    try {
      await saveApiKeyFn(
        provider,
        apiKey.trim() || "",
        isCompatible ? baseUrl : undefined,
        model || undefined,
      );
      // Clear the API key field after successful save (security)
      setApiKey("");
      setAddingNew(false);
      setFetchError("Saved successfully!");
      setTimeout(() => setFetchError(null), 3000);
      await refreshSavedProviders();
    } catch (e: any) {
      setFetchError(e?.message || String(e));
    }
    setSaving(false);
  };

  const handleClear = async () => {
    try {
      await clearApiKeyFn(provider);
      setApiKey("");
      setBaseUrl("");
      setModel("");
      setFetchedModels([]);
      setFetchError(null);
      await loadConfigFn(provider);
      await refreshSavedProviders();
    } catch (e) {
      toastError("Couldn't clear the API key", String(e));
    }
  };

  // Save is valid when:
  // - For native providers: API key is required
  // - For compatible providers: base URL is required, key is optional (can be added later)
  const canSave = isCompatible
    ? baseUrl.trim().length > 0
    : apiKey.trim().length > 0 || hasExistingKey;
  const keyPlaceholder =
    hasExistingKey
      ? `••••• (enter a new key to replace, or leave blank to keep)`
      : "sk-…";

  const PROVIDERS: Array<{ id: ChatProvider; label: string; short: string; description: string }> = [
    { id: "anthropic", label: "Anthropic", short: "A", description: "Anthropic messages API" },
    { id: "openai", label: "OpenAI", short: "O", description: "OpenAI chat completions" },
    { id: "openrouter", label: "OpenRouter", short: "R", description: "Access multiple model providers" },
    { id: "anthropic_compatible", label: "Anthropic Compatible", short: "A/", description: "Custom Anthropic-compatible endpoint" },
    { id: "openai_compatible", label: "OpenAI Compatible", short: "O/", description: "Custom OpenAI-compatible endpoint" },
  ];
  const selectedProvider = PROVIDERS.find((item) => item.id === provider) ?? PROVIDERS[0];
  const selectedConfig = savedProviders?.[provider];
  const savedModel = selectedConfig?.model || model;
  const endpoint = isCompatible
    ? baseUrl || selectedConfig?.baseUrl || "Custom endpoint"
    : isOpenRouter
      ? "https://openrouter.ai/api"
      : "Provider-managed endpoint";

  const clearSelectedProvider = async () => {
    await handleClear();
  };

  // When the user switches provider, load that provider's config so hasKey
  // is always accurate for the selected provider. Fields are pre-filled by
  // the config effect above when the response arrives.
  const onProviderChange = (v: ChatProvider) => {
    setProvider(v);
    setApiKey("");
    setFetchedModels([]);
    setFetchError(null);
    setAddingNew(false);
    formDirtyRef.current = false; // fresh provider — allow config pre-fill
    void loadConfigFn(v);
  };

  return (
    <div className="api-settings">
      <div className="api-settings-head">
        <div>
          <h3>API providers</h3>
          <p>Connect model providers and choose which models appear in chat.</p>
        </div>
        <span className="api-settings-count">{savedProviders ? Object.values(savedProviders).filter((cfg) => cfg.hasKey).length : 0} connected</span>
      </div>
      <div className="api-settings-shell">
        <aside className="api-provider-rail" aria-label="API providers">
          <div className="api-provider-rail-items">
            {PROVIDERS.map((item) => {
              const isSelected = item.id === provider;
              const isSaved = Boolean(savedProviders?.[item.id]?.hasKey);
              return (
                <div key={item.id} className={`api-provider-item${isSelected ? " selected" : ""}`}>
                  <button
                    type="button"
                    className="api-provider-select"
                    aria-current={isSelected ? "page" : undefined}
                    aria-label={`Select ${item.label}`}
                    onClick={() => onProviderChange(item.id)}
                  >
                    <span className="api-provider-mark" aria-hidden="true">{item.short}</span>
                    <span className="api-provider-item-label">{item.label}</span>
                    <span className={`api-provider-status${isSaved ? " connected" : ""}`} aria-label={isSaved ? "Connected" : "Not connected"} />
                  </button>
                  {isSaved && (
                    <button
                      type="button"
                      className="api-provider-delete"
                      aria-label={`Remove ${item.label}`}
                      title={`Remove ${item.label}`}
                      onClick={() => {
                        void clearApiKeyFn(item.id).then(async () => {
                          if (item.id === provider) {
                            setApiKey("");
                            setBaseUrl("");
                            setModel("");
                            setFetchedModels([]);
                            setFetchError(null);
                            await loadConfigFn(item.id);
                          }
                          await refreshSavedProviders();
                        });
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <button
            type="button"
            className="api-provider-add"
            aria-label="Add a new provider"
            onClick={() => {
              const firstUnconfigured = PROVIDERS.find((item) => !savedProviders?.[item.id]?.hasKey);
              const target = firstUnconfigured ?? PROVIDERS[0];
              setProvider(target.id);
              setApiKey("");
              setBaseUrl("");
              setModel("");
              setFetchedModels([]);
              setFetchError(null);
              setAddingNew(true);
              formDirtyRef.current = false;
              void loadConfigFn(target.id);
            }}
          >
            <Plus size={16} />
            <span>New provider</span>
          </button>
        </aside>

        <section className="api-provider-detail" aria-labelledby="api-provider-title">
          <div className="api-provider-detail-head">
            <div className="api-provider-title-wrap">
              <span className="api-provider-large-mark" aria-hidden="true">{selectedProvider.short}</span>
              <div>
                <div className="api-provider-title-row">
                  <h4 id="api-provider-title">{addingNew ? "New provider" : selectedProvider.label}</h4>
                  {!addingNew && (
                    <span className={`api-connection-badge${hasExistingKey ? " connected" : ""}`}>
                      <span className="api-connection-dot" />
                      {hasExistingKey ? "Connected" : "Not connected"}
                    </span>
                  )}
                </div>
                <p>{addingNew ? "Choose a provider type, enter your API key, and fetch available models." : selectedProvider.description}</p>
              </div>
            </div>
            {!addingNew && hasExistingKey && (
              <button type="button" className="api-icon-button danger" aria-label={`Remove ${selectedProvider.label}`} title={`Remove ${selectedProvider.label}`} onClick={() => void clearSelectedProvider()}>
                <Trash2 size={16} />
              </button>
            )}
          </div>

          {!addingNew && hasExistingKey && (
            <div className="api-connection-summary">
              <div>
                <span className="api-summary-label">Endpoint</span>
                <strong title={endpoint}>{endpoint}</strong>
              </div>
              <div>
                <span className="api-summary-label">Selected model</span>
                <strong>{savedModel || "No model selected"}</strong>
              </div>
            </div>
          )}

          <div className="api-provider-form">
            <div className="api-form-section-head">
              <div>
                <h5>{addingNew || !hasExistingKey ? "Add provider" : "Connection details"}</h5>
                <p>{addingNew || !hasExistingKey ? "Configure a provider to use its models in chat." : "Update the endpoint, key, or default model."}</p>
              </div>
            </div>
            <div className="api-form-field">
              <label htmlFor="api-key-provider">Provider</label>
              <GlassSelect<ChatProvider>
                value={provider}
                options={PROVIDERS.map((item) => ({ value: item.id, label: item.label }))}
                onChange={(v) => {
                  if (addingNew) {
                    setProvider(v);
                    setApiKey("");
                    setBaseUrl("");
                    setModel("");
                    setFetchedModels([]);
                    setFetchError(null);
                    formDirtyRef.current = false;
                    void loadConfigFn(v);
                  } else {
                    onProviderChange(v);
                  }
                }}
                aria-label="Provider"
              />
            </div>
            <div className="api-form-field">
              <label htmlFor="api-key-input">API key</label>
              <div className="api-input-with-action">
                <input id="api-key-input" type={showKey ? "text" : "password"} value={apiKey} onChange={(e) => { formDirtyRef.current = true; setApiKey(e.target.value); }} placeholder={keyPlaceholder} />
                <button type="button" className="api-input-action" onClick={() => setShowKey((v) => !v)} title={showKey ? "Hide key" : "Show key"} aria-label={showKey ? "Hide API key" : "Show API key"}>
                  {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            {isCompatible && (
              <div className="api-form-field">
                <label htmlFor="api-base-url">Base URL</label>
                <div className="api-input-with-action">
                  <input id="api-base-url" type="url" value={baseUrl} onChange={(e) => { formDirtyRef.current = true; setBaseUrl(e.target.value); }} placeholder="https://api.example.com/v1" />
                  <button type="button" className="api-fetch-button" onClick={handleFetchModels} disabled={fetchingModels || !baseUrl.trim()}>{fetchingModels ? "Fetching…" : "Fetch models"}</button>
                </div>
              </div>
            )}
            {isOpenRouter && (
              <div className="api-inline-note">
                <span>OpenRouter uses its hosted API endpoint.</span>
                <button type="button" className="api-fetch-button" onClick={handleFetchModels} disabled={fetchingModels || (!apiKey.trim() && !hasExistingKey)}>{fetchingModels ? "Fetching…" : "Fetch models"}</button>
              </div>
            )}
            {fetchError && (
              <div className="api-form-feedback" role="status">
                <span>{fetchError}</span>
                <button type="button" className="api-text-button" onClick={() => { setFetchError(null); setFetchedModels([]); }}>Use manual input</button>
              </div>
            )}
            <div className="api-model-section">
              <div className="api-model-section-head">
                <label>Model list</label>
                {fetchedModels.length > 0 && <span>{fetchedModels.length} available</span>}
              </div>
              {/* The rows the composer's model picker offers for this
                  provider, each with its own context-window pin (0 = auto:
                  live API figure, else the built-in registry). The FIRST
                  row is the default model for new chats. */}
              <div className="api-model-list">
                {curatedModels.map((entry) => (
                  <div className="api-model-row" key={entry.id}>
                    <span className="api-model-row-name" title={entry.id}>{entry.id}</span>
                    <span className="api-model-row-badges">
                      {formatWindowBadge(entry.contextWindow) && (
                        <span className="api-model-badge">{formatWindowBadge(entry.contextWindow)}</span>
                      )}
                      {!entry.contextWindow && (() => {
                        const live = fetchedModels.find((m) => m.id === entry.id)?.contextWindow;
                        return formatWindowBadge(live) ? <span className="api-model-badge is-live">{formatWindowBadge(live)}</span> : null;
                      })()}
                    </span>
                    {editingWindow === entry.id ? (
                      <span className="api-model-row-edit">
                        <input
                          type="number"
                          min={0}
                          step={1000}
                          autoFocus
                          value={windowDraft}
                          placeholder="0 = auto"
                          onChange={(e) => setWindowDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              persistCurated(curatedModels.map((m) =>
                                m.id === entry.id ? { ...m, contextWindow: Math.max(0, Math.floor(Number(windowDraft) || 0)) } : m,
                              ));
                              setEditingWindow(null);
                            }
                            if (e.key === "Escape") setEditingWindow(null);
                          }}
                        />
                        <button type="button" className="api-text-button" onClick={() => {
                          persistCurated(curatedModels.map((m) =>
                            m.id === entry.id ? { ...m, contextWindow: Math.max(0, Math.floor(Number(windowDraft) || 0)) } : m,
                          ));
                          setEditingWindow(null);
                        }}>Save</button>
                      </span>
                    ) : (
                      <span className="api-model-row-actions">
                        <button type="button" className="api-icon-button" title="Edit context window" onClick={() => {
                          setEditingWindow(entry.id);
                          setWindowDraft(entry.contextWindow ? String(entry.contextWindow) : "");
                        }}><Pencil size={13} /></button>
                        <button type="button" className="api-icon-button" title="Remove from list" onClick={() => persistCurated(curatedModels.filter((m) => m.id !== entry.id))}>✕</button>
                      </span>
                    )}
                  </div>
                ))}
                {addingRow && (
                  <div className="api-model-row is-adding">
                    {fetchedModels.length > 0 ? (
                      <GlassSelect<string>
                        value={addId}
                        options={[{ value: "", label: "Pick a model…" }, ...fetchedModels
                          .filter((m) => !curatedModels.some((c) => c.id === m.id))
                          .map((m) => ({ value: m.id, label: m.id }))]}
                        onChange={(v) => setAddId(v)}
                        aria-label="Model to add"
                      />
                    ) : (
                      <input
                        type="text"
                        value={addId}
                        placeholder="model-id"
                        onChange={(e) => setAddId(e.target.value)}
                      />
                    )}
                    <input
                      className="api-model-add-window"
                      type="number"
                      min={0}
                      step={1000}
                      value={addWindow}
                      placeholder="context (0 = auto)"
                      onChange={(e) => setAddWindow(e.target.value)}
                    />
                    <button type="button" className="api-text-button" disabled={!addId.trim()} onClick={() => {
                      persistCurated([...curatedModels, {
                        id: addId.trim(),
                        contextWindow: Math.max(0, Math.floor(Number(addWindow) || 0)),
                      }]);
                      setAddId("");
                      setAddWindow("");
                      setAddingRow(false);
                    }}>Add</button>
                    <button type="button" className="api-text-button" onClick={() => { setAddingRow(false); setAddId(""); setAddWindow(""); }}>Cancel</button>
                  </div>
                )}
              </div>
              <div className="api-model-actions">
                <button type="button" className="api-add-model-button" onClick={() => setAddingRow((v) => !v)}><Plus size={15} /> Add model</button>
              </div>
            </div>
            <div className="api-form-actions">
              <button type="button" className="primary" onClick={handleSave} disabled={!canSave || saving}>{saving ? "Saving…" : (addingNew || !hasExistingKey) ? "Add provider" : "Save changes"}</button>
              <button type="button" onClick={() => void clearSelectedProvider()} disabled={!apiKey && !config?.provider}>Clear</button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

// ---- Connectors (OAuth + remote MCP) ----
//
// Lists supported connectors with their connection status + Connect/Disconnect.
// Connect opens the vendor's login/consent screen in a native webview; the
// completion (or error/denial) arrives via the `oauth:callback` event, which
// we listen for to refresh the list and clear the spinner. Disconnect clears
// the local token and calls the vendor's revocation endpoint where supported
// (Notion has none — surfaced as a note). Granted scopes are shown during the
// connect flow (before completion) as a trust/transparency measure.
function ConnectorsPanel() {
  const [connectors, setConnectors] = useState<ConnectorWithStatus[] | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ id: string; text: string } | null>(null);
  const [modalFamily, setModalFamily] = useState<string | null>(null);

  const refresh = () => {
    void listConnectors().then((cs) => setConnectors(cs ?? []));
  };
  useEffect(refresh, []);

  // Refresh on every OAuth callback (connect/deny/error) so the status flips
  // as soon as the webview flow resolves. Surface the error/denial reason via
  // the existing note slot — otherwise a failed flow just silently clears the
  // spinner with no feedback.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listenOAuthCallback((payload) => {
      setConnecting(null);
      if (payload.status === "error" || payload.status === "denied") {
        const reason = payload.error ?? (payload.status === "denied" ? "Authorization denied." : "Authorization failed.");
        setNote({ id: payload.connectorId, text: reason });
      } else if (payload.status === "connected") {
        setNote(null);
      }
      refresh();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const handleConnect = (id: string) => {
    setNote(null);
    setConnecting(id);
    void connectorConnect(id).catch((e) => {
      setConnecting(null);
      setNote({ id, text: String(e) });
    });
  };

  const handleDisconnect = async (id: string) => {
    setNote(null);
    setBusy(id);
    try {
      const out = await connectorDisconnect(id);
      if (out?.note) setNote({ id, text: out.note });
      refresh();
    } catch (e) {
      setNote({ id, text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  // One OAuth flow (one consent screen) connects every member of the family.
  const handleConnectFamily = (family: string) => {
    setNote(null);
    setConnecting(family);
    void connectorConnectFamily(family).catch((e) => {
      setConnecting(null);
      setNote({ id: family, text: String(e) });
    });
  };

  // Group connectors under their product family — one card per vendor. The
  // Google Workspace set shares a single OAuth client/consent, so it collapses
  // into one "Google" card (big logo, member chips, one Connect-all flow).
  const families = useMemo(() => {
    const out: { family: string; name: string; members: ConnectorWithStatus[] }[] = [];
    const byFamily = new Map<string, ConnectorWithStatus[]>();
    for (const c of connectors ?? []) {
      const list = byFamily.get(c.family) ?? [];
      list.push(c);
      byFamily.set(c.family, list);
    }
    for (const [family, members] of byFamily) {
      out.push({ family, name: FAMILY_NAMES[family] ?? members[0].displayName, members });
    }
    return out;
  }, [connectors]);

  const openFam = modalFamily ? (families.find((f) => f.family === modalFamily) ?? null) : null;
  const totalConnectors = connectors?.length ?? 0;
  const connectedTotal = (connectors ?? []).filter(
    (c) => c.status.connected && !c.status.expired,
  ).length;

  return (
    <>
      <div className="panel-head">
        <h3>Connectors</h3>
        {totalConnectors > 0 && (
          <span className="panel-count">
            {connectedTotal}/{totalConnectors} connected
          </span>
        )}
      </div>

      <div className="conn-info-card">
        <Shield className="conn-info-icon" size={18} />
        <div>
          <div className="conn-info-title">Connect third-party accounts</div>
          <div className="conn-info-body">
            After connecting, the model can use tools like search, read, create, and send on your
            behalf. Read actions run automatically; write/create/delete/send follow the conversation&apos;s
            approval mode.
          </div>
        </div>
      </div>

      <div className="conn-grid">
        {families.map((f) => {
          const connectedCount = f.members.filter(
            (c) => c.status.connected && !c.status.expired,
          ).length;
          const allConnected = connectedCount === f.members.length;
          const single = f.members.length === 1;
          const isConnecting = connecting === f.family || (single && connecting === f.members[0].id);
          const connect = () =>
            single ? handleConnect(f.members[0].id) : handleConnectFamily(f.family);
          const openModal = () => setModalFamily(f.family);
          const familyLabel = allConnected
            ? `All ${f.members.length} connected`
            : connectedCount > 0
              ? `${connectedCount} of ${f.members.length} connected`
              : "Not connected";
          return (
            <div className={`conn-family-card${allConnected ? " done" : ""}`} key={f.family}>
              <button
                type="button"
                className="conn-family-head"
                onClick={openModal}
                title={single ? undefined : "View every product"}
              >
                <span className="conn-family-icon">
                  <FamilyIcon family={f.family} size={30} />
                </span>
                <span className="conn-family-meta">
                  <strong className="conn-family-title">{f.name}</strong>
                  <span
                    className={`conn-family-count${connectedCount > 0 ? (allConnected ? " on" : " partial") : ""}`}
                  >
                    {familyLabel}
                  </span>
                </span>
                {!single && (
                  <ChevronRight className="conn-family-chevron" size={15} aria-hidden />
                )}
              </button>

              {f.members.length > 1 && (
                <div className="conn-member-chips">
                  {f.members.slice(0, 6).map((c) => {
                    const on = c.status.connected && !c.status.expired;
                    return (
                      <span
                        className={`conn-member-chip${on ? "" : " off"}`}
                        key={c.id}
                        title={`${c.displayName}${on ? "" : " — not connected"}`}
                      >
                        {ConnectorIcon({ id: c.id, size: 13 }) ?? (
                          <span className="conn-fallback-icon">{c.icon}</span>
                        )}
                      </span>
                    );
                  })}
                  {f.members.length > 6 && (
                    <span className="conn-more">+{f.members.length - 6}</span>
                  )}
                </div>
              )}

              <div className="conn-family-foot">
                {allConnected ? (
                  <span className="conn-all-done">✓ Connected</span>
                ) : (
                  <button
                    type="button"
                    className="primary conn-connect-btn"
                    disabled={isConnecting}
                    onClick={connect}
                  >
                    {isConnecting ? "Authorizing…" : single ? "Connect" : "Connect all"}
                  </button>
                )}
              </div>

              {note?.id === f.family && <div className="conn-note">{note.text}</div>}
            </div>
          );
        })}
        {totalConnectors === 0 && (
          <div className="empty-reserved conn-empty">
            <ShieldOff className="empty-icon" size={22} />
            <div className="empty-text">
              No connectors available yet.
            </div>
          </div>
        )}
      </div>
      {openFam && (
        <Modal
          title={openFam.name}
          onClose={() => setModalFamily(null)}
          actions={<button className="ghost" onClick={() => setModalFamily(null)}>Close</button>}
        >
          <p className="estimate-note">
            {openFam.members.length > 1
              ? "One OAuth consent covers every product below — use the card's Connect all, or manage each connection here."
              : "Manage this connection."}
          </p>
          <div className="conn-modal-list">
            {openFam.members.map((c) => {
              const st = c.status;
              const statusLabel = st.connected && st.expired ? "Token expired" : "Not connected";
              const isConnecting = connecting === c.id;
              const isBusy = busy === c.id;
              const canConnect = openFam.members.length === 1;
              return (
                <div className="conn-sub-row" key={c.id}>
                  <div className="conn-sub-icon">
                    {ConnectorIcon({ id: c.id, size: 20 }) ?? (
                      <span className="conn-fallback-icon">{c.icon}</span>
                    )}
                  </div>
                  <div className="conn-card-info">
                    <div className="conn-card-title-row">
                      <strong className="conn-card-title">{c.displayName}</strong>
                      {(!st.connected || st.expired) && (
                        <span
                          className={`conn-status${st.expired ? " expired" : ""}${st.connected ? " ok" : ""}`}
                        >
                          {statusLabel}
                        </span>
                      )}
                    </div>
                    {note?.id === c.id && <div className="conn-note">{note.text}</div>}
                  </div>
                  <div className="conn-sub-action">
                    {st.connected ? (
                      <button
                        className="ghost"
                        disabled={isBusy}
                        onClick={() => void handleDisconnect(c.id)}
                      >
                        {isBusy ? "Disconnecting…" : "Disconnect"}
                      </button>
                    ) : canConnect ? (
                      <button
                        className="primary"
                        disabled={isConnecting}
                        onClick={() => handleConnect(c.id)}
                      >
                        {isConnecting ? "Authorizing…" : "Connect"}
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
            {note?.id === modalFamily && (
              <div className="conn-note">{note.text}</div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

/** Numeric input bound to an app_settings key; loads on mount, saves on blur. */
// ---- Data (chat DB + artifacts storage + delete) ----

function DataPanel() {
  const [paths, setPaths] = useState<DataPaths | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"chats" | "artifacts" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [selectedProjectForBackup, setSelectedProjectForBackup] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState<"backup" | "restore" | null>(null);
  // Projects expose a native-list selector for "back up project" (export the
  // chats of one project). Sourced from the projects store like the rest of
  // the sidebar.
  const backupProjects = useProjectsStore((s) => s.projects);
  // After restoring, refresh the sidebar's live chat list from the DB.
  const importDone = useCallback(async () => {
    await useChatStore.getState().loadSessions();
  }, []);

  // Store-backed deletes so the sidebar/chat view update immediately —
  // the raw IPC commands alone leave stale in-memory state on screen.
  const deleteAllChats = useChatStore((s) => s.deleteAllChats);
  const clearAllArtifacts = useArtifactsStore((s) => s.clearAll);

  const refresh = () => {
    void getDataPaths().then((p) => p && setPaths(p));
  };
  useEffect(refresh, []);

  const handleBackupProject = async () => {
    if (!selectedProjectForBackup) return;
    setBackupBusy("backup");
    try {
      await exportProjectZip(selectedProjectForBackup);
      setNote("Project chat backup exported.");
    } catch (err) {
      setNote(`Backup failed: ${String(err)}`);
      toastError("Backup failed", err);
    } finally {
      setBackupBusy(null);
    }
  };

  const handleRestore = async () => {
    setBackupBusy("restore");
    try {
      const imported = await importChatZip();
      if (imported && imported.length > 0) {
        await importDone();
        setNote(`Restored ${imported.length} chat session(s).`);
      } else if (imported) {
        setNote("No chats found in that backup.");
      }
      // imported === null → user cancelled; stay quiet.
    } catch (err) {
      setNote(`Restore failed: ${String(err)}`);
      toastError("Restore failed", err);
    } finally {
      setBackupBusy(null);
    }
  };

  const pickDbDir = async () => {
    const picked = await open({
      directory: true,
      title: "Choose where to store chats (database)",
    });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      await setChatDbDir(picked);
      setNote(`Chat database moved to ${picked}`);
      refresh();
    } catch (err) {
      setNote(`Failed to move chat database: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const resetDbDir = async () => {
    setBusy(true);
    try {
      await setChatDbDir(null);
      setNote("Chat database moved back to the default location");
      refresh();
    } catch (err) {
      setNote(`Failed to reset chat database: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const pickArtifactsDir = async () => {
    const picked = await open({
      directory: true,
      title: "Choose where to store artifacts",
    });
    if (typeof picked !== "string") return;
    await setSetting("storage.artifactsDir", picked);
    setNote(`Artifacts will be stored in ${picked}`);
    refresh();
  };

  const resetArtifactsDir = async () => {
    await setSetting("storage.artifactsDir", "");
    setNote("Artifacts will be stored in the default location");
    refresh();
  };

  const runDelete = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm === "chats") {
        const n = await deleteAllChats();
        setNote(`Deleted ${n} chat session(s)`);
      } else {
        const n = await clearAllArtifacts();
        setNote(`Deleted ${n} artifact(s)`);
      }
      refresh();
    } catch (err) {
      setNote(`Delete failed: ${String(err)}`);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  return (
    <div className="settings-form">
      <div className="panel-head">
        <h3>Data</h3>
        <span className="panel-count">Backup · storage · cleanup</span>
      </div>

      {note && <div className="settings-note">{note}</div>}

      {/* Backup / Restore — roadmap #7 local-first backup story */}
      <div className="settings-section">
        <div className="settings-section-title">Backup</div>
        <p className="settings-section-hint">
          Export a project's chats to a <code>.zip</code>, or restore a previous backup.
          Imported chats are added fresh — nothing is overwritten.
        </p>
        <div className="data-backup-row">
          <select
            value={selectedProjectForBackup ?? ""}
            onChange={(e) => setSelectedProjectForBackup(e.target.value || null)}
          >
            <option value="">Select project…</option>
            {(backupProjects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            className="primary cta-strong"
            onClick={() => void handleBackupProject()}
            disabled={backupBusy !== null || !selectedProjectForBackup}
            title={selectedProjectForBackup ? undefined : "Pick a project first"}
          >
            {backupBusy === "backup" ? "Exporting…" : "Back up"}
          </button>
          <button className="ghost" onClick={() => void handleRestore()} disabled={backupBusy === "restore"}>
            {backupBusy === "restore" ? "Restoring…" : "Restore from backup"}
          </button>
        </div>
      </div>

      {/* Storage locations */}
      <div className="settings-section">
        <div className="settings-section-title">Storage</div>
        <div className="data-path-card">
          <div className="data-path-info">
            <div className="data-path-name">Chats (database)</div>
            <div className="data-path-value mono">
              {paths?.chatDbPath ?? "…"}
              {paths ? ` · ${formatBytes(paths.chatDbSize)}` : ""}
            </div>
          </div>
          <div className="data-path-actions">
            <button className="ghost" onClick={pickDbDir} disabled={busy}>
              Change…
            </button>
            <button className="ghost" onClick={resetDbDir} disabled={busy}>
              Reset
            </button>
          </div>
        </div>
        <div className="data-path-card">
          <div className="data-path-info">
            <div className="data-path-name">Artifacts</div>
            <div className="data-path-value mono">
              {paths?.artifactsDir ?? "…"}
              {paths ? ` · ${formatBytes(paths.artifactsSize)}` : ""}
            </div>
          </div>
          <div className="data-path-actions">
            <button className="ghost" onClick={pickArtifactsDir}>
              Change…
            </button>
            <button className="ghost" onClick={resetArtifactsDir}>
              Reset
            </button>
          </div>
        </div>
      </div>

      {/* Delete */}
      <div className="settings-section">
        <div className="settings-section-title">Danger zone</div>
        <div className="data-danger">
          <span className="data-danger-text">
            Permanently delete all chat sessions or all generated artifacts. This cannot be undone.
          </span>
          <div className="data-danger-actions">
            <button className="danger" onClick={() => setConfirm("chats")} disabled={busy}>
              Delete all chats
            </button>
            <button className="danger" onClick={() => setConfirm("artifacts")} disabled={busy}>
              Delete all artifacts
            </button>
          </div>
        </div>
      </div>

      {confirm && (
        <Modal
          title={confirm === "chats" ? "Delete all chats?" : "Delete all artifacts?"}
          onClose={() => setConfirm(null)}
          actions={
            <>
              <button className="ghost" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button className="danger" onClick={runDelete} disabled={busy}>
                {busy ? "Deleting…" : "Delete"}
              </button>
            </>
          }
        >
          <p>
            {confirm === "chats"
              ? "This permanently deletes every chat session and all of their messages. Generated artifacts are kept."
              : "This permanently deletes every generated artifact (files and diagrams). Chat history is kept."}
          </p>
        </Modal>
      )}
    </div>
  );
}
