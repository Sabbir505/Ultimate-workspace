// Self-contained composer chrome: the queued-message rows, quoted-selection
// row, the folder/git notches, and the extended-thinking toggle. Carved out of
// ChatComposer.tsx verbatim (pure move); ChatComposer re-exports the notches
// so existing import sites are unchanged.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpToLine, GripVertical, Pencil, Trash2, X } from "lucide-react";
import type { QueuedChatMessage } from "../../state/chat";
import { useChatStore, selectContextSessionId } from "../../state/chat";
import { useUiStore } from "../../state/ui";
import { useProjectsStore } from "../../state/projects";
import { BranchDropdown } from "./BranchDropdown";
import { FolderIcon, pathBasename } from "./composerShared";

/** One stacked queued message inside the composer notch (Cursor-style): the
 *  grip drag-reorders via POINTER events (HTML5 drag-and-drop proved dead
 *  inside the Electron webview — no dragstart ever fired), click the text to
 *  expand/collapse it, ↥ Steer sends it immediately (interrupting the running
 *  turn), the pencil edits it in place (compact — Save/Cancel stay on the
 *  row), the trash drops it. */
export function QueuedMessageRow({
  message,
  index,
  count,
  onSteer,
  onEdit,
  onDelete,
  onReorder,
}: {
  message: QueuedChatMessage;
  index: number;
  count: number;
  onSteer: () => void;
  onEdit: (text: string) => void;
  onDelete: () => void;
  /** Live reorder: source index → new index while the pointer drags. */
  onReorder: (from: number, to: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [dragging, setDragging] = useState(false);
  // Drag bookkeeping lives in a ref: the store reorder re-renders the list,
  // but the pointer capture stays on the grip, so tracking survives.
  const dragIndex = useRef(index);
  const dragPointerId = useRef<number | null>(null);

  const label =
    message.content ||
    `${message.attachments?.length ?? 0} attachment${(message.attachments?.length ?? 0) === 1 ? "" : "s"}`;

  const commitEdit = () => {
    const text = draft.trim();
    if (text) onEdit(text);
    setEditing(false);
  };

  const endDrag = () => {
    dragPointerId.current = null;
    setDragging(false);
  };

  const onGripPointerDown = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (editing) return;
    e.preventDefault();
    e.stopPropagation();
    dragIndex.current = index;
    dragPointerId.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };

  const onGripPointerMove = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (dragPointerId.current !== e.pointerId) return;
    // Which row slot is the pointer over RIGHT NOW? Rects are queried live so
    // the tracking survives the list re-rendering after each reorder. The
    // hit-test is scoped to THIS composer's queue: split view mounts one
    // composer per pane, and the document-global selector used to see the
    // other pane's rows too — their (overlapping viewport) rects won the
    // last-match-wins loop and produced an out-of-range index that silently
    // no-op'd the reorder.
    const queue = e.currentTarget.closest<HTMLDivElement>(".composer-queue");
    let target = dragIndex.current;
    if (queue) {
      queue.querySelectorAll<HTMLDivElement>(".composer-queue-row").forEach((el, i) => {
        const r = el.getBoundingClientRect();
        if (e.clientY >= r.top && e.clientY <= r.bottom) target = i;
      });
    }
    if (target !== dragIndex.current) {
      const from = dragIndex.current;
      dragIndex.current = target;
      onReorder(from, target);
    }
  };

  return (
    <div className={`composer-queue-row${dragging ? " dragging" : ""}`}>
      <span
        className="composer-queue-grip"
        title="Drag to reorder"
        aria-hidden="true"
        onPointerDown={onGripPointerDown}
        onPointerMove={onGripPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <GripVertical size={12} strokeWidth={2} />
      </span>
      {editing ? (
        <>
          <textarea
            autoFocus
            className="composer-queue-edit-input"
            value={draft}
            rows={Math.min(4, draft.split("\n").length)}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // IME composition's confirming Enter commits the composition.
              if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                commitEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setDraft(message.content);
                setEditing(false);
              }
            }}
          />
          <button
            type="button"
            className="composer-queue-btn primary"
            title="Save changes"
            onClick={commitEdit}
          >
            Save
          </button>
          <button
            type="button"
            className="composer-queue-icon-btn"
            title="Cancel editing"
            aria-label="Cancel editing"
            onClick={() => {
              setDraft(message.content);
              setEditing(false);
            }}
          >
            <X size={13} strokeWidth={2.2} />
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className={`composer-queue-text${expanded ? " expanded" : ""}`}
            title={expanded ? "Click to collapse" : "Click to expand"}
            onClick={() => setExpanded((v) => !v)}
          >
            {label}
          </button>
          <button
            type="button"
            className="composer-queue-steer"
            title="Send this message now — interrupts the current turn"
            aria-label={`Steer queued message ${index + 1} of ${count} — send now`}
            onClick={onSteer}
          >
            <ArrowUpToLine size={12} strokeWidth={2.2} aria-hidden="true" />
            Steer
          </button>
          <button
            type="button"
            className="composer-queue-icon-btn"
            title="Edit this message"
            aria-label="Edit queued message"
            onClick={() => {
              setDraft(message.content);
              setEditing(true);
            }}
          >
            <Pencil size={13} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="composer-queue-icon-btn"
            title="Delete this message"
            aria-label="Delete queued message"
            onClick={onDelete}
          >
            <Trash2 size={13} strokeWidth={2} />
          </button>
        </>
      )}
    </div>
  );
}

