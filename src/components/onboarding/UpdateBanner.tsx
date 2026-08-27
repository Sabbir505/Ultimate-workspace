// Update modal: centered overlay shown when the updater detects a newer version.
// Replaces the old top banner with a focused, centered modal that appears on app
// startup. Displays the new version, release notes (markdown), a download
// progress bar, and Download & restart / Later actions.
//
// BUNDLE: react-markdown + remark-gfm are heavy (~150 KB raw). The update
// modal is almost never visible (only when an update is available AND the
// user hasn't dismissed it), so we lazy-load the markdown rendering as a
// small MarkdownNotes sub-component. The Suspense boundary in the parent
// shows the raw release notes as a fallback while the chunk downloads.
import { lazy, Suspense, useMemo, useState } from "react";
import { useUpdaterStore } from "../../state/updater";

/** Self-contained markdown renderer. Imported lazily; the parent's Suspense
 *  boundary shows the raw notes for one frame if it's the first render. */
const MarkdownNotes = lazy(() => import("./UpdateBannerMarkdown").then((m) => ({ default: m.MarkdownNotes })));

/** Human-readable byte count, no trailing decimals unless needed. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdateBanner() {
  const update = useUpdaterStore((s) => s.update);
  const install = useUpdaterStore((s) => s.install);
  const downloaded = useUpdaterStore((s) => s.downloaded);
  const total = useUpdaterStore((s) => s.total);
  const error = useUpdaterStore((s) => s.error);
  const startInstall = useUpdaterStore((s) => s.startInstall);
  const dismiss = useUpdaterStore((s) => s.dismiss);

  const pct = useMemo(() => {
    if (!total || total === 0) return null;
    return Math.min(100, Math.round((downloaded / total) * 100));
  }, [downloaded, total]);

  // Nothing to show when there's no update and no in-flight install.
  if (!update && install === "idle") return null;

  // After install: show a "restart" notice until the plugin restarts the app.
  if (install === "installed") {
    return (
      <div className="update-modal-overlay">
        <div className="update-modal installed">
          <div className="update-modal-icon installed">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
              <polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
          </div>
          <h2 className="update-modal-title">Update installed</h2>
          <p className="update-modal-subtitle">Relay is restarting to apply the update…</p>
        </div>
      </div>
    );
  }

  const downloading = install === "downloading";

  return (
    <div className="update-modal-overlay">
      <div className={`update-modal${downloading ? " downloading" : ""}`}>
        {/* Header */}
        <div className="update-modal-header">
          <div className="update-modal-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
              <path d="M3 3v5h5"/>
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
              <path d="M16 21h5v-5"/>
            </svg>
          </div>
          <h2 className="update-modal-title">A new version is available</h2>
          {update?.version && (
            <span className="update-modal-version">v{update.version}</span>
          )}
        </div>

        {/* Release notes */}
        {update?.notes && (
          <div className="update-modal-notes">
            <div className="update-modal-notes-header">What&apos;s new</div>
            <div className="update-modal-notes-body">
              <Suspense fallback={<pre className="update-modal-notes-raw">{update.notes}</pre>}>
                <MarkdownNotes notes={update.notes} />
              </Suspense>
            </div>
          </div>
        )}

        {/* Progress */}
        {downloading ? (
          <div className="update-modal-progress">
            <div className="update-modal-progress-top">
              <span className="update-modal-progress-label">Downloading update…</span>
              <span className="update-modal-progress-value">
                {pct != null ? `${pct}%` : formatBytes(downloaded)}
              </span>
            </div>
            <div className="update-modal-bar">
              <div
                className="update-modal-bar-fill"
                style={{ width: pct != null ? `${pct}%` : "0%" }}
              />
            </div>
            {total != null && (
              <div className="update-modal-progress-meta">
                {formatBytes(downloaded)} of {formatBytes(total)}
              </div>
            )}
          </div>
        ) : (
          <div className="update-modal-actions">
            <button
              className="primary"
              onClick={() => void startInstall()}
              disabled={downloading}
            >
              Download &amp; restart
            </button>
            <button className="ghost" onClick={dismiss}>
              Later
            </button>
          </div>
        )}

        {/* Error */}
        {install === "error" && error && (
          <div className="update-modal-error">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span>
              Update failed: {error}. You can retry or download it manually from
              GitHub Releases.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
