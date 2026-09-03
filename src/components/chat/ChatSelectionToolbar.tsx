// Floating toolbar over a text selection inside a chat message or a markdown
// document (artifact preview / plan canvas): Copy, and "Ask" — prefill the
// composer with the selection as a blockquote so the user can send it (plus
// their question) as a follow-up turn.
//
// Mounted ONCE per window (App), not per surface: the toolbar is a fixed-
// position overlay that tracks window.getSelection(), so a single instance
// serves every message on screen and any open markdown file. Selections
// elsewhere (composer, terminal, browser pane) never summon it.
//
// NOTE: native browser webviews (browser panes) float above all DOM, so the
// toolbar can overlay DOM content only — the same limitation every popover in
// the app has.
import { useCallback, useEffect, useRef, useState } from "react";
import { sendChatSelectionAsFollowUp } from "../../lib/chatSelection";

function CopyIcon() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </svg>
  );
}

/** Surfaces whose text selections summon the toolbar: chat message bodies
 *  AND the markdown document readers (artifact preview pane, plan canvas) —
 *  selecting text in a generated .md file gets the same Copy / Ask actions. */
const SELECTION_HOST_SELECTOR =
  ".chat-bubble-inner, .artifact-preview-md, .canvas-plan-body";

/** Quote the selection as a markdown blockquote so the model sees it as cited
 *  context; the user types their question after it. */
function quoteSelection(text: string): string {
  return `${text
    .trim()
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join("\n")}\n\n`;
}

export function ChatSelectionToolbar() {
  const [sel, setSel] = useState<{ x: number; y: number; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const selRef = useRef<typeof sel>(null);

  const hide = useCallback(() => {
    selRef.current = null;
    setSel(null);
  }, []);

  useEffect(() => {
    let raf = 0;
    const readSelection = () => {
      raf = 0;
      const s = window.getSelection();
      if (!s || s.isCollapsed || s.rangeCount === 0) {
        if (selRef.current) hide();
        return;
      }
      const text = s.toString();
      if (!text.trim()) {
        if (selRef.current) hide();
        return;
      }
      const anchor = s.anchorNode;
      const el = anchor instanceof Element ? anchor : anchor?.parentElement ?? null;
      // Only chat message bodies and markdown document surfaces summon the
      // toolbar — not the composer, terminals, panes or inputs.
      if (!el?.closest(SELECTION_HOST_SELECTOR)) {
        if (selRef.current) hide();
        return;
      }
      const rect = s.getRangeAt(0).getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        if (selRef.current) hide();
        return;
      }
      const next = { x: rect.left + rect.width / 2, y: rect.top, text };
      selRef.current = next;
      setCopied(false);
      setSel(next);
    };
    // selectionchange fires per keystroke of a drag; one rAF coalesces it.
    const onSelChange = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(readSelection);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selRef.current) hide();
    };
    document.addEventListener("selectionchange", onSelChange);
    window.addEventListener("scroll", hide, true); // any scroll dismisses
    window.addEventListener("resize", hide);
    window.addEventListener("keydown", onKey);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("selectionchange", onSelChange);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("keydown", onKey);
    };
  }, [hide]);

  if (!sel) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sel.text);
      setCopied(true);
    } catch {
      // Clipboard unavailable — silently ignore.
    }
  };

  const ask = () => {
    sendChatSelectionAsFollowUp(quoteSelection(sel.text));
    window.getSelection()?.removeAllRanges();
    hide();
  };

  return (
    <div
      className="chat-selection-toolbar"
      style={{ left: sel.x, top: sel.y }}
      // preventDefault on mousedown: clicking a button must not collapse the
      // selection before the click lands.
      onMouseDown={(e) => e.preventDefault()}
      role="toolbar"
      aria-label="Selection actions"
    >
      <button type="button" className="chat-selection-btn" onClick={copy}>
        <CopyIcon />
        {copied ? "Copied" : "Copy"}
      </button>
      <span className="chat-selection-sep" aria-hidden="true" />
      <button type="button" className="chat-selection-btn chat-selection-ask" onClick={ask} title="Prefill the composer with this selection as a quoted follow-up">
        <SendIcon />
        Ask
      </button>
    </div>
  );
}
