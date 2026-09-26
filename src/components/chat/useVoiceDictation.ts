// Voice dictation (roadmap #16) — the ChatComposer's mic engine. All of the
// audio/segment/commit machinery lives in lib/voiceDictationCore.ts, shared
// with the vault note editor; this file is just the <textarea> adapter plus
// the focus predicate that keeps Alt-hold push-to-talk out of the *other*
// composer's pane in split view.
import { useCallback, useMemo, useRef } from "react";
import { useChatStore } from "../../state/chat";
import { useVoiceDictationCore, type DictationTarget } from "../../lib/voiceDictationCore";

export function useVoiceDictation({
  setContent,
  textareaRef,
  setCaret,
  contentRef,
  effectiveSessionId,
}: {
  /** The composer draft setter — dictation splices into it. */
  setContent: (value: string | ((prev: string) => string)) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  setCaret: (caret: number) => void;
  /** The composer's live draft mirror. The core's DictationTarget contract
   *  requires a synchronously authoritative read, and the draft lives in
   *  React state — so the composer owns this ref and updates it in its own
   *  onChange, keeping it exact to the keystroke. */
  contentRef: React.MutableRefObject<string>;
  /** This pane's session — hold-Alt dictation must only react in the
   *  focused chat's composer (split view mounts two). */
  effectiveSessionId: string | null;
}) {
  const target = useMemo<DictationTarget>(
    () => ({
      read: () => contentRef.current,
      write(from, to, text) {
        // Optimistic: the mirror is authoritative for the very next read
        // (two flushes can land in one tick, before React re-renders).
        const prev = contentRef.current;
        const next = prev.slice(0, from) + text + prev.slice(to);
        contentRef.current = next;
        setContent(next);
        return { from, to: from + text.length };
      },
      setCaret(pos) {
        setCaret(pos);
        const ta = textareaRef.current;
        if (ta) ta.setSelectionRange(pos, pos);
      },
      focus() {
        textareaRef.current?.focus();
      },
      isFocused() {
        return document.activeElement === textareaRef.current;
      },
    }),
    [contentRef, setContent, setCaret, textareaRef],
  );

  // Split view mounts TWO composers in one document; the Alt handlers are
  // window-global, so a single press used to start recording in BOTH — two
  // mic captures and the dictated text spliced into both panes. Only the
  // FOCUSED chat's composer may react (read via getState so the listeners
  // don't need re-registering on focus change).
  const sessionRef = useRef(effectiveSessionId);
  sessionRef.current = effectiveSessionId;
  const isFocusedChat = useCallback(() => {
    const s = useChatStore.getState();
    const focused = s.focusedChatSessionId ?? s.activeChatSessionId;
    return focused === sessionRef.current;
  }, []);

  return useVoiceDictationCore({ target, pushToTalk: true, isActiveTarget: isFocusedChat });
}
