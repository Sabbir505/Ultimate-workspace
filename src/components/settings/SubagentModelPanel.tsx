import { useEffect, useRef, useState } from "react";
import {
  listChatModels,
  listHarnessModels,
  scanLocalModels,
} from "../../lib/ipc";
import { AGENT_OPTIONS } from "../../lib/agents";
import { useSettingsStore } from "../../state/settings";

/**
 * Settings → Subagent model. The orchestration default for spawned work:
 * Session Mesh `spawn_session` children run on this model/engine instead of
 * inheriting the parent session's own, and built-in Task subagents pick up
 * the model half (API providers only — CLIs delegate via spawn_session).
 * Stored as `chat.subagentModel` — "provider::model" (cloud/local), a CLI
 * engine pair "claude_code::sonnet", a bare model id (keeps each parent's
 * provider), or "" = inherit. The model itself can still override per call
 * with the `model` argument on task/spawn_session, which wins over this
 * setting.
 */

/** Debounce for the free-text model input (mirrors the Memory panel — rapid
 *  KV writes can land out of order without it). */
const MODEL_DEBOUNCE_MS = 400;

type SourceChoice = "inherit" | "bare" | string; // "bare" = same provider as the parent chat

function groupOf(id: string): "harness" | "api" | "local" | "unknown" {
  return AGENT_OPTIONS.find((a) => a.id === id)?.group ?? "unknown";
}

export function SubagentModelPanel() {
  const subagentModel = useSettingsStore((s) => s.subagentModel);
  const setSubagentModel = useSettingsStore((s) => s.setSubagentModel);
  const settingsLoaded = useSettingsStore((s) => s.loaded);

  // Picker state derived from the stored pick: "provider::model" → provider
  // select + model; a bare id → the "same provider" choice + model; "" →
  // inherit.
  const [source, setSource] = useState<SourceChoice>("inherit");
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
    const stored = subagentModel;
    if (stored.includes("::")) {
      const idx = stored.indexOf("::");
      setSource(stored.slice(0, idx));
      setModel(stored.slice(idx + 2));
    } else if (stored) {
      setSource("bare");
      setModel(stored);
    } else {
      setSource("inherit");
      setModel("");
    }
    // Re-run only when the underlying setting value changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoaded, subagentModel]);

  // Auto-fetch the model catalog for the chosen source — cloud providers list
  // their /v1/models, harnesses their CLI catalog (pre-selecting the CLI's own
  // default model, since an engine pair needs a concrete model to persist),
  // local scans the sidecar folder. "inherit"/"bare" keep free text (the
  // parent's provider isn't known until spawn time).
  useEffect(() => {
    if (source === "inherit" || source === "bare") {
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
            // Pre-select the CLI's own default only when nothing is picked
            // yet — a stored pick (rehydrated below into modelRef) wins.
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
    setSubagentModel(value);
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 2000);
  };

  const changeModel = (value: string) => {
    setModel(value);
    if (source === "inherit") return;
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
    // No model picked yet for the new source — an empty pick is "inherit"
    // until a model lands (a bare "" or half "engine::" pick is never stored).
    // The harness branch pre-selects its CLI's default model in the fetch
    // effect above.
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
        <h3>Subagent model</h3>
        {savedFlash && <span className="assistant-save-pill done">Saved ✓</span>}
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Default model for spawned agents</div>
        <p className="muted" style={{ marginTop: 0 }}>
          Task subagents and chat sessions spawned through the Session Mesh run
          on this model (or CLI engine + model) instead of the parent chat's
          own — e.g. a cheap model for mechanical sub-work while you keep a
          frontier model for the main conversation, or spawned work on Claude
          Code while you chat through the API. The agent can still pick a
          per-task model itself; that choice wins over this default.
        </p>

        <div className="settings-row" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select
            aria-label="Subagent model source"
            value={source}
            onChange={(e) => changeSource(e.target.value as SourceChoice)}
            style={{ minWidth: 190 }}
          >
            <option value="inherit">Inherit the chat's model</option>
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

          {source !== "inherit" && (
            modelOptions.length > 0 && !modelsLoading ? (
              <select
                aria-label="Subagent model"
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
                aria-label="Subagent model id"
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
          {source === "inherit" &&
            "Subagents run on whichever model the parent chat uses (today's behavior)."}
          {source === "bare" &&
            "Keeps each chat's own provider and runs subagents on this model id. Harness CLIs read it as their own --model value."}
          {groupOf(source) === "harness" &&
            "Spawned sessions run on this CLI engine + model no matter what the parent chat runs — a cheap-harness worker alongside a frontier-model main chat. Built-in Task subagents can't launch CLIs; they keep API models and only mesh-spawned sessions take this pick."}
          {groupOf(source) === "api" &&
            "Cross-provider picks need an API key saved for that provider (Settings → API Keys); without one the parent's model is used instead. CLI-harness children keep their own provider and ignore this pick."}
          {groupOf(source) === "local" &&
            "Runs spawned sessions on the local sidecar — the model must be loaded (or loadable) in Settings → Local Models when the spawn fires; otherwise the parent's model is used. CLI-harness children ignore this pick."}
        </span>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Resolution order</div>
        <table className="kv">
          <tbody>
            <tr>
              <td>1 · Per-task choice</td>
              <td className="muted">
                The agent passes <code>model</code> on its task/spawn tool call.
              </td>
            </tr>
            <tr>
              <td>2 · This setting</td>
              <td className="muted">The default configured here.</td>
            </tr>
            <tr>
              <td>3 · Parent's model</td>
              <td className="muted">
                Whatever the chat that spawned the work is running.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
