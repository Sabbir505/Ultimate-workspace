// Module-level bridge between the chat selection toolbar and ChatView.
//
// The toolbar (rendered once per window by App) hands a selected-text
// follow-up to whichever ChatView owns the composer via this registry — the
// same pattern chatScroll.ts uses for scroll-to-message. ChatView registers a
// prefill callback on mount; the toolbar calls sendChatSelectionAsFollowUp
// with the (already quoted) selection text.

let prefillFn: ((text: string) => void) | null = null;

/** Called by ChatView on mount to expose its composer-prefill helper. */
export function setChatSelectionPrefill(fn: ((text: string) => void) | null): void {
  prefillFn = fn;
}

/** Prefill the composer with `text` (a quoted selection) as a follow-up. */
export function sendChatSelectionAsFollowUp(text: string): void {
  prefillFn?.(text);
}
