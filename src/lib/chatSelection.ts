// Module-level bridge between the chat selection toolbar and ChatView.
//
// The toolbar (rendered once per window by App) hands a selected-text
// follow-up to whichever ChatView owns the composer via this registry — the
// same pattern chatScroll.ts uses for scroll-to-message. ChatView registers a
// callback per SESSION on mount; the toolbar calls sendChatSelectionAsFollowUp
// with the (already quoted) selection text. ChatView stacks each call as a
// quote chip ABOVE the composer — the user's existing draft is never touched —
// and the stack is prepended to the next message they send.
//
// Split view mounts TWO ChatViews in one document, each registered under its
// own session id; dispatch targets the FOCUSED chat. Cleanup is owner-scoped:
// a view only removes its own entry, so the split pane closing can never
// disable the main view's registration.

const registry = new Map<string, (text: string) => void>();

/** Register (or clear) the quote-stacking helper for one chat session. */
export function setChatSelectionPrefill(
  sessionId: string | null,
  fn: ((text: string) => void) | null,
): void {
  if (sessionId === null) return;
  if (fn) registry.set(sessionId, fn);
  else registry.delete(sessionId);
}

/** Stack `text` (a quoted selection) as a chip above the focused chat's
 *  composer. Without a session hint, only an unambiguous single registration
 *  is used. */
export function sendChatSelectionAsFollowUp(text: string, focusedSessionId?: string | null): void {
  const fn =
    (focusedSessionId != null ? registry.get(focusedSessionId) : undefined) ??
    (registry.size === 1 ? registry.values().next().value : undefined);
  fn?.(text);
}
