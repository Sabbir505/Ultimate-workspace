// Settings view: theme (§7.2), remappable keybindings (§7.6), Do Not Disturb
// (§7.13), and harness install/auth status with "Run login" buttons (§9).
// Organised as a left-nav of four categories so the long pricing table does
// not bury the short appearance/shortcut sections. Every panel reserves a
// fixed min-height (see .settings-split / .empty-reserved) so switching
// categories — or an empty harness list — does not reflow the modal.
import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getSetting, readFileText, setSetting, type ChatProvider, listChatModels, scanLocalModels, startLocalModel, stopLocalModel, localModelStatus, type GgufModel, type StartedModel, type ActiveLocalModel, listConnectors, connectorConnect, connectorDisconnect, listenOAuthCallback, type ConnectorWithStatus, type OAuthCallbackPayload } from "../../lib/ipc";
import { acceleratorFromEvent, DEFAULT_KEYBINDINGS, type KeybindingAction } from "../../lib/keybindings";
import { runLoginFlow } from "../../lib/sessionLauncher";
import { seededSkills } from "../../lib/defaultSkills";
import { slugifyCommand } from "../../lib/skillCommands";
import { useProjectsStore } from "../../state/projects";
import { useSettingsStore, type ThemeSetting } from "../../state/settings";
import { useUiStore } from "../../state/ui";
import { GlassSelect } from "../common/GlassSelect";
import { useChatStore } from "../../state/chat";

const ACTION_LABELS: Record<KeybindingAction, string> = {
  openPalette: "Open command palette",
  focusPane1: "Focus pane 1",
  focusPane2: "Focus pane 2",
  focusPane3: "Focus pane 3",
  focusPane4: "Focus pane 4",
  focusPane5: "Focus pane 5",
  focusPane6: "Focus pane 6",
  cyclePane: "Cycle pane focus",
  newSession: "New session in current project",
  closePane: "Close focused pane",
  toggleBroadcast: "Toggle broadcast mode",
  openSettings: "Open Settings",
  spotlightNext: "Cycle terminal pair forward (split layout)",
  spotlightPrev: "Cycle terminal pair backward (split layout)",
};

type Category =
  | "appearance"
  | "assistant"
  | "pricing"
  | "harnesses"
  | "shortcuts"
  | "localmodels"
  | "apikeys"
  | "connectors";

