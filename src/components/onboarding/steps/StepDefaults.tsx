// Step 5 — Set your defaults + first task (the approved mock's closing
// step). Everything here writes a REAL setting the moment it's touched:
//  * Permission segmented control → `chat.defaultApproval` KV, which
//    db::create_chat_session reads for every NEW session's posture
//    (unset keeps the app's historical full-auto default).
//  * Model tiles → set_chat_default_model for the provider; a tile whose
//    provider has no key yet expands an inline key form (native providers
//    save straight to the keychain, matching Settings behavior).
//  * The task panel genuinely starts the first chat: newChat("auto","auto")
//    + sendMessage — the same entry the composer uses.
import { useEffect, useState } from "react";
import { getChatConfig, setChatApiKey, setChatDefaultModel, setSetting, toastSuccess } from "../../../lib/ipc";
import { useChatStore } from "../../../state/chat";
import { closeOnboarding, K_DEFAULT_APPROVAL, useOnboardingStore } from "../../../state/onboarding";
import { ClaudeIcon, LocalModelIcon, OpenAiIcon } from "../../chat/agentIcons";

type PermissionChoice = "manual" | "read_only" | "full_auto";

const PERMISSIONS: Array<{ id: PermissionChoice; label: string }> = [
  { id: "manual", label: "Ask first" },
  { id: "read_only", label: "Read only" },
  { id: "full_auto", label: "Automatic" },
];

/** Canonical catalog defaults — mirrors providers.rs ANTHROPIC/OPENAI_DEFAULT_MODEL. */
const TILES = [
  { id: "claude" as const, provider: "anthropic", model: "claude-sonnet-4-5-20250929", label: "Claude Sonnet" },
  { id: "gpt" as const, provider: "openai", model: "gpt-4o", label: "GPT-4o" },
  { id: "local" as const, provider: "local_gguf", model: "local", label: "Local" },
];

const SUGGESTIONS = [
  "Explain this project structure",
  "Find the most important files",
  "Suggest 3 improvements",
];

type TileId = (typeof TILES)[number]["id"];

