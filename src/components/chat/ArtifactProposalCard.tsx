// Artifact proposal card for conversational artifact creation.
// Renders a structured preview of the proposed artifact with Regenerate / Edit / Create actions.
// States: "generating" (spinner — "Creating artifact…" on first generation,
// "Regenerating artifact…" once a spec already exists) | "ready" (buttons) |
// "editing" (in editor) | "created" | "rejected"
import { useEffect, useState, useMemo } from "react";
import type { ArtifactProposal, ArtifactSpec, SkillSpec, LoopSpec, PromptTemplateSpec, AutomationSpec } from "../../lib/ipc";
import { listHarnessModels, listChatModels } from "../../lib/ipc";
import { MissingFieldsPrompt } from "./MissingFieldsPrompt";
import { GlassSelect } from "../common/GlassSelect";

type ProposalState = "generating" | "ready" | "editing" | "created" | "rejected";

/** Agent options for automation runs — mirrors AutomationsView's AGENT_OPTIONS
 *  so both surfaces offer the identical set (harnesses first, then API
 *  providers, then local). */
const AGENT_OPTIONS: { id: string; label: string; group: "harness" | "api" | "local" }[] = [
  { id: "claude_code", label: "Claude Code (harness)", group: "harness" },
  { id: "opencode", label: "OpenCode (harness)", group: "harness" },
  { id: "pi", label: "Pi (harness)", group: "harness" },
  { id: "omp", label: "Omp (harness)", group: "harness" },
  { id: "commandcode", label: "CommandCode (harness)", group: "harness" },
  { id: "anthropic", label: "Anthropic API", group: "api" },
  { id: "openai", label: "OpenAI API", group: "api" },
  { id: "openrouter", label: "OpenRouter", group: "api" },
  { id: "anthropic_compatible", label: "Anthropic-compatible", group: "api" },
  { id: "openai_compatible", label: "OpenAI-compatible", group: "api" },
  { id: "local_gguf", label: "Local GGUF", group: "local" },
];

interface ProposalCardState {
  state: ProposalState;
  /** When true, shows a "thinking" animation with subtle pulse. */
  isThinking: boolean;
  /** Name being decided - used during initial generation. */
  nameInProgress?: string;
  /** Description being refined - used during initial generation. */
  descriptionInProgress?: string;
}

interface ArtifactProposalCardProps {
  /** Stable wrapper ID used by all action callbacks. */
  proposalId: string;
  proposal: ArtifactProposal;
  state: ProposalState;
  onRegenerate: (proposalId: string, instruction?: string) => void;
  onEdit: (proposalId: string) => void;
  onCreate: (proposalId: string) => void;
  onDismiss: (proposalId: string) => void;
  /** Called when the user fills fields that the generator could not infer. */
  onSubmitMissingFields?: (proposalId: string, filledFields: Record<string, unknown>) => void;
  /** Called when the user edits a spec field in-place (e.g. picks the
   *  automation's harness/model). The parent persists it into the proposal
   *  store so "Create" uses the updated spec. */
  onUpdateSpec?: (proposalId: string, spec: ArtifactSpec) => void;
}

/** Accept both the backend's flat spec and the legacy temporary wrapper. */
function normalizeArtifactSpec(spec: ArtifactSpec | undefined): ArtifactSpec | undefined {
  if (!spec || typeof spec !== "object") return undefined;
  const candidate = spec as ArtifactSpec & { spec?: unknown };
  if (candidate.spec && typeof candidate.spec === "object") {
    return { type: candidate.type, ...(candidate.spec as Record<string, unknown>) } as ArtifactSpec;
  }
  return spec;
}

/** Convert backend validation messages into the field paths used by the form. */
function normalizeMissingFieldPath(field: string, artifactType: string): string {
  const value = field.trim().toLowerCase();
  if (value.startsWith("spec.")) return value;
  if (value.includes("name is required")) return "spec.name";
  if (value.includes("description") && value.includes("required")) return "spec.description";
  if (value.includes("skill instructions")) return "spec.instructions";
  if (value.includes("loop objective")) return "spec.objective";
  if (value.includes("at least one step") || value.includes("steps are required")) return "spec.steps";
  if (value.includes("maxiterations") || value.includes("max iterations")) return "spec.iteration.maxIterations";
  if (value.includes("template content")) return "spec.template";
  if (value.includes("schedule cron") || value.includes("cron expression")) return "spec.trigger.schedule";
  if (value.includes("trigger") && value.includes("required")) return "spec.trigger.kind";
  // Keep an unknown field actionable rather than rendering a non-editable sentence.
  return artifactType === "automation" ? "spec.trigger.schedule" : "spec.description";
}

