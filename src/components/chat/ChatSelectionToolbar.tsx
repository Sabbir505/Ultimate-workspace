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
// Appear timing: the toolbar is evaluated ONLY when a selection gesture ends —
// pointerup for mouse/touch selections, a short debounce for keyboard
// selections (shift+arrows, Ctrl+A). selectionchange merely hides while the
// drag is in flight, so the toolbar never chases the mouse mid-select.
// Position: ALWAYS just above the selection's top edge, horizontally clamped
// to the window. Chat text scrolls under the title bar, so a selection near
// the window top has a small rect.top — the anchor clamps to keep the toolbar
// on-screen rather than flipping below the text.
//
// NOTE: native browser webviews (browser panes) float above all DOM, so the
// toolbar can overlay DOM content only — the same limitation every popover in
// the app has.
import { useCallback, useEffect, useRef, useState } from "react";
import { sendChatSelectionAsFollowUp } from "../../lib/chatSelection";
import { useChatStore } from "../../state/chat";

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

// Geometry: the toolbar is ~30px tall with an 8px gap (see .chat-selection-
// toolbar's translate). Half-width bounds the horizontal clamp (Copy | Ask
// measures ~110px); MARGIN keeps it off the window edge.
const TOOLBAR_H = 32;
const TOOLBAR_GAP = 8;
const TOOLBAR_HALF_W = 60;
const EDGE_MARGIN = 6;
/** Keyboard selections (no pointerup) show after this quiet period. */
const KEYBOARD_SHOW_DELAY_MS = 250;

interface ToolbarAnchor {
  x: number;
  y: number;
  text: string;
}

/** Quote the selection as a markdown blockquote so the model sees it as cited
 *  context; the user types their question after it. */
function quoteSelection(text: string): string {
  return `${text
    .trim()
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join("\n")}\n\n`;
}

/** Current selection as a toolbar anchor, or null when there is nothing to
 *  summon the toolbar for (collapsed, whitespace, wrong surface, no box). */
function computeAnchor(): ToolbarAnchor | null {
  const s = window.getSelection();
  if (!s || s.isCollapsed || s.rangeCount === 0) return null;
  const text = s.toString();
  if (!text.trim()) return null;
  const anchor = s.anchorNode;
  const el = anchor instanceof Element ? anchor : anchor?.parentElement ?? null;
  // Only chat message bodies and markdown document surfaces summon the
  // toolbar — not the composer, terminals, panes or inputs.
  if (!el?.closest(SELECTION_HOST_SELECTOR)) return null;
  const rect = s.getRangeAt(0).getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return null;
  // The app supports root-level CSS zoom (app.zoom, Ctrl +/-). gBCR returns
  // VISUAL pixels, but a position:fixed element's left/top resolve in the
  // ZOOMED coordinate space — without dividing out the zoom the toolbar
  // drifts down-right by (zoom-1)×position and lands on/below the text.
  const zoom = Number(getComputedStyle(document.documentElement).zoom) || 1;
  // Clamp in visual space (window.innerWidth is visual), then convert.
  const xVisual = Math.min(
    Math.max(rect.left + rect.width / 2, EDGE_MARGIN + TOOLBAR_HALF_W),
    window.innerWidth - EDGE_MARGIN - TOOLBAR_HALF_W,
  );
  // Always above: the CSS translate(-50%, calc(-100% - 8px)) lifts the
  // toolbar above this anchor. The floor keeps it on-screen when the
  // selection sits under the title bar (scrolled-under text is selectable).
  const yVisual = Math.max(rect.top, TOOLBAR_H + TOOLBAR_GAP + EDGE_MARGIN);
  return { x: xVisual / zoom, y: yVisual / zoom, text };
}

export function ChatSelectionToolbar() {
  const [sel, setSel] = useState<ToolbarAnchor | null>(null);
  const [copied, setCopied] = useState(false);
  const selRef = useRef<typeof sel>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  const hide = useCallback(() => {
    selRef.current = null;
    setSel(null);
  }, []);

  useEffect(() => {
    let raf = 0;
    let showTimer = 0;

    const cancelPending = () => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (showTimer) {
        window.clearTimeout(showTimer);
        showTimer = 0;
      }
    };

    const evaluate = () => {
      const next = computeAnchor();
      selRef.current = next;
      if (next) {
        setCopied(false);
        setSel(next);
      } else {
        hide();
      }
    };

    // selectionchange fires per keystroke of a drag: hide a visible toolbar
    // immediately, and for still-valid selections only re-arm the debounce —
    // keyboard selections (shift+arrows, Ctrl+A) have no pointerup, so the
    // quiet-period timer is what summons the toolbar for them. A re-report
    // of the SAME selection (Chromium can fire a trailing selectionchange
    // right after pointerup) keeps the shown toolbar instead of hiding and
    // re-showing it 250ms later.
    const onSelChange = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        const next = computeAnchor();
        if (!next) {
          cancelPending();
          hide();
          return;
        }
        const cur = selRef.current;
        if (
          cur &&
          cur.text === next.text &&
          Math.abs(cur.x - next.x) < 2 &&
          Math.abs(cur.y - next.y) < 2
        ) {
          return;
        }
        if (showTimer) {
          window.clearTimeout(showTimer);
          showTimer = 0;
        }
        if (cur) hide();
        showTimer = window.setTimeout(() => {
          showTimer = 0;
          evaluate();
        }, KEYBOARD_SHOW_DELAY_MS);
      });
    };
    // End of a mouse/touch selection: show immediately (one rAF so the
    // browser has settled the final range). Double- and triple-click land
    // here too — their last pointerup is the completed gesture.
    const onPointerUp = (e: PointerEvent) => {
      if (toolbarRef.current?.contains(e.target as Node)) return;
      cancelPending();
      raf = requestAnimationFrame(evaluate);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selRef.current) {
        cancelPending();
        hide();
      }
    };
    // Any press outside the toolbar dismisses it. Popups (model/agent picker,
    // menus, modals) preventDefault their mousedown to keep focus, which also
    // keeps the DOM selection alive — so "selection still exists" used to
    // leave the toolbar floating next to an open picker. Capture phase: run
    // before the popup's own handler. A fresh drag-select elsewhere re-summons
    // the toolbar on its pointerup; clicking Copy/Ask targets the toolbar
    // and is excluded.
    const onPointerDown = (e: MouseEvent) => {
      if (selRef.current && !toolbarRef.current?.contains(e.target as Node)) {
        cancelPending();
        hide();
      }
    };
    const onScroll = () => {
      if (!selRef.current && !showTimer) return;
      cancelPending();
      hide();
    };

    document.addEventListener("selectionchange", onSelChange);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true); // any scroll dismisses
    window.addEventListener("resize", onScroll);
    window.addEventListener("keydown", onKey);
    return () => {
      cancelPending();
      document.removeEventListener("selectionchange", onSelChange);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
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
    // Split view: stack the quote on the FOCUSED chat's composer.
    const s = useChatStore.getState();
    sendChatSelectionAsFollowUp(quoteSelection(sel.text), s.focusedChatSessionId ?? s.activeChatSessionId);
    window.getSelection()?.removeAllRanges();
    hide();
  };

  return (
    <div
      ref={toolbarRef}
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
      <button type="button" className="chat-selection-btn chat-selection-ask" onClick={ask} title="Add this selection above the composer as a quoted follow-up">
        <SendIcon />
        Ask
      </button>
    </div>
  );
}
