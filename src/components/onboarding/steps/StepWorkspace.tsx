// Step 4 — Where do you want to work? "Open a project" and "Choose a
// folder" both land in the native folder picker and add the folder to Relay
// (same dialog, different intent copy — Relay is project-centric); the
// preview panel then shows what was actually detected (name, path, real git
// status from the Project record). "I'll do this later" defers without a
// picker. Adding here does NOT close the wizard — Finish does.
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useProjectsStore } from "../../../state/projects";

export function StepWorkspace() {
  const [picked, setPicked] = useState<{ name: string; path: string; isGitRepo: boolean } | null>(null);
  const [deferred, setDeferred] = useState(false);
  const [adding, setAdding] = useState(false);
  const addProjectAtPath = useProjectsStore((s) => s.addProjectAtPath);

  const pickFolder = async () => {
    setAdding(true);
    try {
      const result = await open({ directory: true });
      if (typeof result === "string") {
        const project = await addProjectAtPath(result);
        if (project) {
          setPicked({ name: project.name, path: project.path, isGitRepo: project.isGitRepo });
          setDeferred(false);
        }
      }
    } finally {
      setAdding(false);
    }
  };

  return (
    <>
      <div className="onboarding-eyebrow onb-rise">Choose a workspace</div>
      <h2 className="onboarding-title onb-rise">Where do you want to work?</h2>
      <p className="onboarding-lede onb-rise">Open an existing project or pick a folder to get started.</p>

      <div className="onboarding-split">
        <div className="onboarding-stack">
          <button
            type="button"
            className={`onboarding-radio-card onb-rise${picked && !deferred ? " selected" : ""}`}
            disabled={adding}
            onClick={() => void pickFolder()}
          >
            <span className="onboarding-radio-icon">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </span>
            <span className="onboarding-radio-copy">
              <b>{adding ? "Adding…" : "Open a project"}</b>
              <span>Use a folder with an existing project (Git, etc.)</span>
            </span>
            <span className="onboarding-chev" aria-hidden="true">
              ›
            </span>
          </button>
          <button
            type="button"
            className={`onboarding-radio-card onb-rise${picked && !deferred ? " selected" : ""}`}
            disabled={adding}
            onClick={() => void pickFolder()}
          >
            <span className="onboarding-radio-icon">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
              </svg>
            </span>
            <span className="onboarding-radio-copy">
              <b>Choose a folder</b>
              <span>Pick any folder on your device</span>
            </span>
            <span className="onboarding-chev" aria-hidden="true">
              ›
            </span>
          </button>
          <button
            type="button"
            className={`onboarding-radio-card onb-rise${deferred ? " selected" : ""}`}
            disabled={adding}
            onClick={() => {
              setDeferred(true);
              setPicked(null);
            }}
          >
            <span className="onboarding-radio-icon">+</span>
            <span className="onboarding-radio-copy">
              <b>I'll do this later</b>
              <span>You can always set this up in settings</span>
            </span>
            <span className="onboarding-chev" aria-hidden="true">
              ›
            </span>
          </button>
        </div>

        <div className={`onboarding-preview onb-rise${picked || deferred ? "" : " pending"}`}>
          {picked ? (
            <>
              <div className="onboarding-proj">
                <span className="onboarding-proj-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                </span>
                <div className="onboarding-proj-copy">
                  <b>{picked.name}</b>
                  <span>{picked.path}</span>
                </div>
              </div>
              <ul className="onboarding-checks">
                <li className="onb-appear" style={{ "--d": "80ms" } as React.CSSProperties}>
                  <span className="onboarding-ck">✔</span> Added to Relay
                </li>
                <li className="onb-appear" style={{ "--d": "160ms" } as React.CSSProperties}>
                  <span className="onboarding-ck">✔</span>
                  {picked.isGitRepo ? " Git repository detected" : " Folder ready for agents"}
                </li>
              </ul>
            </>
          ) : deferred ? (
            <div className="onboarding-preview-empty">
              <div className="onboarding-preview-big">🌙</div>
              No worries — you can add a project
              <br />
              anytime from the sidebar.
            </div>
          ) : (
            <div className="onboarding-preview-empty">
              <div className="onboarding-preview-big">▣</div>
              Pick a folder and its details
              <br />
              will show up here.
            </div>
          )}
        </div>
      </div>
    </>
  );
}
