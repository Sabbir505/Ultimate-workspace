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
        ACP agents speak the Agent Client Protocol over stdio (Zed/Devin ecosystem).
        <strong> Zed</strong> and <strong>Devin</strong> are built in — add your own here.
        The command must be on PATH (or an absolute path); a user entry with the same id
        overrides a built-in one.
      </p>

      {note && <div className="settings-note acp-note-ok">{note}</div>}
      {error && (
        <div className="settings-note" style={{ color: "var(--danger, #f85149)" }}>
          {error}
        </div>
      )}

      {/* Agent editor */}
      <div className="acp-editor">
        <div className="acp-editor-title">
          {editingId ? `Edit agent — ${draftId}` : "New ACP agent"}
        </div>
        <div className="acp-grid">
          <label className="acp-field">
            <span>Id</span>
            <input
              type="text"
              value={draftId}
              placeholder="my-agent"
              onChange={(e) => setDraftId(e.target.value)}
              disabled={!!editingId}
            />
          </label>
          <label className="acp-field">
            <span>Display name</span>
            <input
              type="text"
              value={draftName}
              placeholder="My Agent"
              onChange={(e) => setDraftName(e.target.value)}
            />
          </label>
          <label className="acp-field acp-span2">
            <span>Command</span>
            <input
              type="text"
              value={draftCommand}
              placeholder="On PATH or absolute, e.g. zed"
              onChange={(e) => setDraftCommand(e.target.value)}
            />
          </label>
          <label className="acp-field acp-span2">
            <span>Arguments</span>
            <input
              type="text"
              value={draftArgs}
              placeholder="Space/comma separated, e.g. --stdio"
              onChange={(e) => setDraftArgs(e.target.value)}
            />
          </label>
          <label className="acp-field acp-span2">
            <span>Environment variables (optional)</span>
            <textarea
              rows={2}
              value={draftEnv}
              placeholder={"KEY=VALUE, one per line"}
              onChange={(e) => setDraftEnv(e.target.value)}
            />
          </label>
        </div>
        <div className="acp-actions">
          {editingId && (
            <button
              className="ghost"
              onClick={() => { setEditingId(null); setDraftId(""); setDraftName(""); setDraftCommand(""); setDraftArgs(""); setDraftEnv(""); }}
            >
              Cancel
            </button>
          )}
          <button className="primary cta-strong" onClick={() => void saveDraft()} disabled={busy}>
            {editingId ? "Save changes" : "Add agent"}
          </button>
        </div>
      </div>

      {/* User-defined agents */}
      {agents.length === 0 ? (
        <div className="empty-reserved">
          <div className="empty-text">No custom agents yet. Add one above.</div>
        </div>
      ) : (
        <div className="acp-list">
          {agents.map((a) => (
            <div key={a.id} className="acp-list-row">
              <div className="acp-list-info">
                <div className="acp-list-name">
                  {a.displayName}
                  <span> · {a.id}</span>
                </div>
                <div className="acp-list-cmd mono">
                  {a.command} {a.args.join(" ")}
                </div>
              </div>
              <div className="acp-list-actions">
                <button className="ghost" onClick={() => startEdit(a)}>Edit</button>
                <button className="ghost acp-remove" onClick={() => void removeAgent(a.id)}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
