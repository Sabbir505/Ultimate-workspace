// Chat session row in the sidebar — inbox style, two lines: (1) title +
// working-spinner/relative-time, (2) project · branch context on the left
// and the session's provider/harness/local-model brand icon on the right.
// A vertical three-dot button reveals a context menu (star/pin, rename, mark
// unread, delete) on hover. Styled to match the existing .session-row and
// .project-row patterns.
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Folder, GitBranch } from "lucide-react";
import { relativeTime } from "../../lib/relativeTime";
import { sessionModelIcon } from "./agentIcons";

export interface ChatSessionRowData {
  id: string;
  title: string;
  lastActiveAt: number;
  lastMessage?: string;
  starred?: boolean;
  unread?: boolean;
  /** Isolated git worktree path (roadmap P0 §3.1.1); shows a small badge. */
  worktreePath?: string | null;
  /** Bound project's display name, else the chosen folder's name (inbox
   *  second row, folder icon). */
  projectName?: string | null;
  /** Branch the chat works on: the project repo's branch, or `relay/<id>`
   *  for isolated-worktree chats. Null when unknown (not a repo / not polled). */
  branchName?: string | null;
  /** Session's agent + provider pair — drives the second-row brand icon. */
  agent?: string | null;
  provider?: string | null;
}

interface Props {
  session: ChatSessionRowData;
  active: boolean;
  /** True while this chat has a response streaming (even when viewed elsewhere). */
  working?: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onToggleStar: (id: string, starred: boolean) => void;
  onSetUnread: (id: string, unread: boolean) => void;
  onExport: (id: string) => void;
  /** Open this chat in the split pane beside the main chat view. */
  onOpenSplit?: (id: string) => void;
}

export function ChatSessionRow({
  session,
  active,
  working,
  onSelect,
  onDelete,
  onRename,
  onToggleStar,
  onSetUnread,
  onExport,
  onOpenSplit,
}: Props) {

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAbove, setMenuAbove] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(session.title);
  const rowRef = useRef<HTMLDivElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  // True when the title is truncated — drives the hover marquee so users can
  // read the full title without a tooltip round-trip.
  const [titleOverflows, setTitleOverflows] = useState(false);

  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    const check = () => {
      const shift = Math.max(0, el.scrollWidth - el.clientWidth);
      el.style.setProperty("--marquee-shift", `${shift}px`);
      setTitleOverflows(shift > 2);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [session.title]);

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

  // Flip the context menu upward when opening it downward would overflow the
  // sidebar's scroll viewport (e.g. the row is the last in the list). The
  // sidebar clips overflow, so a downward menu at the bottom is invisible —
  // measure the button's position against the nearest scroll container and
  // place the menu above the button when there's more room up than down.
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const btn = menuBtnRef.current;
    const menu = menuRef.current;
    if (!btn || !menu) return;
    const btnRect = btn.getBoundingClientRect();
    // Walk up to the first scrollable ancestor to get the clipping viewport.
    let scrollEl: HTMLElement | null = btn.parentElement;
    while (scrollEl) {
      const style = getComputedStyle(scrollEl);
      if (/(auto|scroll)/.test(style.overflowY) && scrollEl.scrollHeight > scrollEl.clientHeight) {
        break;
      }
      scrollEl = scrollEl.parentElement;
    }
    const view = scrollEl ?? document.documentElement;
    const viewRect = view.getBoundingClientRect();
    const spaceBelow = viewRect.bottom - btnRect.bottom;
    const menuHeight = menu.offsetHeight;
    setMenuAbove(spaceBelow < menuHeight + 8 && btnRect.top - viewRect.top > menuHeight + 8);
  }, [menuOpen]);

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
      className={`chat-session-row${active ? " active" : ""}${session.unread ? " unread" : ""}${menuOpen ? " menu-open" : ""}`}
      onClick={() => !editing && onSelect(session.id)}
      title={session.title}
    >
      {!working && session.starred && (
        <span className="chat-session-star-badge" title="Starred">
          ★
        </span>
      )}
      {!working && session.unread && !session.starred && (
        <span className="chat-session-unread-dot" aria-label="Unread" />
      )}
      <div className="chat-session-info">
        {/* Title + spinner/timer on the same row */}
        <div className="chat-session-title-row">
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
            <div ref={titleRef} className={`chat-session-title${titleOverflows ? " overflows" : ""}`}>
              <span className="chat-session-title-text">{session.title}</span>
            </div>
          )}
          {/* Time slot: the working spinner takes the timer's place while the
              chat is streaming; the relative time returns once it's done. The
              ⋮ button shares the slot and fades in on hover (or while the
              menu is open) — no layout shift. */}
          <div className="chat-session-meta">
            {working ? (
              <span className="chat-session-working" title="Working…" aria-label="Working" />
            ) : (
              <span className="chat-session-time">{relativeTime(session.lastActiveAt)}</span>
            )}
            {session.worktreePath && (
              <span
                className="chat-session-worktree-badge"
                title={`Isolated worktree: ${session.worktreePath}`}
              >
                ⛓
              </span>
            )}
            <button
              ref={menuBtnRef}
              className="ghost chat-session-menu-btn"
              onClick={openMenu}
              title="Chat options"
              aria-label="Chat options"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              ⋮
            </button>
          </div>
        </div>
        {/* Inbox second row: 📁 project/folder + git branch on the left, the
            session's provider/harness/local-model brand icon on the right. */}
        <div className="chat-session-sub-row">
          {session.projectName && (
            <span className="chat-session-context" title={session.projectName}>
              <Folder size={10} strokeWidth={1.8} className="chat-session-context-icon" />
              <span className="chat-session-context-text">{session.projectName}</span>
            </span>
          )}
          {session.branchName && (
            <span className="chat-session-branch" title={session.branchName}>
              <GitBranch size={10} strokeWidth={1.8} className="chat-session-context-icon" />
              <span className="chat-session-context-text">{session.branchName}</span>
            </span>
          )}
          <span
            className="chat-session-provider"
            title={[session.provider, session.agent?.startsWith("harness:") ? session.agent.slice(8) : session.agent]
              .filter(Boolean)
              .join(" · ")}
          >
            {sessionModelIcon(session.agent, session.provider)}
          </span>
        </div>
      </div>

      {menuOpen && (
        <div
          ref={menuRef}
          className="chat-session-menu"
          data-above={menuAbove ? "" : undefined}
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
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
          <button role="menuitem" onClick={(e) => menuAction(e, () => onExport(session.id))}>
            <span className="chat-menu-icon">↓</span>
            Export as zip
          </button>
          {onOpenSplit && (
            <button role="menuitem" onClick={(e) => menuAction(e, () => onOpenSplit(session.id))}>
              <span className="chat-menu-icon">⧉</span>
              Open in split view
            </button>
          )}
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

// PERF (PERFORMANCE_AUDIT.md F5): wrap the row in React.memo so a streaming
// token in one chat (which re-renders the Sidebar on every store change) does
// not force every other row to re-render. The Sidebar now passes stable
// `handleSelectChat` etc. via useCallback so the per-row props stay
// reference-stable across renders.
export const ChatSessionRowMemo = memo(ChatSessionRow);
ChatSessionRowMemo.displayName = "ChatSessionRow";
