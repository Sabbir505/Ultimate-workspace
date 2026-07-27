// Update banner: shown at the top of the app when the updater detected a newer
// version. Displays the new version, the release notes (markdown), a download
// progress bar, and Download & restart / Later actions. Stays out of the way
// when there's nothing to report.
import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useUpdaterStore } from "../../state/updater";

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
      <div className="update-banner installed">
        <span className="update-banner-title">
          ✅ Update installed — restarting…
        </span>
      </div>
    );
  }

  const downloading = install === "downloading";

  return (
    <div className={`update-banner${downloading ? " downloading" : ""}`}>
      {!downloading && (
        <button
          className="update-banner-close"
          onClick={dismiss}
          title="Later — I'll update next time"
          aria-label="Dismiss update notification"
        >
          ×
        </button>
      )}
      <div className="update-banner-head">
        <span className="update-banner-title">
          🔄 A new version of Conduit is available
        </span>
        {update?.version && (
          <span className="update-banner-version">v{update.version}</span>
        )}
      </div>
      {update?.notes && (
        <div className="update-banner-notes">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{update.notes}</ReactMarkdown>
        </div>
      )}
      {downloading ? (
        <div className="update-banner-progress">
          <div className="update-bar">
            <div
              className="update-bar-fill"
              style={{ width: pct != null ? `${pct}%` : undefined }}
            />
          </div>
          <span className="update-bar-label">
            {pct != null
              ? `${pct}%`
              : formatBytes(downloaded) + (total ? ` / ${formatBytes(total)}` : "")}
          </span>
        </div>
      ) : (
        <div className="update-banner-actions">
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
      {install === "error" && error && (
        <div className="update-banner-error">
          Update failed: {error}. You can retry or download it manually from
          GitHub Releases.
        </div>
      )}
    </div>
  );
}
