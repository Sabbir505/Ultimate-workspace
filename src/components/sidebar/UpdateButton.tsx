// Green "Update" button for the sidebar header, right of the "Relay" brand.
// Visible only when an update is available (useUpdaterStore.update != null) or
// an install is in flight / just finished. Hovering (or focusing) the button
// opens a popover with the version, date, and structured Features / Bug Fixes
// sections parsed from the release notes. Clicking the button — or the popover's
// CTA — calls startInstall(), which downloads + installs + restarts.
//
// The parent header has data-tauri-drag-region; the button and popover opt out
// with data-tauri-drag-region="false" so clicks/interactions aren't swallowed.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Loader2, AlertCircle } from "lucide-react";
import { useUpdaterStore } from "../../state/updater";
import { parseReleaseNotes } from "../../lib/releaseNotes";
import { formatBytes, formatDate } from "../../lib/format";

/** Fallback card width, used only before the popover has rendered. Keep in
 *  sync with `.update-popover { width }` in banners.css. */
const POPOVER_WIDTH = 300;
/** Minimum gap between the card and any viewport edge. */
const EDGE = 8;
/** Gap between the button and the card. */
const POPOVER_GAP = 6;

/** Where the details card goes, given the button's rect, the card's measured
 *  size, and the viewport. Pure so the placement rules are testable.
 *
 *  The card is anchored to the button's RIGHT edge, not its left: the button
 *  is a small pill in the top-LEFT sidebar header, so a left-anchored card sat
 *  hard against the screen's left side and straddled the sidebar boundary with
 *  a long overhang past the pill. Starting it where the pill ends reads as
 *  attached to the control and keeps the left margin clear.
 *
 *  It drops below the button, flips above when the card is taller than the
 *  space underneath, and never crosses a viewport edge. `card` may be
 *  nullish (the first pass, before the card has rendered): height is then
 *  unknown, so the flip is deferred to the measured second pass.
 *
 *  DEPENDS ON the CSS: `.update-popover { max-height: min(520px, 100vh - 16px) }`
 *  is what bounds the card to the viewport, which is what makes the flip
 *  above always able to fit. If that cap is removed or raised, this has to
 *  clamp the height too. */
export function computePopoverPos(
  anchor: { left: number; right: number; top: number; bottom: number },
  card: { w: number; h: number } | null,
  viewport: { w: number; h: number },
): { top: number; left: number } {
  const width = card?.w || POPOVER_WIDTH;
  const height = card?.h || 0;
  const left = Math.max(EDGE, Math.min(anchor.right, viewport.w - EDGE - width));
  const below = anchor.bottom + POPOVER_GAP;
  const fitsBelow = height === 0 || below + height <= viewport.h - EDGE;
  const top = fitsBelow ? below : Math.max(EDGE, anchor.top - POPOVER_GAP - height);
  return { top, left };
}

