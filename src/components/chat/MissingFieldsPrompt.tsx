// Inline missing fields collection for artifact proposals.
// Renders when validation returns missing_fields — allows user to fill them
// before creating the artifact.
import { useState, useEffect, useCallback } from "react";
import type { ArtifactSpec, ArtifactType, SkillSpec, LoopSpec, PromptTemplateSpec, AutomationSpec } from "../../lib/ipc";

interface MissingFieldsPromptProps {
  /** The artifact proposal being edited. */
  proposal: {
    artifactType: ArtifactType;
    spec: ArtifactSpec;
  };
  /** List of missing field paths (e.g., "inputs[0].name", "trigger.schedule"). */
  missingFields: string[];
  /** Called when user submits filled fields. */
  onSubmit: (filledFields: Record<string, unknown>) => void;
  /** Called when user cancels. */
  onCancel: () => void;
}

/** Extract a value from an object by dot-notation path. */
function getValueByPath(obj: unknown, path: string): unknown {
  const parts = path.split(/[.\[\]]+/).filter(Boolean);
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === "object" && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Set a value in an object by dot-notation path (mutates). */
function setValueByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(/[.\[\]]+/).filter(Boolean);
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || typeof current[part] !== "object" || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

/** Render an input for a specific field path. */
function FieldInput({
  path,
  label,
  value,
  onChange,
  required,
  type = "text",
}: {
  path: string;
  label: string;
  value: unknown;
  onChange: (path: string, value: unknown) => void;
  required: boolean;
  type?: "text" | "number" | "textarea" | "select";
}) {
  const isRequired = required;

  return (
    <div className="missing-field-row">
      <label className="missing-field-label" htmlFor={path}>
        {label} {isRequired && <span className="missing-field-required">*</span>}
      </label>
      {type === "textarea" ? (
        <textarea
          id={path}
          value={value as string}
          onChange={(e) => onChange(path, e.target.value)}
          rows={3}
          className="missing-field-input"
          placeholder={`Enter ${label.toLowerCase()}`}
        />
      ) : (
        <input
          id={path}
          type={type}
          value={value as string}
          onChange={(e) => onChange(path, type === "number" ? Number(e.target.value) : e.target.value)}
          className="missing-field-input"
          placeholder={`Enter ${label.toLowerCase()}`}
        />
      )}
    </div>
  );
}

/** Map field paths to human-readable labels and types. */
function getFieldInfo(path: string, artifactType: ArtifactType): { label: string; type: "text" | "number" | "textarea"; required: boolean } {
  const fieldMap: Record<string, { label: string; type: "text" | "number" | "textarea"; required: boolean }> = {
    // Skill fields
    "spec.name": { label: "Skill Name", type: "text", required: true },
    "spec.description": { label: "Description", type: "textarea", required: true },
    "spec.instructions": { label: "Instructions", type: "textarea", required: true },
    "spec.inputs": { label: "Inputs (JSON array)", type: "textarea", required: false },
    "spec.outputs": { label: "Outputs (JSON array)", type: "textarea", required: false },
    "spec.tools": { label: "Tools (comma-separated)", type: "text", required: false },
    "spec.model": { label: "Model Config (JSON)", type: "textarea", required: false },
    "spec.permissions": { label: "Permissions (JSON)", type: "textarea", required: false },
    "spec.examples": { label: "Examples (JSON array)", type: "textarea", required: false },

    // Loop fields
    "spec.objective": { label: "Objective", type: "textarea", required: true },
    "spec.steps": { label: "Steps (JSON array)", type: "textarea", required: true },
    "spec.iteration.maxIterations": { label: "Max Iterations", type: "number", required: true },
    "spec.iteration.stopCondition": { label: "Stop Condition", type: "text", required: false },

    // Prompt Template fields
    "spec.template": { label: "Template", type: "textarea", required: true },
    "spec.variables": { label: "Variables (JSON array)", type: "textarea", required: true },
    "spec.outputFormat": { label: "Output Format", type: "text", required: false },
    "spec.promptTemplateExamples": { label: "Examples (JSON array)", type: "textarea", required: false },

    // Automation fields
    "spec.trigger.kind": { label: "Trigger Type", type: "text", required: true },
    "spec.trigger.schedule": { label: "Cron Schedule", type: "text", required: true },
    "spec.enabled": { label: "Enabled", type: "text", required: false },
  };

  // Handle array index paths like "spec.inputs[0].name"
  const basePath = path.replace(/\[\d+\]/g, "");
  if (fieldMap[basePath]) {
    return fieldMap[basePath];
  }

  // Fallback: derive label from path
  const label = path
    .split(".")
    .pop()
    ?.replace(/([A-Z])/g, " $1")
    .trim() ?? path;
  return { label: label.charAt(0).toUpperCase() + label.slice(1), type: "text", required: true };
}

export function MissingFieldsPrompt({
  proposal,
  missingFields,
  onSubmit,
  onCancel,
}: MissingFieldsPromptProps) {
  const [fieldValues, setFieldValues] = useState<Record<string, unknown>>({});

  // Initialize field values from the proposal spec
  useEffect(() => {
    const initial: Record<string, unknown> = {};
    for (const path of missingFields) {
      const value = getValueByPath(proposal.spec, path);
      if (value !== undefined) {
        initial[path] = value;
      }
    }
    setFieldValues(initial);
  }, [proposal.spec, missingFields]);

  const handleChange = useCallback((path: string, value: unknown) => {
    setFieldValues((prev) => ({ ...prev, [path]: value }));
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(fieldValues);
  };

  const handleCancel = () => {
    onCancel();
  };

  // Group fields by top-level spec property for better UX
  const fieldsByGroup: Record<string, string[]> = {};
  for (const path of missingFields) {
    const group = path.split(".")[1] ?? "other"; // e.g., "spec.name" -> "name"
    if (!fieldsByGroup[group]) fieldsByGroup[group] = [];
    fieldsByGroup[group].push(path);
  }

  return (
    <div className="missing-fields-prompt">
      <div className="missing-fields-header">
        <h4>Fill Missing Fields</h4>
        <p className="missing-fields-hint">
          The proposal is missing {missingFields.length} required field{missingFields.length !== 1 ? "s" : ""}.
          Fill them below to continue.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="missing-fields-form">
        {Object.entries(fieldsByGroup).map(([group, paths]) => (
          <fieldset key={group} className="missing-fields-group">
            <legend>{group.charAt(0).toUpperCase() + group.slice(1)}</legend>
            {paths.map((path) => {
              const { label, type, required } = getFieldInfo(path, proposal.artifactType);
              return (
                <FieldInput
                  key={path}
                  path={path}
                  label={label}
                  value={fieldValues[path] ?? ""}
                  onChange={handleChange}
                  required={required}
                  type={type}
                />
              );
            })}
          </fieldset>
        ))}

        <div className="missing-fields-actions">
          <button type="button" className="artifact-btn artifact-btn-ghost" onClick={handleCancel}>
            Cancel
          </button>
          <button type="submit" className="artifact-btn artifact-btn-primary">
            Continue
          </button>
        </div>
      </form>
    </div>
  );
}