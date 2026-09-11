// Settings → Local Models → "Speech": text-to-speech management — the read-aloud
// analog of SttPanel. Kokoro-82M runs in-process (no server to start), so this
// panel is: pick a bundle, pick a voice, set the pace. Backend contract:
// src-tauri/src/commands/tts.rs.
import { useEffect, useMemo, useState } from "react";
import {
  cancelModelDownload,
  onModelDownloadProgress,
  ttsInstallModel,
  ttsPreload,
  ttsInstallGpu,
  ttsGpuStatus,
  ttsSetAutoRead,
  ttsSetDevice,
  ttsSetKeepLoaded,
  ttsSetSpeed,
  ttsSetVoice,
  ttsStatus,
  ttsUnload,
  toastError,
  toastSuccess,
  type PerDownloadState,
  type TtsGpuStatus,
  type TtsStatus as TtsStatusData,
} from "../../lib/ipc";
import { formatBytes } from "../../lib/format";
import { GlassSelect } from "../common/GlassSelect";

/** 1x is the model's natural pace; the backend clamps to the same range. */
const SPEED_PRESETS = [0.75, 1, 1.25, 1.5, 2];

/** Progress-event id shared by both halves of the GPU runtime install
 *  (backend contract: commands/tts_gpu.rs GPU_INSTALL_ID). */
const GPU_INSTALL_ID = "tts-gpu-runtime";

