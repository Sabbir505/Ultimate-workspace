// Settings → Agents → Crew: the declarative-subagent registry (Phase 1).
//
// A crew agent is a persisted, named identity — prompt body, tool allowlist,
// permission scope, engine/model, worktree policy, spawn budget — that later
// waves can spawn from the Run button (Phase 2.5), the `Task` tool (Phase 2),
// the session mesh (Phase 3) and automations (Phase 5). This panel is the
// list + editor only: definitions in, definitions out.
//
// Two things this surface is deliberate about (research doc §C.1):
//  - The engine's ENFORCEMENT TIER is shown, not hidden. `builtin` (provider
//    API / local GGUF) runs Relay's own in-process tool loop, so the allowlist
//    and the sandbox/approval policies genuinely gate every call. A
//    `harness:<id>` CLI runs its own native toolset, which the app cannot
//    restrict — only Relay's bridged tools are gated — so those rows carry an
//    "advisory" badge and say why. `crewEngineTier` owns that vocabulary and is
//    shared with Phase 4.
//  - The tool allowlist is advisory about the *engine ceiling*: write tools only
//    take effect under `workspace_write`, and spawn-capable tools are absent
//    from `CREW_TOOL_OPTIONS` so depth stays 1.
//
// Visual language is the Crew view's own (styles/crew.css): full-page rows,
// crew-chip toggles, and the shared Modal for the editor and the Run dialog.

import { Pencil, Play, Plus, ShieldCheck, Trash2, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Modal } from "../common/Modal";
import { CrewSelect } from "./CrewSelect";
import {
  CREW_TIER_LABELS,
  CREW_TOOL_OPTIONS,
  crewEngineTier,
  listHarnessModels,
  scanLocalModels,
  type CrewAgent,
  type CrewAgentInput,
  type CrewToolOption,
} from "../../lib/ipc";
import { AGENT_OPTIONS } from "../../lib/agents";
import { CREW_NEW_KEY, useCrewStore } from "../../state/crew";

/** The editor's local shape. Unlike the row it keeps "inherit" as an empty
 *  string (so the selects can use "" as a real option) and carries the
 *  allowlist as `string[] | null` — null meaning "inherit the engine default".
 *  `toInput` maps it onto the wire shape. */
interface CrewForm {
  name: string;
  description: string;
  promptMd: string;
  tools: string[] | null;
  engine: string;
  model: string;
  effort: string;
  sandboxPolicy: string;
  approvalPolicy: string;
  worktreePolicy: string;
  maxRounds: number;
  maxConcurrent: number;
}

const EMPTY_FORM: CrewForm = {
  name: "",
  description: "",
  promptMd: "",
  tools: null,
  engine: "",
  model: "",
  effort: "",
  sandboxPolicy: "read_only",
  approvalPolicy: "on_request",
  worktreePolicy: "inherit",
  maxRounds: 100,
  maxConcurrent: 2,
};

function formOf(agent: CrewAgent): CrewForm {
  return {
    name: agent.name,
    description: agent.description,
    promptMd: agent.promptMd,
    tools: agent.tools,
    engine: agent.engine ?? "",
    model: agent.model ?? "",
    effort: agent.effort ?? "",
    sandboxPolicy: agent.sandboxPolicy,
    approvalPolicy: agent.approvalPolicy,
    worktreePolicy: agent.worktreePolicy,
    maxRounds: agent.maxRounds,
    maxConcurrent: agent.maxConcurrent,
  };
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function toInput(form: CrewForm): CrewAgentInput {
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    promptMd: form.promptMd,
    // null = "no explicit allowlist" — the engine default applies.
    tools: form.tools,
    engine: form.engine || null,
    model: form.model.trim() || null,
    effort: form.effort.trim() || null,
    sandboxPolicy: form.sandboxPolicy,
    approvalPolicy: form.approvalPolicy,
    worktreePolicy: form.worktreePolicy,
    maxRounds: clampInt(form.maxRounds, 1, 100, 100),
    // No invented ceiling: the backend clamps this one to a minimum of 1.
    maxConcurrent: Number.isFinite(form.maxConcurrent) ? Math.max(1, Math.round(form.maxConcurrent)) : 2,
  };
}

