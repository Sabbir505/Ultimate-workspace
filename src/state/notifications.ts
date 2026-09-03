// Notification center store — the durable record behind the title-bar bell.
//
// The app already has two ephemeral surfaces (in-app toasts that vanish after
// a few seconds, and OS toasts owned by the platform). This store is the
// third piece: a bounded, persisted list of the events that actually matter
// (agent turns finished, errors/crashes, approvals waiting on the user,
// automation runs, budget alerts) so nothing important is lost just because
// the user wasn't looking at Relay when it happened.
//
// "Unseen" is separate from "read like an email": a notification stays unseen
// until the user OPENS the bell panel (or explicitly marks things read), so
// the white count badge survives restarts. Persistence is localStorage — the
// list is small (capped) and must be readable synchronously at boot, before
// the async settings store resolves.
import { create } from "zustand";

export type RelayNotificationKind =
  | "completed" // an agent turn / pane task finished
  | "error" // a chat or background task failed
  | "crash" // a process exited unexpectedly (nonzero pty exit, harness death)
  | "approval" // the agent is blocked waiting for the user (tool approval / question)
  | "automation" // a scheduled automation run finished
  | "alert"; // budget thresholds and other "you should know" warnings

export interface RelayNotification {
  /** Unique id (monotonic counter + timestamp salt). */
  id: string;
  kind: RelayNotificationKind;
  title: string;
  body: string;
  /** Epoch ms when the event happened. */
  at: number;
  /** True until the bell panel is opened / the row is acted on. Drives the
   *  badge count. */
  unseen: boolean;
  /** Chat session to jump to when the row is clicked. */
  chatSessionId?: string;
  /** Terminal pane to focus when the row is clicked. */
  paneId?: string;
  /** Overlay view to open when the row is clicked (e.g. "automations"). */
  view?: "automations" | "cost" | "settings";
}

interface NotificationsState {
  items: RelayNotification[];
  /** Push one event (newest first). Capped — the oldest items fall off. */
  push: (n: Omit<RelayNotification, "id" | "at" | "unseen"> & { at?: number }) => void;
  /** Mark everything seen (bell panel opened). */
  markAllSeen: () => void;
  /** Mark one row seen (clicked / dismissed from the panel). */
  markSeen: (id: string) => void;
  /** Remove a single row. */
  remove: (id: string) => void;
  /** Drop everything. */
  clear: () => void;
}

const STORAGE_KEY = "relay.notifications.v1";
/** Bounded history: after this, the oldest notifications fall off. */
const MAX_ITEMS = 100;

function loadPersisted(): RelayNotification[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RelayNotification[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((n) => n && typeof n.id === "string" && typeof n.title === "string")
      .slice(0, MAX_ITEMS);
  } catch {
    return [];
  }
}

function persist(items: RelayNotification[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_ITEMS)));
  } catch {
    // Storage full/unavailable — the in-memory list still works this session.
  }
}

let nextId = 1;

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
  items: loadPersisted(),

  push: (n) => {
    const item: RelayNotification = {
      id: `n${Date.now().toString(36)}-${nextId++}`,
      at: n.at ?? Date.now(),
      unseen: true,
      kind: n.kind,
      title: n.title,
      body: n.body,
      chatSessionId: n.chatSessionId,
      paneId: n.paneId,
      view: n.view,
    };
    const items = [item, ...get().items].slice(0, MAX_ITEMS);
    set({ items });
    persist(items);
  },

  markAllSeen: () =>
    set((s) => {
      if (!s.items.some((n) => n.unseen)) return s; // no-op — don't churn/persist
      const items = s.items.map((n) => (n.unseen ? { ...n, unseen: false } : n));
      persist(items);
      return { items };
    }),

  markSeen: (id) =>
    set((s) => {
      const items = s.items.map((n) => (n.id === id ? { ...n, unseen: false } : n));
      persist(items);
      return { items };
    }),

  remove: (id) =>
    set((s) => {
      const items = s.items.filter((n) => n.id !== id);
      persist(items);
      return { items };
    }),

  clear: () => {
    set({ items: [] });
    persist([]);
  },
}));

/** Unseen count — the number rendered in the white badge. */
export function unseenCount(items: RelayNotification[]): number {
  return items.reduce((acc, n) => acc + (n.unseen ? 1 : 0), 0);
}
