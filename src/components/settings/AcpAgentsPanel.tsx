// ACP agent definitions (roadmap #20): user-defined agents that speak the
// Agent Client Protocol over stdio (Zed/Devin-ecosystem CLIs). Static
// registry entries (zed, devin) are always present; a user entry with the
// same id overrides its command/args. The composer's agent menu lists the
// merged set with install detection.
import { useCallback, useEffect, useState } from "react";
import { listAcpAgentDefs, saveAcpAgentDefs, type AcpAgentDef } from "../../lib/ipc";

function parseArgs(raw: string): string[] {
  return raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

function parseEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of raw.split(/\n+/)) {
    const idx = line.indexOf("=");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      if (key) env[key] = val;
    }
  }
  return env;
}

function envText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

export function AcpAgentsPanel() {
  const [agents, setAgents] = useState<AcpAgentDef[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState("");
  const [draftName, setDraftName] = useState("");
  const [draftCommand, setDraftCommand] = useState("");
  const [draftArgs, setDraftArgs] = useState("");
  const [draftEnv, setDraftEnv] = useState("");

  const refresh = useCallback(async () => {
    setAgents(await listAcpAgentDefs());
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const persist = async (next: AcpAgentDef[]) => {
    setAgents(next);
    try {
      await saveAcpAgentDefs(next);
      setError(null);
    } catch (err) {
      setError(`Failed to save agents: ${String(err)}`);
      setAgents(await listAcpAgentDefs());
    }
  };

  const saveDraft = async () => {
    // Normalize to a safe id (lowercase alphanumerics + dashes) and reject
    // anything that would silently change the user's typed id.
    const normalizedId = draftId.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    if (!draftId.trim() || normalizedId !== draftId.trim().toLowerCase()) {
      setError("Agent id may only contain lowercase letters, numbers and dashes.");
      return;
    }
    if (!draftName.trim() || !draftCommand.trim()) {
      setError("Display name and command are required.");
      return;
    }
    setBusy(true);
    const next: AcpAgentDef = {
      id: normalizedId,
      displayName: draftName.trim(),
      command: draftCommand.trim(),
      args: parseArgs(draftArgs),
      env: parseEnv(draftEnv),
    };
    try {
      if (editingId) {
        await persist(agents.map((a) => (a.id === editingId ? next : a)));
        setNote(`Updated agent "${next.displayName}".`);
      } else {
        await persist([...agents, next]);
        setNote(`Added agent "${next.displayName}".`);
      }
      setEditingId(null);
      setDraftId(""); setDraftName(""); setDraftCommand(""); setDraftArgs(""); setDraftEnv("");
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (a: AcpAgentDef) => {
    setEditingId(a.id);
    setDraftId(a.id);
    setDraftName(a.displayName);
    setDraftCommand(a.command);
    setDraftArgs(a.args.join(" "));
    setDraftEnv(envText(a.env));
    setError(null);
  };

  const removeAgent = async (id: string) => {
    await persist(agents.filter((a) => a.id !== id));
  };

  return (
    <div className="settings-form">
      <div className="panel-head">
        <h3>ACP agents</h3>
      </div>
      <p className="settings-note">
        ACP (Agent Client Protocol) lets Zed/Devin-ecosystem agents talk to Conduit over
        stdio. <strong>Zed</strong> and <strong>Devin</strong> are built in; add your own
        agent here when its binary exposes an ACP server. The command must be on PATH
        (or an absolute path) — npm-installed <code>.cmd</code> shims are resolved like
        the harness CLIs. A user entry with the same id overrides the built-in one.
      </p>

      {note && <div className="settings-note">{note}</div>}
      {error && (
        <div className="settings-note" style={{ color: "var(--danger, #f85149)" }}>
          {error}
        </div>
      )}

      {/* Agent editor */}
      <div className="settings-form-row" style={{ alignItems: "flex-start" }}>
        <label className="settings-form-label">{editingId ? "Edit" : "New"} ACP agent</label>
        <div className="settings-form-control" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              value={draftId}
              placeholder="id (e.g. my-agent)"
              onChange={(e) => setDraftId(e.target.value)}
              disabled={!!editingId}
            />
            <input
              type="text"
              value={draftName}
              placeholder="Display name"
              onChange={(e) => setDraftName(e.target.value)}
            />
          </div>
          <input
            type="text"
            value={draftCommand}
            placeholder="Command on PATH, e.g. zed"
            onChange={(e) => setDraftCommand(e.target.value)}
          />
          <input
            type="text"
            value={draftArgs}
            placeholder="Args (space/comma separated), e.g. --stdio"
            onChange={(e) => setDraftArgs(e.target.value)}
          />
          <textarea
            rows={2}
            value={draftEnv}
            placeholder="Env vars, one KEY=VALUE per line (optional)"
            onChange={(e) => setDraftEnv(e.target.value)}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button className="primary" onClick={() => void saveDraft()} disabled={busy}>
              {editingId ? "Save changes" : "Add agent"}
            </button>
            {editingId && (
              <button className="ghost" onClick={() => { setEditingId(null); setDraftId(""); setDraftName(""); setDraftCommand(""); setDraftArgs(""); setDraftEnv(""); }}>
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>

      {/* User-defined agents */}
      {agents.length === 0 ? (
        <div className="empty-reserved">
          <div className="empty-text">No custom agents yet. Add one above.</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
          {agents.map((a) => (
            <div key={a.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm, 6px)" }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>
                  {a.displayName}
                  <span style={{ color: "var(--text-dim)", fontWeight: 400 }}> · {a.id}</span>
                </div>
                <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {a.command} {a.args.join(" ")}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <button className="ghost" onClick={() => startEdit(a)}>Edit</button>
                <button className="ghost" style={{ color: "var(--danger, #f85149)" }} onClick={() => void removeAgent(a.id)}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
