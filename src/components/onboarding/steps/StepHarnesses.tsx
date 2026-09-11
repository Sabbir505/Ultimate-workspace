// Step 3 of the welcome wizard: agent-harness presence check (PRD §9).
// Purely informational and never blocking — the built-in chat, project
// management, and everything else work without any harness installed.
// Install commands mirror OnboardingBanner's list (the repo's canonical
// copy); harnesses without a documented command just show their status.
import { useState } from "react";
import { toastSuccess } from "../../../lib/ipc";
import { useProjectsStore } from "../../../state/projects";
import type { HarnessId } from "../../../types";

const INSTALL_COMMANDS: Partial<Record<HarnessId, string>> = {
  claude_code: "npm install -g @anthropic-ai/claude-code",
  opencode: "npm install -g opencode-ai",
  pi: "npm install -g @earendil-works/pi-coding-agent",
  omp: "npm install -g @oh-my-pi/pi-coding-agent",
  commandcode: "npm install -g command-code",
};

export function StepHarnesses() {
  const harnesses = useProjectsStore((s) => s.harnesses);
  const refreshHarnesses = useProjectsStore((s) => s.refreshHarnesses);
  const [scanning, setScanning] = useState(false);

  const rescan = async () => {
    setScanning(true);
    try {
      await refreshHarnesses(true);
    } finally {
      setScanning(false);
    }
  };

  const installedCount = harnesses.filter((h) => h.installed).length;

  return (
    <div className="onboarding-step">
      <h2 className="onboarding-title">Agent harnesses</h2>
      <p className="onboarding-sub">
        Agent panes drive the CLI agents you already use. None is required — the built-in chat
        works without them.
      </p>

      {harnesses.length === 0 ? (
        <p className="onboarding-note">Checking your PATH…</p>
      ) : (
        <div className="onboarding-harness-list">
          {harnesses.map((h) => {
            const command = INSTALL_COMMANDS[h.id];
            return (
              <div className="onboarding-harness-row" key={h.id}>
                <span className={`onboarding-harness-dot${h.installed ? " ok" : ""}`} aria-hidden="true" />
                <span className="onboarding-harness-name">{h.displayName}</span>
                {h.installed ? (
                  <span className="onboarding-harness-status ok">Installed</span>
                ) : command ? (
                  <span className="onboarding-harness-install">
                    <code>{command}</code>
                    <button
                      type="button"
                      className="onboarding-copy-btn"
                      title="Copy install command"
                      aria-label={`Copy install command for ${h.displayName}`}
                      onClick={() => {
                        void navigator.clipboard.writeText(command).then(
                          () => toastSuccess("Install command copied"),
                        );
                      }}
                    >
                      Copy
                    </button>
                  </span>
                ) : (
                  <span className="onboarding-harness-status">Not found</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="onboarding-harness-foot">
        <span className="onboarding-note">
          {harnesses.length > 0
            ? installedCount > 0
              ? `${installedCount} of ${harnesses.length} harnesses installed.`
              : "Install any one of them later — Settings → Harnesses can also log you in."
            : ""}
        </span>
        <button type="button" className="onboarding-btn" onClick={() => void rescan()} disabled={scanning}>
          {scanning ? "Scanning…" : "Re-scan"}
        </button>
      </div>
    </div>
  );
}
