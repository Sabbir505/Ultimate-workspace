import { createNavigationContainerRef } from '@react-navigation/native';
import type { Session } from '../hooks/useRelay';

/** Root-level navigation ref: lets deep screens (e.g. Settings → Cost
 *  dashboard) navigate across navigator boundaries — the Settings tab lives
 *  in the Tab navigator while CostDashboard is registered in the HomeStack,
 *  and the tab-level navigate can't see it. The container-level ref resolves
 *  through child navigators. */
export const navigationRef = createNavigationContainerRef();

/**
 * Spawn a session on the desktop, then open its chat screen.
 *
 * Shared by the AppDrawer's full-text search hits and the Automations run-log
 * rows: in both cases the target chat is INACTIVE on the desktop, so it must
 * be spawned first for the log to go live and follow-up sends to land. The
 * placeholder Session carries only what the chat screen needs before the
 * first SessionMeta/list refresh arrives — fields that differ per call site
 * (title, timestamp) are params; the rest are the same neutral placeholders
 * every site used.
 */
export function openChatById(
  navigation: { navigate: (name: string, params: Record<string, unknown>) => void },
  spawn: (sessionId: string) => void,
  sessionId: string,
  opts?: { title?: string; lastActivity?: number; unread?: boolean },
): void {
  spawn(sessionId);
  navigation.navigate('SessionDetail', {
    sessionId,
    session: {
      id: sessionId,
      projectId: '',
      projectName: '',
      title: opts?.title ?? 'Chat',
      status: 'idle',
      provider: '',
      model: '',
      lastActivity: opts?.lastActivity ?? Date.now(),
      isLive: false,
      starred: false,
      unread: opts?.unread ?? false,
    } as Session,
  });
}
