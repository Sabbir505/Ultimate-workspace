// Working-directory resolution shared by the chat's file surfaces (edit rows,
// per-edit diff cards, turn-changes rows).
//
// A chat's files must open against THAT chat's repo. The sidebar-selected
// project is not that context: a split-pane focus re-points the global
// selection at the focused pane's project, and a manual project click moves it
// too — routing a message's "Review"/"Open diff" through the selection opened
// the file against another chat's repo (the "files from another chat"
// mis-route). These surfaces resolve from the CHAT: its picked working folder,
// then its worktree, then its bound project. Callers may pass a last-resort
// `fallback` (the selected project's path) so chats bound to nothing keep the
// old behavior, matching the Changes panel's own fallback.
import { useChatStore } from "../state/chat";
import { useProjectsStore } from "../state/projects";

/** The chat's explicit project binding (sessionProjects map first — the newer
 *  of the two binding paths — then the session row's own column). */
export function resolveChatProjectId(chatSessionId?: string | null): string | null {
  const chat = useChatStore.getState();
  const sid = chatSessionId ?? chat.focusedChatSessionId ?? chat.activeChatSessionId;
  if (!sid) return null;
  return (
    chat.sessionProjects[sid] ??
    chat.sessions.find((x) => x.id === sid)?.projectId ??
    null
  );
}

/** The working directory of `chatSessionId` (defaulting to the focused pane's
 *  chat, else the active one): picked folder → worktree → bound project →
 *  `fallback`. */
export function resolveChatCwd(
  chatSessionId?: string | null,
  fallback?: string | null,
): string | null {
  const chat = useChatStore.getState();
  const sid = chatSessionId ?? chat.focusedChatSessionId ?? chat.activeChatSessionId;
  if (!sid) return fallback ?? null;
  const session = chat.sessions.find((x) => x.id === sid);
  const boundProjectId = resolveChatProjectId(sid);
  const boundPath = boundProjectId
    ? useProjectsStore.getState().projectById(boundProjectId)?.path
    : undefined;
  return chat.cwdOverrides[sid] || session?.worktreePath || boundPath || fallback || null;
}

/** The project row whose root IS `cwd`, when one exists. A worktree or an
 *  ad-hoc folder matches nothing — callers fall back to the chat's binding or
 *  ask the backend (git status) instead of guessing. */
export function projectIdForCwd(cwd: string | null): string | null {
  if (!cwd) return null;
  return (
    useProjectsStore.getState().projects.find((p) => p.path === cwd)?.id ?? null
  );
}
