import { useEffect, useRef, useState } from "react";
import {
  listChatModels,
  listHarnessModels,
  scanLocalModels,
} from "../../lib/ipc";
import { AGENT_OPTIONS } from "../../lib/agents";
import { useSettingsStore } from "../../state/settings";
import { ToggleSwitch } from "./ToggleSwitch";

/**
 * Settings → Composer. The "composer predictions" feature: after an assistant
 * reply finishes in the session the user is viewing, the backend suggests the
 * user's NEXT message and the composer shows it as ghost text; Tab fills the
 * draft with it (editing is expected; it never sends). Two settings:
 *
 * - `composer.predictions` (default ON, only the literal "false" disables) —
 *   the master switch, read by both this UI and chat/suggestion.rs.
 * - `composer.predictionsModel` — which model writes the suggestion:
 *   "" = follow the ACTIVE chat's own model/agent (the default), else the
 *   `chat.subagentModel` pick syntax `"provider::model"` naming a harness CLI
 *   engine, an API provider, or local_gguf. A bare model id keeps the
 *   session's provider.
 *
 * ACP agents are deliberately absent from the source list: they have no
 * one-shot generation path (same reason /create and memory extraction exclude
 * them), so a prediction would have nothing to run on.
 */

/** Debounce for the free-text model input (mirrors the Memory/Subagent panels —
 *  rapid KV writes can land out of order without it). */
const MODEL_DEBOUNCE_MS = 400;

type SourceChoice = "chat" | "bare" | string; // "bare" = same provider as the active chat

function groupOf(id: string): "harness" | "api" | "local" | "unknown" {
  return AGENT_OPTIONS.find((a) => a.id === id)?.group ?? "unknown";
}

