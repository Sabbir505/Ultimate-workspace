// Onboarding check (§9): when neither supported harness binary is on PATH we
// show install guidance — without blocking the rest of the app.
import { useState } from "react";
import { useProjectsStore } from "../../state/projects";
import { useUiStore } from "../../state/ui";

export function OnboardingBanner() {
  const loaded = useProjectsStore((s) => s.loaded);
  const harnesses = useProjectsStore((s) => s.harnesses);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;
  if (!loaded || harnesses.length === 0) return null;
  if (harnesses.some((h) => h.installed)) return null;

  return (
    <div className="onboarding-banner">
      <button
        className="onboarding-banner-close"
        onClick={() => setDismissed(true)}
        title="Dismiss"
        aria-label="Dismiss notification"
      >
        ×
      </button>
      <strong>No agent harness detected</strong>
      <div className="hint">
        Relay orchestrates existing CLI agents. None of {harnesses.map((h) => h.displayName).join(", ")} was
        found on your PATH. Install one from Settings → Harnesses to start agent sessions — project
        management, the browser pane, and everything else works regardless.
      </div>
      <div className="hint">
        Claude Code: <code>npm install -g @anthropic-ai/claude-code</code> · OpenCode:{" "}
        <code>npm install -g opencode-ai</code> · Pi: <code>npm install -g @earendil-works/pi-coding-agent</code>{" "}
        · Omp: <code>npm install -g @oh-my-pi/pi-coding-agent</code> · CommandCode:{" "}
        <code>npm install -g command-code</code>
      </div>
      <div>
        <button onClick={() => setActiveView("settings")}>Open Settings to install</button>
      </div>
    </div>
  );
}
