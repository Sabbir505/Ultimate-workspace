// Settings → Session Mesh (P4 close-out). The mesh shipped with a runtime
// toggle (`sessionMesh.enabled`, default ON) but NO settings surface — this
// panel is that surface: master switch, what the mesh does, its hard caps,
// and where the P4 hook events live (Settings → Hooks).
import { useEffect, useState } from "react";
import { getSetting, setSetting } from "../../lib/ipc";
import { useUiStore } from "../../state/ui";

const ENABLED_KEY = "sessionMesh.enabled";

export function MeshPanel() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const setSettingsCategory = useUiStore((s) => s.setSettingsCategory);

  useEffect(() => {
    void getSetting(ENABLED_KEY).then((raw) => {
      // The Rust runtime treats missing/garbage as ON (mesh_enabled).
      setEnabled(raw == null || !["false", "0", "off"].includes(raw.trim()));
    });
  }, []);

  const toggle = async () => {
    const next = !(enabled ?? true);
    setEnabled(next);
    await setSetting(ENABLED_KEY, next ? "true" : "false");
  };

  return (
    <div className="settings-panel" data-testid="mesh-panel">
      <h2>Session Mesh</h2>
      <p className="settings-sub">
        Cross-session awareness: every chat (built-in and CLI harness) can list, read, and
        search the other sessions, message them, and spawn child sessions — through the
        <code className="mono"> relay-tools </code> MCP bridge, with hard caps and a full
        mail audit trail. The mesh rail in the git sidebar shows incoming mail and spawned
        children.
      </p>

      <section className="improve-engine" aria-label="Session Mesh switch">
        <div className="improve-engine-main">
          <div className="improve-engine-copy">
            <span className="improve-engine-title">Session Mesh</span>
            <span className="improve-engine-hint">
              {enabled == null
                ? "Loading…"
                : enabled
                  ? "On — sessions advertise peers and accept mesh mail."
                  : "Off — the mesh tools report disabled and no mail is accepted."}
            </span>
          </div>
          <button
            role="switch"
            aria-checked={enabled ?? true}
            aria-label="Session Mesh"
            data-testid="mesh-enabled-switch"
            className={`improve-switch${enabled ?? true ? " on" : ""}`}
            onClick={() => void toggle()}
          >
            <span className="improve-switch-track" aria-hidden="true" />
            <span className="improve-switch-label">{(enabled ?? true) ? "On" : "Off"}</span>
          </button>
        </div>
      </section>

      <section className="settings-card" style={{ padding: 16, borderRadius: 8 }} aria-label="Mesh hooks">
        <h3>Mesh hooks</h3>
        <p className="settings-note">
          Two lifecycle hook events fire for mesh traffic (configure them under
          Hooks): <code className="mono">mesh_message</code> when a mesh mail is
          delivered into a session, and <code className="mono">mesh_turn_complete</code>{" "}
          when the watched turn ends (answered or expired). Payloads carry{" "}
          <code className="mono">from_session</code>, <code className="mono">mail_id</code>,{" "}
          <code className="mono">mode</code>, and a reply preview.
        </p>
        <button
          className="ghost"
          data-testid="mesh-open-hooks"
          onClick={() => setSettingsCategory("hooks")}
        >
          Configure mesh hooks →
        </button>
      </section>

      <section className="settings-card" style={{ padding: 16, borderRadius: 8 }} aria-label="Mesh limits">
        <h3>Hard caps</h3>
        <p className="settings-note">
          8k chars per mail · 10 mails/hour per sender · queue depth 5 · spawn depth 2 ·
          3 children per parent per day · 8 active spawned sessions. Plans can't be
          approved through the mesh, and write tools stay behind the normal approval
          gate.
        </p>
      </section>

      <section className="settings-card" style={{ padding: 16, borderRadius: 8 }} aria-label="Spawned session model">
        <h3>Spawned-session model</h3>
        <p className="settings-note">
          Mesh-spawned children run on the orchestration default configured under
          Subagents — not the parent's own model.
        </p>
        <button
          className="ghost"
          data-testid="mesh-open-subagents"
          onClick={() => setSettingsCategory("subagents")}
        >
          Open Subagents →
        </button>
      </section>
    </div>
  );
}
