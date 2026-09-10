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
  type ConnectorWithStatus,
  type DataPaths,
  type GgufModel,
  type OAuthCallbackPayload,
  type SelectedModelEntry,
} from "../../lib/ipc";
import { runLoginFlow } from "../../lib/sessionLauncher";
import { K_COMMIT_PROVIDER, K_COMMIT_MODEL } from "./LocalModelsPanel";
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

export function GitPanel() {
  const worktreeDefault = useSettingsStore((s) => s.worktreeDefault);
  const setWorktreeDefault = useSettingsStore((s) => s.setWorktreeDefault);
  const checkpointsEnabled = useSettingsStore((s) => s.checkpointsEnabled);
  const setCheckpointsEnabled = useSettingsStore((s) => s.setCheckpointsEnabled);
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
        <h3>Version control</h3>
        <span className="panel-count">Commits · worktrees · checkpoints</span>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Commit message model</div>
        <p className="settings-section-hint">
          Auto-generates commit messages in the commit modal. Pick a small/fast model
          (<code>gpt-4o-mini</code>, <code>claude-haiku</code>) — leave blank to use the active
          chat model.
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

      <div className="settings-section">
        <div className="settings-section-title">Worktree-per-session isolation</div>
        <p className="settings-section-hint">
          Each git-bound chat works in its own isolated worktree (branch{" "}
          <code>relay/&lt;id&gt;</code>), so agents never collide. Deleting a chat removes it
          best-effort — committed work is never lost.
        </p>
        <div className="settings-toggle-row">
          <div className="settings-toggle-label">
            <span className="settings-toggle-name">Isolate new chats by default</span>
          </div>
          <ToggleSwitch checked={worktreeDefault} onChange={setWorktreeDefault} />
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Per-turn checkpoints</div>
        <p className="settings-section-hint">
          Each file-changing turn gets a hidden git snapshot, shown as a restore chip under the
          reply. Restoring rolls files back and trims the chat to that turn, with one-click undo.
        </p>
        <div className="settings-toggle-row">
          <div className="settings-toggle-label">
            <span className="settings-toggle-name">Record checkpoints by default</span>
          </div>
          <ToggleSwitch checked={checkpointsEnabled} onChange={setCheckpointsEnabled} />
        </div>
      </div>
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
