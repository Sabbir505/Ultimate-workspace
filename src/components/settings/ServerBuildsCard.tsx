// The "Server builds" card shared by the speech + local-models settings
// panels: one row per managed native build (whisper CPU/CUDA, llama.cpp CUDA
// server, TTS GPU runtime) with its version state and Install/Update action.
// The harness-updater's row treatment, applied to binaries — same shape as
// Settings → Harnesses (version delta + one action per row), so update
// affordances live in ONE place per panel instead of floating next to
// unrelated controls.
import { useEffect, useRef, useState } from "react";
import {
  llamaInstallCuda,
  onModelDownloadProgress,
  sttInstallCuda,
  sttInstallServer,
  toastError,
  toastSuccess,
  ttsInstallGpu,
  type BuildUpdateStatus,
  type PerDownloadState,
} from "../../lib/ipc";
import { formatBytes } from "../../lib/format";
import { useBuildUpdatesStore } from "../../state/buildUpdates";

/** Installer per build id — invoked with force=true so an update re-pulls
 *  the pinned release (a first install just has nothing to replace). */
const INSTALLERS: Record<string, (force?: boolean) => Promise<unknown>> = {
  "stt-whisper": sttInstallServer,
  "stt-whisper-cuda": sttInstallCuda,
  "llama-cuda": llamaInstallCuda,
  "tts-gpu": ttsInstallGpu,
};

/** One-line description per build id (what it is, what it needs). */
const DESCRIPTIONS: Record<string, string> = {
  "stt-whisper": "CPU build — used when “Use the GPU” is off.",
  "stt-whisper-cuda":
    "CUDA build — used when “Use the GPU” is on. Bundles its own CUDA 12 runtime. ~640 MB.",
  "llama-cuda":
    "CUDA build of llama-server for GPU offload on local models. Needs an NVIDIA GPU. ~242 MB.",
  "tts-gpu":
    "CUDA voice engine + cuDNN 9 runtime. Needs an NVIDIA GPU with the CUDA 13 runtime. ~876 MB.",
};

const INSTALL_SIZES: Record<string, string> = {
  "stt-whisper": "~8 MB",
  "stt-whisper-cuda": "~640 MB",
  "llama-cuda": "~242 MB",
  "tts-gpu": "~876 MB",
};

/** States that keep a row's progress bar (and disabled button) up. */
function isActive(state: PerDownloadState["state"] | undefined): boolean {
  return state === "starting" || state === "downloading" || state === "verifying";
}

export function ServerBuildsCard({
  ids,
  title = "Server builds",
  note,
  onInstalled,
}: {
  /** Build ids to show, in order (subset of the INSTALLERS keys). */
  ids: string[];
  title?: string;
  note?: string;
  /** Called after a build installs/updates — panels refresh their status. */
  onInstalled?: (id: string) => void;
}) {
  const buildUpdates = useBuildUpdatesStore((s) => s.buildUpdates);
  const markBuildUpdated = useBuildUpdatesStore((s) => s.markBuildUpdated);
  const refreshBuildUpdates = useBuildUpdatesStore((s) => s.refreshBuildUpdates);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, PerDownloadState>>({});

  useEffect(() => {
    void refreshBuildUpdates().catch(() => {});
  }, [refreshBuildUpdates]);

  // Own progress listener for THIS card's ids — the panels no longer need
  // build-install branches in their own listeners.
  const idsRef = useRef(ids);
  idsRef.current = ids;
  useEffect(() => {
    let stale = false;
    let unlisten: (() => void) | null = null;
    void onModelDownloadProgress((p) => {
      if (stale || !idsRef.current.includes(p.id)) return;
      setProgress((prev) => ({
        ...prev,
        [p.id]: { state: p.state, downloaded: p.downloadedBytes, total: p.totalBytes ?? null },
      }));
    }).then((u) => {
      if (stale) u();
      else unlisten = u;
    });
    return () => {
      stale = true;
      unlisten?.();
    };
  }, []);

  const runInstall = async (id: string) => {
    const installer = INSTALLERS[id];
    if (!installer || busyId) return;
    const titleOf = buildUpdates[id]?.title ?? id;
    setBusyId(id);
    try {
      await installer(true);
      // Optimistic flip (mirrors markHarnessUpdated): the installer verified
      // and stamped the build, so the row is current right now.
      markBuildUpdated(id);
      toastSuccess(`${titleOf} is up to date`);
      onInstalled?.(id);
    } catch (err) {
      toastError(`Could not update ${titleOf}`, err);
    } finally {
      setBusyId(null);
      void refreshBuildUpdates().catch(() => {});
    }
  };

  return (
    <div className="settings-note">
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{title}</div>
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 10 }}>
        {note ??
          "Pinned, checksum-verified builds this app downloads and keeps up to date."}
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {ids.map((id, i) => {
          const row: BuildUpdateStatus | undefined = buildUpdates[id];
          const dl = progress[id];
          const active = busyId === id || isActive(dl?.state);
          const pct =
            dl?.total != null && dl.total > 0
              ? Math.min(100, Math.round((dl.downloaded / dl.total) * 100))
              : null;
          const borderTop = i > 0 ? "1px solid var(--border)" : undefined;
          return (
            <div key={id} style={{ borderTop, padding: "10px 0" }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>
                    {row?.title ?? id}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
                    {DESCRIPTIONS[id]}
                  </div>
                  {row?.note && (
                    <div style={{ fontSize: 11, color: "var(--warn, #d29922)", marginTop: 4 }}>
                      {row.note}
                    </div>
                  )}
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-end",
                    gap: 6,
                    flexShrink: 0,
                  }}
                >
                  {!row ? (
                    <span style={{ fontSize: 11, color: "var(--text-dim)" }}>Checking…</span>
                  ) : row.updateAvailable ? (
                    <span style={{ fontSize: 11, color: "var(--state-waiting)" }}>
                      {row.installedVersion ?? "unversioned"} → v{row.latestVersion}
                    </span>
                  ) : row.installed ? (
                    <span style={{ fontSize: 11, color: "var(--state-working)" }}>
                      v{row.installedVersion ?? "?"} · current
                    </span>
                  ) : (
                    <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                      Not installed{INSTALL_SIZES[id] ? ` · ${INSTALL_SIZES[id]}` : ""}
                    </span>
                  )}
                  {row && (row.updateAvailable || !row.installed) && (
                    <button
                      type="button"
                      className="primary cta-strong"
                      disabled={busyId !== null || active}
                      title={
                        row.updateAvailable && row.installed
                          ? `v${row.installedVersion ?? "?"} → v${row.latestVersion} — re-downloads the pinned build`
                          : `Downloads the pinned build (${INSTALL_SIZES[id] ?? "pinned size"}), checksum-verified`
                      }
                      onClick={() => void runInstall(id)}
                    >
                      {active
                        ? pct !== null
                          ? `Installing… ${pct}%`
                          : "Installing…"
                        : row.installed
                          ? "Update"
                          : "Install"}
                    </button>
                  )}
                </div>
              </div>
              {active && (
                <div className="model-card-progress" style={{ padding: 0, marginTop: 8 }}>
                  <div className="model-card-progress-bar">
                    <div
                      className="model-card-progress-fill"
                      style={{ width: `${pct ?? 0}%` }}
                    />
                  </div>
                  <div className="model-card-progress-info">
                    <span>
                      {pct !== null ? `${pct}% · ` : ""}
                      {formatBytes(dl?.downloaded ?? 0)}
                      {dl?.total ? ` / ${formatBytes(dl.total)}` : ""}
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
