/**
 * notificationJournal — the phone's notification center store (desktop
 * NotificationBell parity). The relay already pushes every interesting
 * event (turn done, turn error, approval waiting, automation finished,
 * budget exceeded) to ANY connected phone; this journal persists them so
 * the phone keeps a history the way the desktop's bell does, instead of
 * events vanishing when you're not looking at that chat.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export type NotificationKind =
  | 'turn_done'
  | 'turn_error'
  | 'approval'
  | 'automation'
  | 'budget'
  | 'artifact';

export interface JournalEntry {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  sessionId?: string;
  at: number;
  read: boolean;
}

const KEY = 'relay.notificationJournal.v1';
const CAP = 120;

type Listener = (entries: JournalEntry[]) => void;
const listeners = new Set<Listener>();
let cache: JournalEntry[] = [];
let loaded = false;

async function persist() {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // Storage full/blocked — the in-memory journal still works this session.
  }
  for (const fn of listeners) fn(cache);
}

export async function loadJournal(): Promise<JournalEntry[]> {
  if (loaded) return cache;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    cache = raw ? (JSON.parse(raw) as JournalEntry[]) : [];
  } catch {
    cache = [];
  }
  loaded = true;
  for (const fn of listeners) fn(cache);
  return cache;
}

export function subscribeJournal(fn: Listener): () => void {
  listeners.add(fn);
  if (loaded) fn(cache);
  return () => {
    listeners.delete(fn);
  };
}

export function journalNotification(
  kind: NotificationKind,
  title: string,
  body: string,
  sessionId?: string,
): void {
  const entry: JournalEntry = {
    id: `${Date.now()}-${Math.floor(Math.random() * 1e5)}`,
    kind,
    title,
    body,
    sessionId,
    at: Date.now(),
    read: false,
  };
  void loadJournal().then(() => {
    cache = [entry, ...cache].slice(0, CAP);
    void persist();
  });
}

export async function markAllRead(): Promise<void> {
  await loadJournal();
  cache = cache.map((e) => ({ ...e, read: true }));
  await persist();
}

export async function clearJournal(): Promise<void> {
  await loadJournal();
  cache = [];
  await persist();
}
