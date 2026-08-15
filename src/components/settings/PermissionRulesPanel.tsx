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

const TOOL_LABEL: Record<string, string> = Object.fromEntries(
  TOOL_OPTIONS.map((o) => [o.value, o.value]),
);

function fmtRule(rule: ApprovalRule): string {
  const tool = rule.tool || "any mutating tool";
  return rule.pattern ? `${tool} on ${rule.pattern}` : `${tool} on any path`;
}

export function PermissionRulesPanel() {
  const [rules, setRules] = useState<ApprovalRule[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftTool, setDraftTool] = useState<string>("write_file");
  const [draftPattern, setDraftPattern] = useState<string>("");
  const [note, setNote] = useState<string | null>(null);

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
      // Revert to the persisted state on failure.
      setRules(await getPermissionsRules());
    }
  };

  const handleAdd = async () => {
    const pattern = draftPattern.trim();
    if (!pattern) {
      setError("Enter a path pattern (or use ** to match everything).");
      return;
    }
    setBusy(true);
    try {
      await persist([
        ...rules,
        {
          id: `rule-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
          tool: draftTool,
          pattern,
          createdAt: Math.floor(Date.now() / 1000),
        },
      ]);
      setDraftPattern("");
      setNote(`Added rule: ${draftTool} on ${pattern}`);
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

  return (
    <div className="settings-form">
      <div className="panel-head">
        <h3>Permissions</h3>
      </div>

      <p className="settings-note">
        Rules let the agent run a filesystem tool without pausing for an approval
        card each time it touches a matching path. Both the tool and the path
        glob must match. Deletes/moves stay bounded by the project scope — a
        rule can never let the agent write outside the directories it's already
        allowed to touch.
      </p>

      {note && <div className="settings-note">{note}</div>}
      {error && (
        <div className="settings-note" style={{ color: "var(--danger, #f85149)" }}>
          {error}
        </div>
      )}

      {/* Add a rule */}
      <div className="settings-form-row" style={{ alignItems: "flex-start" }}>
        <label className="settings-form-label">Add rule</label>
        <div className="settings-form-control" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <select
              value={draftTool}
              onChange={(e) => setDraftTool(e.target.value)}
              style={{ maxWidth: 200 }}
            >
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
              onChange={(e) => setDraftPattern(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleAdd()}
              style={{ flex: 1, minWidth: 180 }}
            />
            <button className="primary" onClick={() => void handleAdd()} disabled={busy}>
              Add
            </button>
          </div>
        </div>
      </div>

      {/* Existing rules */}
      {rules.length === 0 ? (
        <div className="empty-reserved">
          <div className="empty-text">
            No approval rules yet. Add one above, or use the “Always allow” box on
            an approval card to capture it from a live request.
          </div>
        </div>
      ) : (
        <div className="rule-list" style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
          {rules.map((r) => (
            <div key={r.id} className="rule-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm, 6px)" }}>
              <span className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
                {fmtRule(r)}
              </span>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                  {TOOL_LABEL[r.tool] ?? r.tool}
                </span>
                <button className="ghost" style={{ color: "var(--danger, #f85149)" }} onClick={() => void handleRemove(r.id)} disabled={busy}>
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
