// Module-level scroll bridge between the TurnNavigator and ChatView.
//
// ChatView registers a scroll-to-message helper here on mount; the
// TurnNavigator calls `scrollToChatMessage(msgId)` on card click. This avoids
// prop-drilling a scroll function through App.tsx or adding a React context
// provider just for one cross-component action.

let scrollFn: ((msgId: number) => void) | null = null;

/** Called by ChatView on mount to expose its scroll-to-message helper. */
export function setChatScrollToMessage(fn: ((msgId: number) => void) | null): void {
  scrollFn = fn;
}

/** Called by the TurnNavigator to scroll the chat to a specific message. */
export function scrollToChatMessage(msgId: number): void {
  scrollFn?.(msgId);
}
