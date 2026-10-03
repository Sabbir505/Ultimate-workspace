// Improvements panel (SELF_IMPROVING_ARTIFACTS.md P1/P2): the self-improvement
// control surface. Lists behavioral artifacts with their open proposals
// (diff-style change summary + eval verdict), runs sweeps, and applies or
// rejects validated candidates. Also hosts the per-artifact autonomy tier and
// the global kill switch (§9.3).
//
// Layout notes: the data/behavior contract is identical to the original list
// implementation — every testid, status label, and action is preserved; the
// redesign is the presentation: an engine card with the kill switch as a real
// toggle, proposal cards with status accenting, and artifact rows that expand
// into a version timeline.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FlaskConical,
  HistoryIcon,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  applyImprovementProposal,
  checkImprovementCanaries,
  evaluateImprovementProposal,
  getImproveAutonomy,
  getSetting,
  listImproveArtifacts,
  listImproveEvalCases,
  listImprovementProposals,
  listImprovePackHealth,
  listImproveVersions,
  rejectImprovementProposal,
  runImprovementSweep,
  setImproveAutonomy,
  setImproveCaseQuarantine,
  setImproveChannel,
  setSetting,
  toastError,
  type ImproveArtifact,
  type ImproveEvalCase,
  type ImprovePackHealth,
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

const KIND_LABEL: Record<string, string> = {
  skill: "Skill",
  loop: "Loop",
  prompt_template: "Template",
  automation: "Automation",
};

