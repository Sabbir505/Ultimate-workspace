// Settings → Permissions: manage user-defined approval rules.
//
// A rule auto-approves a filesystem tool call when BOTH the tool name and the
// target path match the rule's glob — so the agent can edit/build within a
// project without pausing for an approval card each time. Rules are stored as
// a JSON array under the `permissions.rules` app_settings key and matched per
// turn in chat tool dispatch.
//
// Safety: rules only bypass the per-action approval card. The backend's hard
// path-scope gate still rejects writes outside the granted roots (project dir /
// working folder), so a rule cannot let the agent mutate arbitrary system files.

import { Plus, ShieldCheck, ShieldOff, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  getPermissionsRules,
  setPermissionsRules,
  type ApprovalRule,
} from "../../lib/ipc";

const TOOL_OPTIONS: { value: string; label: string }[] = [
  { value: "write_file", label: "write_file (create/overwrite)" },
  { value: "edit_file", label: "edit_file (find+replace)" },
  { value: "delete_file", label: "delete_file" },
  { value: "move_file", label: "move_file" },
  { value: "copy_file", label: "copy_file" },
];

const QUICK_PATTERNS: { label: string; pattern: string }[] = [
  { label: "** any path", pattern: "**" },
  { label: "**/*.test.ts", pattern: "**/*.test.ts" },
  { label: "src/**", pattern: "src/**" },
];

const QUIET_TOOL = "";
const QUIET_LABEL = "Any mutating tool";

function toolLabel(tool: string): string {
  const found = TOOL_OPTIONS.find((o) => o.value === tool);
  return found ? found.label.split(" ")[0] : tool || QUIET_LABEL;
}

export function PermissionRulesPanel() {
  const [rules, setRules] = useState<ApprovalRule[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftTool, setDraftTool] = useState("write_file");
  const [draftPattern, setDraftPattern] = useState("");

  const refresh = useCallback(async () => {
    setRules(await getPermissionsRules());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const persist = async (next: ApprovalRule[]) => {
    setRules(next);
    try {
      await setPermissionsRules(next);
      setError(null);
    } catch (err) {
      setError(`Failed to save rules: ${String(err)}`);
      setRules(await getPermissionsRules());
    }
  };

  const handleAdd = async () => {
    if (!draftPattern.trim()) {
      setError("Enter a path pattern (or use ** to match everything).");
      return;
    }
    setBusy(true);
    try {
      await persist([
        ...rules,
        {
          id: `rule-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
          tool: draftTool === QUIET_TOOL ? "" : draftTool,
          pattern: draftPattern.trim(),
          createdAt: Math.floor(Date.now() / 1000),
        },
      ]);
      setDraftPattern("");
    } finally {
      setBusy(false);
    }
  };

const handleRemove = async (id: string) => {
    setBusy(true);
    try {
      await persist(rules.filter((r) => r.id !== id));
    } finally {
      setBusy(false);
    }
  };

  const hasPattern = draftPattern.trim().length > 0;

  return (
    <div className="settings-form">
      <div className="panel-head">
        <h3>Approval rules</h3>
        {rules.length > 0 && <span className="panel-count">{rules.length} rule{rules.length === 1 ? "" : "s"}</span>}
      </div>

      <div className="perm-card perm-info-card">
        <ShieldCheck className="perm-icon" size={20} />
        <div>
          <div className="perm-info-title">Skip the approval prompt for trusted paths</div>
          <div className="perm-info-body">
            A rule auto-runs a filesystem tool when its name AND the target path glob match.
            Deletes and moves stay bounded by project scope — a rule can never grant access outside
            your enabled directories.
          </div>
        </div>
      </div>

      <div className="perm-card perm-add-card">
        <div className="perm-add-row">
          <select
            value={draftTool}
            onChange={(e) => setDraftTool(e.target.value)}
            aria-label="Tool"
            className="perm-tool-select"
          >
            <option value={QUIET_TOOL}>{QUIET_LABEL}</option>
            {TOOL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={draftPattern}
            placeholder="path glob, e.g. **/*.test.ts (or ** for any path)"
            onChange={(e) => {
              setDraftPattern(e.target.value);
              if (e.target.value.trim()) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy && hasPattern) void handleAdd();
            }}
            className="perm-pattern-input"
            disabled={busy}
          />
          <button
            className="primary"
            onClick={() => void handleAdd()}
            disabled={busy}
            type="button"
          >
            <Plus size={16} /> Add
          </button>
        </div>
        <div className="perm-chips">
          {QUICK_PATTERNS.map((c) => (
            <button
              key={c.pattern}
              type="button"
              className="perm-chip"
              onClick={() => {
                setDraftPattern(c.pattern);
                setError(null);
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="settings-note" style={{ color: "var(--danger, #f85149)" }}>
          {error}
        </div>
      )}

      {rules.length === 0 ? (
        <div className="empty-reserved">
          <ShieldOff className="empty-icon" size={22} />
          <div className="empty-text">
            No approval rules yet. Add one above, or use the "Always allow" box on an approval card
            to capture it from a live request.
          </div>
        </div>
      ) : (
        <div className="perm-rules-list">
          {rules.map((r) => (
            <div key={r.id} className="perm-rule-row">
              <span className="perm-rule-tool">{toolLabel(r.tool)}</span>
              <span className="perm-rule-pattern mono">
                {r.pattern || "any path"}
              </span>
              <button
                type="button"
                className="ghost"
                style={{ color: "var(--danger, #f85149)" }}
                onClick={() => void handleRemove(r.id)}
                disabled={busy}
                title="Remove rule"
                aria-label="Remove rule"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}