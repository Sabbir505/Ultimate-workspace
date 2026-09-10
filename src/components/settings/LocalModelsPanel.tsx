import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  deleteDownloadedModel,
  detectGpuPower,
  getChatConfig,
  getGpuVram,
  getLlamaServerPath,
  getLocalModelOverrides,
  getSetting,
  localModelStatus,
  scanLocalModels,
  setHuggingFaceToken,
  setLocalModelOverrides,
  setSetting,
  startLocalModel,
  stopLocalModel,
  toastError,
  toastSuccess,
  type ActiveLocalModel,
  type ChatConfigPayload,
  type GgufModel,
  type LlamaOverrides,
  type StartedModel,
} from "../../lib/ipc";
import { shortModelName } from "../../lib/modelLabel";
import { useChatStore } from "../../state/chat";
import { useSettingsStore } from "../../state/settings";
import { useUiStore } from "../../state/ui";
import { ModelMarket, FitBadge } from "./ModelMarket";
import { LlamaAdvancedFields } from "../chat/LlamaAdvancedFields";
import { SttPanel } from "./SttPanel";
import { KnowledgePanel } from "./KnowledgePanel";
import { GlassSelect } from "../common/GlassSelect";
import { Modal } from "../common/Modal";
import { ToggleSwitch } from "./ToggleSwitch";
import { formatBytes } from "../../lib/format";

/** Settings → Local Models: on-disk GGUF list, Hugging Face market tab,
 *  speech-to-text tab, and the llama-server sidecar controls. Extracted
 *  (with its electricity/compaction sub-panels) from SettingsView. */