export function ImprovementsPanel() {
  const [artifacts, setArtifacts] = useState<ImproveArtifact[]>([]);
  const [proposals, setProposals] = useState<ImproveProposal[]>([]);
  const [versions, setVersions] = useState<Record<string, ImproveVersion[]>>({});
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tiers, setTiers] = useState<Record<string, "manual" | "auto" | "canary">>({});
  // Previous tier per artifact — captured before each optimistic write so a
  // failed save can revert (audit M: optimistic writes with no rollback).
  const prevTierRef = useRef<Record<string, "manual" | "auto" | "canary">>({});
  // P3: cross-artifact pack health + per-artifact eval cases (quarantine UI).
  const [health, setHealth] = useState<ImprovePackHealth[]>([]);
  const [cases, setCases] = useState<Record<string, ImproveEvalCase[]>>({});

  const refresh = useCallback(async () => {
    try {
      const [a, p, en, h] = await Promise.all([
        listImproveArtifacts(),
        listImprovementProposals(),
        getSetting("improvements.enabled"),
        listImprovePackHealth().catch(() => null),
      ]);
      if (a) setArtifacts(a);
      if (p) setProposals(p);
      if (en !== null) setEnabled(en !== "false");
      if (h) setHealth(h);
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
    if (!cases[artifactId]) {
      try {
        const c = await listImproveEvalCases(artifactId);
        if (c) setCases((prev) => ({ ...prev, [artifactId]: c }));
      } catch {
        /* the eval-cases section just stays empty */
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

  const toggleCaseQuarantine = async (artifactId: string, caseId: string, quarantined: boolean) => {
    // Optimistic flip; refresh pack health with the panel refresh.
    setCases((prev) => ({
      ...prev,
      [artifactId]: (prev[artifactId] ?? []).map((c) =>
        c.id === caseId
          ? { ...c, quarantined, quarantineReason: quarantined ? "quarantined by user" : "" }
          : c,
      ),
    }));
    try {
      await setImproveCaseQuarantine(caseId, quarantined);
      const h = await listImprovePackHealth().catch(() => null);
      if (h) setHealth(h);
    } catch (err) {
      toastError("Could not update the case", err);
    }
  };

  const changeTier = async (artifactId: string, tier: "manual" | "auto" | "canary") => {
    setTiers((prev) => {
      prevTierRef.current = { ...prevTierRef.current, [artifactId]: prev[artifactId] };
      return { ...prev, [artifactId]: tier };
    });
    try {
      await setImproveAutonomy(artifactId, tier);
    } catch (err) {
      // Revert the optimistic tier write on failure.
      const previous = prevTierRef.current[artifactId];
      setTiers((prev) => ({ ...prev, [artifactId]: previous ?? "manual" }));
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
    <div className="settings-panel improve-root">
      <div className="improve-hero">
        <span className="improve-hero-icon" aria-hidden="true">
          <Sparkles size={18} strokeWidth={1.8} />
        </span>
        <div className="improve-hero-copy">
          <h3>Self-improving artifacts</h3>
          <p className="settings-desc">
            Skills, loops, prompt templates, and automations get versioned,
            learn from failed and corrected runs, and propose improvements that
            must pass a regression eval before being applied.
          </p>
        </div>
      </div>

      {/* Engine card — kill switch + sweep in one surface, with live counts. */}
      <section className="improve-engine" aria-label="Improvement engine">
        <div className="improve-engine-main">
          <div className="improve-engine-copy">
            <span className="improve-engine-title">Improvement engine</span>
            <span className="improve-engine-hint">
              {enabled
                ? "Proposals are drafted from run outcomes and gated behind evals."
                : "Paused — nothing is drafted, evaluated, or applied."}
            </span>
          </div>
          <button
            id="improve-enabled"
            role="switch"
            aria-checked={enabled}
            aria-label="Improvement engine"
            data-testid="improve-kill-switch"
            className={`improve-switch${enabled ? " on" : ""}`}
            onClick={() => void toggleEnabled()}
          >
            <span className="improve-switch-track" aria-hidden="true" />
            <span className="improve-switch-label">{enabled ? "On" : "Off (kill switch)"}</span>
          </button>
        </div>
        <div className="improve-engine-foot">
          <button
            className="primary improve-sweep-btn"
            data-testid="run-sweep"
            onClick={() => void runSweep()}
            disabled={!enabled || busy === "sweep"}
          >
            <RefreshCw size={13} strokeWidth={2} className={busy === "sweep" ? "spin" : ""} />
            {busy === "sweep" ? "Sweeping…" : "Run improvement sweep"}
          </button>
          <span className="improve-engine-hint">
            Scans recent runs for correctable mistakes and drafts proposals.
          </span>
        </div>
        <div className="improve-stats">
          <span className="improve-stat">
            <strong>{artifacts.length}</strong> tracked artifact{artifacts.length === 1 ? "" : "s"}
          </span>
          <span className="improve-stat-sep" aria-hidden="true" />
          <span className="improve-stat">
            <strong>{open.length}</strong> open proposal{open.length === 1 ? "" : "s"}
          </span>
        </div>
      </section>

      {/* P3: cross-artifact pack health — one row per artifact's eval pack. */}
      {health.length > 0 && (
        <>
          <div className="improve-section-head">
            <h4>Pack health</h4>
            {health.some((h) => h.suspect) && (
              <span className="improve-count-chip warn" data-testid="pack-health-suspect-count">
                {health.filter((h) => h.suspect).length} suspect
              </span>
            )}
          </div>
          <div className="improve-pack-health">
            {health.map((h) => (
              <div key={h.artifactId} className="improve-pack-row" data-testid="pack-health-row">
                <span className="improve-artifact-name">{h.name}</span>
                <span className="improve-kind-chip">{KIND_LABEL[h.kind] ?? h.kind}</span>
                <span className="improve-pack-stat" title="Active (enabled, not quarantined) eval cases / total">
                  {h.casesActive}/{h.casesTotal} cases
                </span>
                <span
                  className="improve-pack-stat"
                  title="Cases with at least one failing result ever — the pack's evidence it can discriminate"
                >
                  {h.casesDiscriminating} discriminating
                </span>
                <span className="improve-pack-stat" title="Recorded eval runs over this pack">
                  {h.evalRuns} eval {h.evalRuns === 1 ? "run" : "runs"}
                </span>
                {h.casesQuarantined > 0 && (
                  <span
                    className="improve-pack-stat quarantined"
                    title="Flaky cases parked out of gating"
                    data-testid="pack-health-quarantined"
                  >
                    {h.casesQuarantined} quarantined
                  </span>
                )}
                {h.suspect && (
                  <span
                    className="improve-pack-suspect"
                    title="Every active case passed every recorded eval run (≥3 runs) — this pack has never discriminated and cannot veto a bad candidate. Add harder cases."
                    data-testid="pack-health-suspect"
                  >
                    <AlertTriangle size={11} strokeWidth={2} aria-hidden="true" /> never fails — suspect
                  </span>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <div className="improve-section-head">
        <h4>Proposals</h4>
        {open.length > 0 && <span className="improve-count-chip">{open.length}</span>}
      </div>
      {open.length === 0 && (
        <div className="improve-empty">
          <FlaskConical size={16} strokeWidth={1.6} aria-hidden="true" />
          <span>No open proposals.</span>
        </div>
      )}
      {open.map((p) => (
        <div key={p.id} className={`improve-proposal improve-proposal-${p.status}`} data-testid="improve-proposal">
          <div className="improve-proposal-head">
            <strong className="improve-proposal-name">{nameOf(p.artifactId)}</strong>
            <span className="improve-versions">v{p.baseVersion} → v{p.candidateVersion}</span>
            <span className={`improve-status improve-status-${p.status}`}>
              {STATUS_LABEL[p.status] ?? p.status}
            </span>
          </div>
          <div className="improve-summary">{p.changeSummary}</div>
          {(p.expectedEffect || p.riskNotes) && (
            <div className="improve-meta-rows">
              {p.expectedEffect && (
                <div className="improve-meta-row">
                  <span className="improve-meta-label">
                    <ShieldCheck size={12} strokeWidth={2} aria-hidden="true" /> Expected
                  </span>
                  <span className="improve-meta-value">{p.expectedEffect}</span>
                </div>
              )}
              {p.riskNotes && (
                <div className="improve-meta-row">
                  <span className="improve-meta-label is-risk">
                    <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" /> Risk
                  </span>
                  <span className="improve-meta-value">{p.riskNotes}</span>
                </div>
              )}
            </div>
          )}
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
                className="primary"
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

      <div className="improve-section-head">
        <h4>Artifacts &amp; version history</h4>
        {artifacts.length > 0 && <span className="improve-count-chip">{artifacts.length}</span>}
      </div>
      {artifacts.length === 0 && (
        <div className="improve-empty">
          <HistoryIcon size={16} strokeWidth={1.6} aria-hidden="true" />
          <span>
            No tracked artifacts yet — they are registered automatically as
            skills, loops, and templates are used.
          </span>
        </div>
      )}
      <div className="improve-artifact-list">
        {artifacts.map((a) => {
          const isOpen = expanded === a.id;
          return (
            <div key={a.id} className={`improve-artifact${isOpen ? " open" : ""}`}>
              <button
                className="improve-artifact-row"
                data-testid="artifact-row"
                aria-expanded={isOpen}
                onClick={() => void toggleHistory(a.id)}
              >
                <span className="improve-artifact-chevron" aria-hidden="true">
                  {isOpen ? <ChevronDown size={14} strokeWidth={2} /> : <ChevronRight size={14} strokeWidth={2} />}
                </span>
                <span className="improve-artifact-name">{a.name}</span>
                <span className="improve-kind-chip">{KIND_LABEL[a.kind] ?? a.kind}</span>
              </button>
              {isOpen && (
                <div className="improve-versions-list">
                  <div className="improve-autonomy-row">
                    <span className="improve-meta-label">Autonomy</span>
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
                  {/* P3: the pack's cases with flaky-quarantine controls. */}
                  {(cases[a.id] ?? []).length > 0 && (
                    <div className="improve-cases" data-testid={`cases-${a.id}`}>
                      <span className="improve-meta-label">Eval cases</span>
                      {(cases[a.id] ?? []).map((c) => (
                        <div key={c.id} className={`improve-case-row${c.quarantined ? " quarantined" : ""}`}>
                          <span className="improve-case-input" title={c.inputText}>
                            {c.inputText.length > 90 ? `${c.inputText.slice(0, 90)}…` : c.inputText}
                          </span>
                          <span className="improve-kind-chip">{c.source}</span>
                          {c.quarantined ? (
                            <>
                              <span
                                className="improve-pack-stat quarantined"
                                title={c.quarantineReason}
                              >
                                quarantined
                              </span>
                              <button
                                className="ghost improve-rollback-btn"
                                data-testid={`unquarantine-${c.id}`}
                                onClick={() => void toggleCaseQuarantine(a.id, c.id, false)}
                              >
                                Un-quarantine
                              </button>
                            </>
                          ) : (
                            <button
                              className="ghost improve-rollback-btn"
                              data-testid={`quarantine-${c.id}`}
                              title="Park this case — excluded from gating and pack health"
                              onClick={() => void toggleCaseQuarantine(a.id, c.id, true)}
                            >
                              Quarantine
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="improve-timeline">
                    {(versions[a.id] ?? []).map((v) => (
                      <div key={v.id} className="improve-version-row">
                        <span className="improve-version-chip">v{v.version}</span>
                        <span className="improve-meta-value">{v.origin}</span>
                        <button
                          className="ghost improve-rollback-btn"
                          onClick={() => void rollback(a.id, v.version)}
                          disabled={busy === `${a.id}:${v.version}`}
                          title="Roll back to this version"
                        >
                          Set active
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
