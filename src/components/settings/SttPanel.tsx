// Settings → Local Models → "Speech" tab: speech-to-text model management —
// the STT analog of My Models / Model Market. Curated whisper.cpp GGML models
// download through the shared Model-Market engine into <models dir>/stt/, and
// the whisper-server sidecar (started here or auto-started on boot) serves the
// composer mic. Backend contract: src-tauri/src/commands/stt.rs.
import { useEffect, useState } from "react";
import {
  cancelModelDownload,
  onModelDownloadProgress,
  startModelDownload,
  sttInstallServer,
  sttSetAutoStart,
  sttSetDefault,
  sttSetServerPath,
  sttStart,
  sttStatus,
  sttStop,
  toastError,
  toastSuccess,
  type DownloadProgress,
  type SttStatus as SttStatusData,
} from "../../lib/ipc";
import { Modal } from "../common/Modal";

/** Progress-event id emitted by `stt_install_server` (backend contract:
 *  commands/stt.rs SERVER_INSTALL_ID). */
const SERVER_INSTALL_ID = "stt-whisper-server";

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

function shortName(path: string): string {
  if (path.length <= 56) return path;
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}

interface PerDownloadState {
  state: DownloadProgress["state"];
  downloaded: number;
  total: number | null;
}

export function SttPanel() {
  const [stt, setStt] = useState<SttStatusData | null>(null);
  const [busy, setBusy] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [downloads, setDownloads] = useState<Record<string, PerDownloadState>>({});

  const refresh = () => {
    void sttStatus().then(setStt).catch(() => {});
  };
  useEffect(refresh, []);

  // Live download bars (same stream the Model Market and Knowledge use).
  useEffect(() => {
    let stale = false;
    let unlisten: (() => void) | null = null;
    void onModelDownloadProgress((p) => {
      if (stale) return;
      // The whisper-server one-click install rides the same event stream but
      // has its own toasts/labels — never report it as a "speech model".
      if (p.id === SERVER_INSTALL_ID) {
        setDownloads((prev) => ({
          ...prev,
          [p.id]: { state: p.state, downloaded: p.downloadedBytes, total: p.totalBytes ?? null },
        }));
        if (p.state === "done") {
          toastSuccess("whisper-server installed — download a model and start the server");
          refresh();
        }
        if (p.state === "error" && p.error) {
          toastError("whisper-server install failed", p.error);
        }
        return;
      }
      setDownloads((prev) => ({
        ...prev,
        [p.id]: { state: p.state, downloaded: p.downloadedBytes, total: p.totalBytes ?? null },
      }));
      if (p.state === "done") {
        toastSuccess("Speech model installed");
        refresh();
      }
      if (p.state === "error" && p.error) {
        toastError("Speech model download failed", p.error);
      }
    }).then((u) => {
      if (stale) u();
      else unlisten = u;
    });
    return () => {
      stale = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleStart = async () => {
    setBusy(true);
    try {
      const s = await sttStart();
      setStt(s);
      toastSuccess(`Speech server running on port ${s.port}`);
    } catch (err) {
      toastError("Could not start the speech server", err);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const handleStop = async () => {
    setBusy(true);
    try {
      await sttStop();
    } catch (err) {
      toastError("Could not stop the speech server", err);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const handleAutoStart = async (on: boolean) => {
    try {
      await sttSetAutoStart(on);
      setStt((prev) => (prev ? { ...prev, autoStart: on } : prev));
    } catch (err) {
      toastError("Could not save the auto-start setting", err);
    }
  };

  const handleSavePath = async () => {
    try {
      await sttSetServerPath(pathInput.trim() || null);
      refresh();
    } catch (err) {
      toastError("Could not save the whisper-server path", err);
    }
  };

  // One-click install of the prebuilt upstream whisper-server binary. The
  // command itself is idempotent — safe to retry after a failed download.
  const handleInstallServer = async () => {
    try {
      const s = await sttInstallServer();
      setStt(s);
      refresh();
    } catch (err) {
      toastError("Could not install whisper-server", err);
    }
  };

  const handleSetDefault = async (filename: string) => {
    try {
      await sttSetDefault(filename);
      toastSuccess(`${filename} is now the default speech model`);
      refresh();
    } catch (err) {
      toastError("Could not set the default speech model", err);
    }
  };

  const handleDownload = (m: { id: string; filename: string; downloadUrl: string }) => {
    void startModelDownload({
      id: m.id,
      repoId: "ggerganov/whisper.cpp",
      filename: m.filename,
      downloadUrl: m.downloadUrl,
      expectedSha256: undefined,
      destDir: stt?.sttDir ?? undefined, // <models>/stt — stt_status scans it
    }).catch((err) => toastError(`Couldn't start download: ${m.filename}`, err));
  };

  const detail = stt?.catalog.find((m) => m.id === detailId) ?? null;
  const detailDl = detail ? downloads[detail.id] : undefined;
  const detailActive =
    !!detailDl && detailDl.state !== "done" && detailDl.state !== "cancelled" && detailDl.state !== "error";
  const detailPct = detailDl?.total
    ? Math.min(100, Math.round((detailDl.downloaded / detailDl.total) * 100))
    : null;

  // whisper-server one-click install progress (same stream as model downloads).
  const serverInstall = downloads[SERVER_INSTALL_ID];
  const serverInstalling =
    !!serverInstall &&
    serverInstall.state !== "done" &&
    serverInstall.state !== "error" &&
    serverInstall.state !== "cancelled";
  const serverInstallPct = serverInstall?.total
    ? Math.min(100, Math.round((serverInstall.downloaded / serverInstall.total) * 100))
    : null;

  return (
    <div className="settings-form">
      <div className="panel-head">
        <h3>Speech-to-text</h3>
      </div>

      <p className="settings-note">
        Voice input for the composer mic runs on a local whisper.cpp server —
        open weights, no cloud. Download a model below, then start the server
        (or let it auto-start with the app).
      </p>

      {!stt ? (
        <div className="settings-note" style={{ color: "var(--text-dim)" }}>
          Speech-to-text status unavailable (app backend not reachable).
        </div>
      ) : (
        <>
          <div className="settings-note">
            <div style={{ marginBottom: 8 }}>
              {stt.running ? (
                <>
                  Server{" "}
                  <span style={{ color: "var(--success, #3fb950)" }}>running</span> on
                  port {stt.port} —{" "}
                  <code className="mono" style={{ fontSize: 11 }}>
                    {shortName(stt.modelPath ?? "")}
                  </code>
                </>
              ) : stt.binaryPath ? (
                <>
                  Server stopped. Binary:{" "}
                  <code className="mono" style={{ fontSize: 11 }}>
                    {shortName(stt.binaryPath)}
                  </code>
                </>
              ) : (
                <span style={{ color: "var(--warn, #d29922)" }}>
                  whisper-server binary not found — install it with one click below, or point at
                  an existing build.
                </span>
              )}
            </div>
            {/* One-click install — the primary path when no binary exists.
                Downloads the pinned upstream release (~8 MB) and saves the
                path automatically; the manual path input below stays as the
                escape hatch for custom builds. */}
            {!stt.binaryPath && (
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="primary cta-strong"
                  disabled={serverInstalling}
                  onClick={() => void handleInstallServer()}
                >
                  {serverInstalling
                    ? serverInstallPct !== null
                      ? `Installing… ${serverInstallPct}%`
                      : "Installing…"
                    : "Install whisper-server (one click)"}
                </button>
                {serverInstalling && (
                  <div className="model-card-progress" style={{ padding: 0, marginTop: 8 }}>
                    <div className="model-card-progress-bar">
                      <div
                        className="model-card-progress-fill"
                        style={{ width: `${serverInstallPct ?? 0}%` }}
                      />
                    </div>
                    <div className="model-card-progress-info">
                      <span>
                        {serverInstallPct !== null ? `${serverInstallPct}% · ` : ""}
                        {formatBytes(serverInstall?.downloaded ?? 0)}
                        {serverInstall?.total ? ` / ${formatBytes(serverInstall.total)}` : ""}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}
            {/* Auto-start row — same shape as the Notifications toggles:
                label left, switch pinned to the far-right edge. */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 600 }}>Start when the app starts</span>
              <button
                type="button"
                role="switch"
                aria-checked={stt.autoStart}
                aria-label="Start the speech server when the app starts"
                className={`settings-toggle${stt.autoStart ? " on" : ""}`}
                onClick={() => void handleAutoStart(!stt.autoStart)}
              >
                <span className="settings-toggle-thumb" />
              </button>
            </div>
            {/* Start/Stop — right-aligned action, same edge as Save path. */}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
              {stt.running ? (
                <button
                  className="ghost"
                  style={{ padding: "4px 10px" }}
                  disabled={busy}
                  onClick={() => void handleStop()}
                >
                  Stop server
                </button>
              ) : (
                <button
                  className="ghost"
                  style={{ padding: "4px 10px" }}
                  disabled={busy || !stt.binaryPath}
                  onClick={() => void handleStart()}
                  title={stt.defaultModel ? undefined : "Download a model and set it as default first"}
                >
                  Start server
                </button>
              )}
            </div>
            {!stt.binaryPath && (
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <input
                  className="mono"
                  style={{ flex: 1, fontSize: 12 }}
                  placeholder="Path to whisper-server(.exe) or its containing folder"
                  value={pathInput}
                  onChange={(e) => setPathInput(e.target.value)}
                />
                <button
                  className="ghost"
                  style={{ padding: "4px 10px" }}
                  onClick={() => void handleSavePath()}
                >
                  Save path
                </button>
              </div>
            )}
          </div>

          <div className="settings-note" style={{ marginTop: 4 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Models</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {stt.catalog.map((m) => {
                const dl = downloads[m.id];
                const active =
                  !!dl && dl.state !== "done" && dl.state !== "cancelled" && dl.state !== "error";
                const pct = dl?.total
                  ? Math.min(100, Math.round((dl.downloaded / dl.total) * 100))
                  : null;
                return (
                  // div[role=button] — the row hosts real <button>s (Download /
                  // Set default), and a <button> inside a <button> is invalid
                  // DOM (validateDOMNesting) with broken focus/click semantics.
                  <div
                    key={m.id}
                    role="button"
                    tabIndex={0}
                    className="ghost knowledge-suggestion"
                    onClick={() => setDetailId(m.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setDetailId(m.id);
                      }
                    }}
                    title={`View details for ${m.label}`}
                  >
                    <span className="knowledge-suggestion-main">
                      <span style={{ fontSize: 12, fontWeight: 600 }}>
                        {m.label}
                        {m.isDefault && (
                          <span className="fit-badge fits" style={{ marginLeft: 8 }}>
                            Default
                          </span>
                        )}
                      </span>
                      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{m.note}</span>
                    </span>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 10,
                        flexShrink: 0,
                      }}
                    >
                      {!m.installed && !active && (
                        <span className="knowledge-suggestion-size mono">
                          {formatBytes(m.sizeBytes)}
                        </span>
                      )}
                      {/* Far-right action button — same edge the settings
                          toggles/buttons live on. Row click opens details;
                          the button acts directly. */}
                      {m.installed ? (
                        m.isDefault ? (
                          <span className="fit-badge fits">✓ Default</span>
                        ) : (
                          <button
                            type="button"
                            className="ghost"
                            style={{ padding: "2px 10px" }}
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleSetDefault(m.filename);
                            }}
                          >
                            Set default
                          </button>
                        )
                      ) : active ? (
                        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                          {pct !== null ? `${pct}%` : "downloading…"}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="ghost"
                          style={{ padding: "2px 10px" }}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDownload(m);
                          }}
                        >
                          Download
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* Detail modal — rendered ONLY when a model is selected. `Modal` has no
          internal open state: mounting it unconditionally portals a permanent,
          focus-stealing empty dialog onto the tab (the "stuck empty box"). */}
      {detail && (
        <Modal
          title={detail.label}
          onClose={() => setDetailId(null)}
          actions={
            detail.installed ? (
              detail.isDefault ? (
                <div
                  className="model-card-status done"
                  style={{ margin: 0, flex: 1, textAlign: "center" }}
                >
                  ✓ Installed — default speech model
                </div>
              ) : (
                <button
                  className="primary cta-strong"
                  style={{ flex: 1 }}
                  onClick={() => void handleSetDefault(detail.filename)}
                >
                  Set as default speech model
                </button>
              )
            ) : detailActive ? (
              <button
                className="ghost"
                onClick={() => void cancelModelDownload(detail.id)}
                style={{ flex: 1 }}
              >
                Cancel download{detailPct !== null ? ` (${detailPct}%)` : ""}
              </button>
            ) : (
              <button
                className="primary cta-strong"
                style={{ flex: 1 }}
                onClick={() => handleDownload(detail)}
              >
                Download ({formatBytes(detail.sizeBytes)})
              </button>
            )
          }
        >
          <div className="model-detail-modal">
            <div className="model-detail-hero">
              <div className="model-detail-avatar-lg">S</div>
              <div>
                <div className="model-detail-repo">{detail.filename}</div>
                <div className="model-detail-stats">
                  <span>{formatBytes(detail.sizeBytes)}</span>
                  <span>·</span>
                  <span>whisper.cpp GGML</span>
                </div>
              </div>
            </div>
            <p className="model-detail-desc">
              {detail.note}. After download, set it as the default and start the
              server (or enable auto-start) — the composer mic then transcribes
              locally, no cloud involved.
            </p>
            {detailActive && (
              <div className="model-market-grid">
                <div className="model-card-progress" style={{ padding: 0 }}>
                  <div className="model-card-progress-bar">
                    <div
                      className="model-card-progress-fill"
                      style={{ width: `${detailPct ?? 0}%` }}
                    />
                  </div>
                  <div className="model-card-progress-info">
                    <span>
                      {detailPct !== null ? `${detailPct}% · ` : ""}
                      {formatBytes(detailDl?.downloaded ?? 0)}
                      {detailDl?.total ? ` / ${formatBytes(detailDl.total)}` : ""}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
