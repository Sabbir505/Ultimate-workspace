// Compact branch pill for the top-right toolbar. Shows a branch icon + current
// branch name + caret. Clicking opens the BranchDropdown popover. This is the
// ONLY git element in the toolbar — everything else lives in the GitToolsSidebar
// (the full vertical panel on the right).
//
// The popover PORTALS to <body>: the toolbar carries backdrop-filter (it's
// glass), which forms a backdrop root — a nested popover's own frost would
// only sample the toolbar's empty backdrop and render transparent (chat text
// bled through it sharply). Portaled + fixed-anchored to the pill instead.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useProjectsStore } from "../../state/projects";
import { useChatStore } from "../../state/chat";
import { BranchDropdown } from "./BranchDropdown";

export function GitMenu() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

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
      const t = e.target as Node;
      // Both the pill and the portaled popover count as "inside".
      if (
        wrapRef.current &&
        !wrapRef.current.contains(t) &&
        !popRef.current?.contains(t)
      ) {
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
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="git-menu-popover"
            style={{
              position: "fixed",
              top: (wrapRef.current?.getBoundingClientRect().bottom ?? 0) + 6,
              right: Math.max(
                8,
                window.innerWidth - (wrapRef.current?.getBoundingClientRect().right ?? 0),
              ),
              left: "auto",
              bottom: "auto",
              zIndex: 9999,
            }}
          >
            <BranchDropdown onClose={() => setOpen(false)} />
          </div>,
          document.body,
        )}
    </div>
  );
}
