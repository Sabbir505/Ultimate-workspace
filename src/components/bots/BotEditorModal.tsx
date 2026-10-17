// BotEditorModal — the ONLY place a bot is created or edited
// (docs/architecture/BOTS.md: there is deliberately no Settings page for
// bots). Create and edit share the form; the footer differs.
//
// The pet picker is the fun part and it is load-bearing: the chosen companion
// is what docks on the composer and the search bar (src/components/pet), so a
// bot is visible and reachable without opening this view.
//
// There is no engine/model picker on purpose: a bot inherits the ACTIVE chat's
// engine and model, so you switch models from the composer, not from here.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Bot, BotInput, BotMemoryRow, DeleteBotOutcome } from "../../lib/ipc/bots";
import { BOT_PETS } from "../../lib/ipc/bots";
import { PetAvatar } from "../pet/PetAvatar";
import { relativeTime } from "../../lib/relativeTime";

const EMOJI_CHOICES = ["🤖", "🛰️", "🔎", "📚", "🧠", "🛠️", "🌱", "📝", "⚙️", "🧭"];

export interface BotEditorModalProps {
  bot?: Bot | null;
  onClose: () => void;
  onCreate: (input: BotInput) => Promise<Bot>;
  onUpdate?: (botId: string, patch: Partial<BotInput>) => Promise<Bot>;
  onDelete?: (botId: string, purgeMemory?: boolean) => Promise<void>;
  onRun?: (botId: string, prompt?: string) => Promise<unknown>;
  listMemory?: (botId: string) => Promise<BotMemoryRow[]>;
  deleteMemory?: (botId: string, memoryId: string) => Promise<void>;
  onOpenAutomations?: () => void;
  refresh?: () => Promise<void>;
}

