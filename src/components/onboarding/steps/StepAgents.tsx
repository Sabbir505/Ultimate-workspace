// Step 3 — Pick an agent. Live harness detection from the projects store
// (the boot probe already ran listHarnesses): skeleton rows while the probe
// is in flight, staggered reveal with Ready/Install per harness, a
// first-class Local Model row that deep-links into the Model Market, and a
// Re-scan that forces a fresh PATH probe. Never blocking — built-in chat
// works without any harness.
import { toastSuccess } from "../../../lib/ipc";
import { useProjectsStore } from "../../../state/projects";
import { closeOnboardingForDeepLink } from "../../../state/onboarding";
import { useUiStore } from "../../../state/ui";
import type { HarnessId } from "../../../types";
import {
  ClaudeIcon,
  CommandCodeIcon,
  KimiIcon,
  LocalModelIcon,
  OmpIcon,
  OpenCodeIcon,
  PiIcon,
} from "../../chat/agentIcons";

const INSTALL_COMMANDS: Partial<Record<HarnessId, string>> = {
  claude_code: "npm install -g @anthropic-ai/claude-code",
  opencode: "npm install -g opencode-ai",
  pi: "npm install -g @earendil-works/pi-coding-agent",
  omp: "npm install -g @oh-my-pi/pi-coding-agent",
  commandcode: "npm install -g command-code",
};

/** Harness glyph — same mapping as AgentModelPicker's rail. */
function HarnessGlyph({ id }: { id: HarnessId }) {
  if (id === "claude_code") return <ClaudeIcon />;
  if (id === "kimi_code") return <KimiIcon />;
  if (id === "opencode") return <OpenCodeIcon />;
  if (id === "pi") return <PiIcon />;
  if (id === "omp") return <OmpIcon />;
  if (id === "commandcode") return <CommandCodeIcon />;
  return <LocalModelIcon />;
}

export function StepAgents() {
  const harnesses = useProjectsStore((s) => s.harnesses);
  const refreshHarnesses = useProjectsStore((s) => s.refreshHarnesses);
  const scanning = harnesses.length === 0;

  const rescan = () => void refreshHarnesses(true);

  const openMarket = () => {
    // Leaving through the Model Market is a deliberate local-model choice —
    // closeOnboarding writes onboarding.completed AND localModels.onboarded,
    // so the flow won't re-open and the standalone nudge stays quiet.
    closeOnboardingForDeepLink();
    const ui = useUiStore.getState();
    ui.setSettingsCategory("localmodels");
    ui.setLocalModelsOpenMarket(true);
    ui.setActiveView("settings");
  };

  const installedCount = harnesses.filter((h) => h.installed).length;

  return (
    <>
      <div className="onboarding-eyebrow onb-rise">Connect your first agent</div>
      <h2 className="onboarding-title onb-rise">Pick an agent to get started</h2>
      <p className="onboarding-lede onb-rise" role="status">
        {scanning
          ? "Scanning this machine for installed agents…"
          : `${installedCount} of ${harnesses.length} agents detected on this machine — connect one or skip ahead.`}
      </p>

      <div className="onboarding-agent-list" aria-busy={scanning}>
        {scanning
          ? [0, 1, 2, 3].map((i) => (
              <div className="onboarding-skel-row" key={i}>
                <div className="onboarding-skel onboarding-skel-icon" />
                <div>
                  <div className="onboarding-skel onboarding-skel-l1" />
                  <div className="onboarding-skel onboarding-skel-l2" />
                </div>
                <div className="onboarding-skel onboarding-skel-end" />
              </div>
            ))
          : harnesses.map((h, i) => {
              const command = INSTALL_COMMANDS[h.id];
              return (
                <div className="onboarding-agent-row onb-rise" style={{ "--d": `${i * 70}ms` } as React.CSSProperties} key={h.id}>
                  <span className="onboarding-agent-icon">
                    <HarnessGlyph id={h.id} />
                  </span>
                  <span className="onboarding-agent-copy">
                    <b>{h.displayName}</b>
                    <span className="onboarding-agent-status">
                      <span className={h.installed ? "onboarding-st-dot" : "onboarding-st-dot off"} />
                      {h.installed ? "Installed — ready to connect" : "Not installed"}
                    </span>
                  </span>
                  <span className="onboarding-agent-end">
                    {h.installed ? (
                      <>
                        <span className="onboarding-badge">Ready</span>
                        <span className="onboarding-row-chev" aria-hidden="true">
                          ›
                        </span>
                      </>
                    ) : command ? (
                      <button
                        type="button"
                        className="onboarding-btn onboarding-btn-outline"
                        title={`Copy: ${command}`}
                        onClick={() => {
                          void navigator.clipboard.writeText(command).then(() => toastSuccess("Install command copied"));
                        }}
                      >
                        Install
                      </button>
                    ) : (
                      <span className="onboarding-agent-status">—</span>
                    )}
                  </span>
                </div>
              );
            })}

        {!scanning && (
          <div
            className="onboarding-agent-row local onb-rise"
            style={{ "--d": `${harnesses.length * 70}ms` } as React.CSSProperties}
          >
            <span className="onboarding-agent-icon">
              <LocalModelIcon />
            </span>
            <span className="onboarding-agent-copy">
              <b>Local Model</b>
              <span className="onboarding-agent-status">
                Run open models on your machine — no API key or account needed
              </span>
            </span>
            <span className="onboarding-agent-end">
              <button type="button" className="onboarding-btn onboarding-btn-outline onboarding-btn-green" onClick={openMarket}>
                Setup
              </button>
            </span>
          </div>
        )}
      </div>

      <div className="onboarding-agent-foot onb-rise">
        <span className="onboarding-note">Anything you skip now can be finished later from Settings.</span>
        <button type="button" className="onboarding-btn onboarding-btn-ghost" onClick={rescan} disabled={scanning}>
          {scanning ? "Scanning…" : "↻ Re-scan"}
        </button>
      </div>
    </>
  );
}
