// Module-level bridge between the chat selection toolbar and ChatView.
//
// The toolbar (rendered once per window by App) hands a selected-text
// follow-up to whichever ChatView owns the composer via this registry — the
// same pattern chatScroll.ts uses for scroll-to-message. ChatView registers a
// callback on mount; the toolbar calls sendChatSelectionAsFollowUp with the
// (already quoted) selection text. ChatView stacks each call as a quote chip
// ABOVE the composer — the user's existing draft is never touched — and the
// stack is prepended to the next message they send.

let prefillFn: ((text: string) => void) | null = null;

/** Called by ChatView on mount to expose its quote-stacking helper. */
export function setChatSelectionPrefill(fn: ((text: string) => void) | null): void {
  prefillFn = fn;
}

/** Stack `text` (a quoted selection) as a chip above the composer. */
export function sendChatSelectionAsFollowUp(text: string): void {
  prefillFn?.(text);
}
