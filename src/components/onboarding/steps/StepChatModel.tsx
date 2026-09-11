// Step 2 of the welcome wizard: pick a chat model. Two paths —
//  * Cloud: save an API key into the OS keychain. `list_chat_models` only
//    supports compatible/OpenRouter providers (chat/commands.rs), so those
//    get a live "verify" (the key is only saved after the endpoint answers);
//    native Anthropic/OpenAI keys save directly, matching Settings behavior.
//  * Local: deep-link to the Model Market (same pattern as LocalModelModal).
//    Leaving through it finishes the wizard, so the flow doesn't re-open.
import { useState } from "react";
import {
  listChatModels,
  setChatApiKey,
  toastSuccess,
} from "../../../lib/ipc";
import { useChatStore } from "../../../state/chat";
import { closeOnboarding } from "../../../state/onboarding";
import { useUiStore } from "../../../state/ui";
import { GlassSelect } from "../../common/GlassSelect";

type ProviderId = "anthropic" | "openai" | "openrouter" | "anthropic_compatible" | "openai_compatible";

const PROVIDERS: Array<{ id: ProviderId; label: string }> = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "anthropic_compatible", label: "Anthropic Compatible" },
  { id: "openai_compatible", label: "OpenAI Compatible" },
];

export function StepChatModel() {
  const [mode, setMode] = useState<"cloud" | "local">("cloud");
  const [provider, setProvider] = useState<ProviderId>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const isCompatible = provider === "anthropic_compatible" || provider === "openai_compatible";
  const canLiveVerify = isCompatible || provider === "openrouter";
  const canSave = isCompatible ? baseUrl.trim().length > 0 : apiKey.trim().length > 0;

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      let note: string;
      if (canLiveVerify) {
        // Verify first — a dead endpoint/key must not land in the keychain.
        const models = await listChatModels(provider, baseUrl.trim() || undefined, apiKey.trim() || undefined);
        if (!models || models.length === 0) {
          setError("The endpoint answered but listed no models. Check the key or base URL.");
          setBusy(false);
          return;
        }
        await setChatApiKey(provider, apiKey.trim(), isCompatible ? baseUrl.trim() : undefined);
        note = `Connected — ${models.length} models available.`;
      } else {
        // Native providers: no model-list endpoint; save directly (the first
        // chat turn surfaces any key problem, same as Settings).
        await setChatApiKey(provider, apiKey.trim());
        note = "Key saved to your OS keychain.";
      }
      // Refresh the global config so the composer picks the provider up now.
      await useChatStore.getState().loadConfig(provider).catch(() => {});
      setSaved(note);
      toastSuccess("Chat model connected");
    } catch (e: any) {
      setError(e?.message || String(e));
    }
    setBusy(false);
  };

  const openMarket = () => {
    // closeOnboarding writes onboarding.completed AND localModels.onboarded —
    // the user just chose the market deliberately.
    closeOnboarding();
    const ui = useUiStore.getState();
    ui.setSettingsCategory("localmodels");
    ui.setLocalModelsOpenMarket(true);
    ui.setActiveView("settings");
  };

  return (
    <div className="onboarding-step">
      <h2 className="onboarding-title">Pick a chat model</h2>
      <p className="onboarding-sub">
        The built-in chat needs one model to start. You can add more anytime in Settings.
      </p>

      <div
        role="radio"
        aria-checked={mode === "cloud"}
        tabIndex={0}
        className={`onboarding-option${mode === "cloud" ? " selected" : ""}`}
        onClick={() => setMode("cloud")}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setMode("cloud");
          }
        }}
      >
        <span className="onboarding-radio-dot" aria-hidden="true" />
        <div className="onboarding-option-copy">
          <span className="onboarding-option-title">Cloud API</span>
          <span className="onboarding-option-hint">Anthropic, OpenAI, OpenRouter, or any compatible endpoint.</span>
        </div>
      </div>

      {mode === "cloud" && (
        <div className="onboarding-model-form">
          <div className="onboarding-form-row">
            <div className="onboarding-field">
              <label className="onboarding-label" htmlFor="onboarding-provider">Provider</label>
              <GlassSelect<ProviderId>
                value={provider}
                options={PROVIDERS.map((p) => ({ value: p.id, label: p.label }))}
                onChange={(v) => {
                  setProvider(v);
                  setError(null);
                  setSaved(null);
                }}
                title="Provider"
              />
            </div>
            <div className="onboarding-field">
              <label className="onboarding-label" htmlFor="onboarding-api-key">API key</label>
              <input
                id="onboarding-api-key"
                type="password"
                value={apiKey}
                placeholder="sk-…"
                autoComplete="off"
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setSaved(null);
                }}
              />
            </div>
          </div>
          {isCompatible && (
            <div className="onboarding-field">
              <label className="onboarding-label" htmlFor="onboarding-base-url">Base URL</label>
              <input
                id="onboarding-base-url"
                type="url"
                value={baseUrl}
                placeholder="https://api.example.com/v1"
                onChange={(e) => {
                  setBaseUrl(e.target.value);
                  setSaved(null);
                }}
              />
            </div>
          )}
          {provider === "openrouter" && (
            <p className="onboarding-note">OpenRouter uses its hosted endpoint — your key unlocks every model it offers.</p>
          )}
          {error && <p className="onboarding-error" role="alert">{error}</p>}
          {saved && <p className="onboarding-success" role="status">{saved}</p>}
          <button
            type="button"
            className="onboarding-btn onboarding-btn-primary"
            disabled={!canSave || busy}
            onClick={() => void save()}
          >
            {busy ? "Verifying…" : canLiveVerify ? "Verify & save" : "Save key"}
          </button>
        </div>
      )}

      <div
        role="radio"
        aria-checked={mode === "local"}
        tabIndex={0}
        className={`onboarding-option onboarding-option-local${mode === "local" ? " selected" : ""}`}
        onClick={() => setMode("local")}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setMode("local");
          }
        }}
      >
        <span className="onboarding-radio-dot" aria-hidden="true" />
        <div className="onboarding-option-copy">
          <span className="onboarding-option-title">Local model</span>
          <span className="onboarding-option-hint">Private and offline — GGUF models sized to your GPU.</span>
        </div>
      </div>

      {mode === "local" && (
        <div className="onboarding-model-form">
          <button type="button" className="onboarding-btn onboarding-market-btn" onClick={openMarket}>
            Browse the Model Market
          </button>
          <p className="onboarding-note">
            Relay runs GGUF models through a bundled llama.cpp server — nothing leaves your machine.
          </p>
        </div>
      )}
    </div>
  );
}
