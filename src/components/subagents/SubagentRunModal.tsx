// The Run modal (Phase 2.5, research doc §C.5 item 3): the one door from a
// subagent definition to an actual run.
//
// Exactly three inputs, because that is all `run_subagent` takes:
//   - TASK TEXT (required) — the whole point. An empty task is refused inline
//     rather than disabled on the button alone, so a keyboard/programmatic
//     submit gets the same explanation.
//   - PROJECT — which project root (and therefore worktree/cwd) the run works
//     in. "No project" is a valid choice: the backend then runs project-less,
//     exactly as a project-less chat does.
//   - WAIT vs BACKGROUND — `wait: true` holds the command until the first
//     turn goes idle; `false` returns as soon as the session exists and the
//     run streams in the chat view. Either way the user lands in the run.
//
// No `wait` distinction is advertised as "faster": both create the same
// session, and the Run button reports the outcome either way.

import { useEffect, useState } from "react";
import { Modal } from "../common/Modal";
import { SubagentSelect } from "./SubagentSelect";
import { SUBAGENT_TIER_LABELS, subagentEngineTier, type Subagent } from "../../lib/ipc";
import { useSubagentStore } from "../../state/subagents";
import { useProjectsStore } from "../../state/projects";

export interface SubagentRunModalProps {
  agent: Subagent;
  onClose: () => void;
}

export function SubagentRunModal({ agent, onClose }: SubagentRunModalProps) {
  const [task, setTask] = useState("");
  const [projectId, setProjectId] = useState("");
  const [wait, setWait] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projects = useProjectsStore((s) => s.projects);
  const runNow = useSubagentStore((s) => s.runNow);
  // One busy flag per agent (the store keys it by agent id) — the submit
  // button reflects the same state the registry row's Run button shows.
  const busy = useSubagentStore((s) => s.busy[agent.id] === true);

  // Keep the project list populated; the store may not have loaded if the
  // user came straight here from a fresh window.
  const loaded = useProjectsStore((s) => s.loaded);
  const loadAll = useProjectsStore((s) => s.loadAll);
  useEffect(() => {
    if (!loaded) void loadAll();
  }, [loaded, loadAll]);

  // The store owns the error string (one place, so the registry panel and
  // this modal never disagree); read it back off the failure rather than
  // mirroring it, so a stale error from a previous action can't greet the
  // user the moment the modal opens.
  const trimmed = task.trim();
  const submit = async () => {
    if (!trimmed) {
      setError("Describe what the agent should do — an empty task can't be run.");
      return;
    }
    setError(null);
    const sessionId = await runNow(agent.id, trimmed, projectId || null, wait);
    if (sessionId) {
      onClose();
    } else {
      setError(useSubagentStore.getState().error ?? "The run didn't start.");
    }
  };

  const tier = subagentEngineTier(agent.engine);

  return (
    <Modal
      className="subagent-glass-modal"
      title={`Run ${agent.name}`}
      onClose={busy ? undefined : onClose}
      actions={
        <>
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void submit()}
            disabled={busy || !trimmed}
          >
            {busy ? "Starting…" : "Run"}
          </button>
        </>
      }
    >
      <div className="settings-section">
        <div className="settings-section-title">Task</div>
        <textarea
          className="perm-pattern-input subagent-modal-textarea"
          aria-label="Task"
          rows={6}
          value={task}
          disabled={busy}
          placeholder="Write the onboarding guide for the new settings panel."
          onChange={(e) => setTask(e.target.value)}
        />
        <p className="settings-section-hint" style={{ marginTop: 6, marginBottom: 0 }}>
          The run opens as a normal chat — you can keep talking to it, and the
          sidebar row is tagged with {agent.name}.
        </p>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Project</div>
        <SubagentSelect
          ariaLabel="Project"
          value={projectId}
          disabled={busy}
          options={[
            { value: "", label: "No project — run project-less" },
            ...projects.map((p) => ({ value: p.id, label: p.name })),
          ]}
          onChange={setProjectId}
        />
        <p className="settings-section-hint" style={{ marginTop: 6, marginBottom: 0 }}>
          {agent.worktreePolicy === "always"
            ? "This agent always provisions its own git worktree, so the run won't touch your working tree."
            : agent.worktreePolicy === "never"
              ? "This agent never uses a worktree — it works in the project's own working tree."
              : "The run follows the project's worktree setting."}
        </p>
      </div>

      <label className="settings-section subagent-modal-wait">
        <input
          type="checkbox"
          aria-label="Wait for the run to finish"
          checked={wait}
          disabled={busy}
          onChange={(e) => setWait(e.target.checked)}
        />
        <span className="settings-section-title subagent-modal-wait-title">
          Wait for the first turn to finish
        </span>
      </label>
      <p className="settings-section-hint" style={{ marginTop: 0, marginBottom: 0 }}>
        Off, the run streams in the chat view while you carry on. Either way you
        land in the run when it starts.
      </p>

      {error && <div className="settings-note subagent-error">{error}</div>}

      <p className="settings-section-hint" style={{ marginBottom: 0 }}>
        {SUBAGENT_TIER_LABELS[tier].detail} Up to{" "}
        <span className="mono">{agent.maxRounds}</span> rounds.
      </p>
    </Modal>
  );
}
