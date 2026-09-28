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
// Visual language is HooksPanel's (settings-form / panel-head / perm-card /
// perm-chip / perm-rule-row) and PermissionRulesPanel's chip picker — no new
// stylesheet.

import { Pencil, Play, Plus, ShieldCheck, Trash2, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  CREW_TIER_LABELS,
  CREW_TOOL_OPTIONS,
  crewEngineTier,
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
    <span
      className="perm-chip"
      title={copy.detail}
      style={
        tier === "enforced"
          ? { color: "var(--accent)", borderColor: "var(--accent)", borderStyle: "solid" }
          : undefined
      }
    >
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
      className="perm-chip"
      aria-pressed={on}
      disabled={disabled}
      title={`${tool.label} — ${tool.id}`}
      style={
        on
          ? {
              color: "var(--accent)",
              background: "var(--accent-soft)",
              borderColor: "var(--accent)",
              borderStyle: "solid",
            }
          : undefined
      }
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
    <div className="perm-rule-row" style={{ flexWrap: "wrap", alignItems: "flex-start" }}>
      <span className="perm-rule-tool" style={{ minWidth: 0 }}>{agent.name}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span className="perm-rule-pattern">
          {agent.description || "(no description)"}
        </span>
        <span style={{ display: "block", opacity: 0.7, marginTop: 4, fontSize: 12 }}>
          <TierBadge engine={agent.engine} />
          {tier === "advisory" && " CLI tools not restrictible"}
          {agent.builtin ? " · builtin" : " · " + (agent.engine || "inherits engine")}
          {toolCount === null ? " · engine default tools" : ` · ${toolCount} tool${toolCount === 1 ? "" : "s"}`}
          {` · ${agent.sandboxPolicy} / ${agent.approvalPolicy}`}
          {` · ${agent.maxRounds} rounds`}
        </span>
      </span>
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
        className="ghost"
        style={{ color: "var(--danger, #f85149)" }}
        onClick={onDelete}
        disabled={busy || agent.builtin}
        title={agent.builtin ? BUILTIN_DELETE_HINT : "Delete this agent"}
        aria-label={`Delete ${agent.name}`}
      >
        <Trash2 size={16} />
      </button>
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
    <div className="settings-form">
      <div className="panel-head">
        <h3>Crew</h3>
        {agents.length > 0 && (
          <span className="panel-count">
            {agents.length} agent{agents.length === 1 ? "" : "s"}
          </span>
        )}
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

      {!editorOpen && (
        <div className="perm-add-card">
          <div className="perm-add-row">
            <button className="primary" onClick={openCreate} type="button">
              <Plus size={16} /> New agent
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="settings-note" style={{ color: "var(--danger, #f85149)" }}>
          {error}
        </div>
      )}

      {editorOpen && (
        <div className="perm-card">
          <div className="settings-section-title" style={{ marginBottom: 8 }}>
            {editingId ? `Edit ${editing?.name ?? "agent"}` : "New agent"}
          </div>

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
            <p className="settings-section-hint" style={{ marginTop: 6, marginBottom: 0 }}>
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
              className="perm-pattern-input mono"
              rows={10}
              value={form.promptMd}
              aria-label="Agent prompt"
              placeholder={"You are…\n\n- do this\n- never do that"}
              disabled={saving}
              onChange={(e) => setForm({ ...form, promptMd: e.target.value })}
              style={{ minHeight: 180, minWidth: 0 }}
            />
            <p className="settings-section-hint" style={{ marginTop: 6, marginBottom: 0 }}>
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
            <div className="perm-chips" role="group" aria-label="Read-only tools">
              {CREW_TOOL_OPTIONS.filter((t) => t.group === "read").map((t) => (
                <ToolChip key={t.id} tool={t} selected={selected} disabled={saving} onToggle={toggleTool} />
              ))}
            </div>
            <div className="settings-section-hint" style={{ margin: "8px 0 4px" }}>
              Write tools — only granted under the workspace-write sandbox
            </div>
            <div className="perm-chips" role="group" aria-label="Write tools">
              {CREW_TOOL_OPTIONS.filter((t) => t.group === "write").map((t) => (
                <ToolChip key={t.id} tool={t} selected={selected} disabled={saving} onToggle={toggleTool} />
              ))}
            </div>
            <div className="perm-chips">
              <button
                type="button"
                className="perm-chip"
                disabled={saving || inherited}
                onClick={() => setForm({ ...form, tools: null })}
              >
                use engine default
              </button>
              <button
                type="button"
                className="perm-chip"
                disabled={saving || inherited || selected.length === 0}
                onClick={() => setForm({ ...form, tools: [] })}
              >
                select none
              </button>
            </div>
            <p className="settings-section-hint" style={{ marginTop: 6, marginBottom: 0 }}>
              {inherited
                ? "No explicit allowlist — the engine's own read-only default applies."
                : "The allowlist is intersected with the engine's ceiling: write tools still need the workspace-write sandbox."}
            </p>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">Engine &amp; model</div>
            <div className="perm-add-row">
              <select
                className="perm-tool-select"
                value={form.engine}
                aria-label="Engine"
                disabled={saving}
                onChange={(e) => setForm({ ...form, engine: e.target.value })}
              >
                {engineOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <input
                className="perm-pattern-input"
                type="text"
                value={form.model}
                aria-label="Model"
                placeholder="provider::model — e.g. openrouter::x-ai/grok-4"
                disabled={saving}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
              />
            </div>
            <p className="settings-section-hint" style={{ marginTop: 6, marginBottom: 0 }}>
              <TierBadge engine={form.engine || null} />{" "}
              {CREW_TIER_LABELS[crewEngineTier(form.engine || null)].detail} Leave the model
              blank to inherit, or write <span className="mono">provider::model</span> to pin one.
            </p>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">Scope &amp; budget</div>
            <div className="perm-add-row">
              <select
                className="perm-tool-select"
                value={form.sandboxPolicy}
                aria-label="Sandbox policy"
                disabled={saving}
                onChange={(e) => setForm({ ...form, sandboxPolicy: e.target.value })}
              >
                {SANDBOX_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <select
                className="perm-tool-select"
                value={form.approvalPolicy}
                aria-label="Approval policy"
                disabled={saving}
                onChange={(e) => setForm({ ...form, approvalPolicy: e.target.value })}
              >
                {APPROVAL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <select
                className="perm-tool-select"
                value={form.worktreePolicy}
                aria-label="Worktree policy"
                disabled={saving}
                onChange={(e) => setForm({ ...form, worktreePolicy: e.target.value })}
              >
                {WORKTREE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="perm-add-row">
              <label style={{ display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={Number.isFinite(form.maxRounds) ? form.maxRounds : ""}
                  aria-label="Max rounds"
                  disabled={saving}
                  onChange={(e) => numField("maxRounds", e.target.value)}
                />
                rounds (1–100)
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
                <input
                  type="number"
                  min={1}
                  value={Number.isFinite(form.maxConcurrent) ? form.maxConcurrent : ""}
                  aria-label="Max concurrent"
                  disabled={saving}
                  onChange={(e) => numField("maxConcurrent", e.target.value)}
                />
                concurrent runs (1 or more)
              </label>
            </div>
          </div>

          {formError && (
            <div className="settings-note" style={{ color: "var(--danger, #f85149)" }}>
              {formError}
            </div>
          )}

          <div className="perm-add-row">
            <button className="primary" onClick={() => void handleSave()} disabled={saving} type="button">
              {saving ? "Saving…" : "Save"}
            </button>
            <button className="ghost" onClick={closeEditor} disabled={saving} type="button">
              Cancel
            </button>
          </div>
        </div>
      )}

      {!loaded ? (
        <div className="empty-reserved">
          <div className="empty-text">Loading agents…</div>
        </div>
      ) : agents.length === 0 ? (
        <div className="empty-reserved">
          <Users className="empty-icon" size={22} />
          <div className="empty-text">
            No crew agents yet. Add one above — a named prompt with its own tool
            allowlist and permission scope, ready to hand to the Task tool or run on
            its own.
          </div>
        </div>
      ) : (
        <div className="perm-rules-list">
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