/** One quoted selection stacked above the textarea (the selection toolbar's
 *  "Ask"): a quiet strip — no bordered box, no hover effects, no tooltips —
 *  visually distinct from the send queue above it. Click expands a long
 *  quote; × drops it. The quoted text is prepended to the NEXT message the
 *  user sends; their typed draft is never overwritten. */
export function QuotedSelectionRow({
  quote,
  onRemove,
}: {
  quote: { id: number; text: string };
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const label = quote.text.trim() || "Empty selection";
  return (
    <div className="composer-quote-row">
      <span className="composer-quote-mark" aria-hidden="true">
        ❝
      </span>
      <button
        type="button"
        className={`composer-quote-text${expanded ? " expanded" : ""}`}
        onClick={() => setExpanded((v) => !v)}
      >
        {label}
      </button>
      <button
        type="button"
        className="composer-quote-remove"
        aria-label="Remove quoted selection"
        onClick={onRemove}
      >
        <X size={13} strokeWidth={2} />
      </button>
    </div>
  );
}

/** Notch chip beside the agent selector showing the directory the chat is
 *  working in: the custom folder chosen via the "+" picker when set, else the
 *  chat's isolated worktree (roadmap P0 §3.1.1), else the selected project's
 *  folder. The × (visible on hover) fully unbinds the chat from that project —
 *  drop the per-chat binding, any custom-folder override, and the global
 *  selection when it's the same project. Hidden when neither resolves (no
 *  project selected). When the chat works in an isolated worktree a ⛓ chip
 *  sits beside the folder name — clicking it joins the main working tree. */
export function FolderNotch() {
  // Shared chrome follows the FOCUSED chat (split-view aware), not the plain
  // active session — see selectContextSessionId.
  const activeChatSessionId = useChatStore(selectContextSessionId);
  const override = useChatStore((s) =>
    activeChatSessionId ? s.cwdOverrides[activeChatSessionId] : undefined,
  );
  const worktreePath = useChatStore((s) =>
    activeChatSessionId
      ? s.sessions.find((x) => x.id === activeChatSessionId)?.worktreePath
      : undefined,
  );
  // The chat's own project binding wins over the global selection, so
  // switching chats shows each chat's project — not whichever project was
  // clicked last.
  const boundProjectId = useChatStore((s) =>
    activeChatSessionId ? s.sessionProjects[activeChatSessionId] : undefined,
  );
  const project = useProjectsStore((s) =>
    s.projectById(boundProjectId ?? s.selectedProjectId),
  );
  const path = override ?? worktreePath ?? project?.path ?? null;
  // Only show the folder chip when the chat has an explicit binding — either
  // a per-session project, a custom CWD override, or a worktree. A globally
  // selected project without a per-chat binding is not enough.
  const hasExplicitBinding = !!(boundProjectId || override || worktreePath);
  if (!path || !activeChatSessionId || !hasExplicitBinding) return null;
  return (
    <div className="composer-notch-folder" title={path}>
      <FolderIcon />
      <span className="composer-notch-folder-name">{pathBasename(path)}</span>
      {worktreePath && (
        <button
          type="button"
          className="composer-notch-worktree"
          title={`Isolated worktree (branch on ${pathBasename(worktreePath)}). Click to join the main working tree.`}
          aria-label="Join main working tree"
          onClick={(e) => {
            e.stopPropagation();
            void useChatStore.getState().toggleSessionWorktree(activeChatSessionId);
          }}
        >
          ⛓
        </button>
      )}
    </div>
  );
}

/** GitHub / branch pill — sits beside the project pill. Shows a git-branch
 *  icon + the current branch name. Clicking it opens a small dropdown popover
 *  (right there at the composer) with the branch list, search, create, and git
 *  log — NOT the tool panel. Hidden when the project isn't a git repo. */
export function GitHubNotch() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // Same focused-chat rule as FolderNotch: split-view aware.
  const activeChatSessionId = useChatStore(selectContextSessionId);
  const boundProjectId = useChatStore((s) =>
    activeChatSessionId ? s.sessionProjects[activeChatSessionId] : undefined,
  );
  const override = useChatStore((s) =>
    activeChatSessionId ? s.cwdOverrides[activeChatSessionId] : undefined,
  );
  const worktreePath = useChatStore((s) =>
    activeChatSessionId
      ? s.sessions.find((x) => x.id === activeChatSessionId)?.worktreePath
      : undefined,
  );
  const selectedProjectId = useProjectsStore((s) => s.selectedProjectId);
  // Only show the git chip when the chat has an explicit binding (same logic
  // as FolderNotch) — not just a globally selected project.
  const hasExplicitBinding = !!(boundProjectId || override || worktreePath);
  const projectId = hasExplicitBinding ? (boundProjectId ?? selectedProjectId) : null;
  const gitStatus = useProjectsStore((s) =>
    projectId ? s.gitStatuses[projectId] : undefined,
  );

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      // The popover portals to <body> (out of the toolbar's backdrop root so
      // its glass frost can see the page) — so both the trigger wrap AND the
      // portaled popover count as "inside".
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

  if (!gitStatus?.isRepo || !gitStatus.branch || !activeChatSessionId) return null;
  return (
    <div className="composer-notch-github-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`composer-notch-github${open ? " open" : ""}`}
        title={`Branch: ${gitStatus.branch}`}
        onClick={() => setOpen((o) => !o)}
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
        <span className="composer-notch-github-name">{gitStatus.branch}</span>
      </button>
      {open &&
        createPortal(
        <div
          ref={popRef}
          className="composer-notch-github-popover"
          style={{
            position: "fixed",
            // LEFT-anchored to the chip (clamped inside the window): the
            // popover is 340px wide and right-anchoring made it hang over
            // the sidebar. Opens below the pill like a native dropdown.
            top: (wrapRef.current?.getBoundingClientRect().bottom ?? 0) + 6,
            left: Math.min(
              wrapRef.current?.getBoundingClientRect().left ?? 8,
              window.innerWidth - 356,
            ),
            right: "auto",
            bottom: "auto",
            zIndex: 9999,
          }}
        >
          <button
            type="button"
            className="composer-notch-pulls-entry"
            onClick={() => {
              setOpen(false);
              useUiStore.getState().addTab("pulls");
              useUiStore.getState().setToolPanelCollapsed(false);
            }}
            title="Open the Pull Requests tab in the side panel"
          >
            <GitPullRequestIcon />
            <span>Pull Requests</span>
          </button>
          <BranchDropdown onClose={() => setOpen(false)} />
        </div>,
        document.body,
      )}
    </div>
  );
}