export function ComposerPanel() {
  const composerPredictions = useSettingsStore((s) => s.composerPredictions);
  const setComposerPredictions = useSettingsStore((s) => s.setComposerPredictions);
  const composerPredictionsModel = useSettingsStore((s) => s.composerPredictionsModel);
  const setComposerPredictionsModel = useSettingsStore((s) => s.setComposerPredictionsModel);
  const settingsLoaded = useSettingsStore((s) => s.loaded);

  // Picker state derived from the stored pick: "" → follow the active chat's
  // model; "provider::model" → source select + model; a bare id → the "same
  // provider" choice + model.
  const [source, setSource] = useState<SourceChoice>("chat");
  const [model, setModel] = useState("");
  const [modelOptions, setModelOptions] = useState<{ id: string; label: string }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const persistTimer = useRef<number | null>(null);
  // Current model mirrored for the async fetch effect — it must not clobber a
  // rehydrated pick (stored claude_code::opus) with the CLI's default model.
  const modelRef = useRef("");
  modelRef.current = model;

  // Rehydrate the picker once the settings store has loaded.
  useEffect(() => {
    if (!settingsLoaded) return;
    const stored = composerPredictionsModel;
    if (stored.includes("::")) {
      const idx = stored.indexOf("::");
      setSource(stored.slice(0, idx));
      setModel(stored.slice(idx + 2));
    } else if (stored) {
      setSource("bare");
      setModel(stored);
    } else {
      setSource("chat");
      setModel("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoaded, composerPredictionsModel]);

  // Auto-fetch the model catalog for the chosen source — cloud providers list
  // their /v1/models, harnesses their CLI catalog (pre-selecting the CLI's own
  // default model, since an engine pair needs a concrete model to persist),
  // local scans the sidecar folder. "chat"/"bare" keep free text (the active
  // chat's provider isn't known until prediction time).
  useEffect(() => {
    if (source === "chat" || source === "bare") {
      setModelOptions([]);
      return;
    }
    let cancelled = false;
    const fetchModels = async () => {
      setModelsLoading(true);
      setModelOptions([]);
      try {
        const group = groupOf(source);
        if (group === "harness") {
          const cfg = await listHarnessModels(source);
          if (!cancelled && cfg) {
            const list = cfg.models.map((m) => ({ id: m.id, label: m.label }));
            setModelOptions(list);
            const preset = cfg.defaultModel || list[0]?.id || "";
            if (preset && !modelRef.current) {
              setModel(preset);
              persistPick(`${source}::${preset}`);
            }
          }
        } else if (group === "local") {
          const list = await scanLocalModels();
          if (!cancelled && list) {
            setModelOptions(list.map((m) => ({ id: m.id, label: m.name || m.filename })));
          }
        } else {
          const list = await listChatModels(source);
          if (!cancelled && list) {
            setModelOptions([...new Set(list.map((m) => m.id))].map((id) => ({ id, label: id })));
          }
        }
      } catch {
        // Listing failed — the free-text input stays available.
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    };
    void fetchModels();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  useEffect(
    () => () => {
      if (persistTimer.current !== null) window.clearTimeout(persistTimer.current);
    },
    [],
  );

  const persistPick = (value: string) => {
    setComposerPredictionsModel(value);
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 2000);
  };

  const changeModel = (value: string) => {
    setModel(value);
    if (source === "chat") return;
    if (persistTimer.current !== null) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      persistTimer.current = null;
      persistPick(source === "bare" ? value.trim() : `${source}::${value.trim()}`);
    }, MODEL_DEBOUNCE_MS);
  };

  const changeSource = (next: SourceChoice) => {
    setSource(next);
    setModel("");
    if (persistTimer.current !== null) {
      window.clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
    // No model picked yet for the new source — an empty pick is "follow the
    // active chat model" until a model lands (a bare "" or half "engine::"
    // pick is never stored). The harness branch pre-selects its CLI's default
    // model in the fetch effect above.
    persistPick("");
  };

  const pickModel = (id: string) => {
    setModel(id);
    if (persistTimer.current !== null) {
      window.clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
    persistPick(source === "bare" ? id : `${source}::${id}`);
  };

  return (
    <>
      <div className="panel-head">
        <h3>Composer predictions</h3>
        {savedFlash && <span className="assistant-save-pill done">Saved ✓</span>}
      </div>

      <div className="settings-section">
        <p className="settings-section-hint">
          After each reply, a guess at your next message appears as ghost text
          in an empty composer. Tab fills it in; Enter still sends.
        </p>

        <div className="settings-toggle-row">
          <div className="settings-toggle-label">
            <span className="settings-toggle-name">Show predictions</span>
            <span className="settings-toggle-desc">
              On by default, in memory only — never written to the chat.
            </span>
          </div>
          <ToggleSwitch
            id="composer-predictions-toggle"
            checked={composerPredictions}
            onChange={setComposerPredictions}
          />
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Prediction model</div>
        <p className="settings-section-hint">
          Defaults to the chat's own model/agent; overrides send the recent
          messages to that model instead.
        </p>

        <div className="settings-row" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select
            aria-label="Prediction model source"
            value={source}
            onChange={(e) => changeSource(e.target.value as SourceChoice)}
            style={{ minWidth: 190 }}
          >
            <option value="chat">Use the active chat model</option>
            <option value="bare">Same provider, fixed model</option>
            <optgroup label="CLI Agents">
              {AGENT_OPTIONS.filter((a) => a.group === "harness").map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </optgroup>
            <optgroup label="Cloud APIs">
              {AGENT_OPTIONS.filter((a) => a.group === "api").map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </optgroup>
            <optgroup label="Local">
              {AGENT_OPTIONS.filter((a) => a.group === "local").map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </optgroup>
          </select>

          {source !== "chat" && (
            modelOptions.length > 0 && !modelsLoading ? (
              <select
                aria-label="Prediction model"
                value={modelOptions.some((m) => m.id === model) ? model : ""}
                onChange={(e) => pickModel(e.target.value)}
                style={{ minWidth: 220 }}
              >
                <option value="" disabled>
                  {source === "bare"
                    ? "Pick a model…"
                    : groupOf(source) === "harness"
                      ? "Harness default"
                      : "Provider default"}
                </option>
                {modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            ) : (
              <input
                aria-label="Prediction model id"
                value={model}
                onChange={(e) => changeModel(e.target.value)}
                placeholder={modelsLoading ? "Loading models…" : "model id"}
                disabled={modelsLoading}
                spellCheck={false}
                style={{ minWidth: 220 }}
              />
            )
          )}
        </div>

        <span className="muted" style={{ display: "block", marginTop: 8 }}>
          {source === "chat" &&
            "Follows the chat — ACP chats skip predictions unless you pick a model here."}
          {source === "bare" &&
            "Keeps each chat's provider; this model writes the prediction."}
          {groupOf(source) === "harness" &&
            "Runs the CLI once per reply — a few seconds."}
          {groupOf(source) === "api" &&
            "Needs an API key for that provider; otherwise predictions are skipped."}
          {groupOf(source) === "local" &&
            "Needs the model running in Local Models; otherwise predictions are skipped."}
        </span>
      </div>
    </>
  );
}
