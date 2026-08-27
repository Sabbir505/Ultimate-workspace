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
        Relay orchestrates existing CLI agents. Neither <code>claude</code> (Claude Code) nor{" "}
        <code>kimi</code> (Kimi Code CLI) was found on your PATH. Install one of them to start agent
        sessions — project management, the browser pane, and everything else works regardless.
      </div>
      <div className="hint">
        Claude Code: <code>npm install -g @anthropic-ai/claude-code</code> · Kimi Code CLI: see{" "}
        <code>https://www.kimi.com/code</code>
      </div>
      <div>
        <button onClick={() => setActiveView("settings")}>Open Settings to re-check</button>
      </div>
    </div>
  );
}