export function LocalModelsPanel() {
  const [models, setModels] = useState<GgufModel[]>([]);
  const [active, setActive] = useState<ActiveLocalModel | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // Per-model loading state so the row whose "Use this model" was clicked
  // shows a spinner while the sidecar spawns + loads the GGUF.
  const [starting, setStarting] = useState<Record<string, boolean>>({});
  const [folders, setFolders] = useState<string[]>([]);
  // Persisted per-model llama-server runtime overrides (`localModels.overrides`
  // blob — the same source the backend reads at spawn time). Edits debounce
  // 600ms into the KV; a ref mirror keeps the persist helper stale-free.
  const [overridesMap, setOverridesMap] = useState<Record<string, LlamaOverrides>>({});
  const overridesMapRef = useRef<Record<string, LlamaOverrides>>({});
  const overridesPersistTimer = useRef<number | null>(null);
  // Panel tabs: "models" = on-disk GGUF list, "market" = Hugging Face browser.
  const [tab, setTab] = useState<"models" | "market" | "speech">("models");
  // Dense-row UX state: name filter (shown past 8 models), per-row overflow
  // menu, two-click delete confirmation, inline Advanced expansion, and the
  // dismissible first-run info callout.
  const [filter, setFilter] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [advancedFor, setAdvancedFor] = useState<string | null>(null);
  const [infoDismissed, setInfoDismissed] = useState(true);
  // llama-server path from settings (for one-click setup)
  const [llamaServerPath, setLlamaServerPath] = useState<string | null>(null);
  // One-shot deep-link (local-model onboarding banner): open straight to the
  // market tab. Consumed on first boot of the panel.
  const openMarket = useUiStore((s) => s.localModelsOpenMarket);
  const setLocalModelsOpenMarket = useUiStore((s) => s.setLocalModelsOpenMarket);
  useEffect(() => {
    if (openMarket) {
      setTab("market");
      setLocalModelsOpenMarket(false);
    }
  }, [openMarket, setLocalModelsOpenMarket]);

  // Load the persisted llama-server path from settings
  useEffect(() => {
    void getLlamaServerPath()
      .then((r) => setLlamaServerPath(r?.path ?? null))
      .catch(() => setLlamaServerPath(null));
  }, []);

  // One-click setup: detect and set the llama-server path
  const [settingPathLoading, setSettingPathLoading] = useState(false);
  // Persist a picked/detected path, refresh the panel, and toast the result.
  const applyLlamaServerPath = async (pathToUse: string) => {
    await invoke("set_llama_server_path", { path: pathToUse });
    setLlamaServerPath(pathToUse);
    toastSuccess(`llama-server path set to: ${pathToUse}`);
  };

  const handleOneClickPathSetup = async () => {
    setSettingPathLoading(true);
    try {
      // Try to detect a common installation path first (env var → drive scan
      // for source builds + legacy flat drops like llama-cuda → PATH probe).
      const detected = await invoke<{ path: string | null }>("detect_llama_server_path", {});
      const pathToUse = detected.path;

      if (pathToUse) {
        await applyLlamaServerPath(pathToUse);
      } else {
        // Auto-detection failed: fall back to a native file picker so any
        // non-standard install location can be pointed at manually.
        const picked = await open({
          directory: false,
          multiple: false,
          title: "Locate llama-server",
          filters: [{ name: "llama-server", extensions: ["exe"] }],
        });
        if (typeof picked === "string" && picked) {
          try {
            await applyLlamaServerPath(picked);
          } catch (setErr) {
            toastError("Couldn't use that file", String(setErr));
          }
        }
      }
    } catch (err) {
      toastError("Failed to set llama-server path", String(err));
    } finally {
      setSettingPathLoading(false);
    }
  };

  /** Update one model's overrides: patch state immediately, debounce the
   *  KV write so dragging/typing doesn't hammer the setting. */
  const setModelOverrides = (id: string, next: LlamaOverrides) => {
    const map = { ...overridesMapRef.current, [id]: next };
    overridesMapRef.current = map;
    setOverridesMap(map);
    if (overridesPersistTimer.current) window.clearTimeout(overridesPersistTimer.current);
    overridesPersistTimer.current = window.setTimeout(() => {
      void setLocalModelOverrides(JSON.stringify(map));
    }, 600);
  };

  const newChat = useChatStore((s) => s.newChat);
  const selectSession = useChatStore((s) => s.selectSession);
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
  // Memoized so the ModelMarket's onDownloadComplete callback (below) is
  // stable — a fresh identity re-subscribed the download-progress listener
  // on every parent render.
  const runScan = useCallback(async () => {
    const list = await scanLocalModels();
    setModels(list ?? []);
  }, []);

  // Auto-scan default locations + any previously-added folders on mount.
  useEffect(() => {
    if (loaded) return;
    let stale = false;
    void (async () => {
      try {
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
        // Load the persisted runtime-override blob (lenient — corrupt JSON
        // settles to empty, the backend parses the same way).
        const blob = await getLocalModelOverrides();
        if (!stale && blob) {
          try {
            const parsed = JSON.parse(blob) as Record<string, LlamaOverrides>;
            if (parsed && typeof parsed === "object") {
              overridesMapRef.current = parsed;
              setOverridesMap(parsed);
            }
          } catch {
            /* corrupt — start empty */
          }
        }
        const dismissed = await getSetting(K_LOCAL_INFO_DISMISSED);
        if (!stale) setInfoDismissed(dismissed === "1");
        await runScan();
        const a = await localModelStatus();
        if (!stale) {
          setLoaded(true);
          setLoading(false);
          setActive(a);
        }
      } catch {
        // A rejected scan/status fetch must not leave the panel spinning
        // forever — settle to the (empty) loaded state instead.
        if (!stale) {
          setLoaded(true);
          setLoading(false);
        }
      }
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

  // Stable across renders (useCallback + memoized runScan): ModelMarket keys
  // its download-progress subscription on this identity, so a fresh arrow
  // function per render re-subscribed the backend listener every time.
  const handleDownloadComplete = useCallback(() => {
    void runScan();
    // First successful download marks local-model onboarding as
    // seen so the nudge banner never returns.
    void setSetting("localModels.onboarded", "1").catch(() => {});
  }, [runScan]);

  const handleUseModel = async (m: GgufModel) => {
    setErrors((prev) => {
      const next = { ...prev };
      delete next[m.id];
      return next;
    });
    setStarting((prev) => ({ ...prev, [m.id]: true }));
    try {
      // Pass the live override entry when one exists (flushes faster than
      // the debounced KV write); otherwise undefined lets the backend load
      // the persisted blob itself (which preserves last-good ngl).
      const live = overridesMapRef.current[m.id];
      const overrides =
        live && Object.keys(live).length > 0 ? live : undefined;
      const started = await startLocalModel(m.id, m.path, m.mmprojPath, overrides);
      if (!started) throw new Error("start_local_model returned null");
      refreshStatus();
      // start_local_model persisted chat.local_gguf.model (the send-path
      // default). It intentionally no longer flips chat.active_provider —
      // that setting drives which provider NEW chats are seeded with, and a
      // sidecar spawn must not re-point them at local. Reload config so the
      // sidebar "New Chat" seed reflects the running local model.
      void loadConfig("local_gguf");

      // Create/select a chat session with local_gguf provider.
      const modelName = m.name || m.filename;
      // Explicit local pick — remember it so new chats seed on this model
      // (the fresh app-launch sidecar is respawned by the send-path
      // auto-warm, so a local last-selection is safe to reopen on).
      useChatStore
        .getState()
        .rememberSelection({ agent: "local", provider: "local_gguf", model: modelName });
      const existing = sessions.find(
        (s) => s.provider === "local_gguf" && s.model === modelName,
      );
      if (existing) {
        // Reuse the matching session instead of spawning a duplicate one
        // (selectSession loads its history; the view switches to chat).
        await selectSession(existing.id);
        setActiveView("chat");
        return;
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

  const performDelete = async (m: GgufModel) => {
    try {
      await deleteDownloadedModel(m.path);
      await runScan();
    } catch (e) {
      console.warn("delete failed", e);
      toastError(`Couldn't delete ${m.filename || m.id}`, String(e));
    }
  };

  // Close the row overflow menu on any outside pointer press.
  useEffect(() => {
    if (!menuFor) return;
    const close = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && t instanceof Element && t.closest(".row-menu-wrap")) return;
      setMenuFor(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menuFor]);

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
          className={`tab${tab === "speech" ? " active" : ""}`}
          onClick={() => setTab("speech")}
        >
          Speech
        </button>
        <button
          className={`tab${tab === "market" ? " active" : ""}`}
          onClick={() => setTab("market")}
        >
          Model Market
        </button>
      </div>

      {/* Compaction + Electricity Cost — surfaced near the top so users
          don't scroll past the model list to reach them. One compaction
          panel covers both engines: local (GGUF sidecar) and cloud (the
          session's own provider). */}
      {tab === "models" && (
        <div className="local-model-settings-row">
          <details className="model-advanced local-compaction-advanced">
            <summary>Compaction (advanced)</summary>
            <LocalCompactionControls />
            <CloudCompactionControls />
          </details>
          <LocalElectricitySettings />
        </div>
      )}

      {/* llama-server path setup section */}
      {tab === "models" && (
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 14px 8px 14px",
          marginTop: 8,
          borderTop: "1px solid var(--border)",
          marginBottom: 12
        }}>
          <span style={{ fontSize: 13, color: "var(--text-dim)" }}>
            llama-server: {llamaServerPath ? "Configured" : "Not set"}
          </span>
          {llamaServerPath && (
            <span style={{
              fontSize: 12,
              padding: "2px 8px",
              background: "var(--surface-2)",
              borderRadius: 6,
              color: "var(--text-dim)"
            }}>
              {llamaServerPath}
            </span>
          )}
          <button
            className="ghost"
            style={{
              padding: "4px 10px",
              fontSize: 12,
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              gap: 4,
              marginLeft: "auto"
            }}
            onClick={handleOneClickPathSetup}
            disabled={settingPathLoading}
          >
            {settingPathLoading ? (
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span className="local-spinner" /> Setting up…
              </span>
            ) : (
              "One-click setup"
            )}
          </button>
        </div>
      )}

      {tab === "models" && (
      <>
      {!infoDismissed && (
        <div className="local-info-callout">
          <span>
            Models are scanned from ~/.lmstudio/models, ~/.cache/lm-studio/models,
            your Downloads folder, Ollama, and any folder you add. llama-server
            (llama.cpp) must be installed separately.
          </span>
          <button
            className="ghost"
            style={{ padding: "2px 8px", flexShrink: 0 }}
            onClick={() => {
              setInfoDismissed(true);
              void setSetting(K_LOCAL_INFO_DISMISSED, "1");
            }}
          >
            Got it
          </button>
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

      {models.length > 8 && (
        <div className="local-model-search">
          <input
            type="text"
            placeholder="Filter models…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            spellCheck={false}
          />
        </div>
      )}

      <div className="local-model-rows">
        {models.length === 0 && !loading && !active && (
          <div className="empty-reserved local-empty">
            <span className="empty-text">
              No .gguf models found. Add a folder to scan, or grab one from the
              Model Market.
            </span>
            <div className="empty-ctas">
              <button className="primary cta-strong" onClick={() => void handleAddFolder()}>
                Add folder
              </button>
              <button onClick={() => setTab("market")}>Browse Model Market</button>
            </div>
          </div>
        )}

        {(() => {
          const q = filter.trim().toLowerCase();
          const visible = q
            ? models.filter((m) =>
                `${m.name ?? ""} ${m.filename} ${m.architecture ?? ""} ${m.quantization ?? ""}`
                  .toLowerCase()
                  .includes(q),
              )
            : models;
          return visible.map((m) => {
          const ram: "fits" | "tight" | "too_large" = m.memoryClass ?? classifyRam(m.sizeBytes);
          const err = errors[m.id];
          const isStarting = starting[m.id];
          const isRunning = active?.modelId === m.id;
          const displayName = shortModelName(m.name || m.filename);
          return (
            <div key={m.id} className="local-model-item">
              <div className={`local-model-row${isRunning ? " running" : ""}`}>
                <span
                  className={`fit-dot ${ram}`}
                  title={ram === "fits" ? "Fits RAM" : ram === "tight" ? "Tight fit — may be slow" : "Too large for available RAM"}
                />
                <div className="local-model-row-main">
                  <div className="local-model-row-name" title={m.filename}>{displayName}</div>
                  <div className="local-model-row-meta">
                    <span>{formatBytes(m.sizeBytes)}</span>
                    {m.quantization && <span className="model-tag">{m.quantization}</span>}
                    {m.paramCountLabel && <span>{m.paramCountLabel}</span>}
                    {m.hasVision && <span className="model-tag vision">Vision</span>}
                    <FitBadge ram={ram} />
                    {isRunning && (
                      <span className="running-pill">● Running · port {active.port}</span>
                    )}
                    {err && <span className="row-error" title={err}>{err}</span>}
                  </div>
                </div>
                <div className="local-model-row-actions">
                  {isRunning ? (
                    <button
                      className="ghost local-stop-btn"
                      onClick={() => void handleStop()}
                      disabled={loading}
                    >
                      Stop
                    </button>
                  ) : (
                    <button
                      className="primary cta-strong local-use-btn"
                      onClick={() => void handleUseModel(m)}
                      disabled={isStarting || loading || ram === "too_large"}
                      title={ram === "too_large" ? "Model exceeds available RAM" : undefined}
                    >
                      {isStarting ? "Starting…" : "Use"}
                    </button>
                  )}
                  <div className="row-menu-wrap">
                    <button
                      className="ghost row-menu-btn"
                      aria-label="More actions"
                      onClick={() => setMenuFor(menuFor === m.id ? null : m.id)}
                    >
                      ⋯
                    </button>
                    {menuFor === m.id && (
                      <div className="row-menu" role="menu">
                        <button
                          role="menuitem"
                          onClick={() => {
                            setAdvancedFor(advancedFor === m.id ? null : m.id);
                            setMenuFor(null);
                          }}
                        >
                          Advanced…
                        </button>
                        <button
                          role="menuitem"
                          className="danger-menu"
                          onClick={() => {
                            if (confirmId !== m.id) {
                              setConfirmId(m.id);
                              window.setTimeout(
                                () => setConfirmId((c) => (c === m.id ? null : c)),
                                3000,
                              );
                              return;
                            }
                            setConfirmId(null);
                            setMenuFor(null);
                            void performDelete(m);
                          }}
                        >
                          {confirmId === m.id ? "Click again to delete" : "Delete from disk…"}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {advancedFor === m.id && (
                <div className="local-row-advanced">
                  <div className="local-row-advanced-head">
                    <span>Advanced settings</span>
                    <button
                      className="ghost local-advanced-collapse"
                      onClick={() => setAdvancedFor(null)}
                    >
                      Collapse ▴
                    </button>
                  </div>
                  <LlamaAdvancedFields
                    overrides={overridesMap[m.id] ?? {}}
                    onChange={(next) => setModelOverrides(m.id, next)}
                  />
                  {isRunning && (
                    <button
                      className="ghost"
                      style={{ padding: "3px 10px", alignSelf: "flex-start" }}
                      disabled={starting[m.id]}
                      title="Persist these settings and reload the running model with them"
                      onClick={() => {
                        // Flush the debounced persist immediately, then restart.
                        if (overridesPersistTimer.current) window.clearTimeout(overridesPersistTimer.current);
                        void setLocalModelOverrides(JSON.stringify(overridesMapRef.current));
                        setStarting((prev) => ({ ...prev, [m.id]: true }));
                        void startLocalModel(m.id, m.path, m.mmprojPath, overridesMapRef.current[m.id])
                          .then(() => refreshStatus())
                          .catch((err2) =>
                            setErrors((prev) => ({ ...prev, [m.id]: String(err2) })),
                          )
                          .finally(() => setStarting((prev) => ({ ...prev, [m.id]: false })));
                      }}
                    >
                      {starting[m.id] ? "Restarting…" : "↻ Restart with new settings"}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
          });
        })()}
      </div>
      </>
      )}
      {tab === "speech" && <SttPanel />}
      {tab === "market" && (
        <ModelMarket
          onDownloadComplete={handleDownloadComplete}
          localModels={models}
        />
      )}
    </>
  );
}

function LocalElectricitySettings() {
  const [elecRate, setElecRate] = useState<string>("");
  const [gpuWatts, setGpuWatts] = useState<string>("");
  const [gpuName, setGpuName] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const load = async () => {
      const rate = await getSetting("localModels.electricityRateUsdPerKwh");
      const watts = await getSetting("localModels.gpuPowerWatts");
      setElecRate(rate ?? "");
      setGpuWatts(watts ?? "");
      setLoaded(true);
    };
    void load();
  }, []);

  const autoDetect = async () => {
    setDetecting(true);
    try {
      const detection = await detectGpuPower();
      if (detection?.estimatedWatts) {
        const watts = String(Math.round(detection.estimatedWatts));
        setGpuWatts(watts);
        setGpuName(detection.deviceName ?? null);
        await setSetting("localModels.gpuPowerWatts", watts);
        toastSuccess(`Detected ${detection.deviceName} — set to ${watts}W`);
      } else {
        toastError("No discrete GPU detected — enter the power manually.");
      }
    } catch (err) {
      toastError("GPU detection failed", err);
    } finally {
      setDetecting(false);
    }
  };

  const save = async () => {
    await setSetting("localModels.electricityRateUsdPerKwh", elecRate);
    await setSetting("localModels.gpuPowerWatts", gpuWatts);
    toastSuccess("Electricity settings saved");
  };

  if (!loaded) return null;

  return (
    <details className="model-advanced local-electricity-advanced">
      <summary>Electricity Cost (advanced)</summary>
      <div className="model-advanced-fields">
        <label>
          Electricity rate ($/kWh)
          <input
            type="number"
            min={0}
            step={0.01}
            value={elecRate}
            onChange={(e) => setElecRate(e.target.value)}
            onBlur={save}
          />
          <span className="local-compaction-hint">
            Your electricity cost per kilowatt-hour (e.g., 0.15)
          </span>
        </label>
        <label>
          GPU power (W)
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="number"
              min={0}
              step={1}
              value={gpuWatts}
              onChange={(e) => setGpuWatts(e.target.value)}
              onBlur={save}
            />
            <button
              type="button"
              className="ghost"
              style={{ padding: "4px 10px", fontSize: 11, flexShrink: 0 }}
              disabled={detecting}
              onClick={() => void autoDetect()}
              title="Auto-detect GPU and estimate its power draw"
            >
              {detecting ? "Detecting…" : "Auto-detect"}
            </button>
          </div>
          <span className="local-compaction-hint">
            {gpuName
              ? `${gpuName} — override if the estimate is off`
              : "GPU power consumption in watts, or click Auto-detect"}
          </span>
        </label>
      </div>
    </details>
  );
}

/** Context-compaction controls for local-GGUF sessions. These tune when the
 *  framework summarizes older turns before a small context window overflows.
 *  Defaults and clamping mirror the Rust loader in chat/compaction.rs. */
function LocalCompactionControls() {
  const threshold = useSettingsStore((s) => s.localCompactionThreshold);
  const pin = useSettingsStore((s) => s.localPinExchanges);
  const summarizer = useSettingsStore((s) => s.localCompactionSummarizer);
  const rebuildFromRaw = useSettingsStore((s) => s.localCompactionRebuildFromRaw);
  const setThreshold = useSettingsStore((s) => s.setLocalCompactionThreshold);
  const setPin = useSettingsStore((s) => s.setLocalPinExchanges);
  const setSummarizer = useSettingsStore((s) => s.setLocalCompactionSummarizer);
  const setRebuildFromRaw = useSettingsStore((s) => s.setLocalCompactionRebuildFromRaw);
  return (
    <div className="model-advanced-fields">
      <label>
        Summarizer
        <select
          value={summarizer}
          onChange={(e) => setSummarizer(e.target.value === "cloud" ? "cloud" : "sidecar")}
        >
          <option value="sidecar">Sidecar model (default)</option>
          <option value="cloud">Cloud provider (needs an API key)</option>
        </select>
        <span className="local-compaction-hint">
          which model writes the summary — a small sidecar model can lean on a
          configured cloud key for better quality
        </span>
      </label>
      <label>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={rebuildFromRaw}
            onChange={(e) => setRebuildFromRaw(e.target.checked)}
          />
          <span>Rebuild summaries from the original turns</span>
        </div>
        <span className="local-compaction-hint">
          re-derives each new summary from the folded raw turns instead of
          stacking summary-on-summary (prevents compounding loss)
        </span>
      </label>
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

/** Context-compaction controls for cloud/API sessions. Same engine as the
 *  local path; the trigger is an estimated request size against the model
 *  registry's window and the summarizer is the session's own provider.
 *  Defaults and clamping mirror the Rust loader in chat/cloud_compact.rs. */
function CloudCompactionControls() {
  const enabled = useSettingsStore((s) => s.cloudCompactionEnabled);
  const threshold = useSettingsStore((s) => s.cloudCompactionThreshold);
  const pin = useSettingsStore((s) => s.cloudPinExchanges);
  const contextLimit = useSettingsStore((s) => s.cloudContextLimit);
  const setEnabled = useSettingsStore((s) => s.setCloudCompactionEnabled);
  const setThreshold = useSettingsStore((s) => s.setCloudCompactionThreshold);
  const setPin = useSettingsStore((s) => s.setCloudPinExchanges);
  const setContextLimit = useSettingsStore((s) => s.setCloudContextLimit);
  return (
    <div className="model-advanced-fields">
      <label>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>Compact cloud conversations automatically</span>
        </div>
        <span className="local-compaction-hint">
          summarizes older turns when the estimated request approaches the model's
          window; a context-overflow rejection is compacted and retried regardless
        </span>
      </label>
      <label>
        Threshold
        <input
          type="number"
          min={0.25}
          max={0.99}
          step={0.05}
          value={threshold}
          disabled={!enabled}
          onChange={(e) => setThreshold(Number(e.target.value))}
        />
        <span className="local-compaction-hint">
          fraction of the model window that triggers compaction (default 0.75)
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
          disabled={!enabled}
          onChange={(e) => setPin(Math.floor(Number(e.target.value)))}
        />
        <span className="local-compaction-hint">
          recent user+assistant pairs kept verbatim (default 6)
        </span>
      </label>
      <label>
        Context limit (tokens)
        <input
          type="number"
          min={0}
          step={10000}
          placeholder="0 = model default"
          value={contextLimit}
          onChange={(e) => setContextLimit(Number(e.target.value))}
        />
        <span className="local-compaction-hint">
          cap the effective window below the model's own — 0 uses the model's
          real window (fetched live from Anthropic/OpenRouter where available);
          a cap only shrinks, never raises
        </span>
      </label>
    </div>
  );
}

export const K_SYSTEM_PROMPT = "assistant.systemPrompt";
export const K_COMMIT_PROVIDER = "commitMessage.provider";
export const K_COMMIT_MODEL = "commitMessage.model";
const K_LOCAL_FOLDERS = "localModels.folders";
const K_LOCAL_INFO_DISMISSED = "localModels.infoDismissed";

/** Assistant panel: the custom system prompt only. Skills live on disk in the
 *  harness skill directories and are managed via the Skills Library modal
 *  (surfaced in the chat `/` menu and injected on `/slug` invocation) — there
 *  is no per-assistant skill config here. */
export const PROMPT_PRESETS: { label: string; text: string }[] = [
  {
    label: "Concise replies",
    text: "Keep answers short and direct. Lead with the answer; skip preamble, filler and restating the question.",
  },
  {
    label: "Senior reviewer",
    text: "Act as a senior engineer reviewing my work. Flag bugs and edge cases first, then suggest the simplest correct fix.",
  },
  {
    label: "Plain English",
    text: "Always respond in English. Prefer plain language over jargon and explain any term of art on first use.",
  },
];