const CATEGORIES: Array<{ key: Category; label: string; sub: string }> = [
  { key: "appearance", label: "Appearance", sub: "Theme, notifications" },
  { key: "assistant", label: "Assistant", sub: "System prompt & skills" },
  { key: "pricing", label: "Pricing", sub: "Per-model $/Mtok rates" },
  { key: "harnesses", label: "Harnesses", sub: "CLI install & login" },
  { key: "shortcuts", label: "Shortcuts", sub: "Remap keybindings" },
  { key: "localmodels", label: "Local Models", sub: "GGUF via llama-server" },
  { key: "apikeys", label: "API Keys", sub: "Chat provider keys" },
  { key: "connectors", label: "Connectors", sub: "Notion & more (OAuth)" },
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
  const activeView = useUiStore((s) => s.activeView);
  const theme = useSettingsStore((s) => s.theme);
  const dnd = useSettingsStore((s) => s.dnd);
  const watchMode = useSettingsStore((s) => s.watchMode);
  const keybindings = useSettingsStore((s) => s.keybindings);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setDnd = useSettingsStore((s) => s.setDnd);
  const setWatchMode = useSettingsStore((s) => s.setWatchMode);
  const setKeybinding = useSettingsStore((s) => s.setKeybinding);
  const resetKeybindings = useSettingsStore((s) => s.resetKeybindings);
  const harnesses = useProjectsStore((s) => s.harnesses);
  const projects = useProjectsStore((s) => s.projects);
  const refreshHarnesses = useProjectsStore((s) => s.refreshHarnesses);

  const [recording, setRecording] = useState<KeybindingAction | null>(null);
  const [category, setCategory] = useState<Category>("appearance");

  return (
    <div className="view-overlay modal-centered" onPointerDown={(e) => e.target === e.currentTarget && setActiveView(activeView === "chat" ? "chat" : "grid")}>
      <div className="view-panel">
        <div className="view-header">
          <h2>Settings</h2>
          <button className="ghost" onClick={() => setActiveView(activeView === "chat" ? "chat" : "grid")}>
            ✕
          </button>
        </div>
        <div className="view-body">
          <div className="settings-split">
            <nav className="settings-nav">
              {CATEGORIES.map((c) => (
                <button
                  key={c.key}
                  className={`nav-item${category === c.key ? " active" : ""}`}
                  onClick={() => setCategory(c.key)}
                >
                  {c.label}
                  <span className="nav-sub">{c.sub}</span>
                </button>
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
                      <label className="settings-form-label">Watch mode</label>
                      <div className="settings-form-control">
                        <label className="settings-checkbox-row">
                          <input type="checkbox" checked={watchMode} onChange={(e) => setWatchMode(e.target.checked)} />
                          <span>Visual pacing for browser actions (~600ms delay) so you can follow what the agent is doing. Only applies when the browser pane is visible.</span>
                        </label>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {category === "assistant" && <AssistantPanel />}

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
                                    setActiveView(activeView === "chat" ? "chat" : "grid");
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

              {category === "shortcuts" && (
                <>
                  <div className="panel-head">
                    <h3>Keyboard shortcuts</h3>
                    <button className="ghost" onClick={resetKeybindings} style={{ padding: "2px 8px" }}>
                      Reset defaults
                    </button>
                  </div>
                  <p className="estimate-note">
                    “Mod” means Cmd on macOS and Ctrl elsewhere. Click a shortcut to remap it.
                  </p>
                  <table className="kv">
                    <tbody>
                      {(Object.keys(ACTION_LABELS) as KeybindingAction[]).map((action) => (
                        <tr key={action}>
                          <td>{ACTION_LABELS[action]}</td>
                          <td style={{ textAlign: "right" }}>
                            <button
                              className={`kbd-chip${recording === action ? " recording" : ""}`}
                              onClick={() => setRecording(action)}
                              onKeyDown={(e) => {
                                if (recording !== action) return;
                                e.preventDefault();
                                e.stopPropagation();
                                if (e.key === "Escape") {
                                  setRecording(null);
                                  return;
                                }
                                const accel = acceleratorFromEvent(e);
                                if (accel) {
                                  setKeybinding(action, accel);
                                  setRecording(null);
                                }
                              }}
                              onBlur={() => recording === action && setRecording(null)}
                            >
                              {recording === action ? "press keys…" : keybindings[action]}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
                    Defaults: {DEFAULT_KEYBINDINGS.openPalette} palette, {DEFAULT_KEYBINDINGS.closePane} close pane
                  </span>
                </>
              )}

              {category === "localmodels" && <LocalModelsPanel />}

              {category === "apikeys" && <ApiKeysPanel />}

              {category === "connectors" && <ConnectorsPanel />}
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

  const newChat = useChatStore((s) => s.newChat);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const sessions = useChatStore((s) => s.sessions);

  // Persist the list of user-added folders so they survive app restarts.
  const persistFolders = (next: string[]) => {
    setFolders(next);
    void setSetting(K_LOCAL_FOLDERS, JSON.stringify(next));
  };

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
      if (!stale) setLoaded(true);
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

  return (
    <>
      <div className="panel-head">
        <h3>Local Models</h3>
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
              setLoaded(false);
            }}
          >
            Rescan defaults
          </button>
        </div>
      </div>
      <p className="estimate-note">
        Llama-server must be installed separately (llama.cpp). Place .gguf files
        in ~/.cache/lm-studio/models, ~/Downloads, or any folder you add here.
      </p>

      {active && (
        <div style={{ padding: "8px 12px", background: "var(--surface)", borderRadius: 8, marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#4caf50", flexShrink: 0 }} />
          <span style={{ fontSize: 13 }}>
            Active: <strong>{active.modelId}</strong> on port {active.port}
          </span>
        </div>
      )}

      {nothing && (
        <div className="empty-reserved">
          <span className="empty-text">
            No .gguf models found. Place them in the LM Studio cache
            (~/.cache/lm-studio/models), your Downloads folder, or click "Add
            folder" to scan a custom location.
          </span>
        </div>
      )}

      {folders.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
          {folders.map((f) => (
            <span
              key={f}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "3px 8px", borderRadius: 12, fontSize: 11,
                background: "var(--surface)", color: "var(--text-dim)",
                maxWidth: "100%",
              }}
              title={f}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {f}
              </span>
              <button
                className="ghost"
                style={{ padding: 0, fontSize: 12, lineHeight: 1, color: "var(--text-dim)" }}
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

      {models.map((m) => {
        const mc = MEMORY_LABELS[m.memoryClass] ?? MEMORY_LABELS.tight;
        const err = errors[m.id];
        const overrides = advanced[m.id] ?? {};
        const isStarting = starting[m.id];
        return (
          <div key={m.id} className="skill-card">
            <div className="skill-card-head" style={{ alignItems: "flex-start", gap: 8 }}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: mc.color, flexShrink: 0, marginTop: 4 }} title={mc.text} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, wordBreak: "break-all" }}>
                  {m.name || m.filename}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
                  {humanSize(m.sizeBytes)}
                  {m.paramCountLabel && ` · ${m.paramCountLabel}`}
                  {m.quantization && ` · ${m.quantization}`}
                  {m.architecture && ` · ${m.architecture}`}
                  {" · "}{m.source}
                </div>
                {m.hasVision && (
                  <div style={{ fontSize: 11, color: "var(--accent)", marginTop: 2 }}>
                    👁 Vision capable
                  </div>
                )}
                <div style={{ fontSize: 11, color: mc.color, marginTop: 2 }}>
                  {mc.text}
                </div>
              </div>
              <button
                className="ghost"
                style={{ padding: "4px 12px", whiteSpace: "nowrap", flexShrink: 0 }}
                onClick={() => void handleUseModel(m)}
                disabled={isStarting || loading}
              >
                {isStarting ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span className="local-spinner" /> Loading…
                  </span>
                ) : (
                  "Use this model"
                )}
              </button>
            </div>
            {isStarting && (
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6, display: "flex", alignItems: "center", gap: 6 }}>
                <span className="local-spinner" />
                Starting llama-server and loading the model onto your GPU. This can take 5–20s for larger models.
              </div>
            )}
            {err && (
              <div style={{ fontSize: 11, color: "#f44336", marginTop: 6 }}>
                Couldn't load this model: {err}
              </div>
            )}
            <details style={{ marginTop: 6, fontSize: 12 }}>
              <summary style={{ cursor: "pointer", color: "var(--text-dim)" }}>Advanced</summary>
              <div style={{ display: "flex", gap: 12, marginTop: 6 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  -ngl
                  <input
                    type="number"
                    style={{ width: 60, padding: "2px 4px" }}
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
                <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  -c
                  <input
                    type="number"
                    style={{ width: 80, padding: "2px 4px" }}
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
    </>
  );
}

interface SkillItem {
  id: string;
  name: string;
  /** Short slash token that invokes the skill in chat (`/docx`). Optional —
   *  falls back to the slugified name when unset. */
  command?: string;
  content: string;
  enabled: boolean;
  /** Who created this skill — "Anthropic" for built-ins, "You" for user-added. */
  author?: string;
  /** ISO date string (YYYY-MM-DD) of last update. */
  updatedAt?: string;
  /** One-line description extracted from frontmatter or user input. */
  description?: string;
}

const K_SYSTEM_PROMPT = "assistant.systemPrompt";
const K_SKILLS = "assistant.skills";
const K_LOCAL_FOLDERS = "localModels.folders";

/** Assistant panel: Claude-style skills manager. A table of skills with
 *  search/browse/add, and a detail view for editing/previewing each skill.
 *  The custom system prompt lives above the skills table. */
function AssistantPanel() {
  const [systemPrompt, setSystemPrompt] = useState("");
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // Detail view: null = table view, string = skill id being viewed
  const [detailId, setDetailId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let stale = false;
    void Promise.all([getSetting(K_SYSTEM_PROMPT), getSetting(K_SKILLS)]).then(
      ([sp, sk]) => {
        if (stale) return;
        setSystemPrompt(sp ?? "");
        if (sk == null) {
          const seeded = seededSkills();
          setSkills(seeded);
          void setSetting(K_SKILLS, JSON.stringify(seeded));
        } else {
          try {
            const parsed = JSON.parse(sk) as SkillItem[];
            if (Array.isArray(parsed)) {
              // Migrate old skills without author/updatedAt
              const migrated = parsed.map((s) => ({
                ...s,
                author: s.author ?? "You",
                updatedAt: s.updatedAt ?? new Date().toISOString().split("T")[0],
              }));
              setSkills(migrated);
            }
          } catch {
            /* corrupt setting — start empty */
          }
        }
        setLoaded(true);
      },
    );
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

  const persistSkills = (next: SkillItem[]) => {
    setSkills(next);
    void setSetting(K_SKILLS, JSON.stringify(next));
    setSavedAt(Date.now());
  };

  const addSkill = () => {
    const today = new Date().toISOString().split("T")[0];
    const newSkill: SkillItem = {
      id: `skill_${Date.now()}`,
      name: "",
      content: "",
      enabled: true,
      author: "You",
      updatedAt: today,
      description: "",
    };
    persistSkills([...skills, newSkill]);
    setDetailId(newSkill.id);
  };

  // Parse description out of a YAML frontmatter block.
  const descriptionFromFrontmatter = (text: string): string | undefined => {
    const lines = text.split(/\r?\n/);
    if (lines[0]?.trim() !== "---") return undefined;
    for (let i = 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t === "---") break;
      const m = t.match(/^description:\s*["']?(.+?)["']?\s*$/);
      if (m) return m[1].trim();
    }
    return undefined;
  };

  // Parse a `name:` value out of a YAML frontmatter block.
  const nameFromFrontmatter = (text: string): string | null => {
    const lines = text.split(/\r?\n/);
    if (lines[0]?.trim() !== "---") return null;
    for (let i = 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t === "---") break;
      const m = t.match(/^name:\s*(.*)$/);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "").trim();
    }
    return null;
  };

  const stemFromPath = (p: string): string => {
    const base = p.split(/[\\/]/).pop() ?? p;
    return base.replace(/\.[^.]+$/, "");
  };

  const uploadSkill = async () => {
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
        title: "Upload skill (.md)",
      });
      if (typeof picked !== "string" || !picked) return;
      const text = (await readFileText(picked)) ?? "";
      if (!text) return;
      const name = nameFromFrontmatter(text) || stemFromPath(picked);
      const description = descriptionFromFrontmatter(text);
      const today = new Date().toISOString().split("T")[0];
      const newSkill: SkillItem = {
        id: `skill_${Date.now()}`,
        name,
        content: text,
        enabled: true,
        author: "You",
        updatedAt: today,
        description,
      };
      persistSkills([...skills, newSkill]);
    } catch (err) {
      console.warn("skill upload failed", err);
    }
  };

  const updateSkill = (id: string, patch: Partial<SkillItem>) => {
    const next = skills.map((s) =>
      s.id === id
        ? { ...s, ...patch, updatedAt: new Date().toISOString().split("T")[0] }
        : s,
    );
    persistSkills(next);
  };

  const removeSkill = (id: string) => {
    persistSkills(skills.filter((s) => s.id !== id));
    if (detailId === id) setDetailId(null);
  };

  const filtered = search.trim()
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(search.toLowerCase()) ||
          (s.description ?? "").toLowerCase().includes(search.toLowerCase()) ||
          (s.author ?? "").toLowerCase().includes(search.toLowerCase()),
      )
    : skills;

const SYSTEM_PROMPT_ID = "_system_prompt";

  const detailSkill = detailId
    ? detailId === SYSTEM_PROMPT_ID
      ? null
      : skills.find((s) => s.id === detailId) ?? null
    : null;
  const isSystemPromptDetail = detailId === SYSTEM_PROMPT_ID;

  return (
    <>
      <div className="panel-head">
        <h3>Assistant</h3>
        {savedAt && <span className="panel-count">saved ✓</span>}
      </div>

      {/* Skills section */}
      <div className="skills-section">
        {isSystemPromptDetail ? (
          <SystemPromptDetail
            content={systemPrompt}
            onChange={setSystemPrompt}
            onBack={() => setDetailId(null)}
          />
        ) : detailSkill ? (
          <SkillDetail
            skill={detailSkill}
            onBack={() => setDetailId(null)}
            onUpdate={(patch) => updateSkill(detailSkill.id, patch)}
            onDelete={() => removeSkill(detailSkill.id)}
          />
        ) : (
          <>
            <div className="skills-header">
              <h4>Skills</h4>
              <div className="skills-header-actions">
                <div className="skills-search">
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
                    <circle cx="11" cy="11" r="7" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    type="text"
                    placeholder="Search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <button className="skills-btn-browse" onClick={() => setSearch("")}>
                  Browse
                </button>
                <div className="skills-add-wrap">
                  <button className="skills-btn-add" onClick={addSkill}>
                    Add <span className="skills-add-chevron">▼</span>
                  </button>
                </div>
              </div>
            </div>

            <div className="skills-table">
              <div className="skills-table-head">
                <span className="skills-col-name">Skill</span>
                <span className="skills-col-date">Last updated</span>
                <span className="skills-col-author">Author</span>
              </div>
              <div className="skills-table-body">
                {/* System prompt — always first row */}
                <button
                  type="button"
                  className="skills-table-row system-prompt-row"
                  onClick={() => setDetailId(SYSTEM_PROMPT_ID)}
                >
                  <span className="skills-col-name">
                    <span className="skills-row-icon">⚙</span>
                    Custom system prompt
                  </span>
                  <span className="skills-col-date">—</span>
                  <span className="skills-col-author">
                    <span className="skills-author-badge">You</span>
                  </span>
                </button>

                {filtered.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="skills-table-row"
                    onClick={() => setDetailId(s.id)}
                  >
                    <span className="skills-col-name">{s.name || "Untitled skill"}</span>
                    <span className="skills-col-date">{s.updatedAt ?? "—"}</span>
                    <span className="skills-col-author">
                      <span className={`skills-author-badge${s.author === "Anthropic" ? " built-in" : ""}`}>
                        {s.author ?? "You"}
                      </span>
                    </span>
                  </button>
                ))}

                {skills.length === 0 && (
                  <div className="skills-table-empty">
                    No skills yet. Add one to give the model reusable instructions.
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

/** Skill detail view: shows the skill's full content with an enable toggle,
 *  back button, and inline editing for name/description/content. */
function SkillDetail({
  skill,
  onBack,
  onUpdate,
  onDelete,
}: {
  skill: SkillItem;
  onBack: () => void;
  onUpdate: (patch: Partial<SkillItem>) => void;
  onDelete: () => void;
}) {
  return (
    <div className="skill-detail">
      <div className="skill-detail-head">
        <button type="button" className="skill-detail-back" onClick={onBack} aria-label="Back to skills">
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
          <span>Skills</span>
        </button>
      </div>

      <div className="skill-detail-meta">
        <div className="skill-detail-title-row">
          <input
            className="skill-detail-name-input"
            type="text"
            value={skill.name}
            onChange={(e) => onUpdate({ name: e.target.value })}
            placeholder="Skill name"
          />
          <div className="skill-detail-actions">
            <label className="skill-detail-toggle" title="Enable this skill">
              <input
                type="checkbox"
                checked={skill.enabled}
                onChange={(e) => onUpdate({ enabled: e.target.checked })}
              />
              <span className="skill-toggle-track">
                <span className="skill-toggle-thumb" />
              </span>
            </label>
            <button
              type="button"
              className="skill-detail-menu-btn"
              title="Delete skill"
              aria-label="Delete skill"
              onClick={onDelete}
            >
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          </div>
        </div>
        <div className="skill-detail-sub">
          by {skill.author ?? "You"}
        </div>
      </div>

      <div className="skill-detail-command">
        <label className="skill-detail-label">Slash command</label>
        <div className="skill-command-field">
          <span className="skill-command-slash">/</span>
          <input
            type="text"
            value={skill.command ?? ""}
            onChange={(e) =>
              onUpdate({
                command: e.target.value.replace(/^\/+/, "").trim(),
              })
            }
            placeholder={slugifyCommand(skill.name) || "command"}
            spellCheck={false}
          />
        </div>
      </div>

      <div className="skill-detail-description">
        <textarea
          className="assistant-textarea"
          value={skill.description ?? ""}
          onChange={(e) => onUpdate({ description: e.target.value })}
          placeholder="One-line description of what this skill does…"
          rows={2}
        />
      </div>

      <div className="skill-detail-content">
        <label className="skill-detail-label">Skill instructions</label>
        <textarea
          className="assistant-textarea"
          value={skill.content}
          onChange={(e) => onUpdate({ content: e.target.value })}
          placeholder="Instructions the model should follow when this skill applies…"
          rows={12}
        />
      </div>
    </div>
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
        <button type="button" className="skill-detail-back" onClick={onBack} aria-label="Back to skills">
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
          <span>Skills</span>
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
          rows={16}
        />
      </div>
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
      <div className="api-config-summary">
        <strong>Current configuration</strong>
        {config?.provider === provider ? (
          <div className="hint">
            API key: {config.hasKey ? "saved ✓" : "not set"}
            {isCompatible && <> · Base URL: {config.baseUrl || "not set"}</>}
            {" · Model: "}
            {config.model || "not set"}
          </div>
        ) : (
          <div className="hint">Loading…</div>
        )}
      </div>
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

  return (
    <>
      <div className="panel-head">
        <h3>Connectors</h3>
      </div>
      <p className="estimate-note">
        Connect a third-party account once, then attach it per conversation from
        the chat composer. Attached connectors expose the vendor&apos;s tools
        (search, read, create) for that conversation only. Write/create/delete
        actions always require a per-action approval, regardless of permission mode.
      </p>
      <div className="skill-list">
        {(connectors ?? []).map((c) => {
          const st = c.status;
          const statusLabel = !st.connected
            ? "Not connected"
            : st.expired
              ? "Token expired"
              : st.accountDisplay
                ? `Connected as ${st.accountDisplay}`
                : "Connected";
          const isConnecting = connecting === c.id;
          const isBusy = busy === c.id;
          return (
            <div className="skill-card" key={c.id}>
              <div className="skill-card-head">
                <strong>
                  <span className="connector-icon" aria-hidden>{c.icon}</span>{" "}
                  {c.displayName}
                </strong>
                <span className={`connector-status${st.expired ? " expired" : ""}${st.connected ? " ok" : ""}`}>
                  {statusLabel}
                </span>
              </div>
              {st.grantedScopes && (
                <div className="connector-scopes">
                  <span className="muted">Scopes:</span> {st.grantedScopes}
                </div>
              )}
              {note?.id === c.id && (
                <div className="connector-note">{note.text}</div>
              )}
              <div className="skill-card-actions">
                {st.connected ? (
                  <button
                    className="ghost"
                    disabled={isBusy}
                    onClick={() => void handleDisconnect(c.id)}
                  >
                    {isBusy ? "Disconnecting…" : "Disconnect"}
                  </button>
                ) : (
                  <button
                    className="primary"
                    disabled={isConnecting}
                    onClick={() => handleConnect(c.id)}
                  >
                    {isConnecting ? "Authorizing…" : "Connect"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {(connectors ?? []).length === 0 && (
          <div className="empty-reserved">No connectors available.</div>
        )}
      </div>
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