/** Engine choices. The ids come from the shared catalog in lib/agents.ts — no
 *  crew-only engine ids — composed into the same string grammar the rest of
 *  the app uses for `chat_sessions.agent` ("builtin" | "local" | "harness:<id>"),
 *  so a definition's engine is directly usable as a session's engine. The API
 *  providers collapse into the single `builtin` engine: which provider runs is
 *  the model's `provider::model` prefix, not a separate engine. */
const ENGINE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Inherit — follow the parent session" },
  { value: "builtin", label: "Built-in loop (provider API)" },
  ...(AGENT_OPTIONS.filter((o) => o.group === "harness").map((o) => ({
    value: `harness:${o.id}`,
    label: o.label,
  })) as { value: string; label: string }[]),
  ...(AGENT_OPTIONS.filter((o) => o.group === "local").map((o) => ({
    value: "local",
    label: o.label,
  })) as { value: string; label: string }[]),
];

const SANDBOX_OPTIONS = [
  { value: "read_only", label: "Read only" },
  { value: "workspace_write", label: "Workspace write" },
];

const APPROVAL_OPTIONS = [
  { value: "on_request", label: "Ask when needed" },
  { value: "auto_edit", label: "Auto-approve edits" },
  { value: "full_access", label: "Full access" },
];

const WORKTREE_OPTIONS = [
  { value: "inherit", label: "Inherit the project's setting" },
  { value: "always", label: "Always provision a worktree" },
  { value: "never", label: "Never use a worktree" },
];

const BUILTIN_DELETE_HINT = "Built-in roles can't be deleted — edit their prompt instead.";

/** The enforcement badge. Advisory rows spell out the boundary in the title and
 *  in the row's meta line, so the badge is never read as a promise. */
function TierBadge({ engine }: { engine: string | null }) {
  const tier = crewEngineTier(engine);
  const copy = CREW_TIER_LABELS[tier];
  return (
    <span className={`crew-chip${tier === "enforced" ? " enforced" : ""}`} title={copy.detail}>
      {copy.label}
    </span>
  );
}

/** One allowlist toggle. The chip shows the tool name (the thing the backend
 *  matches on) and carries the human label as its tooltip. */
function ToolChip({
  tool,
  selected,
  disabled,
  onToggle,
}: {
  tool: CrewToolOption;
  selected: string[];
  disabled: boolean;
  onToggle: (id: string) => void;
}) {
  const on = selected.includes(tool.id);
  return (
    <button
      type="button"
      className="crew-chip"
      aria-pressed={on}
      disabled={disabled}
      title={`${tool.label} — ${tool.id}`}
      onClick={() => onToggle(tool.id)}
    >
      {tool.id}
    </button>
  );
}

/** One row: name, description, tier, tool count, scope summary, actions. */
function AgentRow({
  agent,
  busy,
  onEdit,
  onDelete,
  onRun,
}: {
  agent: CrewAgent;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onRun?: (agent: CrewAgent) => void;
}) {
  const tier = crewEngineTier(agent.engine);
  const toolCount = agent.tools === null ? null : agent.tools.length;
  return (
    <div className="crew-agent-row">
      <span className="crew-agent-name">{agent.name}</span>
      <span className="crew-agent-main">
        <span className="crew-agent-desc">
          {agent.description || "(no description)"}
        </span>
        <span className="crew-agent-meta">
          <TierBadge engine={agent.engine} />
          {tier === "advisory" && " CLI tools not restrictible"}
          {agent.builtin ? " · builtin" : " · " + (agent.engine || "inherits engine")}
          {agent.origin === "agent" && " · made by agent"}
          {toolCount === null ? " · engine default tools" : ` · ${toolCount} tool${toolCount === 1 ? "" : "s"}`}
          {` · ${agent.sandboxPolicy} / ${agent.approvalPolicy}`}
          {` · ${agent.maxRounds} rounds`}
        </span>
      </span>
      <span className="crew-agent-actions">
      {/* Run (Phase 2.5): the panel renders no run button until a caller
          passes `onRun`, so the settings surface stays registry-only. */}
      {onRun && (
        <button
          type="button"
          className="ghost"
          onClick={() => onRun(agent)}
          disabled={busy}
          title="Run this agent on a task"
          aria-label={`Run ${agent.name}`}
        >
          <Play size={16} />
        </button>
      )}
      <button
        type="button"
        className="ghost"
        onClick={onEdit}
        disabled={busy}
        title="Edit this agent"
        aria-label={`Edit ${agent.name}`}
      >
        <Pencil size={16} />
      </button>
      <button
        type="button"
        className="ghost crew-danger"
        onClick={onDelete}
        disabled={busy || agent.builtin}
        title={agent.builtin ? BUILTIN_DELETE_HINT : "Delete this agent"}
        aria-label={`Delete ${agent.name}`}
      >
        <Trash2 size={16} />
      </button>
      </span>
    </div>
  );
}