/** Harness/provider + model picker shown on automation proposal cards. The
 *  selection lives in the spec itself (harness/model fields) — every change
 *  flows up through onUpdateSpec so "Create" persists what the user picked.
 *  Model lists load lazily per agent: harnesses via listHarnessModels, API
 *  providers via listChatModels, local via scanLocalModels. */
function AutomationAgentPicker({
  agentId,
  model,
  onChange,
}: {
  agentId: string;
  model: string;
  onChange: (next: { harness: string; model: string }) => void;
}) {
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([]);
  const [loading, setLoading] = useState(false);
  const group = AGENT_OPTIONS.find((a) => a.id === agentId)?.group ?? "harness";

  // Load the chosen agent's model catalogue whenever it changes.
  useEffect(() => {
    let stale = false;
    setLoading(true);
    void (async () => {
      try {
        if (group === "harness") {
          const cfg = await listHarnessModels(agentId);
          if (!stale) {
            setModels((cfg?.models ?? []).map((m) => ({ id: m.id, label: m.label })));
          }
        } else if (group === "api") {
          const list = await listChatModels(agentId);
          if (!stale) {
            setModels((list ?? []).map((m) => ({ id: m.id, label: m.id })));
          }
        } else {
          // local_gguf: models come from the GGUF scan; ids are file paths.
          const { scanLocalModels } = await import("../../lib/ipc");
          const list = await scanLocalModels();
          if (!stale) {
            setModels((list ?? []).map((m) => ({ id: m.path || m.filename, label: m.name || m.filename })));
          }
        }
      } catch {
        if (!stale) setModels([]);
      } finally {
        if (!stale) setLoading(false);
      }
    })();
    return () => {
      stale = true;
    };
  }, [agentId, group]);

  return (
    <div className="artifact-field">
      <span className="artifact-field-label">Runs with</span>
      <div className="artifact-agent-picker">
        <GlassSelect
          value={agentId}
          options={AGENT_OPTIONS.map((a) => ({ value: a.id, label: a.label }))}
          onChange={(v) => onChange({ harness: v, model: "" })}
        />
        <GlassSelect
          value={model}
          options={[
            { value: "", label: loading ? "Loading models…" : "Default model" },
            ...models.map((m) => ({ value: m.id, label: m.label })),
          ]}
          onChange={(v) => onChange({ harness: agentId, model: v })}
        />
      </div>
    </div>
  );
}

