// Extracted panel of SettingsView (see its header for context).
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  deleteDownloadedModel,
  detectGpuPower,
  exportProjectZip,
  getChatDbPath,
  getDataPaths,
  getSetting,
  importChatZip,
  listChatModels,
  listConnectors,
  connectorConnect,
  connectorConnectFamily,
  connectorDisconnect,
  listenOAuthCallback,
  setChatDbDir,
  setChatDefaultModel,
  setSetting,
  toastError,
  toastSuccess,
  type ChatProvider,
  getChatConfig,
  type ChatConfigPayload,
  type ConnectorWithStatus,
  type DataPaths,
  type GgufModel,
  type OAuthCallbackPayload,
  type SelectedModelEntry,
} from "../../lib/ipc";
import { runLoginFlow } from "../../lib/sessionLauncher";
import { useChatStore } from "../../state/chat";
import type { HarnessId } from "../../types";
import { useProjectsStore } from "../../state/projects";
import { useSettingsStore } from "../../state/settings";
import { useUiStore } from "../../state/ui";
import { GlassSelect } from "../common/GlassSelect";
import { Modal } from "../common/Modal";
import { ToggleSwitch } from "./ToggleSwitch";
import {
  Database,
  Eye,
  EyeOff,
  KeyRound,
  Plug,
  Plus,
  Pencil,
  Trash2,
} from "lucide-react";

export function ApiKeysPanel() {
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
