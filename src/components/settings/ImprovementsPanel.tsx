// Improvements panel (SELF_IMPROVING_ARTIFACTS.md P1/P2): the self-improvement
// control surface. Lists behavioral artifacts with their open proposals
// (diff-style change summary + eval verdict), runs sweeps, and applies or
// rejects validated candidates. Also hosts the per-artifact autonomy tier and
// the global kill switch (§9.3).
import { useCallback, useEffect, useState } from "react";
import {
  applyImprovementProposal,
  checkImprovementCanaries,
  evaluateImprovementProposal,
  getImproveAutonomy,
  getSetting,
  listImproveArtifacts,
  listImprovementProposals,
  listImproveVersions,
  rejectImprovementProposal,
  runImprovementSweep,
  setImproveAutonomy,
  setImproveChannel,
  setSetting,
  toastError,
  type ImproveArtifact,
  type ImproveProposal,
  type ImproveVersion,
} from "../../lib/ipc";

const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  evaluating: "Evaluating…",
  passed: "Passed eval",
  failed_eval: "Failed eval",
  applied: "Applied",
  rejected: "Rejected",
  stale: "Stale",
};

export function ImprovementsPanel() {
  const [artifacts, setArtifacts] = useState<ImproveArtifact[]>([]);
  const [proposals, setProposals] = useState<ImproveProposal[]>([]);
  const [versions, setVersions] = useState<Record<string, ImproveVersion[]>>({});
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tiers, setTiers] = useState<Record<string, "manual" | "auto" | "canary">>({});

  const refresh = useCallback(async () => {
    try {
      const [a, p, en] = await Promise.all([
        listImproveArtifacts(),
        listImprovementProposals(),
        getSetting("improvements.enabled"),
      ]);
      if (a) setArtifacts(a);
      if (p) setProposals(p);
      if (en !== null) setEnabled(en !== "false");
    } catch (err) {
      toastError("Could not load improvements", err);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Resolve any matured canary windows (promote / auto-rollback) on open.
    void checkImprovementCanaries().then(() => refresh()).catch(() => {});
  }, [refresh]);

  const nameOf = (artifactId: string) =>
    artifacts.find((a) => a.id === artifactId)?.name ?? artifactId.slice(0, 8);

  const runSweep = async () => {
    setBusy("sweep");
    try {
      await runImprovementSweep();
      await refresh();
    } catch (err) {
      toastError("Improvement sweep failed", err);
    } finally { setBusy(null); }
  };

  const evaluate = async (proposalId: string) => {
    setBusy(proposalId);
    try {
      await evaluateImprovementProposal(proposalId);
      await refresh();
    } catch (err) {
      toastError("Evaluation failed", err);
    } finally { setBusy(null); }
  };

  const apply = async (proposalId: string) => {
    setBusy(proposalId);
    try {
      await applyImprovementProposal(proposalId);
      await refresh();
    } catch (err) {
      toastError("Apply failed", err);
    } finally { setBusy(null); }
  };

  const reject = async (proposalId: string) => {
    setBusy(proposalId);
    try {
      await rejectImprovementProposal(proposalId);
      await refresh();
    } catch (err) {
      toastError("Reject failed", err);
    } finally { setBusy(null); }
  };

  const toggleEnabled = async () => {
    const next = !enabled;
    setEnabled(next);
    try {
      await setSetting("improvements.enabled", next ? "true" : "false");
    } catch (err) {
      setEnabled(!next);
      toastError("Could not save the kill switch", err);
    }
  };

  const toggleHistory = async (artifactId: string) => {
    if (expanded === artifactId) { setExpanded(null); return; }
    setExpanded(artifactId);
    if (!versions[artifactId]) {
      try {
        const v = await listImproveVersions(artifactId);
        if (v) setVersions((prev) => ({ ...prev, [artifactId]: v }));
      } catch (err) {
        toastError("Could not load version history", err);
      }
    }
    if (!(artifactId in tiers)) {
      try {
        const t = await getImproveAutonomy(artifactId);
        if (t) setTiers((prev) => ({ ...prev, [artifactId]: t as "manual" | "auto" | "canary" }));
      } catch {
        /* default tier applies */
      }
    }
  };

  const changeTier = async (artifactId: string, tier: "manual" | "auto" | "canary") => {
    setTiers((prev) => ({ ...prev, [artifactId]: tier }));
    try {
      await setImproveAutonomy(artifactId, tier);
    } catch (err) {
      toastError("Could not save the autonomy tier", err);
    }
  };

  const rollback = async (artifactId: string, version: number) => {
    setBusy(`${artifactId}:${version}`);
    try {
      await setImproveChannel(artifactId, "active", version);
      await refresh();
    } catch (err) {
      toastError("Rollback failed", err);
    } finally { setBusy(null); }
  };

  const open = proposals.filter((p) => !["applied", "rejected", "stale"].includes(p.status));

  return (
    <div className="settings-panel">
      <h3>Self-improving artifacts</h3>
      <p className="settings-desc">
        Skills, loops, prompt templates, and automations get versioned, learn
        from failed and corrected runs, and propose improvements that must pass
        a regression eval before being applied.
      </p>
      <div className="settings-row">
        <label htmlFor="improve-enabled">Improvement engine</label>
        <button
          id="improve-enabled"
          role="switch"
          aria-checked={enabled}
          data-testid="improve-kill-switch"
          className="ghost"
          onClick={() => void toggleEnabled()}
        >
          {enabled ? "On" : "Off (kill switch)"}
        </button>
      </div>
      <div className="settings-row">
        <button
          className="ghost"
          data-testid="run-sweep"
          onClick={() => void runSweep()}
          disabled={!enabled || busy === "sweep"}
        >
          {busy === "sweep" ? "Sweeping…" : "Run improvement sweep"}
        </button>
      </div>

      <h4>Proposals</h4>
      {open.length === 0 && <p className="settings-desc">No open proposals.</p>}
      {open.map((p) => (
        <div key={p.id} className="improve-proposal" data-testid="improve-proposal">
          <div className="improve-proposal-head">
            <strong>{nameOf(p.artifactId)}</strong>
            <span className={`improve-status improve-status-${p.status}`}>
              {STATUS_LABEL[p.status] ?? p.status}
            </span>
            <span className="improve-versions">v{p.baseVersion} → v{p.candidateVersion}</span>
          </div>
          <div className="improve-summary">{p.changeSummary}</div>
          {p.expectedEffect && <div className="improve-meta">Expected: {p.expectedEffect}</div>}
          {p.riskNotes && <div className="improve-meta">Risk: {p.riskNotes}</div>}
          <div className="improve-actions">
            {(p.status === "open" || p.status === "failed_eval") && (
              <button
                className="ghost"
                onClick={() => void evaluate(p.id)}
                disabled={busy === p.id || !enabled}
              >
                {busy === p.id ? "Evaluating…" : "Evaluate"}
              </button>
            )}
            {p.status === "passed" && (
              <button
                className="ghost"
                data-testid="apply-proposal"
                onClick={() => void apply(p.id)}
                disabled={busy === p.id}
              >
                Apply
              </button>
            )}
            <button
              className="ghost"
              data-testid="reject-proposal"
              onClick={() => void reject(p.id)}
              disabled={busy === p.id}
            >
              Reject
            </button>
          </div>
        </div>
      ))}

      <h4>Artifacts &amp; version history</h4>
      {artifacts.length === 0 && (
        <p className="settings-desc">
          No tracked artifacts yet — they are registered automatically as skills,
          loops, and templates are used.
        </p>
      )}
      {artifacts.map((a) => (
        <div key={a.id} className="improve-artifact">
          <button className="ghost" data-testid="artifact-row" onClick={() => void toggleHistory(a.id)}>
            {expanded === a.id ? "▾" : "▸"} {a.name} ({a.kind})
          </button>
          {expanded === a.id && (
            <div className="improve-versions-list">
              <div className="improve-version-row">
                <span className="improve-meta">Autonomy</span>
                <select
                  data-testid={`tier-${a.id}`}
                  value={tiers[a.id] ?? "manual"}
                  onChange={(e) => void changeTier(a.id, e.target.value as "manual" | "auto" | "canary")}
                >
                  <option value="manual">Manual — I apply proposals</option>
                  <option value="auto">Auto — promote after passing eval (1/24h)</option>
                  <option value="canary">Canary — shadow window, auto-rollback</option>
                </select>
              </div>
              {(versions[a.id] ?? []).map((v) => (
                <div key={v.id} className="improve-version-row">
                  <span>v{v.version}</span>
                  <span className="improve-meta">{v.origin}</span>
                  <button
                    className="ghost"
                    onClick={() => void rollback(a.id, v.version)}
                    disabled={busy === `${a.id}:${v.version}`}
                    title="Roll back to this version"
                  >
                    Set active
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