/** Render artifact-type-specific fields for the proposal card. */
function ArtifactDetails({
  spec: rawSpec,
  proposalId,
  onUpdateSpec,
}: {
  spec?: ArtifactSpec;
  proposalId?: string;
  onUpdateSpec?: (proposalId: string, spec: ArtifactSpec) => void;
}) {
  const spec = normalizeArtifactSpec(rawSpec);
  if (!spec) {
    return (
      <div className="artifact-proposal-details">
        <div className="artifact-field">
          <span className="artifact-field-label">Status</span>
          <span className="artifact-field-value">Waiting for LLM response…</span>
        </div>
      </div>
    );
  }
  switch (spec.type) {
    case "skill": {
      return (
        <div className="artifact-proposal-details">
          <div className="artifact-field">
            <span className="artifact-field-label">Description</span>
            <span className="artifact-field-value">{spec.description}</span>
          </div>
          <div className="artifact-field">
            <span className="artifact-field-label">Instructions</span>
            <span className="artifact-field-value">{spec.instructions}</span>
          </div>
          {spec.inputs && spec.inputs.length > 0 && (
            <div className="artifact-field">
              <span className="artifact-field-label">Inputs</span>
              <div className="artifact-tags">
                {spec.inputs.map((input, i) => (
                  <span key={i} className="artifact-tag">
                    <code>{input.name}</code>
                    {input.type && <span className="artifact-tag-meta"> · {input.type}</span>}
                    {input.required && <span className="artifact-tag-meta"> · required</span>}
                    {input.default && <span className="artifact-tag-meta"> = {input.default}</span>}
                  </span>
                ))}
              </div>
            </div>
          )}
          {spec.tools && spec.tools.length > 0 && (
            <div className="artifact-field">
              <span className="artifact-field-label">Tools</span>
              <div className="artifact-tags">
                {spec.tools.map((t, i) => <span key={i} className="artifact-tag">{t}</span>)}
              </div>
            </div>
          )}
          {spec.permissions && (
            <div className="artifact-field">
              <span className="artifact-field-label">Permissions</span>
              <div className="artifact-tags">
                <span className="artifact-tag">{spec.permissions}</span>
              </div>
            </div>
          )}
        </div>
      );
    }
    case "loop": {
      return (
        <div className="artifact-proposal-details">
          <div className="artifact-field">
            <span className="artifact-field-label">Description</span>
            <span className="artifact-field-value">{spec.description}</span>
          </div>
          <div className="artifact-field">
            <span className="artifact-field-label">Objective</span>
            <span className="artifact-field-value">{spec.objective}</span>
          </div>
          <div className="artifact-field">
            <span className="artifact-field-label">Iteration</span>
            <span className="artifact-field-value">
              {spec.iteration
                ? `Max ${spec.iteration.maxIterations} iterations${spec.iteration.stopCondition ? `, stop: ${spec.iteration.stopCondition}` : ""}`
                : "—"}
            </span>
          </div>
          {spec.steps && spec.steps.length > 0 && (
            <div className="artifact-field">
              <span className="artifact-field-label">Steps</span>
              <ol className="artifact-steps">
                {spec.steps.map((step, i) => (
                  <li key={i}>
                    <strong>{step.label}</strong>: {step.action}
                    {step.condition && <span className="artifact-condition"> (if {step.condition})</span>}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {spec.permissions && (
            <div className="artifact-field">
              <span className="artifact-field-label">Permissions</span>
              <div className="artifact-tags">
                <span className="artifact-tag">{spec.permissions}</span>
              </div>
            </div>
          )}
        </div>
      );
    }
    case "prompt_template": {
      return (
        <div className="artifact-proposal-details">
          <div className="artifact-field">
            <span className="artifact-field-label">Description</span>
            <span className="artifact-field-value">{spec.description}</span>
          </div>
          <div className="artifact-field">
            <span className="artifact-field-label">Template</span>
            <pre className="artifact-template">{spec.template}</pre>
          </div>
          {spec.variables && spec.variables.length > 0 && (
            <div className="artifact-field">
              <span className="artifact-field-label">Variables</span>
              <div className="artifact-tags">
                {spec.variables.map((v, i) => (
                  <span key={i} className="artifact-tag">
                    <code>{v.name}</code>
                    {v.type && <span className="artifact-tag-meta"> · {v.type}</span>}
                    {v.required && <span className="artifact-tag-meta"> · required</span>}
                    {v.default && <span className="artifact-tag-meta"> = {v.default}</span>}
                  </span>
                ))}
              </div>
            </div>
          )}
          {spec.outputFormat && (
            <div className="artifact-field">
              <span className="artifact-field-label">Output Format</span>
              <span className="artifact-field-value">{spec.outputFormat}</span>
            </div>
          )}
        </div>
      );
    }
    case "automation": {
      const autoSpec = spec as AutomationSpec;
      const agentId = autoSpec.harness || "claude_code";
      const modelId = autoSpec.model || "";
      return (
        <div className="artifact-proposal-details">
          <div className="artifact-field">
            <span className="artifact-field-label">Description</span>
            <span className="artifact-field-value">{spec.description}</span>
          </div>
        <div className="artifact-field">
          <span className="artifact-field-label">Trigger</span>
          <span className="artifact-field-value">
            {spec.trigger && spec.trigger.kind === "schedule" && spec.trigger.schedule
              ? `Schedule: ${spec.trigger.schedule}`
              : spec.trigger && spec.trigger.kind === "event"
                ? "Event-driven"
                : "Webhook"}
          </span>
        </div>
          {proposalId && onUpdateSpec && (
            <AutomationAgentPicker
              agentId={agentId}
              model={modelId}
              onChange={({ harness, model }) =>
                onUpdateSpec(proposalId, { ...autoSpec, type: "automation", harness, model })
              }
            />
          )}
          {spec.steps && spec.steps.length > 0 && (
            <div className="artifact-field">
              <span className="artifact-field-label">Steps</span>
              <ol className="artifact-steps">
                {spec.steps.map((step, i) => (
                  <li key={i}>
                    <strong>{step.label}</strong>: {step.action}
                    {step.condition && <span className="artifact-condition"> (if {step.condition})</span>}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {spec.permissions && (
            <div className="artifact-field">
              <span className="artifact-field-label">Permissions</span>
              <div className="artifact-tags">
                <span className="artifact-tag">{spec.permissions}</span>
              </div>
            </div>
          )}
          <div className="artifact-field">
            <span className="artifact-field-label">Enabled</span>
            <span className="artifact-field-value">
              {spec.enabled ? "Yes — active right after creation" : "No — created paused"}
              {spec.trigger?.kind === "schedule" && !spec.trigger.schedule
                ? " (no cron provided yet — will be created paused)"
                : ""}
            </span>
          </div>
        </div>
      );
    }
  }
}

/** Type badge for the card header. */
function TypeBadge({ type }: { type: string }) {
  const labels: Record<string, string> = {
    skill: "Reusable Skill",
    loop: "Goal Loop",
    prompt_template: "Prompt Template",
    automation: "Automation",
  };
  return (
    <span className={`artifact-type-badge artifact-type-${type}`}>
      {labels[type] ?? type}
    </span>
  );
}

export function ArtifactProposalCard({
  proposalId,
  proposal,
  state,
  onRegenerate,
  onEdit,
  onCreate,
  onDismiss,
  onSubmitMissingFields,
  onUpdateSpec,
}: ArtifactProposalCardProps) {
  const [showRegenerateInput, setShowRegenerateInput] = useState(false);
  const [regenerateInstruction, setRegenerateInstruction] = useState("");
  const [regenerating, setRegenerating] = useState(false);
  const [showMissingFields, setShowMissingFields] = useState(false);

  const isGenerating = state === "generating";
  const isReady = state === "ready";
  const isEditing = state === "editing";
  const isCreated = state === "created";
  const isRejected = state === "rejected";
  const isThinking = isGenerating || isEditing;

  // A first-time generation starts from a bare { type } shell (see
  // ChatComposer.triggerArtifactGeneration); once any real field exists the
  // proposal has been generated before, so a new "generating" state is an
  // actual regeneration — the Regenerate button or a missing-fields refill.
  const hasGeneratedSpec = useMemo(() => {
    const normalized = normalizeArtifactSpec(proposal.spec);
    if (!normalized) return false;
    return Object.keys(normalized).some((key) => key !== "type");
  }, [proposal.spec]);

  // Show thinking animation when generating or editing
  const cardClass = useMemo(() => {
    const classes = ["artifact-proposal-card", `t-${proposal.artifactType}`, state];
    if (isThinking) classes.push("thinking");
    return classes.join(" ");
  }, [state, isThinking, proposal.artifactType]);

  // Simulated "thinking" names for dynamic animation (during generation)
  const thinkingNames = [
    "Emerging Idea",
    "Concept Building",
    "Design Draft",
    "Refining Structure",
    "Finalizing",
    "Preparing Specification"
  ];
  const [thinkingIndex, setThinkingIndex] = useState(0);
  
  useEffect(() => {
    if (isThinking) {
      const interval = setInterval(() => {
        setThinkingIndex(prev => (prev + 1) % thinkingNames.length);
      }, 1200);
      return () => clearInterval(interval);
    }
    return () => {};
  }, [isThinking]);

  const handleRegenerate = () => {
    if (showRegenerateInput) {
      // Call parent; parent sets state to "generating" (shows spinner).
      onRegenerate(proposalId, regenerateInstruction || undefined);
      setRegenerating(true);
      setShowRegenerateInput(false);
      setRegenerateInstruction("");
    } else {
      setShowRegenerateInput(true);
    }
  };

  const handleRegenerateKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleRegenerate();
    }
  };

  // Reset local regen state if parent switches us away from "generating"
  useEffect(() => {
    if (state !== "generating" && regenerating) {
      setRegenerating(false);
    }
  }, [state, regenerating]);

  return (
    <div className={cardClass} role="status" aria-live="polite">
      <div className="artifact-proposal-header">
        <div className="artifact-proposal-title-row">
          <TypeBadge type={proposal.artifactType} />
          <div className="artifact-proposal-name">
            {(() => {
              const normalized = normalizeArtifactSpec(proposal.spec);
              if (isThinking && !normalized) {
                // Show animated thinking text during generation
                return (
                  <span className="artifact-name-thinking">
                    {thinkingNames[thinkingIndex]}...
                  </span>
                );
              }
              if (!normalized) return "Generating…";
              switch (normalized.type) {
                case "skill": return (normalized as SkillSpec).name || "(unnamed)";
                case "loop": return (normalized as LoopSpec).name || "(unnamed)";
                case "prompt_template": return (normalized as PromptTemplateSpec).name || "(unnamed)";
                case "automation": return (normalized as AutomationSpec).name || "(unnamed)";
                default: return "(unnamed)";
              }
            })()}
          </div>
        </div>
        <div className="artifact-proposal-confidence">
          {isThinking ? (
            <span className="artifact-confidence-thinking">
              Thinking<span className="artifact-pulse">…</span>
            </span>
          ) : (
            `Confidence: ${(proposal.confidence * 100).toFixed(0)}%`
          )}
        </div>
      </div>

      <div className="artifact-proposal-body">
        <ArtifactDetails
          spec={proposal.spec}
          proposalId={onUpdateSpec ? proposalId : undefined}
          onUpdateSpec={onUpdateSpec}
        />

        {proposal.missingFields.length > 0 && (
          <div className="artifact-proposal-warnings">
            <span className="artifact-warning-label">⚠ Missing fields:</span>
            <ul>
              {proposal.missingFields.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
            {onSubmitMissingFields && (
              <button
                type="button"
                className="artifact-btn artifact-btn-secondary"
                onClick={() => setShowMissingFields((visible) => !visible)}
              >
                {showMissingFields ? "Hide fields" : "Fill missing fields"}
              </button>
            )}
          </div>
        )}

        {showMissingFields && onSubmitMissingFields && proposal.missingFields.length > 0 && (
          <MissingFieldsPrompt
            proposal={{ artifactType: proposal.artifactType, spec: proposal.spec }}
            missingFields={proposal.missingFields.map((field) =>
              normalizeMissingFieldPath(field, proposal.artifactType),
            )}
            onSubmit={(filledFields) => {
              setShowMissingFields(false);
              onSubmitMissingFields(proposalId, filledFields);
            }}
            onCancel={() => setShowMissingFields(false)}
          />
        )}

        {proposal.assumptions.length > 0 && (
          <div className="artifact-proposal-warnings">
            <span className="artifact-warning-label">💡 Assumptions:</span>
            <ul>
              {proposal.assumptions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="artifact-proposal-actions">
        {(isGenerating || regenerating) && (
          <div className="artifact-proposal-generating">
            <span className="artifact-spinner" />
            <span>{regenerating || hasGeneratedSpec ? "Regenerating artifact…" : "Creating artifact…"}</span>
          </div>
        )}

        {isReady && !regenerating && (
          <div className="artifact-proposal-buttons">
            <div className="artifact-proposal-buttons-row">
              <button
                className="artifact-btn artifact-btn-secondary"
                onClick={() => onEdit(proposalId)}
              >
                Edit
              </button>
              <button
                className="artifact-btn artifact-btn-primary"
                onClick={() => onCreate(proposalId)}
              >
                Create {proposal.artifactType === "prompt_template" ? "Prompt Template" : proposal.artifactType === "automation" ? "Automation" : proposal.artifactType.charAt(0).toUpperCase() + proposal.artifactType.slice(1)}
              </button>
              <button
                className="artifact-btn artifact-btn-secondary"
                onClick={handleRegenerate}
                disabled={showRegenerateInput}
              >
                {showRegenerateInput ? "Cancel Regen" : "Regenerate"}
              </button>
              <button
                className="artifact-btn artifact-btn-ghost"
                onClick={() => onDismiss(proposalId)}
              >
                Dismiss
              </button>
            </div>
            {showRegenerateInput && (
              <div className="artifact-regenerate-input">
                <input
                  type="text"
                  value={regenerateInstruction}
                  onChange={(e) => setRegenerateInstruction(e.target.value)}
                  onKeyDown={handleRegenerateKeyDown}
                  placeholder="Additional instruction for regeneration (optional)"
                  autoFocus
                />
                <button
                  className="artifact-btn artifact-btn-primary"
                  onClick={handleRegenerate}
                  disabled={!regenerateInstruction.trim()}
                >
                  Go
                </button>
                <button
                  className="artifact-btn artifact-btn-ghost"
                  onClick={() => { setShowRegenerateInput(false); setRegenerateInstruction(""); }}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}

        {isEditing && (
          <div className="artifact-proposal-editing">
            <span className="artifact-spinner" />
            <span>Opening in editor…</span>
          </div>
        )}

        {isCreated && (
          <div className="artifact-proposal-created">
            <span className="artifact-success-icon">✓</span>
            <span>Created successfully!</span>
          </div>
        )}

        {isRejected && (
          <div className="artifact-proposal-rejected">
            <span>Dismissed</span>
            <button
              className="artifact-btn artifact-btn-ghost"
              onClick={() => onDismiss(proposalId)}
            >
              Remove
            </button>
          </div>
        )}
      </div>
    </div>
  );
}