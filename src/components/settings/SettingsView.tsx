// Settings view: theme (§7.2), remappable keybindings (§7.6), Do Not Disturb
// (§7.13), and harness install/auth status with "Run login" buttons (§9).
// Organised as a left-nav of four categories so the long pricing table does
// not bury the short appearance/shortcut sections. Every panel reserves a
// fixed min-height (see .settings-split / .empty-reserved) so switching
// categories — or an empty harness list — does not reflow the modal.
import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getSetting, setSetting, type ChatProvider, listChatModels, scanLocalModels, startLocalModel, stopLocalModel, localModelStatus, type GgufModel, type StartedModel, type ActiveLocalModel, listConnectors, connectorConnect, connectorConnectFamily, connectorDisconnect, listenOAuthCallback, type ConnectorWithStatus, type OAuthCallbackPayload, deleteDownloadedModel, getDataPaths, setChatDbDir, type DataPaths, getChatConfig, type ChatConfigPayload, exportProjectZip, importChatZip, toastError, toastSuccess } from "../../lib/ipc";
import { runLoginFlow } from "../../lib/sessionLauncher";
import { shortModelName } from "../../lib/modelLabel";
import { useProjectsStore } from "../../state/projects";
import { useSettingsStore, type ThemeSetting } from "../../state/settings";
import { useUiStore } from "../../state/ui";
import { GlassSelect } from "../common/GlassSelect";
import { useChatStore } from "../../state/chat";
import { useArtifactsStore } from "../../state/artifacts";
import { ModelMarket } from "./ModelMarket";
import { KnowledgePanel } from "./KnowledgePanel";
import { PermissionRulesPanel } from "./PermissionRulesPanel";
import { PromptTemplatesPanel } from "./PromptTemplatesPanel";
import { ThemeGalleryPanel } from "./ThemeGalleryPanel";
import { ConnectorIcon, FamilyIcon, FAMILY_NAMES } from "./ConnectorIcon";
import { Modal } from "../common/Modal";
import {
  Database,
  KeyRound,
  Palette,
  Plug,
  Bot,
  Cpu,
  Coins,
  TerminalSquare,
  GitBranch,
  Pencil,
  Trash2,
  Library,
  Shield,
} from "lucide-react";

type Category =
  | "appearance"
  | "assistant"
  | "pricing"
  | "harnesses"
  | "localmodels"
  | "apikeys"
  | "connectors"
  | "knowledge"
  | "permissions"
  | "data"
  | "git";

const CATEGORY_KEYS: Category[] = [
  "appearance",
  "assistant",
  "pricing",
  "harnesses",
  "localmodels",
  "apikeys",
  "connectors",
  "knowledge",
  "permissions",
  "data",
  "git",
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
    case "assistant": return <Bot {...props} />;
    case "apikeys": return <KeyRound {...props} />;
    case "localmodels": return <Cpu {...props} />;
    case "pricing": return <Coins {...props} />;
    case "harnesses": return <TerminalSquare {...props} />;
    case "connectors": return <Plug {...props} />;
    case "knowledge": return <Library {...props} />;
    case "permissions": return <Shield {...props} />;
    case "data": return <Database {...props} />;
    case "git": return <GitBranch {...props} />;
    default: return null;
  }
}

interface CategoryDef {
  key: Category;
  label: string;
  sub: string;
}

/** Grouped nav sections: section header + its categories, in display order. */
const NAV_SECTIONS: Array<{ title: string; items: CategoryDef[] }> = [
  {
    title: "General",
    items: [
      { key: "appearance", label: "Appearance", sub: "Theme, notifications" },
      { key: "assistant", label: "Assistant", sub: "System prompt & skills" },
    ],
  },
  {
    title: "Models & Providers",
    items: [
      { key: "apikeys", label: "API Keys", sub: "Chat provider keys" },
      { key: "localmodels", label: "Local Models", sub: "GGUF via llama-server" },
      { key: "pricing", label: "Pricing", sub: "Per-model $/Mtok rates" },
    ],
  },
  {
    title: "Agents",
    items: [
      { key: "harnesses", label: "Harnesses", sub: "CLI install & login" },
    ],
  },
  {
    title: "Version Control",
    items: [
      { key: "git", label: "Commit message model", sub: "Utility model for auto-commits" },
    ],
  },
  {
    title: "Integrations",
    items: [
      { key: "connectors", label: "Connectors", sub: "Notion & more (OAuth)" },
      { key: "knowledge", label: "Knowledge", sub: "Local folders (RAG)" },
    ],
  },
  {
    title: "Permissions",
    items: [
      { key: "permissions", label: "Approval rules", sub: "Always-allow tool+glob" },
    ],
  },
  {
    title: "Storage",
    items: [
      { key: "data", label: "Data", sub: "Location & delete" },
    ],
  },
];

const MODELS: Array<[string, string, string, string]> = [
  ["claude-opus-4-8", "Claude Opus 4.8", "5", "25"],
  ["claude-sonnet-5", "Claude Sonnet 5", "2", "10"],
  ["claude-sonnet-4-5", "Claude Sonnet 4.5", "3", "15"],
  ["claude-haiku-4-5", "Claude Haiku 4.5", "1", "5"],
  ["kimi-k3", "Kimi K3", "3", "15"],
  ["kimi-k2.7-code", "Kimi K2.7 Code", "0.95", "4"],
  ["kimi-k2.6", "Kimi K2.6", "0.95", "4"],
  ["glm-5.2", "GLM 5.2", "1.4", "4.4"],
  ["glm-5.1", "GLM 5.1", "1.4", "4.4"],
  ["deepseek-v4-pro", "DeepSeek V4 Pro", "0.435", "0.87"],
  ["minimax-m3", "MiniMax M3", "0.3", "1.2"],
  ["qwen3.7-plus", "Qwen 3.7 Plus", "0.4", "1.6"],
];