export function CrewPanel({ onRun }: { onRun?: (agent: CrewAgent) => void } = {}) {
  const agents = useCrewStore((s) => s.agents);
  const loaded = useCrewStore((s) => s.loaded);
  const error = useCrewStore((s) => s.error);
  const busy = useCrewStore((s) => s.busy);
  const load = useCrewStore((s) => s.load);
  const create = useCrewStore((s) => s.create);
  const update = useCrewStore((s) => s.update);
  const remove = useCrewStore((s) => s.remove);

  /** id of the row being edited; null + an open editor = the create form. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [form, setForm] = useState<CrewForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  const editing = editingId ? agents.find((a) => a.id === editingId) : undefined;
  const saveKey = editingId ?? CREW_NEW_KEY;
  const saving = busy[saveKey] === true;
  const inherited = form.tools === null;
  const selected = form.tools ?? [];

  // A stored engine the catalog doesn't know (an ACP agent, say) must still
  // render as its own option — otherwise opening the editor would silently
  // rewrite the agent onto the "inherit" default on the next save.
  const engineOptions = useMemo(() => {
    if (!form.engine || ENGINE_OPTIONS.some((o) => o.value === form.engine)) return ENGINE_OPTIONS;
    return [...ENGINE_OPTIONS, { value: form.engine, label: form.engine }];
  }, [form.engine]);

  // Model catalog for the chosen engine family — the same method the
  // Subagent model panel uses: harnesses list their CLI's own catalog
  // (listHarnessModels), local lists the sidecar folder (scanLocalModels).
  // Inherit/builtin/ACP have no single catalog (builtin models are pinned
  // per provider as `provider::model`), so those keep the free-text input.
  const [modelOptions, setModelOptions] = useState<{ id: string; label: string }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  useEffect(() => {
    const fam = form.engine;
    if (!fam || fam === "builtin" || fam.startsWith("acp:")) {
      setModelOptions([]);
      setModelsLoading(false);
      return;
    }
    let cancelled = false;
    setModelsLoading(true);
    setModelOptions([]);
    void (async () => {
      try {
        if (fam === "local") {
          const list = await scanLocalModels();
          if (!cancelled && list) {
            setModelOptions(
              [...new Set(list.map((m) => m.name || m.filename))].map((id) => ({ id, label: id })),
            );
          }
        } else if (fam.startsWith("harness:")) {
          const cfg = await listHarnessModels(fam.slice("harness:".length));
          if (!cancelled && cfg) {
            setModelOptions(cfg.models.map((m) => ({ id: m.id, label: m.label || m.id })));
          }
        }
      } catch {
        // Listing failed (CLI absent, probe raced) — the free-text input stays.
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [form.engine]);

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setEditorOpen(true);
  };

  const openEdit = (agent: CrewAgent) => {
    setEditingId(agent.id);
    setForm(formOf(agent));
    setFormError(null);
    setEditorOpen(true);
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setEditingId(null);
    setFormError(null);
  };

  const toggleTool = (id: string) => {
    setForm((f) => {
      const current = f.tools ?? [];
      const next = current.includes(id) ? current.filter((t) => t !== id) : [...current, id];
      return { ...f, tools: next };
    });
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      setFormError("Give the agent a name — it's how the Task tool refers to it.");
      return;
    }
    if (form.description.trim().length > 200) {
      setFormError("Keep the description to 200 characters or fewer.");
      return;
    }
    const input = toInput(form);
    const saved = editingId ? await update(editingId, input) : await create(input);
    // A failed save keeps the editor open with the store's error beside it.
    if (saved) closeEditor();
  };

  const numField = (key: "maxRounds" | "maxConcurrent", raw: string) => {
    const n = Number.parseInt(raw, 10);
    setForm((f) => ({ ...f, [key]: Number.isFinite(n) ? n : NaN }));
  };

  return (
    <div className="crew-section">
      <div className="crew-section-head">
        <h3>Agents</h3>
        <span className="crew-spacer" />
        {agents.length > 0 && (
          <span className="panel-count">
            {agents.length} agent{agents.length === 1 ? "" : "s"}
          </span>
        )}
        <button className="primary" onClick={openCreate} type="button">
          <Plus size={16} /> New agent
        </button>
      </div>

      <div className="perm-card perm-info-card">
        <ShieldCheck className="perm-icon" size={20} />
        <div>
          <div className="perm-info-title">Named subagents, defined as data</div>
          <div className="perm-info-body">
            A crew agent is a saved identity — a prompt, a tool allowlist, a permission
            scope, a model and a spawn budget. Relay's own tool loop enforces all of it
            (<span className="mono">enforced</span>); a CLI harness runs its own tools that
            the app can only advise on (<span className="mono">advisory</span>). The badge on
            each row tells you which one you'd get.
          </div>
        </div>
      </div>

      {error && <div className="settings-note crew-error">{error}</div>}

      {editorOpen && (
        <Modal
          className="crew-editor-modal crew-glass-modal"
          title={editingId ? `Edit ${editing?.name ?? "agent"}` : "New agent"}
          onClose={saving ? undefined : closeEditor}
          actions={
            <>
              <button className="ghost" onClick={closeEditor} disabled={saving} type="button">
                Cancel
              </button>
              <button
                className="primary"
                onClick={() => void handleSave()}
                disabled={saving}
                type="button"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </>
          }
        >
          <div className="crew-editor-body">
            <div className="settings-section">
              <div className="settings-section-title">Name</div>
              <input
                className="perm-pattern-input"
                type="text"
                value={form.name}
                aria-label="Agent name"
                placeholder="doc-writer"
                disabled={saving || !!editing?.builtin}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <p className="settings-section-hint">
                {editing?.builtin
                  ? "Built-in roles keep their name — it's the Task tool's enum value."
                  : "Letters, digits and dashes. The Task tool refers to the agent by this name."}
              </p>
            </div>

            <div className="settings-section">
              <div className="settings-section-title">Description</div>
              <input
                className="perm-pattern-input"
                type="text"
                value={form.description}
                aria-label="Agent description"
                placeholder="Writes and polishes user documentation"
                disabled={saving}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>

            <div className="settings-section">
              <div className="settings-section-title">Prompt</div>
              <textarea
                className="perm-pattern-input mono crew-editor-textarea"
                rows={10}
                value={form.promptMd}
                aria-label="Agent prompt"
                placeholder={"You are…\n\n- do this\n- never do that"}
                disabled={saving}
                onChange={(e) => setForm({ ...form, promptMd: e.target.value })}
              />
              <p className="settings-section-hint">
                The system prompt this agent runs under. Markdown is fine.
              </p>
            </div>

            <div className="settings-section">
              <div className="settings-section-title">
                Tools{" "}
                <span className="panel-count">
                  {inherited ? "engine default" : `${selected.length} selected`}
                </span>
              </div>
              <div className="crew-chip-group" role="group" aria-label="Read-only tools">
                {CREW_TOOL_OPTIONS.filter((t) => t.group === "read").map((t) => (
                  <ToolChip key={t.id} tool={t} selected={selected} disabled={saving} onToggle={toggleTool} />
                ))}
              </div>
            <div className="settings-section-hint">
              Write tools — only granted under the workspace-write sandbox
            </div>
              <div className="crew-chip-group" role="group" aria-label="Write tools">
                {CREW_TOOL_OPTIONS.filter((t) => t.group === "write").map((t) => (
                  <ToolChip key={t.id} tool={t} selected={selected} disabled={saving} onToggle={toggleTool} />
                ))}
              </div>
              <div className="crew-chip-group">
                <button
                  type="button"
                  className="crew-chip"
                  disabled={saving || inherited}
                  onClick={() => setForm({ ...form, tools: null })}
                >
                  use engine default
                </button>
                <button
                  type="button"
                  className="crew-chip"
                  disabled={saving || inherited || selected.length === 0}
                  onClick={() => setForm({ ...form, tools: [] })}
                >
                  select none
                </button>
              </div>
              <p className="settings-section-hint">
                {inherited
                  ? "No explicit allowlist — the engine's own read-only default applies."
                  : "The allowlist is intersected with the engine's ceiling: write tools still need the workspace-write sandbox."}
              </p>
            </div>

            <div className="settings-section">
              <div className="settings-section-title">Engine &amp; model</div>
            <div className="crew-editor-row">
              <CrewSelect
                ariaLabel="Engine"
                value={form.engine}
                options={engineOptions}
                disabled={saving}
                onChange={(v) => setForm((f) => ({ ...f, engine: v, model: "" }))}
              />
              {modelOptions.length > 0 && !modelsLoading ? (
                <CrewSelect
                  ariaLabel="Model"
                  value={modelOptions.some((m) => m.id === form.model) ? form.model : ""}
                  options={[
                    { value: "", label: "Engine default model" },
                    ...modelOptions.map((m) => ({ value: m.id, label: m.label })),
                  ]}
                  disabled={saving}
                  onChange={(v) => setForm((f) => ({ ...f, model: v }))}
                />
              ) : (
                <input
                  className="perm-pattern-input"
                  type="text"
                  value={form.model}
                  aria-label="Model"
                  placeholder={
                    modelsLoading
                      ? "Loading models…"
                      : "provider::model — e.g. openrouter::x-ai/grok-4"
                  }
                  disabled={saving}
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                />
              )}
            </div>
              <p className="settings-section-hint">
                <TierBadge engine={form.engine || null} />{" "}
                {CREW_TIER_LABELS[crewEngineTier(form.engine || null)].detail} Leave the model
                blank to inherit, or write <span className="mono">provider::model</span> to pin one.
              </p>
            </div>

            <div className="settings-section">
              <div className="settings-section-title">Scope &amp; budget</div>
              <div className="crew-editor-row">
                <label className="crew-field">
                  <span className="crew-field-label">Sandbox</span>
                  <CrewSelect
                    ariaLabel="Sandbox policy"
                    value={form.sandboxPolicy}
                    options={SANDBOX_OPTIONS}
                    disabled={saving}
                    onChange={(v) => setForm((f) => ({ ...f, sandboxPolicy: v }))}
                  />
                </label>
                <label className="crew-field">
                  <span className="crew-field-label">Approvals</span>
                  <CrewSelect
                    ariaLabel="Approval policy"
                    value={form.approvalPolicy}
                    options={APPROVAL_OPTIONS}
                    disabled={saving}
                    onChange={(v) => setForm((f) => ({ ...f, approvalPolicy: v }))}
                  />
                </label>
                <label className="crew-field">
                  <span className="crew-field-label">Worktree</span>
                  <CrewSelect
                    ariaLabel="Worktree policy"
                    value={form.worktreePolicy}
                    options={WORKTREE_OPTIONS}
                    disabled={saving}
                    onChange={(v) => setForm((f) => ({ ...f, worktreePolicy: v }))}
                  />
                </label>
              </div>
              <div className="crew-editor-row">
                <label className="crew-field">
                  <span className="crew-field-label">Max rounds (1–100)</span>
                  <input
                    className="crew-field-input"
                    type="number"
                    min={1}
                    max={100}
                    value={Number.isFinite(form.maxRounds) ? form.maxRounds : ""}
                    aria-label="Max rounds"
                    disabled={saving}
                    onChange={(e) => numField("maxRounds", e.target.value)}
                  />
                </label>
                <label className="crew-field">
                  <span className="crew-field-label">Concurrent runs (1 or more)</span>
                  <input
                    className="crew-field-input"
                    type="number"
                    min={1}
                    value={Number.isFinite(form.maxConcurrent) ? form.maxConcurrent : ""}
                    aria-label="Max concurrent"
                    disabled={saving}
                    onChange={(e) => numField("maxConcurrent", e.target.value)}
                  />
                </label>
              </div>
            </div>

            {formError && <p className="crew-error">{formError}</p>}
          </div>
        </Modal>
      )}

      {!loaded ? (
        <div className="crew-empty">Loading agents…</div>
      ) : agents.length === 0 ? (
        <div className="crew-empty">
          <Users size={22} />
          <div>
            No crew agents yet. Add one above — a named prompt with its own tool
            allowlist and permission scope, ready to hand to the Task tool or run on
            its own.
          </div>
        </div>
      ) : (
        <div className="crew-agent-list">
          {agents.map((a) => (
            <AgentRow
              key={a.id}
              agent={a}
              busy={busy[a.id] === true}
              onEdit={() => openEdit(a)}
              onDelete={() => void remove(a.id)}
              onRun={onRun}
            />
          ))}
        </div>
      )}
    </div>
  );
}