export function StepDefaults() {
  const [permission, setPermission] = useState<PermissionChoice>("full_auto");
  const [selectedTile, setSelectedTile] = useState<TileId | null>(null);
  const [keyStatus, setKeyStatus] = useState<Partial<Record<"anthropic" | "openai", boolean>>>({});
  const [keyFormFor, setKeyFormFor] = useState<"anthropic" | "openai" | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [task, setTask] = useState("");
  const path = useOnboardingStore((s) => s.path);

  // Which providers already have a key (drives tile click behavior).
  useEffect(() => {
    let alive = true;
    for (const p of ["anthropic", "openai"] as const) {
      void getChatConfig(p)
        .then((cfg) => {
          if (alive) setKeyStatus((s) => ({ ...s, [p]: !!cfg?.hasKey }));
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, []);

  const choosePermission = (id: PermissionChoice) => {
    setPermission(id);
    // Written through immediately: a skip right after must not lose it.
    void setSetting(K_DEFAULT_APPROVAL, id).catch(() => {});
  };

  const chooseTile = async (tile: (typeof TILES)[number]) => {
    if (tile.provider !== "local_gguf" && !keyStatus[tile.provider as "anthropic" | "openai"]) {
      setKeyFormFor(tile.provider as "anthropic" | "openai");
      return;
    }
    setKeyFormFor(null);
    setSelectedTile(tile.id);
    await setChatDefaultModel(tile.provider, tile.model).catch(() => {});
  };

  const saveKey = async () => {
    if (!keyFormFor || !apiKey.trim()) return;
    setKeyBusy(true);
    setKeyError(null);
    try {
      const tile = TILES.find((t) => t.provider === keyFormFor)!;
      // Native providers save straight to the OS keychain (same as Settings);
      // the first chat turn surfaces any key problem.
      await setChatApiKey(keyFormFor, apiKey.trim());
      await setChatDefaultModel(keyFormFor, tile.model);
      setKeyStatus((s) => ({ ...s, [keyFormFor]: true }));
      setSelectedTile(tile.id);
      setKeyFormFor(null);
      setApiKey("");
      toastSuccess(`${tile.label} connected`);
    } catch (e: any) {
      setKeyError(e?.message || String(e));
    }
    setKeyBusy(false);
  };

  const startTask = async (text: string) => {
    const prompt = text.trim();
    if (!prompt) return;
    // Real first send: creates the session (auto-routed) and starts the turn
    // — the same path the composer's send button uses.
    closeOnboarding();
    const chat = useChatStore.getState();
    await chat.newChat("auto", "auto").catch(() => {});
    await useChatStore.getState().sendMessage(prompt).catch(() => {});
  };

  return (
    <>
      <div className="onboarding-eyebrow onb-rise">Ready to go</div>
      <h2 className="onboarding-title onb-rise">Set your defaults</h2>
      <p className="onboarding-lede onb-rise">These settings can be changed anytime in Settings.</p>

      <div className="onboarding-split onboarding-split-start">
        <div>
          <div className="onboarding-panel onb-rise">
            <div className="onboarding-panel-title">Default agent permission</div>
            <div className="onboarding-segmented" role="radiogroup" aria-label="Default agent permission">
              {PERMISSIONS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={permission === p.id}
                  className={`onboarding-seg${permission === p.id ? " selected" : ""}`}
                  onClick={() => choosePermission(p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="onboarding-panel onb-rise">
            <div className="onboarding-panel-title">Default model</div>
            <div className="onboarding-model-tiles" role="radiogroup" aria-label="Default model">
              <button
                type="button"
                role="radio"
                aria-checked={selectedTile === "claude"}
                className={`onboarding-model-tile${selectedTile === "claude" ? " selected" : ""}`}
                onClick={() => void chooseTile(TILES[0])}
              >
                <span className="onboarding-mi t-claude">
                  <ClaudeIcon />
                </span>
                Claude Sonnet
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={selectedTile === "gpt"}
                className={`onboarding-model-tile${selectedTile === "gpt" ? " selected" : ""}`}
                onClick={() => void chooseTile(TILES[1])}
              >
                <span className="onboarding-mi t-openai">
                  <OpenAiIcon />
                </span>
                GPT-4o
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={selectedTile === "local"}
                className={`onboarding-model-tile${selectedTile === "local" ? " selected" : ""}`}
                onClick={() => void chooseTile(TILES[2])}
              >
                <span className="onboarding-mi t-local">
                  <LocalModelIcon />
                </span>
                Local
              </button>
            </div>
            {keyFormFor && (
              <div className="onboarding-key-form">
                <input
                  type="password"
                  placeholder={`${keyFormFor === "anthropic" ? "Anthropic" : "OpenAI"} API key (sk-…)`}
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  aria-label="API key"
                />
                <button type="button" className="onboarding-btn onboarding-btn-primary" disabled={!apiKey.trim() || keyBusy} onClick={() => void saveKey()}>
                  {keyBusy ? "Saving…" : "Save key"}
                </button>
                {keyError && <p className="onboarding-error" role="alert">{keyError}</p>}
              </div>
            )}
          </div>
        </div>

        <div className="onboarding-task-panel onb-rise">
          <span className="onboarding-spark" aria-hidden="true">
            ✦
          </span>
          <b>Try your first task</b>
          <span className="onboarding-task-sub">
            {path === "newcomer"
              ? "Let's see Relay in action. Pick a suggestion — Relay sends it to your agent for real."
              : "Choose a suggestion or write your own prompt."}
          </span>
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" className="onboarding-suggest" onClick={() => void startTask(s)}>
              <span className="onboarding-suggest-b" aria-hidden="true" />
              {s}
            </button>
          ))}
          <div className="onboarding-prompt-row">
            <input
              type="text"
              placeholder="Or write your own prompt…"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void startTask(task);
              }}
              aria-label="Your first task"
            />
            <button type="button" className="onboarding-send" title="Send" aria-label="Send first task" onClick={() => void startTask(task)}>
              ➤
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