export function BotEditorModal({
  bot,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
  onRun,
  listMemory,
  deleteMemory,
  onOpenAutomations,
  refresh,
}: BotEditorModalProps) {
  const editing = Boolean(bot);
  const [name, setName] = useState(bot?.name ?? "");
  const [description, setDescription] = useState(bot?.description ?? "");
  const [emoji, setEmoji] = useState(bot?.emoji ?? "🤖");
  const [pet, setPet] = useState(bot?.pet ?? "");
  const [persona, setPersona] = useState(bot?.systemPrompt ?? "");
  // `enabled` gates standing jobs + run_bot/ask_bot; the thread stays usable.
  // New bots created here are enabled by default (the owner's own path — the
  // agent's create_bot is the one that lands disabled).
  const [enabled, setEnabled] = useState(bot?.enabled ?? true);
  const [toolsEnabled, setToolsEnabled] = useState(bot?.toolsEnabled ?? true);
  const [memoryEnabled, setMemoryEnabled] = useState(bot?.memoryEnabled ?? true);
  const [inheritGlobalPrompt, setInheritGlobalPrompt] = useState(bot?.inheritGlobalPrompt ?? true);
  const [memoryReadDefault, setMemoryReadDefault] = useState(bot?.memoryReadDefault ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [purgeMemory, setPurgeMemory] = useState(false);
  const [memories, setMemories] = useState<BotMemoryRow[] | null>(null);

  useEffect(() => {
    if (!editing || !bot || !listMemory) return;
    let cancelled = false;
    void listMemory(bot.id)
      .then((rows) => {
        if (!cancelled) setMemories(rows ?? []);
      })
      .catch(() => {
        if (!cancelled) setMemories([]);
      });
    return () => {
      cancelled = true;
    };
  }, [editing, bot, listMemory]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const buildInput = (): BotInput => ({
    name: name.trim(),
    description,
    emoji,
    pet,
    systemPrompt: persona,
    enabled,
    toolsEnabled,
    memoryEnabled,
    inheritGlobalPrompt,
    memoryReadDefault,
  });

  const save = async () => {
    if (!name.trim()) {
      setError("Bot name can't be empty");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editing && bot && onUpdate) {
        // Patch semantics: only send what changed, so a save can never blank
        // a field the form does not carry (and can never re-enable a bot).
        const patch: Partial<BotInput> = {};
        const next = buildInput();
        if (next.name !== bot.name) patch.name = next.name;
        if (next.description !== bot.description) patch.description = next.description;
        if (next.emoji !== bot.emoji) patch.emoji = next.emoji;
        if (next.pet !== bot.pet) patch.pet = next.pet;
        if (next.systemPrompt !== bot.systemPrompt) patch.systemPrompt = next.systemPrompt;
        // The owner may enable/disable from here; the agent's update_bot tool
        // deliberately drops `enabled` (enabling is the owner's call).
        if (next.enabled !== bot.enabled) patch.enabled = next.enabled;
        if (next.toolsEnabled !== bot.toolsEnabled) patch.toolsEnabled = next.toolsEnabled;
        if (next.memoryEnabled !== bot.memoryEnabled) patch.memoryEnabled = next.memoryEnabled;
        if (next.inheritGlobalPrompt !== bot.inheritGlobalPrompt) {
          patch.inheritGlobalPrompt = next.inheritGlobalPrompt;
        }
        if (next.memoryReadDefault !== bot.memoryReadDefault) patch.memoryReadDefault = next.memoryReadDefault;
        await onUpdate(bot.id, patch);
      } else {
        await onCreate(buildInput());
      }
      onClose();
    } catch (e) {
      // The backend is authoritative (empty / over 40 chars / duplicate name):
      // show its message and keep the modal open.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // PORTAL to <body>: the pet stage is a fixed canvas appended to <body> at
  // z-index 38. A modal rendered inside the Bots view lives in that view's
  // stacking context, so the composer's docked pet drew OVER the editor (the
  // "pet bleeding into the edit modal" report). At body level this scrim's
  // z-index 60 wins. Pets INSIDE the modal render `flat` (in-DOM chips): the
  // shared stage would otherwise paint them behind the glass (see PetAvatar).
  return createPortal(
    <div className="bots-modal-scrim" onClick={onClose}>
      <div
        className="bots-modal"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? `Edit ${bot?.name}` : "New bot"}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="bots-modal-head">
          <span className="bots-modal-identity" aria-hidden="true">
            {pet ? (
              <PetAvatar species={pet} size={30} flat />
            ) : (
              <span className="bots-modal-emoji">{emoji}</span>
            )}
          </span>
          <div className="bots-modal-heading">
            <h2>{editing ? "Edit bot" : "New bot"}</h2>
            <p>
              {editing
                ? "Update how this bot thinks and acts."
                : "A named agent with its own persona, memory and standing jobs."}
            </p>
          </div>
          <button type="button" className="bots-modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="bots-modal-body">
          <div className="bots-form-row">
            <label className="bots-field bots-field-grow">
              <span>Name</span>
              <input
                value={name}
                maxLength={40}
                aria-label="Name"
                onChange={(e) => setName(e.target.value)}
                placeholder="Atlas"
              />
            </label>
          </div>

          <label className="bots-field">
            <span>Description</span>
            <input
              value={description}
              aria-label="Description"
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Watches the repo and reports drift"
            />
            <small className="bots-hint">One line, shown under the name in the rail.</small>
          </label>

          <div className="bots-field">
            <span>Emoji</span>
            <div className="bots-emoji-row">
              {EMOJI_CHOICES.map((e) => (
                <button
                  key={e}
                  type="button"
                  aria-label={`Emoji ${e}`}
                  className={`bots-emoji-choice${e === emoji ? " is-on" : ""}`}
                  onClick={() => setEmoji(e)}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>

          <div className="bots-field">
            <span>Pet</span>
            <div className="bots-pet-grid" role="radiogroup" aria-label="Pet">
              <button
                type="button"
                role="radio"
                aria-checked={pet === ""}
                className={`bots-pet-choice${pet === "" ? " is-on" : ""}`}
                onClick={() => setPet("")}
              >
                <span className="bots-pet-none">{emoji}</span>
                <span className="bots-pet-label">None</span>
              </button>
              {BOT_PETS.map((species) => (
                <button
                  key={species}
                  type="button"
                  role="radio"
                  aria-checked={pet === species}
                  className={`bots-pet-choice${pet === species ? " is-on" : ""}`}
                  onClick={() => setPet(species)}
                >
                  <PetAvatar species={species} size={40} flat />
                  <span className="bots-pet-label">{species}</span>
                </button>
              ))}
            </div>
            <small className="bots-hint">
              The pet docks on the composer and the search bar — click it there to open this bot.
            </small>
          </div>

          <label className="bots-field">
            <span>Persona</span>
            <textarea
              rows={4}
              value={persona}
              aria-label="Persona"
              onChange={(e) => setPersona(e.target.value)}
              placeholder="Who is this bot and how does it behave?"
            />
            <small className="bots-hint">
              {inheritGlobalPrompt
                ? "Layers on top of your assistant prompt."
                : "Replaces your assistant prompt for this bot."}
            </small>
          </label>

          <div className="bots-field">
            <span>Behaviour</span>
            <div className="bots-toggles">
              <label className="bots-toggle">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                <span className="bots-toggle-text">
                  Active
                  <small>Off = standing jobs are skipped and Run now is refused. The chat still works.</small>
                </span>
                <span className="bots-switch" aria-hidden="true">
                  <span className="bots-switch-knob" />
                </span>
              </label>
              <label className="bots-toggle">
                <input
                  type="checkbox"
                  checked={toolsEnabled}
                  onChange={(e) => setToolsEnabled(e.target.checked)}
                />
                <span className="bots-toggle-text">
                  Allow tools
                  <small>Off = chat only. It can never act.</small>
                </span>
                <span className="bots-switch" aria-hidden="true">
                  <span className="bots-switch-knob" />
                </span>
              </label>
              <label className="bots-toggle">
                <input
                  type="checkbox"
                  checked={memoryEnabled}
                  onChange={(e) => setMemoryEnabled(e.target.checked)}
                />
                <span className="bots-toggle-text">
                  Memory
                  <small>Its own memory, separate from yours.</small>
                </span>
                <span className="bots-switch" aria-hidden="true">
                  <span className="bots-switch-knob" />
                </span>
              </label>
              <label className="bots-toggle">
                <input
                  type="checkbox"
                  checked={inheritGlobalPrompt}
                  onChange={(e) => setInheritGlobalPrompt(e.target.checked)}
                />
                <span className="bots-toggle-text">
                  Use my global instructions
                  <small>Your assistant prompt still applies.</small>
                </span>
                <span className="bots-switch" aria-hidden="true">
                  <span className="bots-switch-knob" />
                </span>
              </label>
              <label className="bots-toggle">
                <input
                  type="checkbox"
                  checked={memoryReadDefault}
                  onChange={(e) => setMemoryReadDefault(e.target.checked)}
                />
                <span className="bots-toggle-text">
                  Can read my memory
                  <small>Read only — it can never change or delete yours.</small>
                </span>
                <span className="bots-switch" aria-hidden="true">
                  <span className="bots-switch-knob" />
                </span>
              </label>
            </div>
          </div>

          <p className="bots-model-note">
            This bot runs on the active chat's engine and model — switch models from the composer.
          </p>

          {editing && bot && (
            <div className="bots-field bots-memory">
              <span>Memory</span>
              {memories === null ? (
                <small className="bots-hint">Loading…</small>
              ) : memories.length === 0 ? (
                <small className="bots-hint">Nothing remembered yet.</small>
              ) : (
                <ul className="bots-memory-list">
                  {memories.map((m) => (
                    <li key={m.id}>
                      <span className="bots-memory-content">{m.content}</span>
                      <span className="bots-memory-meta">
                        {m.kind} · importance {m.importance} · {relativeTime(m.createdAt)}
                      </span>
                      {deleteMemory && (
                        <button
                          type="button"
                          onClick={async () => {
                            await deleteMemory(bot.id, m.id);
                            const rows = await listMemory?.(bot.id);
                            setMemories(rows ?? []);
                          }}
                        >
                          Delete
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {editing && confirmDelete && (
            <div className="bots-delete-note" role="alert">
              <p>
                Deleting this bot removes its standing jobs and run history. Its conversation
                stays in chat history as a normal chat.
              </p>
              <label className="bots-toggle">
                <input
                  type="checkbox"
                  checked={purgeMemory}
                  onChange={(e) => setPurgeMemory(e.target.checked)}
                />
                <span>
                  Also delete its {memories?.length ?? 0} memories
                  <small>Otherwise they are kept, hidden.</small>
                </span>
              </label>
            </div>
          )}

          {error && (
            <div className="bots-modal-error" role="alert">
              {error}
            </div>
          )}
        </div>

        <footer className="bots-modal-foot">
          {editing && bot && onDelete && (
            <button
              type="button"
              className="danger"
              onClick={async () => {
                if (!confirmDelete) {
                  setConfirmDelete(true);
                  return;
                }
                try {
                  await onDelete(bot.id, purgeMemory);
                  onClose();
                } catch (e) {
                  // Keep the modal open and surface the backend's reason
                  // instead of closing on a failed delete.
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              {confirmDelete ? "Confirm delete" : "Delete"}
            </button>
          )}
          {editing && bot && onRun && (
            <button
              type="button"
              onClick={async () => {
                try {
                  await onRun(bot.id);
                  await refresh?.();
                } catch (e) {
                  // e.g. a disabled bot refuses run_bot — show why.
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              Run now
            </button>
          )}
          {editing && onOpenAutomations && (
            <button type="button" onClick={onOpenAutomations}>
              Manage jobs
            </button>
          )}
          <span className="bots-modal-spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
