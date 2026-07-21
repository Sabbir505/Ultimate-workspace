// Project Settings panel: per-project quick actions (§7.7) and the secrets
// key/value store (§7.16). Secret values are write-only in the UI — the
// contract exposes key listing but no value read, by design.
import { useEffect, useState } from "react";
import {
  createQuickAction,
  deleteQuickAction,
  deleteSecret,
  listQuickActions,
  listSecretKeys,
  setSecret,
  updateQuickAction,
} from "../../lib/ipc";
import { runQuickAction } from "../../lib/sessionLauncher";
import { useProjectsStore } from "../../state/projects";
import { useUiStore } from "../../state/ui";
import type { QuickAction } from "../../types";

export function ProjectSettingsPanel() {
  const projectId = useUiStore((s) => s.projectSettingsFor);
  const setProjectSettingsFor = useUiStore((s) => s.setProjectSettingsFor);
  const project = useProjectsStore((s) => s.projectById(projectId));

  const [actions, setActions] = useState<QuickAction[]>([]);
  const [secretKeys, setSecretKeys] = useState<string[]>([]);
  const [label, setLabel] = useState("");
  const [command, setCommand] = useState("");
  const [keybinding, setKeybinding] = useState("");
  const [runOnWorktree, setRunOnWorktree] = useState(false);
  const [secretKey, setSecretKeyDraft] = useState("");
  const [secretValue, setSecretValue] = useState("");

  useEffect(() => {
    if (!projectId) return;
    void listQuickActions(projectId).then((a) => setActions(a ?? []));
    void listSecretKeys(projectId).then((k) => setSecretKeys(k ?? []));
  }, [projectId]);

  if (!projectId || !project) return null;

  const addAction = async () => {
    if (!label.trim() || !command.trim()) return;
    const created = await createQuickAction(
      projectId,
      label.trim(),
      command.trim(),
      keybinding.trim() || undefined,
      runOnWorktree,
    );
    if (created) setActions((a) => [...a, created]);
    setLabel("");
    setCommand("");
    setKeybinding("");
    setRunOnWorktree(false);
  };

  const toggleRunOnWorktree = async (action: QuickAction) => {
    await updateQuickAction(
      action.id,
      action.label,
      action.command,
      action.keybinding ?? undefined,
      !action.runOnWorktree,
    );
    setActions((a) => a.map((x) => (x.id === action.id ? { ...x, runOnWorktree: !x.runOnWorktree } : x)));
  };

  const addSecret = async () => {
    if (!secretKey.trim() || !secretValue) return;
    await setSecret(projectId, secretKey.trim(), secretValue);
    setSecretKeys((keys) => (keys.includes(secretKey.trim()) ? keys : [...keys, secretKey.trim()]));
    setSecretKeyDraft("");
    setSecretValue("");
  };

  return (
    <div className="view-overlay" onPointerDown={(e) => e.target === e.currentTarget && setProjectSettingsFor(null)}>
      <div className="view-panel">
        <div className="view-header">
          <h2>Project Settings — {project.name}</h2>
          <button className="ghost" onClick={() => setProjectSettingsFor(null)}>
            ✕
          </button>
        </div>
        <div className="view-body">
          <section>
            <h3>Quick Actions</h3>
            <p className="estimate-note">
              Run in their own pane, scoped to this project. Secrets below are injected into the
              action's environment.
            </p>
            {actions.length > 0 && (
              <table className="kv">
                <tbody>
                  {actions.map((action) => (
                    <tr key={action.id}>
                      <td>{action.label}</td>
                      <td className="mono">{action.command}</td>
                      <td>
                        <label style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 11 }}>
                          <input
                            type="checkbox"
                            checked={action.runOnWorktree}
                            onChange={() => void toggleRunOnWorktree(action)}
                          />
                          on worktree
                        </label>
                      </td>
                      <td>
                        <button onClick={() => void runQuickAction(projectId, action.label, action.command)}>
                          Run
                        </button>{" "}
                        <button
                          className="danger"
                          onClick={() => {
                            void deleteQuickAction(action.id);
                            setActions((a) => a.filter((x) => x.id !== action.id));
                          }}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="form-row">
              <input placeholder="Label (e.g. dev server)" value={label} onChange={(e) => setLabel(e.target.value)} />
              <input
                placeholder="Command (e.g. npm run dev)"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
              />
            </div>
            <div className="form-row">
              <input
                placeholder="Keybinding (optional, e.g. Mod+Shift+D)"
                value={keybinding}
                onChange={(e) => setKeybinding(e.target.value)}
              />
              <label style={{ display: "flex", gap: 4, alignItems: "center", minWidth: 0 }}>
                <input type="checkbox" checked={runOnWorktree} onChange={(e) => setRunOnWorktree(e.target.checked)} />
                run on worktree creation
              </label>
              <button className="primary" onClick={() => void addAction()} disabled={!label.trim() || !command.trim()}>
                Add
              </button>
            </div>
          </section>

          <section>
            <h3>Secrets</h3>
            <p className="estimate-note">
              Encrypted at rest, injected only into panes spawned from this project's quick actions.
              Never logged or exported.
            </p>
            {secretKeys.length > 0 && (
              <table className="kv">
                <tbody>
                  {secretKeys.map((key) => (
                    <tr key={key}>
                      <td className="mono">{key}</td>
                      <td className="mono" style={{ color: "var(--text-dim)" }}>
                        ••••••••
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          className="danger"
                          onClick={() => {
                            void deleteSecret(projectId, key);
                            setSecretKeys((keys) => keys.filter((k) => k !== key));
                          }}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="form-row">
              <input placeholder="KEY" value={secretKey} onChange={(e) => setSecretKeyDraft(e.target.value)} />
              <input
                placeholder="value"
                type="password"
                value={secretValue}
                onChange={(e) => setSecretValue(e.target.value)}
              />
              <button className="primary" onClick={() => void addSecret()} disabled={!secretKey.trim() || !secretValue}>
                Set
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
