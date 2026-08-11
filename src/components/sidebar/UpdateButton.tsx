// Green "Update" button for the sidebar header, right of the "Conduit" brand.
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function NotesSection({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
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

  // Position the popover below the button. Uses position:fixed + viewport
  // coords to escape the sidebar's overflow:hidden and stacking context
  // (createPortal crashed the WebView in this app — see GitToolsSidebar.tsx).
  const reposition = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    // Open rightward from the button's left edge; clamp so a narrow viewport
    // can't push it off-screen.
    const width = 300;
    const left = Math.min(r.left, window.innerWidth - width - 8);
    setPopoverPos({ top: r.bottom + 6, left: Math.max(8, left) });
  };

  // Recompute when the popover opens and on viewport changes while open.
  useEffect(() => {
    if (!open) return;
    reposition();
    const onScroll = () => reposition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
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
                <span>{pct != null ? `${pct}%` : formatBytes(downloaded)}</span>
              </div>
              <div className="update-popover-bar">
                <div
                  className="update-popover-bar-fill"
                  style={{ width: pct != null ? `${pct}%` : "0%" }}
                />
              </div>
              {total != null && (
                <div className="update-popover-progress-meta">
                  {formatBytes(downloaded)} of {formatBytes(total)}
                </div>
              )}
            </div>
          )}

          {installed && (
            <div className="update-popover-installed">
              Update installed — Conduit is restarting to apply it.
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
