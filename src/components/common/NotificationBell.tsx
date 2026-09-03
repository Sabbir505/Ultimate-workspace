// Title-bar notification bell: opens the small notifications panel (a compact
// anchored popover, not a full modal). The white count badge shows how many
// events are unseen; opening the panel marks everything seen (like every
// messaging app) while rows that WERE unseen stay highlighted for that
// viewing. Rows navigate: chat completions jump to the chat, pane events
// focus the pane, automation rows open the Automations view.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  Bot,
  CalendarClock,
  CheckCircle2,
  CheckCheck,
  CircleHelp,
  CircleX,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import {
  useNotificationsStore,
  unseenCount,
  type RelayNotification,
  type RelayNotificationKind,
} from "../../state/notifications";
import { useChatStore } from "../../state/chat";
import { usePanesStore } from "../../state/panes";
import { useUiStore } from "../../state/ui";
import { relativeTime } from "../../lib/relativeTime";

const KIND_META: Record<RelayNotificationKind, { icon: typeof Bell; label: string }> = {
  completed: { icon: CheckCircle2, label: "Completed" },
  error: { icon: CircleX, label: "Error" },
  crash: { icon: TriangleAlert, label: "Crash" },
  approval: { icon: CircleHelp, label: "Needs you" },
  automation: { icon: CalendarClock, label: "Automation" },
  alert: { icon: Bot, label: "Alert" },
};

function NotifRow({ n, fresh, onOpen }: { n: RelayNotification; fresh: boolean; onOpen: (n: RelayNotification) => void }) {
  const meta = KIND_META[n.kind];
  const Icon = meta.icon;
  return (
    <button
      type="button"
      className={`notif-row${fresh ? " fresh" : ""}`}
      onClick={() => onOpen(n)}
      title={meta.label}
    >
      <span className={`notif-row-icon kind-${n.kind}`} aria-hidden="true">
        <Icon size={15} strokeWidth={1.8} />
      </span>
      <span className="notif-row-body">
        <span className="notif-row-title">
          {n.title}
          {fresh && <span className="notif-row-dot" aria-label="new" />}
        </span>
        <span className="notif-row-text">{n.body}</span>
      </span>
      <span className="notif-row-time">{relativeTime(Math.floor(n.at / 1000))}</span>
    </button>
  );
}

export function NotificationBell() {
  const items = useNotificationsStore((s) => s.items);
  const unseen = useMemo(() => unseenCount(items), [items]);
  const markAllSeen = useNotificationsStore((s) => s.markAllSeen);
  const markSeen = useNotificationsStore((s) => s.markSeen);
  const clear = useNotificationsStore((s) => s.clear);

  const [open, setOpen] = useState(false);
  // Ids that were unseen when the panel opened — they stay highlighted for
  // this viewing even though opening marks them seen.
  const [freshIds, setFreshIds] = useState<Set<string>>(() => new Set());
  const wrapRef = useRef<HTMLDivElement>(null);
  const setModalOpen = useUiStore((s) => s.setModalOpen);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (next) {
        const current = useNotificationsStore.getState().items;
        setFreshIds(new Set(current.filter((n) => n.unseen).map((n) => n.id)));
        markAllSeen();
      } else {
        setFreshIds(new Set());
      }
      return next;
    });
  }, [markAllSeen]);

  // Register with the webview-occlusion system (M22) so native browser panes
  // hide while the panel is open.
  useEffect(() => {
    setModalOpen("app:notification-bell", open);
    return () => setModalOpen("app:notification-bell", false);
  }, [open, setModalOpen]);

  // Close on Escape and on any click outside the bell + panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const handleOpenRow = useCallback((n: RelayNotification) => {
    // Navigate to whatever the row points at, then drop it from the panel.
    if (n.chatSessionId) {
      void useChatStore.getState().selectSession(n.chatSessionId);
    } else if (n.paneId) {
      const panes = usePanesStore.getState();
      if (panes.panes.some((p) => p.paneId === n.paneId)) {
        panes.focusPane(n.paneId);
      }
    } else if (n.view) {
      useUiStore.getState().setActiveView(n.view);
    }
    markSeen(n.id);
    setOpen(false);
  }, [markSeen]);

  // Badge turns red when the unseen set contains failures — completions alone
  // get the quiet accent treatment.
  const hasBadUnseen = useMemo(
    () => items.some((n) => n.unseen && (n.kind === "error" || n.kind === "crash")),
    [items],
  );

  return (
    <div className="notification-bell-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`ghost toolbar-icon-btn notification-bell${unseen > 0 ? " has-unseen" : ""}${open ? " active" : ""}`}
        onClick={toggle}
        title="Notifications"
        aria-label={`Notifications${unseen > 0 ? ` (${unseen} unseen)` : ""}`}
        aria-expanded={open}
      >
        <Bell size={16} strokeWidth={1.8} />
        {unseen > 0 && (
          <span className={`bell-badge${hasBadUnseen ? " bad" : ""}`} aria-hidden="true">
            {unseen > 99 ? "99+" : unseen}
          </span>
        )}
      </button>
      {open && (
        <div className="notifications-panel" role="dialog" aria-label="Notifications">
          <div className="notifications-panel-head">
            <strong>Notifications</strong>
            <div className="notifications-panel-actions">
              <button
                type="button"
                className="ghost notif-panel-btn"
                onClick={markAllSeen}
                disabled={unseen === 0}
                title="Mark all as read"
              >
                <CheckCheck size={13} strokeWidth={1.8} /> Read all
              </button>
              <button
                type="button"
                className="ghost notif-panel-btn"
                onClick={clear}
                disabled={items.length === 0}
                title="Clear all notifications"
              >
                <Trash2 size={13} strokeWidth={1.8} /> Clear
              </button>
            </div>
          </div>
          <div className="notifications-panel-list">
            {items.length === 0 ? (
              <div className="notifications-empty">
                <Bell size={20} strokeWidth={1.5} />
                <span>You're all caught up</span>
              </div>
            ) : (
              items.map((n) => (
                <NotifRow key={n.id} n={n} fresh={freshIds.has(n.id)} onOpen={handleOpenRow} />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