export function SettingsView() {
  const setActiveView = useUiStore((s) => s.setActiveView);
  const theme = useSettingsStore((s) => s.theme);
  const dnd = useSettingsStore((s) => s.dnd);
  const notifySound = useSettingsStore((s) => s.notifySound);
  const watchMode = useSettingsStore((s) => s.watchMode);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setDnd = useSettingsStore((s) => s.setDnd);
  const setNotifySound = useSettingsStore((s) => s.setNotifySound);
  const setWatchMode = useSettingsStore((s) => s.setWatchMode);
  const harnesses = useProjectsStore((s) => s.harnesses);
  const projects = useProjectsStore((s) => s.projects);
  const refreshHarnesses = useProjectsStore((s) => s.refreshHarnesses);

  // Category lives in the ui store so other views (sidebar "Manage
  // connectors") can deep-link into a specific Settings section; local state
  // mirrors it for instant nav clicks.
  const settingsCategory = useUiStore((s) => s.settingsCategory);
  const setSettingsCategory = useUiStore((s) => s.setSettingsCategory);
  const [category, setCategory] = useState<Category>("appearance");
  useEffect(() => {
    if (settingsCategory && isCategory(settingsCategory)) {
      setCategory(settingsCategory as Category);
    }
  }, [settingsCategory]);
  const pickCategory = (c: Category) => {
    setCategory(c);
    setSettingsCategory(c);
  };

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
            <nav className="settings-nav">
              {NAV_SECTIONS.map((section) => (
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
              ))}
            </nav>

            <div className="settings-panel">
              {category === "appearance" && (
                <>
                  <div className="panel-head">
                    <h3>Appearance</h3>
                  </div>
                  <div className="settings-form">
                    <div className="settings-form-row">
                      <label className="settings-form-label">Theme</label>
                      <div className="settings-form-control">
                        <GlassSelect<ThemeSetting>
                          value={theme}
                          options={[
                            { value: "system", label: "System", hint: "match OS" },
                            { value: "dark", label: "Dark" },
                            { value: "light", label: "Light" },
                          ]}
                          onChange={(v) => setTheme(v)}
                        />
                      </div>
                    </div>
                    <div className="settings-form-row">
                      <label className="settings-form-label">Do Not Disturb</label>
                      <div className="settings-form-control">
                        <label className="settings-checkbox-row">
                          <input type="checkbox" checked={dnd} onChange={(e) => setDnd(e.target.checked)} />
                          <span>Suppress OS notifications when agents finish (in-app badges still update)</span>
                        </label>
                      </div>
                    </div>
                    <div className="settings-form-row">
                      <label className="settings-form-label">Notification sound</label>
                      <div className="settings-form-control">
                        <label className="settings-checkbox-row">
                          <input
                            type="checkbox"
                            checked={notifySound}
                            onChange={(e) => setNotifySound(e.target.checked)}
                          />
                          <span>Play a subtle chime when a PTY notification fires</span>
                        </label>
                      </div>
                    </div>
                    <div className="settings-form-row">
                      <label className="settings-form-label">Watch mode</label>
                      <div className="settings-form-control">
                        <label className="settings-checkbox-row">
                          <input type="checkbox" checked={watchMode} onChange={(e) => setWatchMode(e.target.checked)} />
                          <span>Visual pacing for browser actions (~600ms delay) so you can follow what the agent is doing. Only applies when the browser pane is visible.</span>
                        </label>
                      </div>
                    </div>
                  </div>
                  {/* Custom theme import/export + gallery (roadmap #19). */}
                  <ThemeGalleryPanel />
                </>
              )}

              {category === "assistant" && (
                <>
                  <AssistantPanel />
                  <PromptTemplatesPanel />
                </>
              )}
              {category === "git" && <GitPanel />}

              {category === "pricing" && (
                <>
                  <div className="panel-head">
                    <h3>Cost estimate rates</h3>
                    <span className="panel-count">{MODELS.length} models</span>
                  </div>
                  <p className="estimate-note">
                    Per-million-token list prices per model (defaults from official pricing pages, July
                    2026; claude-sonnet-5 is the $2/$10 intro rate until 2026-08-31). The dashboard
                    prices each session by the model recorded in the harness's session log. Adjust to
                    your actual plan pricing — all cost figures are estimates.
                  </p>
                  <div className="rate-grid">
                    {MODELS.map(([key, label, inDefault, outDefault]) => (
                      <div className="rate-card" key={key}>
                        <div className="rate-name">
                          {label}
                          <span className="rate-id">{key}</span>
                        </div>
                        <div className="rate-fields">
                          <div className="field">
                            <label>in $/Mtok</label>
                            <RateField settingsKey={`price.${key}.input_per_mtok`} fallback={inDefault} />
                          </div>
                          <div className="field">
                            <label>out $/Mtok</label>
                            <RateField settingsKey={`price.${key}.output_per_mtok`} fallback={outDefault} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {category === "harnesses" && (
                <>
                  <div className="panel-head">
                    <h3>Agent harnesses</h3>
                    <button className="ghost" onClick={() => void refreshHarnesses()} style={{ padding: "2px 8px" }}>
                      Re-check
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
                        {harnesses.map((h) => (
                          <tr key={h.id}>
                            <td>{h.displayName}</td>
                            <td>
                              {h.installed ? (
                                <span style={{ color: "var(--state-working)" }}>installed</span>
                              ) : (
                                <span style={{ color: "var(--state-waiting)" }}>not installed</span>
                              )}
                            </td>
                            <td style={{ textAlign: "right" }}>
                              {h.installed && (
                                <button
                                  onClick={() => {
                                    const cwd = projects[0]?.path ?? ".";
                                    void runLoginFlow(h.id, cwd, `${h.displayName} login`);
                                    setActiveView("chat");
                                  }}
                                >
                                  Run login
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )}

              {category === "localmodels" && <LocalModelsPanel />}

              {category === "apikeys" && <ApiKeysPanel />}

              {category === "connectors" && <ConnectorsPanel />}

              {category === "knowledge" && <KnowledgePanel />}

              {category === "permissions" && <PermissionRulesPanel />}

              {category === "data" && <DataPanel />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Human-readable file size string. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

const MEMORY_LABELS: Record<string, { color: string; text: string }> = {
  fits: { color: "#4caf50", text: "Fits comfortably" },
  tight: { color: "#ff9800", text: "Fits tightly" },
  too_large: { color: "#f44336", text: "Likely too large" },
};

/** Local Models panel: scan folders for .gguf files, start/stop sidecars. */
function LocalModelsPanel() {
  const [models, setModels] = useState<GgufModel[]>([]);
  const [active, setActive] = useState<ActiveLocalModel | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // Per-model loading state so the row whose "Use this model" was clicked
  // shows a spinner while the sidecar spawns + loads the GGUF.
  const [starting, setStarting] = useState<Record<string, boolean>>({});
  const [folders, setFolders] = useState<string[]>([]);
  const [advanced, setAdvanced] = useState<Record<string, { ngl?: number; ctx?: number }>>({});
  // Panel tabs: "models" = on-disk GGUF list, "market" = Hugging Face browser.
  const [tab, setTab] = useState<"models" | "market">("models");

  const newChat = useChatStore((s) => s.newChat);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const sessions = useChatStore((s) => s.sessions);
  const loadConfig = useChatStore((s) => s.loadConfig);

  // Persist the list of user-added folders so they survive app restarts.
  const persistFolders = (next: string[]) => {
    setFolders(next);
    void setSetting(K_LOCAL_FOLDERS, JSON.stringify(next));
  };

  // Heuristic RAM estimate for the "fits my RAM" badge — same heuristic the
  // Model Market tab uses. navigator.deviceMemory is in GiB and only set on
  // Chromium-family browsers; fall back to 16 GB when missing.
  const totalRam = useMemo(() => {
    const dm = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
    return (dm && dm > 0 ? dm : 16) * 1024 * 1024 * 1024;
  }, []);

  // Rescan and replace the model list. The backend's bare scan_local_models
  // already merges default locations with every persisted user-added folder
  // (localModels.folders), so the frontend just asks for the full set.
  const runScan = async () => {
    const list = await scanLocalModels();
    setModels(list ?? []);
  };

  // Auto-scan default locations + any previously-added folders on mount.
  useEffect(() => {
    if (loaded) return;
    let stale = false;
    void (async () => {
      // Load persisted folders for the chip display (the backend reads the
      // same setting when scanning, so they're scanned automatically).
      const stored = await getSetting(K_LOCAL_FOLDERS);
      let initialFolders: string[] = [];
      if (stored) {
        try {
          const parsed = JSON.parse(stored) as string[];
          if (Array.isArray(parsed)) initialFolders = parsed.filter((f) => typeof f === "string");
        } catch {
          /* corrupt — start empty */
        }
      }
      if (!stale) setFolders(initialFolders);
      await runScan();
      if (!stale) {
        setLoaded(true);
        setLoading(false);
      }
      const a = await localModelStatus();
      if (!stale) setActive(a);
    })();
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const refreshStatus = () => {
    void localModelStatus().then((a) => setActive(a));
  };

  const handleAddFolder = async () => {
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        title: "Select models folder",
      });
      if (typeof picked !== "string" || !picked) return;
      // Persist the folder BEFORE rescanning so the backend's bare scan
      // includes it (the backend reads localModels.folders).
      const nextFolders = folders.includes(picked) ? folders : [...folders, picked];
      persistFolders(nextFolders);
      setLoading(true);
      await runScan();
    } catch (err) {
      console.warn("scan folder failed", err);
    } finally {
      setLoading(false);
    }
  };

  const handleUseModel = async (m: GgufModel) => {
    setErrors((prev) => {
      const next = { ...prev };
      delete next[m.id];
      return next;
    });
    setStarting((prev) => ({ ...prev, [m.id]: true }));
    try {
      const overrides = advanced[m.id];
      const started = await startLocalModel(
        m.id,
        m.path,
        overrides?.ngl,
        overrides?.ctx,
        m.mmprojPath,
      );
      if (!started) throw new Error("start_local_model returned null");
      refreshStatus();
      // start_local_model persisted chat.local_gguf.model + chat.active_provider.
      // Reload config so the sidebar "New Chat" seed (chatConfig.model) reflects
      // the running local model instead of the pre-local default.
      void loadConfig("local_gguf");

      // Create/select a chat session with local_gguf provider.
      const modelName = m.name || m.filename;
      const existing = sessions.find(
        (s) => s.provider === "local_gguf" && s.model === modelName,
      );
      if (existing) {
        // navigate there (the store handles it via selectSession)
      }
      const session = await newChat("local_gguf", modelName);
      if (session) {
        setActiveView("chat");
      }
    } catch (err) {
      setErrors((prev) => ({
        ...prev,
        [m.id]: String(err),
      }));
    } finally {
      setStarting((prev) => ({ ...prev, [m.id]: false }));
    }
  };

  const handleStop = async () => {
    if (!active) return;
    try {
      await stopLocalModel(active.modelId);
      setActive(null);
    } catch (err) {
      console.warn("stop failed", err);
    }
  };

  const nothing =
    loaded && models.length === 0 && folders.length === 0 && !loading;
  // `nothing` is intentionally unused now — the empty state is rendered
  // inline in the grid below. Keeping the flag for future use.
  void nothing;

  // RAM fit classification (matches the heuristic in ModelMarket.tsx).
  // < 50% → "fits", 50-80% → "tight", > 80% → "too_large".
  const classifyRam = (sizeBytes: number): "fits" | "tight" | "too_large" => {
    if (!totalRam) return "tight";
    const r = sizeBytes / totalRam;
    if (r < 0.5) return "fits";
    if (r < 0.8) return "tight";
    return "too_large";
  };

  return (
    <>
      <div className="panel-head">
        <h3>Local Models</h3>
        {tab === "models" && (
          <div style={{ display: "flex", gap: 8 }}>
            {active && (
              <button className="ghost" style={{ padding: "2px 8px" }} onClick={handleStop}>
                Stop server
              </button>
            )}
            <button
              className="ghost"
              style={{ padding: "2px 8px" }}
              onClick={() => void handleAddFolder()}
            >
              + Add folder
            </button>
            <button
              className="ghost"
              style={{ padding: "2px 8px" }}
              onClick={() => {
                setLoading(true);
                setLoaded(false);
              }}
              disabled={loading}
            >
              {loading ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span className="local-spinner" /> Scanning…
                </span>
              ) : (
                "Rescan defaults"
              )}
            </button>
          </div>
        )}
      </div>

      <div className="tab-bar">
        <button
          className={`tab${tab === "models" ? " active" : ""}`}
          onClick={() => setTab("models")}
        >
          My Models
        </button>
        <button
          className={`tab${tab === "market" ? " active" : ""}`}
          onClick={() => setTab("market")}
        >
          Model Market
        </button>
      </div>

      {tab === "models" && (
      <>
      <p className="estimate-note">
        Llama-server must be installed separately (llama.cpp). Models are
        scanned from ~/.lmstudio/models, ~/.cache/lm-studio/models, your
        Downloads folder, Ollama, and any folder you add here.
      </p>

      {active && (
        <div className="local-models-banner">
          <span className="status-dot" />
          <span>
            Active: <strong>{active.modelId}</strong> on port {active.port}
          </span>
        </div>
      )}

      {folders.length > 0 && (
        <div className="local-models-folder-chips">
          {folders.map((f) => (
            <span key={f} className="local-models-folder-chip" title={f}>
              <span className="chip-path">{f}</span>
              <button
                className="chip-remove"
                title="Remove this folder from scans"
                onClick={() => {
                  const next = folders.filter((x) => x !== f);
                  persistFolders(next);
                  void runScan();
                }}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="model-market-grid">
        {models.length === 0 && !loading && !active && (
          <div className="empty-reserved">
            <span className="empty-text">
              No .gguf models found. Place them in the LM Studio models folder
              (~/.lmstudio/models), your Downloads folder, or click "Add folder"
              to scan a custom location. Or grab one from the Model Market tab.
            </span>
          </div>
        )}

        {models.map((m) => {
        const ram = classifyRam(m.sizeBytes);
        const err = errors[m.id];
        const overrides = advanced[m.id] ?? {};
        const isStarting = starting[m.id];
        const isRunning = active?.modelId === m.id;
        const displayName = shortModelName(m.name || m.filename);
        return (
          <div key={m.id} className={`local-model-card model-card${isRunning ? " running" : ""}`}>
            <button
              className="model-card-delete"
              title="Delete this model file from disk"
              aria-label="Delete model"
              onClick={async () => {
                if (!confirm(`Delete ${m.filename || m.id} from disk?`)) return;
                try {
                  await deleteDownloadedModel(m.path);
                  await runScan();
                } catch (e) {
                  console.warn("delete failed", e);
                }
              }}
            >
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                <path d="M10 11v6" />
                <path d="M14 11v6" />
                <path d="M9 6V4a2 2 0 012-2h2a2 2 0 012 2v2" />
              </svg>
            </button>
            <div className="model-card-head">
              <div className="model-info">
                <div className="model-name" title={displayName}>{displayName}</div>
                <div className="model-meta">
                  <span>{m.architecture || m.source}</span>
                  <span>·</span>
                  <span>{humanSize(m.sizeBytes)}</span>
                  {m.quantization && <span className="model-tag">{m.quantization}</span>}
                  {m.paramCountLabel && <span className="model-tag">{m.paramCountLabel}</span>}
                  {m.hasVision && <span className="model-tag vision">Vision</span>}
                  <span className={`model-tag memory-status`} style={{ color: ram === "fits" ? "var(--green)" : ram === "tight" ? "var(--yellow)" : "var(--red)" }}>
                    {ram === "fits" ? "Fits RAM" : ram === "tight" ? "Tight" : "Too large"}
                  </span>
                </div>
              </div>
            </div>

            {isStarting && (
              <div className="model-card-progress">
                <div className="model-card-progress-bar">
                  <div className="model-card-progress-fill" style={{ width: "0%" }} />
                </div>
                <div className="model-card-progress-info">
                  <span>Starting llama-server and loading model…</span>
                </div>
              </div>
            )}

            {isRunning && (
              <div className="model-card-status done">
                Running on port {active.port} · Ready to use
                {active.nGpuLayers > 0
                  ? ` · ${active.nGpuLayers} layer${active.nGpuLayers === 1 ? "" : "s"} on GPU`
                  : active.nGpuLayers === 0
                    ? " · CPU only"
                    : ""}
              </div>
            )}

            {err && (
              <div className="model-card-status error">{err}</div>
            )}

            <div className="model-card-actions">
              {isRunning ? (
                <button
                  className="primary danger"
                  onClick={() => void handleStop()}
                  disabled={loading}
                >
                  Stop server
                </button>
              ) : (
                <button
                  className="primary"
                  onClick={() => void handleUseModel(m)}
                  disabled={isStarting || loading || ram === "too_large"}
                >
                  {isStarting ? "Starting…" : "Use this model"}
                </button>
              )}
            </div>

            {ram !== "fits" && (
              <div className="model-card-desc">
                {ram === "tight" ? "⚠️ May run slowly with current RAM" : "❌ Requires more RAM than available"}
              </div>
            )}

            <details className="model-advanced">
              <summary>Advanced</summary>
              <div className="model-advanced-fields">
                <label>
                  -ngl
                  <input
                    type="number"
                    placeholder="auto"
                    value={overrides.ngl ?? ""}
                    onChange={(e) =>
                      setAdvanced((prev) => ({
                        ...prev,
                        [m.id]: { ...prev[m.id], ngl: e.target.value ? Number(e.target.value) : undefined },
                      }))
                    }
                  />
                </label>
                <label>
                  -c
                  <input
                    type="number"
                    placeholder="auto"
                    value={overrides.ctx ?? ""}
                    onChange={(e) =>
                      setAdvanced((prev) => ({
                        ...prev,
                        [m.id]: { ...prev[m.id], ctx: e.target.value ? Number(e.target.value) : undefined },
                      }))
                    }
                  />
                </label>
              </div>
            </details>
          </div>
        );
      })}
      </div>
      <details className="model-advanced local-compaction-advanced">
        <summary>Compaction (advanced)</summary>
        <LocalCompactionControls />
      </details>
      </>
      )}
      {tab === "market" && (
        <ModelMarket onDownloadComplete={() => void runScan()} localModels={models} />
      )}
    </>
  );
}

/** Context-compaction controls for local-GGUF sessions. These tune when the
 *  framework summarizes older turns before a small context window overflows.
 *  Defaults and clamping mirror the Rust loader in chat/compaction.rs. */
function LocalCompactionControls() {
  const threshold = useSettingsStore((s) => s.localCompactionThreshold);
  const pin = useSettingsStore((s) => s.localPinExchanges);
  const setThreshold = useSettingsStore((s) => s.setLocalCompactionThreshold);
  const setPin = useSettingsStore((s) => s.setLocalPinExchanges);
  return (
    <div className="model-advanced-fields">
      <label>
        Threshold
        <input
          type="number"
          min={0.25}
          max={0.99}
          step={0.05}
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
        />
        <span className="local-compaction-hint">
          fraction of the context window that triggers compaction (default 0.75)
        </span>
      </label>
      <label>
        Pin exchanges
        <input
          type="number"
          min={1}
          max={50}
          step={1}
          value={pin}
          onChange={(e) => setPin(Math.floor(Number(e.target.value)))}
        />
        <span className="local-compaction-hint">
          recent user+assistant pairs kept verbatim (default 6)
        </span>
      </label>
    </div>
  );
}

const K_SYSTEM_PROMPT = "assistant.systemPrompt";
const K_COMMIT_PROVIDER = "commitMessage.provider";
const K_COMMIT_MODEL = "commitMessage.model";
const K_LOCAL_FOLDERS = "localModels.folders";

/** Assistant panel: the custom system prompt only. Skills live on disk in the
 *  harness skill directories and are managed via the Skills Library modal
 *  (surfaced in the chat `/` menu and injected on `/slug` invocation) — there
 *  is no per-assistant skill config here. */
function AssistantPanel() {
  const [systemPrompt, setSystemPrompt] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // false = row view, true = system prompt editor open.
  // Since the Assistant section now only has the system prompt, start expanded.
  const [detailOpen, setDetailOpen] = useState(true);

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
    if (!loaded) return;
    const t = setTimeout(() => {
      void setSetting(K_SYSTEM_PROMPT, systemPrompt);
      setSavedAt(Date.now());
    }, 500);
    return () => clearTimeout(t);
  }, [systemPrompt, loaded]);

  return (
    <>
      <div className="panel-head">
        <h3>Assistant</h3>
        {savedAt && <span className="panel-count">saved ✓</span>}
      </div>

      <div className="skills-section">
        <SystemPromptDetail
          content={systemPrompt}
          onChange={setSystemPrompt}
          onBack={() => setDetailOpen(false)}
        />
      </div>
    </>
  );
}

/** Version control settings: the utility model used to auto-generate commit
 *  messages in the commit modal (a fast/cheap model, independent of the chat
 *  assistant). Stored as a provider+model pair because API keys resolve
 *  per-provider. */
function GitPanel() {
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
        <h3>Commit message model</h3>
        <span className="panel-count">Version control</span>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Commit message model</div>
        <p className="settings-section-hint">
          The model used to auto-generate commit messages in the commit modal. Pick a
          small/fast model (e.g. <code>gpt-4o-mini</code>, <code>claude-haiku</code>) for
          near-instant suggestions. Leave blank to use the active chat model.
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
    </>
  );
}


/** System prompt detail view — styled like a skill detail but for the global
 *  system prompt that is sent on every turn. */
function SystemPromptDetail({
  content,
  onChange,
  onBack,
}: {
  content: string;
  onChange: (text: string) => void;
  onBack: () => void;
}) {
  return (
    <div className="skill-detail">
      <div className="skill-detail-head">
        <button type="button" className="skill-detail-back" onClick={onBack} aria-label="Back to assistant">
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
          <span>Assistant</span>
        </button>
      </div>

      <div className="skill-detail-meta">
        <div className="skill-detail-title-row">
          <span className="skill-detail-name" style={{ fontSize: 16, fontWeight: 600 }}>
            <span style={{ marginRight: 8 }}>⚙</span>
            Custom system prompt
          </span>
        </div>
        <div className="skill-detail-sub">Sent on every chat turn</div>
      </div>

      <div className="skill-detail-content">
        <label className="skill-detail-label">System prompt</label>
        <textarea
          className="assistant-textarea"
          value={content}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. You are a concise, senior technical writer…"
          rows={32}
        />
      </div>
    </div>
  );
}

/** Compact summary grid of all providers that have a saved key, shown at
 *  the top of the API Keys panel. Clicking a card selects that provider in
 *  the form below. */
function SavedProvidersGrid({
  saved,
  activeProvider,
  onPick,
  onEdit,
  onDelete,
}: {
  saved: Record<string, ChatConfigPayload> | null;
  activeProvider: ChatProvider;
  onPick: (p: ChatProvider) => void;
  onEdit: (p: ChatProvider) => void;
  onDelete: (p: ChatProvider) => void;
}) {
  const LABELS: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    openrouter: "OpenRouter",
    anthropic_compatible: "Anthropic Compatible",
    openai_compatible: "OpenAI Compatible",
  };
  if (!saved) return <div className="hint">Loading providers…</div>;
  const entries = Object.entries(saved).filter(
    ([, cfg]) => cfg.hasKey,
  );
  if (entries.length === 0)
    return (
      <div className="hint" style={{ marginBottom: 12 }}>
        No API keys saved yet — pick a provider and enter a key above.
      </div>
    );
  return (
    <div className="saved-providers-grid" style={{ marginBottom: 12 }}>
      {entries.map(([id, cfg]) => {
        const isActive = id === activeProvider;
        const isCompatible =
          id === "anthropic_compatible" || id === "openai_compatible";
        return (
          <button
            key={id}
            type="button"
            className={`saved-provider-card ${isActive ? "active" : ""}`}
            onClick={() => onPick(id as ChatProvider)}
          >
            <div className="saved-provider-name-row">
              <span className="saved-provider-name">{LABELS[id]}</span>
              <span className="saved-provider-actions">
                <button
                  type="button"
                  className="saved-provider-icon"
                  title="Edit"
                  aria-label={`Edit ${LABELS[id]}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(id as ChatProvider);
                  }}
                >
                  <Pencil size={13} />
                </button>
                <button
                  type="button"
                  className="saved-provider-icon danger"
                  title="Delete"
                  aria-label={`Delete ${LABELS[id]}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(id as ChatProvider);
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </span>
            </div>
            <div className="saved-provider-meta">
              {isCompatible && cfg.baseUrl && (
                <span
                  className="saved-provider-url"
                  title={cfg.baseUrl}
                >
                  {cfg.baseUrl.length > 36
                    ? cfg.baseUrl.slice(0, 33) + "…"
                    : cfg.baseUrl}
                </span>
              )}
            </div>
            <div className="saved-provider-key">
              <span className="key-dot" aria-label="API key present" />
              Key saved
            </div>
          </button>
        );
      })}
    </div>
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
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<Array<{ id: string; object: string; created: number; ownedBy: string }>>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);

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
    const results = await Promise.all(ids.map((id) => getChatConfig(id)));
    const out: Record<string, ChatConfigPayload> = {};
    ids.forEach((id, i) => {
      if (results[i]) out[id] = results[i]!;
    });
    setSavedProviders(out);
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
  // for the currently selected provider.
  useEffect(() => {
    if (config?.provider === provider) {
      setBaseUrl(config.baseUrl ?? "");
      setModel(config.model ?? "");
    }
  }, [config, provider]);

  // When the user switches provider, load that provider's config so hasKey
  // is always accurate for the selected provider. Fields are pre-filled by
  // the config effect above when the response arrives.
  const onProviderChange = (v: ChatProvider) => {
    setProvider(v);
    setApiKey("");
    setFetchedModels([]);
    setFetchError(null);
    void loadConfigFn(v);
  };

  const handleFetchModels = async () => {
    if (!canFetchModels) return;
    setFetchingModels(true);
    setFetchError(null);
    setFetchedModels([]);
    try {
      const models = await listChatModels(
        provider,
        baseUrl.trim() || undefined,
        apiKey.trim() || undefined,
      );
      if (models && models.length > 0) {
        setFetchedModels(models);
      } else {
        setFetchError("No models returned. The provider may not support model listing.");
      }
    } catch (e: any) {
      setFetchError(e?.message || String(e));
    }
    setFetchingModels(false);
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
      setFetchError("Saved successfully!");
      setTimeout(() => setFetchError(null), 3000);
      await refreshSavedProviders();
    } catch (e: any) {
      setFetchError(e?.message || String(e));
    }
    setSaving(false);
  };

  const handleClear = async () => {
    await clearApiKeyFn(provider);
    setApiKey("");
    setBaseUrl("");
    setModel("");
    setFetchedModels([]);
    setFetchError(null);
    await loadConfigFn(provider);
    await refreshSavedProviders();
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

  return (
    <>
      <div className="panel-head">
        <h3>Chat API Keys</h3>
      </div>
      <SavedProvidersGrid
        saved={savedProviders}
        activeProvider={provider}
        onPick={(p) => onProviderChange(p)}
        onEdit={(p) => onProviderChange(p)}
        onDelete={async (p) => {
          // Delete = same as clear (removes the key from the keychain +
          // clears stored base URL/model). If we're deleting the currently
          // selected provider, also reset the form fields.
          await clearApiKeyFn(p);
          if (p === provider) {
            setApiKey("");
            setBaseUrl("");
            setModel("");
            setFetchedModels([]);
            setFetchError(null);
            await loadConfigFn(p);
          }
          await refreshSavedProviders();
        }}
      />
      <div className="form-row">
        <label>Provider</label>
        <GlassSelect<ChatProvider>
          value={provider}
          options={[
            { value: "anthropic", label: "Anthropic" },
            { value: "openai", label: "OpenAI" },
            { value: "openrouter", label: "OpenRouter" },
            { value: "anthropic_compatible", label: "Anthropic Compatible" },
            { value: "openai_compatible", label: "OpenAI Compatible" },
          ]}
          onChange={(v) => onProviderChange(v)}
        />
      </div>
      <div className="form-row">
        <label>API Key</label>
        <input
          type={showKey ? "text" : "password"}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={keyPlaceholder}
          style={{ flex: 1 }}
        />
        <button
          className="ghost"
          style={{ padding: "5px 8px" }}
          onClick={() => setShowKey((v) => !v)}
          title={showKey ? "Hide key" : "Show key"}
        >
          {showKey ? "🙈" : "👁"}
        </button>
      </div>
      {isCompatible && (
        <div className="form-row">
          <label>Base URL</label>
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
            style={{ flex: 1 }}
          />
          <button
            className="ghost"
            style={{ padding: "5px 12px", whiteSpace: "nowrap" }}
            onClick={handleFetchModels}
            disabled={fetchingModels || !baseUrl.trim()}
          >
            {fetchingModels ? "Fetching…" : "Fetch Models"}
          </button>
        </div>
      )}
      {isOpenRouter && (
        <div className="form-row">
          <label />
          <span className="hint" style={{ flex: 1 }}>
            Uses OpenRouter's endpoint (https://openrouter.ai/api). Save your
            key, then fetch the model catalogue.
          </span>
          <button
            className="ghost"
            style={{ padding: "5px 12px", whiteSpace: "nowrap" }}
            onClick={handleFetchModels}
            disabled={fetchingModels || (!apiKey.trim() && !hasExistingKey)}
          >
            {fetchingModels ? "Fetching…" : "Fetch Models"}
          </button>
        </div>
      )}
      {fetchError && (
        <div className="form-row">
          <label />
          <span style={{ color: "var(--state-error)", fontSize: 12 }}>
            {fetchError}
            <button
              className="ghost"
              style={{ padding: "2px 8px", marginLeft: 8, fontSize: 12 }}
              onClick={() => {
                setFetchError(null);
                setFetchedModels([]);
              }}
            >
              Use manual input
            </button>
          </span>
        </div>
      )}
      {fetchedModels.length > 0 && (
        <div className="form-row">
          <label>Model</label>
          <GlassSelect<string>
            value={model}
            options={fetchedModels.map((m) => ({ value: m.id, label: m.id }))}
            onChange={(v) => setModel(v)}
          />
        </div>
      )}
      {fetchedModels.length === 0 && (
        <div className="form-row">
          <label>Model</label>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="e.g. claude-sonnet-5"
            style={{ flex: 1 }}
          />
        </div>
      )}
      <div className="form-row" style={{ marginTop: 4 }}>
        <label />
        <button className="primary" onClick={handleSave} disabled={!canSave || saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button onClick={handleClear} disabled={!apiKey && !config?.provider}>
          Clear
        </button>
      </div>
    </>
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

  return (
    <>
      <div className="panel-head">
        <h3>Connectors</h3>
      </div>
      <p className="estimate-note">
        Connect a third-party account once and its tools (search, read, create,
        send) become available in every conversation automatically — the model
        picks the right connector when a task needs it. Read actions always
        auto-run; write/create/delete/send actions follow the conversation&apos;s
        approval mode (card in Manual / Read Only, auto-run in Auto-Edit and
        Full Auto).
      </p>
      <div className="skill-list">
        {families.map((f) => {
          const connectedCount = f.members.filter(
            (c) => c.status.connected && !c.status.expired
          ).length;
          const allConnected = connectedCount === f.members.length;
          const familyLabel =
            connectedCount === 0
              ? "Not connected"
              : allConnected
                ? `All ${f.members.length} connected`
                : `${connectedCount} of ${f.members.length} connected`;
          const single = f.members.length === 1;
          const isConnecting =
            connecting === f.family || (single && connecting === f.members[0].id);
          const connect = () =>
            single ? handleConnect(f.members[0].id) : handleConnectFamily(f.family);
          const openModal = () => setModalFamily(f.family);
          return (
            <div className="skill-card connector-card connector-family-card" key={f.family}>
              <div
                className="connector-card-main connector-family-head"
                role="button"
                tabIndex={0}
                onClick={openModal}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openModal();
                  }
                }}
                title={single ? undefined : "Click to view every product"}
              >
                <div className="connector-card-icon connector-family-icon">
                  <FamilyIcon family={f.family} size={40} />
                </div>
                <div className="connector-card-info">
                  <div className="connector-card-title-row">
                    <strong className="connector-card-title">{f.name}</strong>
                  </div>
                  {f.members.length > 1 && (
                    <div className="connector-member-chips">
                      {f.members.slice(0, 4).map((c) => {
                        const on = c.status.connected && !c.status.expired;
                        return (
                          <span
                            className={`connector-member-chip${on ? "" : " off"}`}
                            key={c.id}
                            title={c.displayName}
                          >
                            {ConnectorIcon({ id: c.id, size: 16 }) ?? (
                              <span className="connector-fallback-icon">{c.icon}</span>
                            )}
                          </span>
                        );
                      })}
                      {f.members.length > 4 && (
                        <span className="connector-more">+{f.members.length - 4} more</span>
                      )}
                    </div>
                  )}
                </div>
                <div className="connector-family-side">
                  <span className="connector-family-count">{familyLabel}</span>
                  {!allConnected && (
                    <button
                      className="primary"
                      disabled={isConnecting}
                      onClick={(e) => {
                        e.stopPropagation();
                        connect();
                      }}
                    >
                      {isConnecting ? "Authorizing…" : single ? "Connect" : "Connect all"}
                    </button>
                  )}
                </div>
              </div>
              {note?.id === f.family && (
                <div className="connector-note connector-family-note">{note.text}</div>
              )}
            </div>
          );
        })}
        {(connectors ?? []).length === 0 && (
          <div className="empty-reserved">No connectors available.</div>
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
          <div className="connector-modal-list">
            {openFam.members.map((c) => {
              const st = c.status;
              const statusLabel = st.connected && st.expired ? "Token expired" : "Not connected";
              const isConnecting = connecting === c.id;
              const isBusy = busy === c.id;
              const canConnect = openFam.members.length === 1;
              return (
                <div className="connector-sub-row" key={c.id}>
                  <div className="connector-sub-icon">
                    {ConnectorIcon({ id: c.id, size: 20 }) ?? (
                      <span className="connector-fallback-icon">{c.icon}</span>
                    )}
                  </div>
                  <div className="connector-card-info">
                    <div className="connector-card-title-row">
                      <strong className="connector-card-title">{c.displayName}</strong>
                      {(!st.connected || st.expired) && (
                        <span
                          className={`connector-status${st.expired ? " expired" : ""}${st.connected ? " ok" : ""}`}
                        >
                          {statusLabel}
                        </span>
                      )}
                    </div>
                    {note?.id === c.id && <div className="connector-note">{note.text}</div>}
                  </div>
                  <div className="connector-sub-action">
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
              <div className="connector-note">{note.text}</div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

/** Numeric input bound to an app_settings key; loads on mount, saves on blur. */
function RateField({ settingsKey, fallback }: { settingsKey: string; fallback: string }) {
  const [value, setValue] = useState(fallback);
  useEffect(() => {
    void getSetting(settingsKey).then((v) => {
      if (v !== null && v !== "") setValue(v);
    });
  }, [settingsKey]);
  return (
    <input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        const n = parseFloat(value);
        if (!Number.isNaN(n) && n >= 0) void setSetting(settingsKey, value);
        else setValue(fallback);
      }}
      inputMode="decimal"
    />
  );
}

// ---- Data (chat DB + artifacts storage + delete) ----

function fmtSize(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(1)} KB`;
  return `${bytes} B`;
}

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
      </div>

      {note && <div className="settings-note">{note}</div>}

      {/* Backup / Restore — roadmap #7 local-first backup story */}
      <div className="settings-form-row" style={{ alignItems: "flex-start" }}>
        <label className="settings-form-label">Backup</label>
        <div className="settings-form-control" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
            Export a project's chats (messages + artifacts) to a <code>.zip</code>,
            or restore a previous backup. Imported chats are added fresh — an
            existing chat is never overwritten.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <select
              value={selectedProjectForBackup ?? ""}
              onChange={(e) => setSelectedProjectForBackup(e.target.value || null)}
              style={{ maxWidth: 220 }}
            >
              <option value="">Select project…</option>
              {(backupProjects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              className="ghost"
              onClick={() => void handleBackupProject()}
              disabled={backupBusy !== null || !selectedProjectForBackup}
            >
              {backupBusy === "backup" ? "Exporting…" : "Back up project"}
            </button>
            <button className="ghost" onClick={() => void handleRestore()} disabled={backupBusy === "restore"}>
              {backupBusy === "restore" ? "Restoring…" : "Restore from backup"}
            </button>
          </div>
        </div>
      </div>

      {/* Chat database location */}
      <div className="settings-form-row" style={{ alignItems: "flex-start" }}>
        <label className="settings-form-label">Chats (database)</label>
        <div className="settings-form-control" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
          <div className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
            {paths?.chatDbPath ?? "…"}
            {paths ? ` (${fmtSize(paths.chatDbSize)})` : ""}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="ghost" onClick={pickDbDir} disabled={busy}>
              Change…
            </button>
            <button className="ghost" onClick={resetDbDir} disabled={busy}>
              Reset to default
            </button>
          </div>
        </div>
      </div>

      {/* Artifacts location */}
      <div className="settings-form-row" style={{ alignItems: "flex-start" }}>
        <label className="settings-form-label">Artifacts</label>
        <div className="settings-form-control" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
          <div className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
            {paths?.artifactsDir ?? "…"}
            {paths ? ` (${fmtSize(paths.artifactsSize)})` : ""}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="ghost" onClick={pickArtifactsDir}>
              Change…
            </button>
            <button className="ghost" onClick={resetArtifactsDir}>
              Reset to default
            </button>
          </div>
        </div>
      </div>

      {/* Delete */}
      <div className="settings-form-row" style={{ alignItems: "flex-start" }}>
        <label className="settings-form-label">Delete</label>
        <div className="settings-form-control" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
            Permanently delete all chat sessions and their messages, or all
            generated artifacts. This cannot be undone.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
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