/** Small git-pull-request icon for the "Pull Requests" popover row. */
function GitPullRequestIcon() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5v7a4 4 0 0 0 4 4h5.5" />
      <path d="M18 8.5v7" />
      <circle cx="18" cy="6" r="2.5" />
    </svg>
  );
}

/** Brain / lightbulb icon for the extended-thinking toggle. Filled when
 *  thinking is on (state is locked-in to a "think harder" request), outlined
 *  when off. The switch between filled/outlined is handled via `fill`
 *  rather than a separate SVG. */
export function ThinkingIcon({ on }: { on: boolean }) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill={on ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.5 2a3.5 3.5 0 0 0-3.4 4.2 3 3 0 0 0-1.6 4.6 3 3 0 0 0 1 4.3 3 3 0 0 0 3 3.4h.2a1 1 0 0 0 1-.8l.3-1.7h2l.3 1.7a1 1 0 0 0 1 .8h.2a3 3 0 0 0 3-3.4 3 3 0 0 0 1-4.3 3 3 0 0 0-1.6-4.6A3.5 3.5 0 0 0 14.5 2 3.4 3.4 0 0 0 12 3.1 3.4 3.4 0 0 0 9.5 2Z" />
      <path d="M12 3.1V18" />
      <path d="M10 18h4" />
    </svg>
  );
}

/** Tri-state thinking toggle button:
 *  - default (`null`) — provider decides. Outlined icon, neutral label.
 *  - on (`true`) — explicit "think more". Filled icon, accent color.
 *  - off (`false`) — explicit "no thinking". Faded icon, struck-through.
 *
 *  Clicking cycles null → true → false → null. Each press applies to the
 *  NEXT message only — the store resets to null on session change. */
export function ThinkingToggle({
  value,
  onChange,
}: {
  value: boolean | null;
  onChange: (next: boolean | null) => void;
}) {
  const on = value === true;
  const off = value === false;
  const next: boolean | null = value === null ? true : value === true ? false : null;
  const title = value === null
    ? "Extended thinking: provider default. Click to force ON."
    : value === true
      ? "Extended thinking: ON. Click to force OFF."
      : "Extended thinking: OFF. Click to clear override.";
  return (
    <button
      type="button"
      className={`composer-thinking-btn${on ? " on" : ""}${off ? " off" : ""}`}
      title={title}
      aria-label={title}
      aria-pressed={on}
      onClick={() => onChange(next)}
    >
      <ThinkingIcon on={on} />
    </button>
  );
}
