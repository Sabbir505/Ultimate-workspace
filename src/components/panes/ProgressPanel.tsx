// Progress panel — shows the active chat session's task progress (the same
// `chat:task-progress` data the inline TaskProgressCards use, but in a
// dedicated tool-panel tab). Empty state when there are no running/completed
// tasks for the session.
import { useChatStore } from "../../state/chat";

const EMPTY_TASKS: Record<string, unknown> = {};

export function ProgressPanel() {
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);
  const tasks = useChatStore(
    (s) => (activeChatSessionId ? (s.tasks[activeChatSessionId] ?? EMPTY_TASKS) : EMPTY_TASKS),
  );
  const list = Object.values(tasks);

  if (list.length === 0) {
    return (
      <div className="tool-panel-empty">
        <div>No tasks</div>
        <div>Background tasks from the chat will appear here.</div>
      </div>
    );
  }

  return (
    <div className="progress-panel">
      {list.map((t) => {
        const pct = t.total && t.total > 0 ? Math.min(100, (t.downloaded / t.total) * 100) : null;
        return (
          <div key={t.taskId} className="progress-panel-row">
            <div className="progress-panel-header">
              <span className={`progress-panel-status status-${t.state}`}>
                {t.state === "running" ? "●" : t.state === "completed" ? "✓" : "✕"}
              </span>
              <span className="progress-panel-label">{t.message || t.kind}</span>
            </div>
            {t.state === "running" && pct != null && (
              <div className="progress-panel-bar">
                <div className="progress-panel-bar-fill" style={{ width: `${pct}%` }} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
