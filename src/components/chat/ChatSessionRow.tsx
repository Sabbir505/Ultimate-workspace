// Chat session row in the sidebar: title, last-active relative time,
// and a truncated preview of the last message. Styled to match the existing
// .session-row and .project-row patterns.
import { useCallback } from "react";
import { relativeTime } from "../../lib/relativeTime";

export interface ChatSessionRowData {
  id: string;
  title: string;
  lastActiveAt: number;
  lastMessage?: string;
}

interface Props {
  session: ChatSessionRowData;
  active: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

export function ChatSessionRow({ session, active, onSelect, onDelete }: Props) {
  const truncated =
    session.lastMessage
      ? session.lastMessage.length > 60
        ? session.lastMessage.slice(0, 60) + "…"
        : session.lastMessage
      : "";

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDelete(session.id);
    },
    [onDelete, session.id],
  );

  return (
    <div
      className={`chat-session-row${active ? " active" : ""}`}
      onClick={() => onSelect(session.id)}
      title={session.title}
    >
      <div className="chat-session-info">
        <div className="chat-session-title">{session.title}</div>
        <div className="chat-session-meta">
          <span>{relativeTime(session.lastActiveAt)}</span>
          {truncated && <span className="chat-session-preview">{truncated}</span>}
        </div>
      </div>
      <button
        className="ghost danger chat-session-delete"
        onClick={handleDelete}
        title="Delete chat"
      >
        ✕
      </button>
    </div>
  );
}