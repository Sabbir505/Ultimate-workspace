// Chat session row in the sidebar: title, last-active relative time, and a
// truncated preview of the last message. A vertical three-dot button reveals
// a context menu (star/pin, rename, mark unread, delete) on hover. Styled to
// match the existing .session-row and .project-row patterns.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { relativeTime } from "../../lib/relativeTime";

export interface ChatSessionRowData {
  id: string;
  title: string;
  lastActiveAt: number;
  lastMessage?: string;
  starred?: boolean;
  unread?: boolean;
}

interface Props {
  session: ChatSessionRowData;
  active: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onToggleStar: (id: string, starred: boolean) => void;
  onSetUnread: (id: string, unread: boolean) => void;
}

export function ChatSessionRow({
  session,
  active,
  onSelect,
  onDelete,
  onRename,
  onToggleStar,
  onSetUnread,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(session.title);
  const rowRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const truncated =
    session.lastMessage
      ? session.lastMessage.length > 60
        ? session.lastMessage.slice(0, 60) + "…"
        : session.lastMessage
      : "";

  // Close the menu on any outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (rowRef.current && !rowRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  useLayoutEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const openMenu = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen((o) => !o);
  }, []);

  const commitRename = useCallback(() => {
    const next = draftTitle.trim();
    if (next && next !== session.title) onRename(session.id, next);
    setEditing(false);
  }, [draftTitle, onRename, session.id, session.title]);

  const startRename = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setMenuOpen(false);
      setDraftTitle(session.title);
      setEditing(true);
    },
    [session.title],
  );

  const menuAction = useCallback((e: React.MouseEvent, fn: () => void) => {
    e.stopPropagation();
    setMenuOpen(false);
    fn();
  }, []);

  return (
    <div
      ref={rowRef}
      className={`chat-session-row${active ? " active" : ""}${session.unread ? " unread" : ""}`}
      onClick={() => !editing && onSelect(session.id)}
      title={session.title}
    >
      {session.starred && (
        <span className="chat-session-star-badge" title="Starred">
          ★
        </span>
      )}
      {session.unread && !session.starred && (
        <span className="chat-session-unread-dot" aria-label="Unread" />
      )}
      <div className="chat-session-info">
        {editing ? (
          <input
            ref={inputRef}
            className="chat-session-rename-input"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              else if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <div className="chat-session-title">{session.title}</div>
        )}
        <div className="chat-session-meta">
          <span>{relativeTime(session.lastActiveAt)}</span>
          {truncated && <span className="chat-session-preview">{truncated}</span>}
        </div>
      </div>

      <button
        className="ghost chat-session-menu-btn"
        onClick={openMenu}
        title="Chat options"
        aria-label="Chat options"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        ⋮
      </button>

      {menuOpen && (
        <div className="chat-session-menu" role="menu" onClick={(e) => e.stopPropagation()}>
          <button
            role="menuitem"
            onClick={(e) => menuAction(e, () => onToggleStar(session.id, !session.starred))}
          >
            <span className="chat-menu-icon">★</span>
            {session.starred ? "Remove from top" : "Keep at top"}
          </button>
          <button role="menuitem" onClick={startRename}>
            <span className="chat-menu-icon">✎</span>
            Rename
          </button>
          <button
            role="menuitem"
            onClick={(e) => menuAction(e, () => onSetUnread(session.id, !session.unread))}
          >
            <span className="chat-menu-icon">●</span>
            {session.unread ? "Mark as read" : "Mark as unread"}
          </button>
          <button
            role="menuitem"
            className="danger"
            onClick={(e) => menuAction(e, () => onDelete(session.id))}
          >
            <span className="chat-menu-icon">🗑</span>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
