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
import { SidebarArtPanel } from "./SidebarArtPanel";
import { AcpAgentsPanel } from "./AcpAgentsPanel";
import { McpGalleryPanel } from "./McpGalleryPanel";
import { RemotePanel } from "./RemotePanel";
import { ConnectorIcon, FamilyIcon, FAMILY_NAMES } from "./ConnectorIcon";
import { formatBytes } from "../../lib/format";
import { LocalModelsPanel, K_SYSTEM_PROMPT, K_COMMIT_PROVIDER, K_COMMIT_MODEL, PROMPT_PRESETS } from "./LocalModelsPanel";
import { GitPanel } from "./GitPanel";
import { ApiKeysPanel } from "./ApiKeysPanel";
import { ConnectorsPanel } from "./ConnectorsPanel";
import { DataPanel } from "./DataPanel";
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

      {/* Sidebar art: a user-uploaded image behind the header block. */}
      <SidebarArtPanel />

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