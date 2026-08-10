// Compact branch pill for the top-right toolbar. Shows a branch icon + current
// branch name + caret. Clicking opens the BranchDropdown popover. This is the
// ONLY git element in the toolbar — everything else lives in the GitToolsSidebar
// (the full vertical panel on the right).
import { useEffect, useRef, useState } from "react";
import { useProjectsStore } from "../../state/projects";
import { useChatStore } from "../../state/chat";
import { BranchDropdown } from "./BranchDropdown";

export function GitMenu() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const boundProjectId = useChatStore((s) =>
    s.activeChatSessionId ? s.sessionProjects[s.activeChatSessionId] : undefined,
  );
  const selectedProjectId = useProjectsStore((s) => s.selectedProjectId);
  const projectId = boundProjectId ?? selectedProjectId;
  const gitStatus = useProjectsStore((s) =>
    projectId ? s.gitStatuses[projectId] : undefined,
  );

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (!gitStatus?.isRepo || !gitStatus.branch) return null;

  return (
    <div className="git-menu" ref={wrapRef}>
      <button
        className={`git-menu-branch${open ? " open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title={`Branch: ${gitStatus.branch}`}
      >
        <svg
          width={13}
          height={13}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="4" cy="3" r="1.5" />
          <circle cx="4" cy="13" r="1.5" />
          <circle cx="12" cy="3" r="1.5" />
          <path d="M4 4.5v7" />
          <path d="M12 4.5c0 4-4 2-4 4.5" />
        </svg>
        <span className="git-menu-branch-name">{gitStatus.branch}</span>
        <span className="git-menu-branch-caret">▾</span>
      </button>
      {open && (
        <div className="git-menu-popover">
          <BranchDropdown onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
