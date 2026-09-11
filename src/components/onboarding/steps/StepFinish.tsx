// Step 4 of the welcome wizard: land the user somewhere useful. Adding a
// project finishes the wizard directly (the git-init prompt, if needed,
// fires afterwards via App's own flow); Done just closes.
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useProjectsStore } from "../../../state/projects";
import { closeOnboarding } from "../../../state/onboarding";

const POINTERS = [
  {
    title: "Connectors",
    text: "Attach Notion, GitHub, Google Drive and more — Settings → Connectors.",
  },
  {
    title: "Mobile companion",
    text: "Pair your phone over the QR in the sidebar footer; keys never leave this machine.",
  },
  {
    title: "Automations",
    text: "Schedule headless agent runs with cron — even while Relay is closed.",
  },
];

export function StepFinish() {
  const [adding, setAdding] = useState(false);
  const addProjectAtPath = useProjectsStore((s) => s.addProjectAtPath);

  const addProject = async () => {
    setAdding(true);
    try {
      const picked = await open({ directory: true });
      if (typeof picked === "string") {
        await addProjectAtPath(picked);
        // The project is in — the wizard's job is done (any git-init prompt
        // is App's own flow and fires after we close).
        closeOnboarding();
      }
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="onboarding-step onboarding-step-center">
      <div className="onboarding-check" aria-hidden="true">
        <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </div>
      <h2 className="onboarding-title">You're all set</h2>
      <p className="onboarding-sub">
        Open a folder to give agents a home base — or just start chatting.
      </p>
      <button
        type="button"
        className="onboarding-btn onboarding-btn-primary onboarding-add-project"
        disabled={adding}
        onClick={() => void addProject()}
      >
        {adding ? "Adding…" : "Add your first project"}
      </button>
      <div className="onboarding-pointers">
        {POINTERS.map((p) => (
          <div className="onboarding-pointer" key={p.title}>
            <div className="onboarding-pointer-title">{p.title}</div>
            <div className="onboarding-pointer-text">{p.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
