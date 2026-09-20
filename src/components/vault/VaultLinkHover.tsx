// Obsidian-style page preview: hovering an internal vault link floats a
// card with the target note rendered in place. The open/close API lives at
// module level (no hooks) so non-React surfaces — a CodeMirror plugin, the
// file tree — can drive the same card; <VaultLinkHoverHost /> mounts the one
// card instance and mirrors that module state into React.
//
// VaultPreview imports THIS module for the link handlers, so the markdown
// body renderer is pulled in the OTHER direction via React.lazy: a static
// import back would close a require cycle at module-eval time.

import { lazy, Suspense, useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";

/** Hover-to-show delay; later hovers restart the timer, so walking down a
 *  wall of links never flashes a card per link — only the last one lands. */
const HOVER_DEBOUNCE_MS = 450;

/** Placement constants — keep in sync with .vault-hover-card in
 *  styles/vault-extras.css. */
const CARD_WIDTH = 380;
const CARD_MAX_HEIGHT = 300;
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 10;

/** What the host renders. `loading` covers the search+read round-trip after
 *  the debounce fires; past it, `content == null` means unresolved target. */
interface HoverCardState {
  target: string;
  rect: DOMRect;
  loading: boolean;
  resolved: string | null;
  content: string | null;
}

let cardState: HoverCardState | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
/** Grace gap between leaving the link and dismissing the card — the cursor
 *  needs it to travel onto the card (to scroll or read it) without the card
 *  vanishing mid-move. */
const CLOSE_DELAY_MS = 260;

function cancelClose() {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

/** Dismiss after the grace gap unless the cursor reaches the card first.
 *  Idempotent: repeated non-link mousemoves (editor, preview) don't push the
 *  moment of death out forever. */
export function scheduleCloseVaultLinkHover(): void {
  if (closeTimer || !cardState) return;
  closeTimer = setTimeout(() => {
    closeTimer = null;
    closeVaultLinkHover();
  }, CLOSE_DELAY_MS);
}
/** Monotonic hover-generation counter — a resolve landing after close or
 *  replace must never resurrect the card (same guard as the vault store's
 *  openGeneration). */
let hoverGeneration = 0;
const listeners = new Set<(s: HoverCardState | null) => void>();

function setCardState(next: HoverCardState | null) {
  cardState = next;
  for (const fn of listeners) fn(next);
}

function subscribe(fn: (s: HoverCardState | null) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Resolve a wikilink target to a note path exactly like NoteEmbed does:
 *  backend `file:` search, basename-or-stem match on the target's LAST
 *  segment, shortest path first — never blindly hits[0] (`[[Daily]]` with
 *  `Daily.md` + `Daily 2026.md` present must pick the right note). */
async function resolveTarget(target: string): Promise<{ path: string | null; content: string | null }> {
  const { vaultSearch, vaultReadNote } = await import("../../lib/ipc");
  const lc = target.toLowerCase();
  const base = lc.split("/").pop() ?? lc;
  // `?? []` — a null RESOLUTION (stub IPC, backend hiccup) must behave like
  // "no hits", same guard as the store's runSearch.
  const hits = (await vaultSearch(`file:"${target}"`, 10).catch(() => [])) ?? [];
  const ranked = hits
    .filter((h) => {
      const hb = h.basename.toLowerCase();
      const dot = hb.lastIndexOf(".");
      const stem = dot > 0 ? hb.slice(0, dot) : hb;
      return hb === base || stem === base;
    })
    .sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
  const hit = ranked[0];
  if (!hit) return { path: null, content: null };
  const content = await vaultReadNote(hit.path).catch(() => null);
  return { path: hit.path, content };
}

/** Schedule the page preview for `target` (debounced; restartable). Safe to
 *  call from non-React code — the rect is captured by the caller. */
export function openVaultLinkHover(opts: {
  target: string;
  anchor: DOMRect;
  /** The note the link lives in. Wikilinks resolve vault-wide (see
   *  resolveTarget), so this only tags the hover for future relative-link
   *  disambiguation — accepted now for API stability. */
  fromPath?: string | null;
}): void {
  if (showTimer) clearTimeout(showTimer);
  cancelClose(); // heading for a new link — a pending fade-out must not eat the fresh card
  const gen = ++hoverGeneration;
  const { target, anchor } = opts;
  showTimer = setTimeout(() => {
    showTimer = null;
    setCardState({ target, rect: anchor, loading: true, resolved: null, content: null });
    void resolveTarget(target).then(({ path, content }) => {
      if (gen !== hoverGeneration) return; // closed or replaced mid-read
      setCardState({ target, rect: anchor, loading: false, resolved: path, content });
    });
  }, HOVER_DEBOUNCE_MS);
}

/** Cancel any pending preview and hide the card immediately. */
export function closeVaultLinkHover(): void {
  cancelClose();
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  hoverGeneration += 1; // strand any in-flight resolve
  if (cardState) setCardState(null);
}

/** Spread-ready hover props for an anchor rendering an internal vault link. */
export function hoverHandlers(
  target: string,
  fromPath: string | null | undefined,
): {
  onMouseEnter: (e: ReactMouseEvent<HTMLAnchorElement>) => void;
  onMouseLeave: () => void;
  onBlur: () => void;
} {
  return {
    onMouseEnter: (e) => {
      openVaultLinkHover({
        target,
        anchor: e.currentTarget.getBoundingClientRect(),
        fromPath: fromPath ?? null,
      });
    },
    onMouseLeave: () => scheduleCloseVaultLinkHover(),
    onBlur: () => closeVaultLinkHover(),
  };
}

const LazyVaultPreviewContent = lazy(() =>
  import("./VaultPreview").then((m) => ({ default: m.VaultPreviewContent })),
);

/** Fixed placement BELOW the anchor, aligned to its left edge — a card to
 *  the link's right covered the very sentence being read and sat in the
 *  cursor's path. Flip above when the lower viewport lacks room; clamp the
 *  horizontal axis so a link at the screen edge keeps the card on-screen
 *  (height uses the CSS max-height — the card never exceeds it). */
function placeCard(rect: DOMRect): { top: number; left: number } {
  let top = rect.bottom + ANCHOR_GAP;
  if (top + CARD_MAX_HEIGHT > window.innerHeight - VIEWPORT_MARGIN) {
    top = Math.max(VIEWPORT_MARGIN, rect.top - ANCHOR_GAP - CARD_MAX_HEIGHT);
  }
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(rect.left, window.innerWidth - VIEWPORT_MARGIN - CARD_WIDTH),
  );
  return { top, left };
}

/** The single card instance — mount once per app and forget. */
export function VaultLinkHoverHost(): JSX.Element | null {
  // Initialized from module state so a card opened before mount (editor
  // plugin firing early) is not silently dropped.
  const [snap, setSnap] = useState<HoverCardState | null>(cardState);
  useEffect(() => subscribe(setSnap), []);
  if (!snap) return null;
  const { top, left } = placeCard(snap.rect);
  return (
    <div
      className="vault-hover-card"
      style={{ top, left }}
      // Entering the card cancels the grace-gap close (pinned); leaving it
      // dismisses — the card is a reading surface, not a trap.
      onMouseEnter={cancelClose}
      onMouseLeave={() => closeVaultLinkHover()}
    >
      {snap.loading ? (
        <div className="vault-hover-missing">…</div>
      ) : snap.content != null ? (
        <>
          <Suspense fallback={null}>
            <LazyVaultPreviewContent
              content={snap.content}
              notePath={snap.resolved ?? snap.target}
              depth={1}
            />
          </Suspense>
          <div className="vault-hover-path">{snap.resolved}</div>
        </>
      ) : (
        <div className="vault-hover-missing">No note named {snap.target}</div>
      )}
    </div>
  );
}
