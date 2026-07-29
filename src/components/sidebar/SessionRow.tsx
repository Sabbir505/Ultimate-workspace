// Sidebar session row (wireframe §12.5): state dot matching the pane-state
// legend, editable auto-generated title (§7.4), harness badge, relative time.
import { useState } from "react";
import { sessionDisplayTitle } from "../../lib/sessionTitle";
import { relativeTime } from "../../lib/relativeTime";
import { openSession } from "../../lib/sessionLauncher";
import { usePanesStore } from "../../state/panes";
import { useProjectsStore } from "../../state/projects";
import type { SessionRecord } from "../../types";
import { harnessShortName } from "../../types";

interface Props {
  session: SessionRecord;
  projectName: string;
}

export function SessionRow({ session, projectName }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const panes = usePanesStore((s) => s.panes);
  const closePane = usePanesStore((s) => s.closePane);
  const setSessionTitle = useProjectsStore((s) => s.setSessionTitle);
  const removeSession = useProjectsStore((s) => s.removeSession);

  // Live-state dot: if a pane is open for this session, mirror its state.
  const livePane = panes.find((p) => p.data.kind === "terminal" && p.data.sessionId === session.id);
  const dotState = livePane ? livePane.state : "idle";

  const commitTitle = () => {
    const trimmed = draft.trim();
    if (trimmed.length > 0 && trimmed !== session.title) {
      void setSessionTitle(session.id, trimmed);
    }
    setEditing(false);
  };

  return (
    <div
      className="session-row"
      onClick={() => void openSession(session)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setDraft(sessionDisplayTitle(session.title));
        setEditing(true);
      }}
      title="Click to open/resume · double-click to rename"
    >
      <span className="state-dot" data-state={dotState} style={{ marginTop: 4 }} />
      <div className="info">
        {editing ? (
          <input
            className="title-edit"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTitle();
              if (e.key === "Escape") setEditing(false);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div className="title">{sessionDisplayTitle(session.title)}</div>
        )}
        <div className="meta">
          <span>{projectName}</span>
          <span className="harness-tag">{harnessShortName(session.harness)}</span>
          <span>{relativeTime(session.lastActiveAt)}</span>
          <button
            className="ghost danger"
            style={{ padding: "0 4px", fontSize: 10 }}
            title="Delete session from history"
            onClick={(e) => {
              e.stopPropagation();
              // §6.5: closing the live pane is the only path that kills the
              // pty. If we only drop the session row, the pane (and process)
              // would linger on the dev tab pointing at a deleted session.
              for (const p of usePanesStore.getState().panes) {
                if (p.data.kind === "terminal" && p.data.sessionId === session.id) {
                  closePane(p.paneId);
                }
              }
              void removeSession(session.id);
            }}
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