function NotesSection({ title, items }: { title: string; items: string[] }) {  if (items.length === 0) return null;
  return (
    <div className="update-popover-section">
      <div className="update-popover-section-title">{title}</div>
      <ul className="update-popover-list">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export function UpdateButton() {
  const update = useUpdaterStore((s) => s.update);
  const install = useUpdaterStore((s) => s.install);
  const downloaded = useUpdaterStore((s) => s.downloaded);
  const total = useUpdaterStore((s) => s.total);
  const error = useUpdaterStore((s) => s.error);
  const startInstall = useUpdaterStore((s) => s.startInstall);

  const [open, setOpen] = useState(false);
  // Popover coords (viewport-relative, for position:fixed). Recomputed on open.
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
  const closeTimer = useRef<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Position the popover. Uses position:fixed + viewport coords to escape the
  // sidebar's overflow:hidden and stacking context (createPortal crashed the
  // WebView in this app — see GitToolsSidebar.tsx).
  const reposition = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const card = popoverRef.current;
    setPopoverPos(
      computePopoverPos(
        { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
        card ? { w: card.offsetWidth, h: card.offsetHeight } : null,
        { w: window.innerWidth, h: window.innerHeight },
      ),
    );
  };

  // Recompute when the popover opens and on viewport changes while open. The
  // second pass (next frame) runs once the card has actually rendered, so the
  // height-driven flip above/below is decided on real measurements rather than
  // a guess.
  useEffect(() => {
    if (!open) return;
    reposition();
    const frame = requestAnimationFrame(reposition);
    const onScroll = () => reposition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  const parsed = useMemo(
    () => parseReleaseNotes(update?.notes ?? null),
    [update?.notes],
  );
  const pct = useMemo(() => {
    if (!total || total === 0) return null;
    return Math.min(100, Math.round((downloaded / total) * 100));
  }, [downloaded, total]);

  // Click-outside closes the popover. The popover is portaled to document.body,
  // so it is NOT a DOM descendant of the wrap — check both refs.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Cancel any pending close on unmount.
  useEffect(() => () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
  }, []);

  // Nothing to render when there's no update and no in-flight install.
  if (!update && install === "idle") return null;

  const downloading = install === "downloading";
  const installed = install === "installed";
  const hasError = install === "error";

  const cancelClose = () => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 120);
  };

  const onActivate = () => {
    if (downloading || installed) return;
    void startInstall();
  };

  return (
    <div
      ref={wrapRef}
      className="update-button-wrap"
      onMouseEnter={() => {
        cancelClose();
        setOpen(true);
      }}
      onMouseLeave={scheduleClose}
    >
      <button
        ref={btnRef}
        type="button"
        data-tauri-drag-region="false"
        className={
          "update-button" +
          (downloading ? " downloading" : "") +
          (installed ? " installed" : "") +
          (hasError ? " errored" : "")
        }
        onClick={onActivate}
        disabled={downloading || installed}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={
          installed
            ? "Update installed — restarting"
            : downloading
              ? "Downloading update…"
              : hasError
                ? "Update failed — click to retry"
                : `Update available${update?.version ? ` (v${update.version})` : ""}`
        }
      >
        {downloading ? (
          <Loader2 size={14} strokeWidth={2.2} className="spin" />
        ) : installed ? (
          <span className="update-button-check">✓</span>
        ) : hasError ? (
          <AlertCircle size={14} strokeWidth={2.2} />
        ) : (
          <Download size={14} strokeWidth={2.2} />
        )}
        <span className="update-button-label">
          {installed ? "Restarting" : downloading ? (pct != null ? `${pct}%` : "Updating") : "Update"}
        </span>
      </button>

      {open && popoverPos && createPortal(
        <div
          ref={popoverRef}
          className="update-popover"
          role="dialog"
          data-tauri-drag-region="false"
          style={{ position: "fixed", top: popoverPos.top, left: popoverPos.left, zIndex: 2147483647 }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          <div className="update-popover-header">
            <div className="update-popover-titles">
              <div className="update-popover-heading">Update available</div>
              {update?.version && (
                <span className="update-popover-version">v{update.version}</span>
              )}
            </div>
            {update?.pubDate && (
              <div className="update-popover-date">{formatDate(update.pubDate)}</div>
            )}
          </div>

          {downloading && (
            <div className="update-popover-progress">
              <div className="update-popover-progress-top">
                <span>Downloading…</span>
                <span>{pct != null ? `${pct}%` : formatBytes(downloaded, "0 B")}</span>
              </div>
              <div className="update-popover-bar">
                <div
                  className="update-popover-bar-fill"
                  style={{ width: pct != null ? `${pct}%` : "0%" }}
                />
              </div>
              {total != null && (
                <div className="update-popover-progress-meta">
                  {formatBytes(downloaded, "0 B")} of {formatBytes(total, "0 B")}
                </div>
              )}
            </div>
          )}

          {installed && (
            <div className="update-popover-installed">
              Update installed — Relay is restarting to apply it.
            </div>
          )}

          {hasError && error && (
            <div className="update-popover-error">
              <AlertCircle size={14} strokeWidth={2.2} />
              <span>Update failed: {error}. Click to retry.</span>
            </div>
          )}

          {!downloading && !installed && (
            <div className="update-popover-notes">
              <NotesSection title="Features" items={parsed.features} />
              <NotesSection title="Bug Fixes" items={parsed.bugfixes} />
              <NotesSection title="Changes" items={parsed.other} />
              {parsed.features.length === 0 &&
                parsed.bugfixes.length === 0 &&
                parsed.other.length === 0 && (
                  <div className="update-popover-empty">Release notes will be shown here.</div>
                )}
            </div>
          )}

          {!installed && (
            <button
              type="button"
              data-tauri-drag-region="false"
              className="update-popover-cta"
              onClick={onActivate}
              disabled={downloading}
            >
              {downloading ? (
                <>
                  <Loader2 size={14} strokeWidth={2.2} className="spin" /> Downloading…
                </>
              ) : hasError ? (
                "Retry update"
              ) : (
                "Download & install"
              )}
            </button>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
