// Settings view: theme (§7.2), remappable keybindings (§7.6), Do Not Disturb
// (§7.13), and harness install/auth status with "Run login" buttons (§9).
// Organised as a left-nav of four categories so the long pricing table does
// not bury the short appearance/shortcut sections. Every panel reserves a
// fixed min-height (see .settings-split / .empty-reserved) so switching
// categories — or an empty harness list — does not reflow the modal.
import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getSetting, readFileText, setSetting, type ChatProvider, listChatModels } from "../../lib/ipc";
import { acceleratorFromEvent, DEFAULT_KEYBINDINGS, type KeybindingAction } from "../../lib/keybindings";
import { runLoginFlow } from "../../lib/sessionLauncher";
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
  | "apikeys";

const CATEGORIES: Array<{ key: Category; label: string; sub: string }> = [
  { key: "appearance", label: "Appearance", sub: "Theme, notifications" },
  { key: "assistant", label: "Assistant", sub: "System prompt & skills" },
  { key: "pricing", label: "Pricing", sub: "Per-model $/Mtok rates" },
  { key: "harnesses", label: "Harnesses", sub: "CLI install & login" },
  { key: "shortcuts", label: "Shortcuts", sub: "Remap keybindings" },
  { key: "apikeys", label: "API Keys", sub: "Chat provider keys" },
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
  const keybindings = useSettingsStore((s) => s.keybindings);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setDnd = useSettingsStore((s) => s.setDnd);
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
                  <div className="form-row">
                    <label>Theme</label>
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
                  <div className="form-row">
                    <label>Do Not Disturb</label>
                    <input type="checkbox" checked={dnd} onChange={(e) => setDnd(e.target.checked)} />
                    <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
                      Suppress OS notifications when agents finish (in-app badges still update)
                    </span>
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

              {category === "apikeys" && <ApiKeysPanel />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface SkillItem {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
}

const K_SYSTEM_PROMPT = "assistant.systemPrompt";
const K_SKILLS = "assistant.skills";

/** Assistant panel: a Claude-style custom system prompt plus reusable "skills"
 *  (named instruction snippets). Both persist through get_setting/set_setting
 *  and are injected into chat requests by the backend. The system prompt is
 *  debounce-saved; skills are saved on every edit. */
function AssistantPanel() {
  const [systemPrompt, setSystemPrompt] = useState("");
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let stale = false;
    void Promise.all([getSetting(K_SYSTEM_PROMPT), getSetting(K_SKILLS)]).then(
      ([sp, sk]) => {
        if (stale) return;
        setSystemPrompt(sp ?? "");
        if (sk) {
          try {
            const parsed = JSON.parse(sk) as SkillItem[];
            if (Array.isArray(parsed)) setSkills(parsed);
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
    persistSkills([
      ...skills,
      {
        id: `skill_${Date.now()}`,
        name: "",
        content: "",
        enabled: true,
      },
    ]);
  };

  // Parse a `name:` value out of a YAML frontmatter block (the same minimal
  // shape the backend's skill scanner reads). Returns null if there's no
  // frontmatter or no name field — caller then falls back to the filename.
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

  // Filename without extension + leading dir, e.g. "C:\x\docx-skill.md" -> "docx-skill".
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
      persistSkills([
        ...skills,
        { id: `skill_${Date.now()}`, name, content: text, enabled: true },
      ]);
    } catch (err) {
      console.warn("skill upload failed", err);
    }
  };

  const updateSkill = (id: string, patch: Partial<SkillItem>) => {
    persistSkills(skills.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  const removeSkill = (id: string) => {
    persistSkills(skills.filter((s) => s.id !== id));
  };

  return (
    <>
      <div className="panel-head">
        <h3>Assistant</h3>
        {savedAt && <span className="panel-count">saved ✓</span>}
      </div>
      <p className="estimate-note">
        The system prompt and any enabled skills are sent to the model on every
        chat turn (in addition to the built-in tool guidance). Use skills to
        capture reusable instructions — e.g. how to format a report, brand
        colours, or a slide-deck style — that the model applies when relevant.
      </p>

      <div className="form-row form-row-stack">
        <label>Custom system prompt</label>
        <textarea
          className="assistant-textarea"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="e.g. You are a concise, senior technical writer. Prefer clean, well-structured documents with a professional tone…"
          rows={6}
        />
      </div>

      <div className="panel-head" style={{ marginTop: 16 }}>
        <h3 style={{ fontSize: 14 }}>Skills</h3>
        <span style={{ display: "flex", gap: 6 }}>
          <button className="ghost" style={{ padding: "2px 8px" }} onClick={() => void uploadSkill()}>
            ↑ Upload .md
          </button>
          <button className="ghost" style={{ padding: "2px 8px" }} onClick={addSkill}>
            + Add skill
          </button>
        </span>
      </div>
      {skills.length === 0 ? (
        <div className="empty-reserved">
          <span className="empty-text">
            No skills yet. Add one to give the model reusable, on-demand
            instructions for generating documents, decks and more.
          </span>
        </div>
      ) : (
        <div className="skills-list">
          {skills.map((s) => (
            <div className="skill-card" key={s.id}>
              <div className="skill-card-head">
                <input
                  className="skill-name-input"
                  type="text"
                  value={s.name}
                  onChange={(e) => updateSkill(s.id, { name: e.target.value })}
                  placeholder="Skill name (e.g. Report style)"
                />
                <label className="skill-enable" title="Enable this skill">
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    onChange={(e) => updateSkill(s.id, { enabled: e.target.checked })}
                  />
                  <span>Enabled</span>
                </label>
                <button
                  className="ghost skill-remove"
                  title="Delete skill"
                  aria-label="Delete skill"
                  onClick={() => removeSkill(s.id)}
                >
                  ✕
                </button>
              </div>
              <textarea
                className="assistant-textarea"
                value={s.content}
                onChange={(e) => updateSkill(s.id, { content: e.target.value })}
                placeholder="Instructions the model should follow when this skill applies…"
                rows={4}
              />
            </div>
          ))}
        </div>
      )}
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
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<Array<{ id: string; object: string; created: number; ownedBy: string }>>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const isCompatible = provider === "anthropic_compatible" || provider === "openai_compatible";
  const hasExistingKey = config?.provider === provider && config?.hasKey;

  // Bootstrap: load config for the currently selected provider.
  useEffect(() => {
    void loadConfigFn(provider);
  }, [loadConfigFn, provider]);

  // Auto-fetch the model list once a base URL is set and a key is available
  // (typed in or already stored), debounced so we don't fire per keystroke.
  useEffect(() => {
    if (!isCompatible || !baseUrl.trim()) return;
    if (!apiKey.trim() && !hasExistingKey) return;
    const t = setTimeout(() => {
      void handleFetchModels();
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCompatible, baseUrl, apiKey, hasExistingKey, provider]);

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
    if (!isCompatible) return;
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
