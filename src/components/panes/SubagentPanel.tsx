/**
 * SubagentPanel — renders the active subagent's chat inside the right-side
 * ToolPanel's "Agents" tab. Shows the initial prompt as a user-style bubble,
 * then the subagent's output streaming in real-time beneath it. Read-only;
 * no composer. When no subagent is selected, shows a list of all agents.
 */

import { useEffect, useLayoutEffect, useRef } from "react";
import { useChatStore } from "../../state/chat";
import { useUiStore } from "../../state/ui";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function SubagentListItem({
  sub,
  selected,
  onClick,
}: {
  sub: { id: string; role: string; task: string; status: "running" | "completed" | "error" };
  selected: boolean;
  onClick: () => void;
}) {
  const dotClass =
    sub.status === "running"
      ? "subagent-dot running"
      : sub.status === "error"
        ? "subagent-dot error"
        : "subagent-dot done";
  return (
    <button
      className={`subagent-list-item${selected ? " selected" : ""}`}
      onClick={onClick}
      title={`${sub.role}: ${sub.task}`}
    >
      <span className={dotClass} />
      <span className="subagent-list-role">{sub.role}</span>
      <span className="subagent-list-task">{sub.task}</span>
      {sub.status === "running" && (
        <span className="subagent-list-spinner" />
      )}
      {sub.status === "completed" && <span className="subagent-check">✓</span>}
      {sub.status === "error" && <span className="subagent-x">✕</span>}
    </button>
  );
}

export function SubagentPanel() {
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);
  const subagents = useChatStore(
    (s) => (activeChatSessionId ? s.subagents[activeChatSessionId] ?? {} : {}),
  );
  const activeSubagentId = useUiStore((s) => s.activeSubagentId);
  const setActiveSubagentId = useUiStore((s) => s.setActiveSubagentId);
  const setToolPanelTab = useUiStore((s) => s.setToolPanelTab);
  const panelRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the end as the subagent outputs tokens
  useLayoutEffect(() => {
    if (panelRef.current) {
      panelRef.current.scrollTop = panelRef.current.scrollHeight;
    }
  });

  // Click outside the list to close — keep panel mounted but show list
  const selectedSub =
    activeSubagentId != null ? subagents[activeSubagentId] : undefined;

  // When subagent is selected, auto-open the Agents tab if somehow not active
  useEffect(() => {
    if (selectedSub) {
      setToolPanelTab("agents");
    }
  }, [selectedSub?.id]);

  // Navigate back to the list when the selected sub is gone (e.g., session switch)
  useEffect(() => {
    if (activeSubagentId && !subagents[activeSubagentId]) {
      setActiveSubagentId(null);
    }
  }, [activeSubagentId, subagents]);

  if (!activeChatSessionId || Object.keys(subagents).length === 0) {
    return (
      <div className="subagent-panel-empty">
        <div className="subagent-empty-icon">⬡</div>
        <div>No subagents yet</div>
        <div className="subagent-empty-hint">
          Spawned by the agent will appear here.
        </div>
      </div>
    );
  }

  if (selectedSub) {
    return (
      <div className="subagent-panel-view">
        <div className="subagent-panel-header">
          <button
            className="ghost subagent-back-btn"
            onClick={() => setActiveSubagentId(null)}
            title="Back to list"
          >
            ←
          </button>
          <span className="subagent-panel-title">
            <span className="subagent-panel-role">{selectedSub.role}</span>
            <span className="subagent-panel-task-truncate" title={selectedSub.task}>
              {selectedSub.task}
            </span>
          </span>
          <span
            className={`subagent-panel-status ${
              selectedSub.status === "running"
                ? "running"
                : selectedSub.status === "error"
                  ? "error"
                  : "done"
            }`}
          >
            {selectedSub.status === "running" && (
              <span className="subagent-panel-spinner" />
            )}
            {selectedSub.status === "completed" && "Done"}
            {selectedSub.status === "error" && "Error"}
          </span>
        </div>
        <div className="subagent-panel-body" ref={panelRef}>
          {/* Prompt bubble */}
          <div className="subagent-bubble subagent-prompt-bubble">
            <div className="subagent-bubble-label">Prompt</div>
            <div className="subagent-bubble-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {selectedSub.prompt}
              </ReactMarkdown>
            </div>
          </div>
          {/* Output bubble — grows live as tokens stream in */}
          <div className="subagent-bubble subagent-output-bubble">
            <div className="subagent-bubble-label">Output</div>
            <div className="subagent-bubble-content subagent-bubble-streaming">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {selectedSub.output}
              </ReactMarkdown>
              {selectedSub.status === "running" && (
                <span className="streaming-cursor" />
              )}
            </div>
          </div>
          <div ref={bottomRef} />
        </div>
      </div>
    );
  }

  // List view
  return (
    <div className="subagent-panel-list">
      <div className="subagent-panel-header">
        <span className="subagent-panel-title">Agents</span>
        <span className="subagent-count-badge">{Object.keys(subagents).length}</span>
      </div>
      <div className="subagent-list">
        {Object.values(subagents).map((sub) => (
          <SubagentListItem
            key={sub.id}
            sub={sub}
            selected={activeSubagentId === sub.id}
            onClick={() => setActiveSubagentId(sub.id)}
          />
        ))}
      </div>
    </div>
  );
}
