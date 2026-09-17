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
  listChatInstances,
  providerKindOf,
  type ChatInstancePayload,
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
  Tag,
  Trash2,
} from "lucide-react";

export function ApiKeysPanel() {
  const config = useChatStore((s) => s.config);
  const saveApiKeyFn = useChatStore((s) => s.saveApiKey);
  const clearApiKeyFn = useChatStore((s) => s.clearApiKey);
  const loadConfigFn = useChatStore((s) => s.loadConfig);

  // The selected ENDPOINT id — a bare kind ("anthropic", the kind's default)
  // or "<kind>-<suffix>" for extra endpoints of the same kind. The protocol
  // kind behind it is `selectedKind` below.
  const [provider, setProvider] = useState<string>("anthropic");
  // Latest selected provider for async closures (see handleFetchModels).
  const providerRef = useRef<string>(provider);
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
  const [addNote, setAddNote] = useState("");
  // Per-row note editing (deals / promos / pricing quirks shown beside the
  // model in the picker) — same inline pattern as the window editor.
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  // User-assigned endpoint name — what the rail shows instead of the kind
  // label. Empty falls back to the kind label (also the field's placeholder).
  const [displayName, setDisplayName] = useState("");

  // Saved ENDPOINTS: every entry of the instance registry, keyed by id.
  // Fetched once on mount, refreshed after save/clear.
  const [savedProviders, setSavedProviders] = useState<
    Record<string, ChatInstancePayload> | null
  >(null);
  const refreshSavedProviders = async () => {
    try {
      const instances = (await listChatInstances()) ?? [];
      const out: Record<string, ChatInstancePayload> = {};
      instances.forEach((inst) => {
        out[inst.id] = inst;
      });
      setSavedProviders(out);
    } catch (e) {
      // Keep the previous summary rather than half-updating it.
      toastError("Couldn't load saved providers", String(e));
    }
  };

  const selectedKind = providerKindOf(provider);
  const isCompatible = selectedKind === "anthropic_compatible" || selectedKind === "openai_compatible";
  // OpenRouter uses a fixed endpoint (no base-URL field) but still supports
  // fetching its model catalogue from `/v1/models`.
  const isOpenRouter = selectedKind === "openrouter";
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
      .map((e) => ({
        id: e.id.trim(),
        contextWindow: Math.max(0, Math.floor(e.contextWindow || 0)),
        note: (e.note ?? "").trim().slice(0, 60),
      }))
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
        displayName.trim() || selectedProvider.label,
        selectedKind,
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
  const selectedProvider = PROVIDERS.find((item) => item.id === selectedKind) ?? PROVIDERS[0];
  const selectedConfig = savedProviders?.[provider];
  const savedModel = selectedConfig?.model || model;
  const endpoint = isCompatible
    ? baseUrl || selectedConfig?.baseUrl || "Custom endpoint"
    : isOpenRouter
      ? "https://openrouter.ai/api"
      : "Provider-managed endpoint";

  // The rail lists every saved ENDPOINT (the instance registry); the kind
  // dropdown in the add form offers ALL protocol kinds — a kind can be added
  // any number of times, each add becoming its own named endpoint.
  const addedInstances = savedProviders ? Object.values(savedProviders) : [];
  // Fresh installs land straight in the add flow: with nothing on the rail
  // yet, the detail pane IS the Add API form.
  const showAddForm = addingNew || (savedProviders !== null && addedInstances.length === 0);
  const kindLabel = (kind: string) =>
    PROVIDERS.find((item) => item.id === kind)?.label ?? kind;
  const railLabel = (inst: ChatInstancePayload) =>
    inst.displayName?.trim() || kindLabel(inst.kind);

  // New endpoint ids: a kind's FIRST endpoint reuses the bare kind id (so
  // legacy/active-provider logic keeps working); further ones get
  // "<kind>-<suffix>". `except` drops endpoints being deleted/re-added.
  const makeInstanceIdForKind = (kind: ChatProvider, except: string[]): string => {
    const taken = new Set(
      Object.values(savedProviders ?? {})
        .map((inst) => inst.id)
        .filter((id) => !except.includes(id)),
    );
    if (!taken.has(kind)) return kind;
    const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
    let id: string = kind;
    do {
      id = `${kind}-${Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("")}`;
    } while (taken.has(id));
    return id;
  };

  // Mirror the saved display name into the form whenever the selection or the
  // saved summary changes — unless the user is in the add flow (the kind
  // seeds the name) or has already typed something.
  useEffect(() => {
    if (showAddForm || formDirtyRef.current) return;
    setDisplayName(savedProviders?.[provider]?.displayName?.trim() ?? "");
  }, [savedProviders, provider, showAddForm]);

  // If the selected provider isn't on the rail (the panel always boots on
  // "anthropic", which the user may never have added), snap to the first
  // added endpoint instead of showing a ghost edit form. When nothing is
  // added, showAddForm already owns the pane.
  useEffect(() => {
    if (!savedProviders || addingNew) return;
    if (savedProviders[provider]) return;
    const first = Object.values(savedProviders)[0];
    if (first) {
      setProvider(first.id);
      formDirtyRef.current = false;
      void loadConfigFn(first.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedProviders, provider, addingNew]);

  const clearSelectedProvider = async () => {
    await handleClear();
    // The endpoint just left the rail — flip the pane into the add flow for
    // the same kind so the form never shows a removed endpoint as editable.
    setAddingNew(true);
    formDirtyRef.current = false;
    setProvider(makeInstanceIdForKind(selectedKind, [provider]));
    setDisplayName(selectedProvider.label);
  };

  // When the user switches provider, load that provider's config so hasKey
  // is always accurate for the selected provider. Fields are pre-filled by
  // the config effect above when the response arrives.
  const onProviderChange = (v: string) => {
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
            {savedProviders !== null && addedInstances.length === 0 && (
              <div className="api-provider-rail-empty">No APIs yet — add one to get started.</div>
            )}
            {addedInstances.map((inst) => {
              const label = railLabel(inst);
              const kindMeta = PROVIDERS.find((item) => item.id === inst.kind);
              const isSelected = inst.id === provider;
              return (
                <div key={inst.id} className={`api-provider-item${isSelected ? " selected" : ""}`}>
                  <button
                    type="button"
                    className="api-provider-select"
                    aria-current={isSelected ? "page" : undefined}
                    aria-label={`Select ${label}`}
                    title={kindMeta?.label ?? inst.kind}
                    onClick={() => onProviderChange(inst.id)}
                  >
                    <span className="api-provider-mark" aria-hidden="true">{kindMeta?.short ?? "•"}</span>
                    <span className="api-provider-item-label">{label}</span>
                    <span className={`api-provider-status${inst.hasKey ? " connected" : ""}`} aria-label={inst.hasKey ? "Connected" : "Not connected"} />
                  </button>
                  <button
                    type="button"
                    className="api-provider-delete"
                    aria-label={`Remove ${label}`}
                    title={`Remove ${label}`}
                    onClick={() => {
                      void clearApiKeyFn(inst.id).then(async () => {
                        if (inst.id === provider) {
                          setApiKey("");
                          setBaseUrl("");
                          setModel("");
                          setFetchedModels([]);
                          setFetchError(null);
                          setAddingNew(true);
                          formDirtyRef.current = false;
                          setDisplayName(kindMeta?.label ?? inst.kind);
                          const nextId = makeInstanceIdForKind(inst.kind, [inst.id]);
                          setProvider(nextId);
                          await loadConfigFn(nextId);
                        }
                        await refreshSavedProviders();
                      }).catch((e) => {
                        // A rejected delete used to vanish silently — same
                        // toast the key-clear path uses.
                        toastError("Couldn't clear the API key", String(e));
                      });
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            className="api-provider-add"
            aria-label="Add a new provider"
            onClick={() => {
              const target = PROVIDERS[0];
              const id = makeInstanceIdForKind(target.id, []);
              setProvider(id);
              setApiKey("");
              setBaseUrl("");
              setModel("");
              setFetchedModels([]);
              setFetchError(null);
              setAddingNew(true);
              formDirtyRef.current = false;
              setDisplayName(target.label);
              void loadConfigFn(id);
            }}
          >
            <Plus size={16} />
            <span>Add API</span>
          </button>
        </aside>

        <section className="api-provider-detail" aria-labelledby="api-provider-title">
          <div className="api-provider-detail-head">
            <div className="api-provider-title-wrap">
              <span className="api-provider-large-mark" aria-hidden="true">{selectedProvider.short}</span>
              <div>
                <div className="api-provider-title-row">
                  <h4 id="api-provider-title">{showAddForm ? "Add API" : (selectedConfig ? railLabel(selectedConfig) : selectedProvider.label)}</h4>
                  {!showAddForm && (
                    <span className={`api-connection-badge${hasExistingKey ? " connected" : ""}`}>
                      <span className="api-connection-dot" />
                      {hasExistingKey ? "Connected" : "Not connected"}
                    </span>
                  )}
                </div>
                <p>{showAddForm ? "Name the endpoint, pick its type, and add your key." : selectedProvider.description}</p>
              </div>
            </div>
            {!showAddForm && selectedConfig && (
              <button type="button" className="api-icon-button danger" aria-label={`Remove ${railLabel(selectedConfig)}`} title={`Remove ${railLabel(selectedConfig)}`} onClick={() => void clearSelectedProvider()}>
                <Trash2 size={16} />
              </button>
            )}
          </div>

          {!showAddForm && hasExistingKey && (
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
                <h5>{showAddForm ? "Add API" : "Connection details"}</h5>
                <p>{showAddForm ? "Name the endpoint, pick its type, and add your key." : "Update the name, key, or default model."}</p>
              </div>
            </div>
            <div className="api-form-field">
              <label htmlFor="api-display-name">Name</label>
              <input
                id="api-display-name"
                type="text"
                value={displayName}
                placeholder={selectedProvider.label}
                onChange={(e) => { formDirtyRef.current = true; setDisplayName(e.target.value); }}
              />
            </div>
            <div className="api-form-field">
              <label htmlFor="api-provider-kind">Provider type</label>
              <GlassSelect<ChatProvider>
                value={selectedKind}
                disabled={!showAddForm}
                options={PROVIDERS.map((item) => ({ value: item.id, label: item.label }))}
                onChange={(v) => {
                  // Reachable only in the add flow (locked while editing):
                  // a kind switch mints a fresh endpoint id for that kind —
                  // every kind can be added any number of times — resets the
                  // fields, and reseeds the name unless one was already typed.
                  const id = makeInstanceIdForKind(v, []);
                  setProvider(id);
                  setApiKey("");
                  setBaseUrl("");
                  setModel("");
                  setFetchedModels([]);
                  setFetchError(null);
                  formDirtyRef.current = false;
                  setDisplayName((prev) => {
                    const t = prev.trim();
                    return !t || PROVIDERS.some((p) => p.label === t)
                      ? PROVIDERS.find((p) => p.id === v)?.label ?? v
                      : prev;
                  });
                  void loadConfigFn(id);
                }}
                aria-label="Provider type"
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
                      {entry.note && <span className="api-model-badge is-note">{entry.note}</span>}
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
                        <button type="button" className="api-icon-button" title="Edit note — deals, promos, pricing quirks (shown beside the model in the picker)" onClick={() => {
                          setEditingNote(entry.id);
                          setNoteDraft(entry.note ?? "");
                        }}><Tag size={13} /></button>
                        <button type="button" className="api-icon-button" title="Remove from list" onClick={() => persistCurated(curatedModels.filter((m) => m.id !== entry.id))}>✕</button>
                      </span>
                    )}
                    {editingNote === entry.id ? (
                      <span className="api-model-row-edit">
                        <input
                          type="text"
                          maxLength={60}
                          autoFocus
                          value={noteDraft}
                          placeholder="e.g. 99% off · 6x usage"
                          onChange={(e) => setNoteDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              persistCurated(curatedModels.map((m) =>
                                m.id === entry.id ? { ...m, note: noteDraft } : m,
                              ));
                              setEditingNote(null);
                            }
                            if (e.key === "Escape") setEditingNote(null);
                          }}
                        />
                        <button type="button" className="api-text-button" onClick={() => {
                          persistCurated(curatedModels.map((m) =>
                            m.id === entry.id ? { ...m, note: noteDraft } : m,
                          ));
                          setEditingNote(null);
                        }}>Save</button>
                      </span>
                    ) : null}
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
                    <input
                      className="api-model-add-note"
                      type="text"
                      maxLength={60}
                      value={addNote}
                      placeholder="note (deal, promo…)"
                      onChange={(e) => setAddNote(e.target.value)}
                    />
                    <button type="button" className="api-text-button" disabled={!addId.trim()} onClick={() => {
                      persistCurated([...curatedModels, {
                        id: addId.trim(),
                        contextWindow: Math.max(0, Math.floor(Number(addWindow) || 0)),
                        note: addNote.trim().slice(0, 60),
                      }]);
                      setAddId("");
                      setAddWindow("");
                      setAddNote("");
                      setAddingRow(false);
                    }}>Add</button>
                    <button type="button" className="api-text-button" onClick={() => { setAddingRow(false); setAddId(""); setAddWindow(""); setAddNote(""); }}>Cancel</button>
                  </div>
                )}
              </div>
              <div className="api-model-actions">
                <button type="button" className="api-add-model-button" onClick={() => setAddingRow((v) => !v)}><Plus size={15} /> Add model</button>
              </div>
            </div>
            <div className="api-form-actions">
              <button type="button" className="primary" onClick={handleSave} disabled={!canSave || saving}>{saving ? "Saving…" : showAddForm ? "Add API" : "Save changes"}</button>
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