export function TtsPanel() {
  const [tts, setTts] = useState<TtsStatusData | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloads, setDownloads] = useState<Record<string, PerDownloadState>>({});
  const [gpu, setGpu] = useState<TtsGpuStatus | null>(null);
  const [busyDevice, setBusyDevice] = useState(false);

  const refresh = () => {
    void ttsStatus()
      .then(setTts)
      .catch(() => {});
    void ttsGpuStatus()
      .then(setGpu)
      .catch(() => {});
  };
  useEffect(refresh, []);

  // Model downloads ride the shared progress stream, keyed by the catalog id
  // (so the Cancel button is the same `cancelModelDownload` the market uses).
  useEffect(() => {
    let stale = false;
    let unlisten: (() => void) | null = null;
    void onModelDownloadProgress((p) => {
      if (stale) return;
      if (!p.id.startsWith("tts/")) return;
      setDownloads((prev) => ({
        ...prev,
        [p.id]: { state: p.state, downloaded: p.downloadedBytes, total: p.totalBytes ?? null },
      }));
      if (p.state === "done") {
        toastSuccess("Voice model installed — read-aloud is ready");
        // Warm the engine now so the first press of play isn't the call that
        // pays for the ONNX session.
        void ttsPreload().catch(() => {});
        refresh();
      }
      if (p.state === "error" && p.error) {
        toastError("Voice model download failed", p.error);
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

  const handleInstall = async (id: string) => {
    setBusy(true);
    try {
      const s = await ttsInstallModel(id);
      setTts(s);
      void ttsPreload().catch(() => {});
    } catch (err) {
      toastError("Could not install the voice model", err);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const handleDevice = async (device: "cpu" | "gpu") => {
    setBusyDevice(true);
    try {
      const s = await ttsSetDevice(device);
      setTts(s);
      if (device === "gpu") refresh();
    } catch (err) {
      toastError("Could not switch the synthesis device", err);
    } finally {
      setBusyDevice(false);
    }
  };

  const handleInstallGpu = async () => {
    setBusyDevice(true);
    try {
      setGpu(await ttsInstallGpu());
      toastSuccess("GPU support ready");
    } catch (err) {
      toastError("Could not install GPU support", err);
    } finally {
      setBusyDevice(false);
      refresh();
    }
  };

  const handleKeepLoaded = async (keep: boolean) => {
    setBusyDevice(true);
    try {
      const s = await ttsSetKeepLoaded(keep);
      setTts(s);
    } catch (err) {
      // Rejects when there is nothing to load, or on GPU where there is no
      // resident engine — the backend reverts the setting, so re-read status
      // rather than leaving the toggle showing a state it did not reach.
      toastError("Could not change the load behaviour", err);
      refresh();
    } finally {
      setBusyDevice(false);
    }
  };

  const handleVoice = async (name: string) => {
    try {
      await ttsSetVoice(name);
      setTts((prev) => (prev ? { ...prev, voice: name } : prev));
    } catch (err) {
      toastError("Could not save the voice", err);
    }
  };

  const handleSpeed = async (speed: number) => {
    try {
      // The backend clamps; adopt its answer rather than assuming the request.
      const applied = await ttsSetSpeed(speed);
      setTts((prev) => (prev ? { ...prev, speed: applied } : prev));
    } catch (err) {
      toastError("Could not save the reading speed", err);
    }
  };

  const handleAutoRead = async (on: boolean) => {
    try {
      await ttsSetAutoRead(on);
      setTts((prev) => (prev ? { ...prev, autoRead: on } : prev));
    } catch (err) {
      toastError("Could not save the auto-read setting", err);
    }
  };

  const handleUnload = async () => {
    setBusy(true);
    try {
      const s = await ttsUnload();
      setTts(s);
    } catch (err) {
      toastError("Could not unload the voice model", err);
    } finally {
      setBusy(false);
    }
  };

  // GlassSelect has no optgroups, so the language rides as each option's
  // subtitle — and the list is sorted by language then name, which recovers the
  // grouping a 54-voice flat list would otherwise bury.
  const voiceOptions = useMemo(
    () =>
      [...(tts?.voices ?? [])]
        .sort((a, b) =>
          (a.language || "zz").localeCompare(b.language || "zz") || a.name.localeCompare(b.name),
        )
        .map((v) => ({
          value: v.name,
          label: v.name,
          hint: v.language || undefined,
        })),
    [tts?.voices],
  );

  if (!tts) {
    return (
      <div className="settings-form">
        <div className="panel-head">
          <h3>Text-to-speech</h3>
        </div>
        <div className="settings-note" style={{ color: "var(--text-dim)" }}>
          Text-to-speech status unavailable (app backend not reachable).
        </div>
      </div>
    );
  }

  // GPU runtime install progress (same event stream the model downloads use,
  // under its own id).
  const gpuInstall = downloads[GPU_INSTALL_ID];
  const gpuInstalling =
    !!gpuInstall &&
    gpuInstall.state !== "done" &&
    gpuInstall.state !== "error" &&
    gpuInstall.state !== "cancelled";
  const gpuInstallPct = gpuInstall?.total
    ? Math.min(100, Math.round((gpuInstall.downloaded / gpuInstall.total) * 100))
    : null;

  const selected = tts.catalog.find((m) => m.id === tts.modelId) ?? null;

  return (
    <div className="settings-form">
      <div className="panel-head">
        <h3>Text-to-speech</h3>
      </div>

      <p className="settings-note">
        Read assistant answers and text artifacts aloud with Kokoro-82M — an
        open-weights model (Apache-2.0) that runs entirely on this machine. No
        cloud, no API key, nothing leaves the device. Speech is synthesized on
        the CPU, so it never competes with a model loaded on your GPU.
      </p>
      <p className="settings-note" style={{ fontSize: 11 }}>
        Synthesis runs at roughly playback speed on a typical laptop CPU, so a
        long answer keeps a sentence or two buffered ahead rather than being
        ready instantly — playback starts as soon as the first sentence is
        voiced. Prefer the non-int8 models: int8 is a third of the download but
        is <em>slower</em> unless your CPU has int8 acceleration (roughly Ice
        Lake / Zen 4 and newer).
      </p>

      <div className="settings-note">
        <div style={{ marginBottom: 8 }}>
          {tts.modelId ? (
            <>
              Voice model{" "}
              <span style={{ color: "var(--success, #3fb950)" }}>
                {tts.loaded ? "loaded" : "installed"}
              </span>{" "}
              —{" "}
              <code className="mono" style={{ fontSize: 11 }}>
                {selected?.label ?? tts.modelId}
              </code>
              {tts.cacheBytes > 0 && (
                <span style={{ color: "var(--text-dim)" }}>
                  {" "}
                  · {formatBytes(tts.cacheBytes)} of synthesized audio cached
                </span>
              )}
            </>
          ) : (
            <span style={{ color: "var(--warn, #d29922)" }}>
              No voice model installed — download one below to enable read-aloud.
            </span>
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {tts.loaded && (
            <button
              className="ghost"
              style={{ padding: "4px 10px" }}
              disabled={busy}
              onClick={() => void handleUnload()}
              title="Free the model's memory; it reloads on the next read"
            >
              Unload from memory
            </button>
          )}
        </div>
      </div>

      {tts.modelId && tts.voices.length > 0 && (
        <div className="settings-note" style={{ marginTop: 4 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Voice</div>
          <GlassSelect
            value={tts.voice ?? tts.voices[0]?.name ?? ""}
            options={voiceOptions}
            onChange={(name) => void handleVoice(name)}
            title="Reading voice"
            className="tts-voice-trigger"
          />
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6 }}>
            {tts.voices.length} voices, from the model itself. The subtitle is the
            language each one speaks.
          </div>
        </div>
      )}

      <div className="settings-note" style={{ marginTop: 4 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Reading speed</div>
        <div className="settings-choice-row">
          {SPEED_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              // `.ghost` + `active` had no styling, so the chosen pace looked
              // identical to the others — you could not tell what was selected.
              className={`settings-choice${Math.abs(tts.speed - preset) < 0.01 ? " active" : ""}`}
              aria-pressed={Math.abs(tts.speed - preset) < 0.01}
              onClick={() => void handleSpeed(preset)}
            >
              {preset}×
            </button>
          ))}
        </div>
      </div>

      <div className="settings-note" style={{ marginTop: 4 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 600 }}>Use the GPU (CUDA)</span>
          <button
            type="button"
            role="switch"
            aria-checked={tts.device === "gpu"}
            aria-label="Use the GPU for speech synthesis"
            className={`settings-toggle${tts.device === "gpu" ? " on" : ""}`}
            disabled={busyDevice}
            onClick={() => void handleDevice(tts.device === "gpu" ? "cpu" : "gpu")}
          >
            <span className="settings-toggle-thumb" />
          </button>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6 }}>
          {tts.device === "gpu" ? (
            <>
              GPU synthesis runs the CUDA build of the voice engine as a separate
              process: about <strong>3x faster</strong> at the synthesis itself
              (measured 4.6x vs 1.5x realtime), but every read pays a few seconds
              to start that process — so long texts benefit most. CPU mode loads
              the model once and starts playing sooner.
            </>
          ) : (
            <>
              CPU synthesis runs in-process: nothing to install, and audio starts
              on the first sentence. GPU is roughly 3x faster at synthesizing, at
              the cost of a few seconds of start-up per read.
            </>
          )}
        </div>

        {tts.device === "gpu" && gpu && (
          <div style={{ marginTop: 8, fontSize: 11 }}>
            {gpu.missing.length === 0 ? (
              <span style={{ color: "var(--success, #3fb950)" }}>
                ✓ GPU runtime ready
              </span>
            ) : (
              <>
                <div style={{ color: "var(--warn, #d29922)", marginBottom: 6 }}>
                  Missing: {gpu.missing.join(", ")}
                </div>
                <button
                  type="button"
                  className="primary cta-strong"
                  disabled={busyDevice || gpuInstalling}
                  onClick={() => void handleInstallGpu()}
                >
                  {gpuInstalling
                    ? gpuInstallPct !== null
                      ? `Installing… ${gpuInstallPct}%`
                      : "Installing…"
                    : "Install GPU support (~876 MB)"}
                </button>
                <div style={{ marginTop: 6, color: "var(--text-dim)" }}>
                  Downloads the CUDA voice engine (456 MB) and the cuDNN 9
                  runtime (420 MB), both checksum-verified. The NVIDIA CUDA 13
                  runtime must already be installed.
                </div>
                {gpuInstalling && (
                  <div className="model-card-progress" style={{ padding: 0, marginTop: 8 }}>
                    <div className="model-card-progress-bar">
                      <div
                        className="model-card-progress-fill"
                        style={{ width: `${gpuInstallPct ?? 0}%` }}
                      />
                    </div>
                    <div className="model-card-progress-info">
                      <span>
                        {gpuInstallPct !== null ? `${gpuInstallPct}% · ` : ""}
                        {formatBytes(gpuInstall?.downloaded ?? 0)}
                        {gpuInstall?.total ? ` / ${formatBytes(gpuInstall.total)}` : ""}
                      </span>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600 }}>Keep the model loaded</span>
        <button
          type="button"
          role="switch"
          aria-checked={tts.keepLoaded}
          aria-label="Keep the voice model loaded from app start"
          className={`settings-toggle${tts.keepLoaded ? " on" : ""}`}
          disabled={busyDevice || tts.device === "gpu"}
          onClick={() => void handleKeepLoaded(!tts.keepLoaded)}
        >
          <span className="settings-toggle-thumb" />
        </button>
      </div>
      <div className="settings-note" style={{ fontSize: 11, color: "var(--text-dim)" }}>
        {tts.device === "gpu"
          ? "Not available on GPU. The CUDA engine ships as a command-line program with no server mode, so each read launches it fresh (about 4.5s) and there is no long-lived engine to hold in memory. Switch to CPU if you want the model kept resident between reads."
          : tts.keepLoaded
            ? "The model loads when Relay starts and is released when it closes, so the first answer plays with no loading pause."
            : "The model loads on first use and stays in memory until Relay closes. Turn this on to load it at startup instead."}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600 }}>
          Read new answers aloud automatically
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={tts.autoRead}
          aria-label="Read new answers aloud automatically"
          className={`settings-toggle${tts.autoRead ? " on" : ""}`}
          onClick={() => void handleAutoRead(!tts.autoRead)}
        >
          <span className="settings-toggle-thumb" />
        </button>
      </div>
      {tts.autoRead && (
        <div className="settings-note" style={{ fontSize: 11, color: "var(--text-dim)" }}>
          Browsers only allow audio after you interact with the page once — press
          play on any message first, and auto-read takes over from there.
        </div>
      )}

      <div className="settings-note" style={{ marginTop: 4 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Models</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {tts.catalog.map((m) => {
            const dl = downloads[m.id];
            const active =
              !!dl && dl.state !== "done" && dl.state !== "cancelled" && dl.state !== "error";
            const pct = dl?.total ? Math.min(100, Math.round((dl.downloaded / dl.total) * 100)) : null;
            return (
              <div key={m.id} className="ghost knowledge-suggestion">
                <span className="knowledge-suggestion-main">
                  <span style={{ fontSize: 12, fontWeight: 600 }}>
                    {m.label}
                    {m.isSelected && (
                      <span className="fit-badge fits" style={{ marginLeft: 8 }}>
                        In use
                      </span>
                    )}
                    {m.recommended && !m.isSelected && !m.installed && (
                      <span className="fit-badge fits" style={{ marginLeft: 8 }}>
                        Recommended
                      </span>
                    )}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{m.note}</span>
                </span>
                <span
                  style={{ display: "inline-flex", alignItems: "center", gap: 10, flexShrink: 0 }}
                >
                  {!m.installed && !active && (
                    <span className="knowledge-suggestion-size mono">
                      {formatBytes(m.sizeBytes)}
                    </span>
                  )}
                  {m.installed ? (
                    m.isSelected ? (
                      <span className="fit-badge fits">✓ Ready</span>
                    ) : (
                      // Switching models keeps the download: the engine is
                      // rebuilt against the other bundle on the next read.
                      <button
                        type="button"
                        className="ghost"
                        style={{ padding: "2px 10px" }}
                        disabled={busy}
                        onClick={() => void handleInstall(m.id)}
                      >
                        Use this model
                      </button>
                    )
                  ) : active ? (
                    <button
                      type="button"
                      className="ghost"
                      style={{ padding: "2px 10px" }}
                      onClick={() => void cancelModelDownload(m.id)}
                    >
                      Cancel {pct !== null ? `${pct}%` : ""}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="ghost"
                      style={{ padding: "2px 10px" }}
                      disabled={busy}
                      onClick={() => void handleInstall(m.id)}
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
    </div>
  );
}
