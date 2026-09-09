// Module-level scroll bridge between the TurnNavigator and ChatView.
//
// ChatView registers a scroll-to-message helper per SESSION on mount; the
// TurnNavigator calls `scrollToChatMessage(msgId)` on card click, targeting
// the FOCUSED chat's view. This avoids prop-drilling a scroll function
// through App.tsx or adding a React context provider just for one
// cross-component action.
//
// Split view mounts TWO ChatViews in one document, each registered under its
// own session id. Cleanup is owner-scoped: a view only removes its own entry,
// so the split pane closing can never disable the main view's registration
// (the old last-writer-wins singleton nulled the bridge for both).

const registry = new Map<string, (msgId: number) => void>();

/** Register (or clear) the scroll-to-message helper for one chat session. */
export function setChatScrollToMessage(
  sessionId: string | null,
  fn: ((msgId: number) => void) | null,
): void {
  if (sessionId === null) return;
  if (fn) registry.set(sessionId, fn);
  else registry.delete(sessionId);
}

/** Called by the TurnNavigator to scroll the chat to a specific message.
 *  `focusedSessionId` (focused ?? active) picks the right view in split
 *  mode; without it, only an unambiguous single registration is used. */
export function scrollToChatMessage(msgId: number, focusedSessionId?: string | null): void {
  const fn =
    (focusedSessionId != null ? registry.get(focusedSessionId) : undefined) ??
    (registry.size === 1 ? registry.values().next().value : undefined);
  fn?.(msgId);
}
