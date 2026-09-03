// Interactive citation chip rendered in place of `[1]` / `[1,2]` / `(1,2)`
// markers in assistant markdown. Hovering (or focusing) shows a preview of the
// linked source(s) — title + host, one row per cited number; clicking opens
// the source in the built-in browser pane (same routing as chat markdown
// links, never the system browser). Each row inside the tooltip is itself
// clickable, so with `(1,2)` the user can pick which source to open.
//
// The preview renders through a PORTAL at document.body with position:fixed —
// an absolutely-positioned tip inside the markdown flow got painted over by
// neighboring text/rows (virtualizer rows and markdown blocks create their
// own stacking contexts, so the tip's z-index never escaped them) and was
// clipped at scroll-container edges. A body-level fixed layer has no ancestor
// stacking context to lose against; placement flips below the chip when there
// is no room above and clamps to the viewport.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { openInBrowserPane } from "../../lib/openBrowserPane";
import type { ChatSource } from "../../lib/chatCitations";

const OPEN_DELAY_MS = 70;
const CLOSE_GRACE_MS = 140;
const EDGE_GAP = 8;
const CHIP_GAP = 8;

/** Per-citation verification verdicts from the end-of-turn citation lint:
 *  citation number → how the backend flagged it. "orphan" (cited source not
 *  in the ledger / unreadable) outranks "weak" (low anchor overlap with the
 *  stored excerpt). Chips render amber (weak) or red (orphan) so soft claims
 *  are visible before the reader trusts them. */
export type CitationFlag = "weak" | "orphan";
export const CitationFlagContext = createContext<Record<number, CitationFlag>>({});

export function ChatCitation({ nums, sources }: { nums: number[]; sources: ChatSource[] }) {
  const resolved = nums
    .map((n) => sources.find((s) => s.n === n))
    .filter((s): s is ChatSource => !!s);
  const flags = useContext(CitationFlagContext);
  // One orphan number makes the whole chip red; otherwise any weak number
  // makes it amber. Unflagged chips keep the default link-blue look.
  const chipFlag: CitationFlag | null = resolved.some((s) => flags[s.n] === "orphan")
    ? "orphan"
    : resolved.some((s) => flags[s.n] === "weak")
      ? "weak"
      : null;
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  // Fixed-layer coordinates, recomputed on open (and on scroll/resize while
  // open, since the chip scrolls with the transcript but the tip does not).
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    const tip = tipRef.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const tw = tip?.offsetWidth ?? 260;
    const th = tip?.offsetHeight ?? 96;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(EDGE_GAP, Math.min(left, window.innerWidth - tw - EDGE_GAP));
    // Above the chip by default; flip below when there isn't room (first
    // line of a message, top of the viewport) — never overlapping the text.
    let top = r.top - th - CHIP_GAP;
    if (top < EDGE_GAP) top = r.bottom + CHIP_GAP;
    setPos({ left, top });
  }, []);

  const scheduleOpen = useCallback(() => {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (openTimer.current != null) return;
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null;
      setOpen(true);
    }, OPEN_DELAY_MS);
  }, []);

  const scheduleClose = useCallback(() => {
    if (openTimer.current != null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    // Grace period lets the pointer cross the chip→tip gap (or reach a tip
    // row to pick a source) without dismissing the card.
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, CLOSE_GRACE_MS);
  }, []);

  // Measure + place AFTER the tip mounts (its size is content-driven), and
  // follow scroll/resize while open so the card stays anchored to the chip.
  useEffect(() => {
    if (!open) return;
    place();
    const reflow = requestAnimationFrame(place);
    const follow = () => place();
    window.addEventListener("resize", follow);
    // Capture phase: transcript scrolling happens on inner containers, not
    // the window — only the capture listener sees those scroll events.
    document.addEventListener("scroll", follow, true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(reflow);
      window.removeEventListener("resize", follow);
      document.removeEventListener("scroll", follow, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, place]);

  useEffect(
    () => () => {
      if (openTimer.current != null) window.clearTimeout(openTimer.current);
      if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  if (resolved.length === 0) return null;

  const openSource = (url: string) => openInBrowserPane(url);

  return (
    // onMouseDown preventDefault: clicking the chip must not collapse a text
    // selection the user is building (the chip sits inside selectable text).
    <span
      ref={anchorRef}
      className={`chat-citation${chipFlag ? ` is-${chipFlag}` : ""}`}
      role="link"
      tabIndex={0}
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
      onFocus={scheduleOpen}
      onBlur={scheduleClose}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openSource(resolved[0].url);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openSource(resolved[0].url);
        }
      }}
      aria-label={`Citation ${nums.join(", ")}: ${resolved.map((s) => s.title).join("; ")}`}
    >
      <span className="chat-citation-nums">{nums.join(",")}</span>
      {open &&
        createPortal(
          <div
            ref={tipRef}
            className="chat-citation-tip"
            data-open="true"
            role="tooltip"
            style={{
              position: "fixed",
              left: pos?.left ?? -9999,
              top: pos?.top ?? -9999,
            }}
            onMouseEnter={scheduleOpen}
            onMouseLeave={scheduleClose}
          >
            <span className="chat-citation-tip-head">
              {resolved.length === 1 ? "Source" : "Sources"}
            </span>
            {resolved.map((s) => (
              <button
                key={s.n}
                type="button"
                className="chat-citation-tip-row"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openSource(s.url);
                }}
              >
                <span className="chat-citation-tip-num">[{s.n}]</span>
                <span className="chat-citation-tip-body">
                  <span className="chat-citation-tip-title">{s.title}</span>
                  <span className="chat-citation-tip-url">{displayUrl(s.url)}</span>
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </span>
  );
}

/** Trim a URL for the tooltip's secondary line: scheme stripped, host kept,
 *  long paths elided. */
function displayUrl(url: string): string {
  let out = url.replace(/^https?:\/\//i, "");
  try {
    const u = new URL(url);
    out = u.host.replace(/^www\./, "") + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    /* keep the scheme-stripped form */
  }
  if (out.length > 46) out = `${out.slice(0, 45)}…`;
  return out;
}
