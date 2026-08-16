// Settings → Remote: mobile relay pairing + Tailscale cross-network access.
//
// The desktop relay binds 127.0.0.1 (security-first). Two paths reach it:
//   1. USB bridge (adb reverse) → ws://localhost:<port> — same machine only
//   2. Tailscale serve → wss://<machine>.<tailnet>.ts.net — cross-network
//
// The panel shows a QR of the active URL (token in the fragment), the raw
// token for manual entry, and the Tailscale card (install/login guidance,
// enable/disable serve). When Tailscale serve is active the cross-network
// QR replaces the local one.

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  getMobilePairingInfo,
  tailscaleServeEnable,
  tailscaleServeDisable,
  startMobileRelay,
  stopMobileRelay,
  type MobilePairingInfo,
} from "../../lib/ipc";
import { toastError, toastSuccess } from "../../lib/ipc";

export function RemotePanel() {
  const [info, setInfo] = useState<MobilePairingInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [localQr, setLocalQr] = useState<string>("");
  const [tsQr, setTsQr] = useState<string>("");
  const refreshTimer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    const data = await getMobilePairingInfo();
    setInfo(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    // Poll every 5s so the token + tailscale state stay live in the UI
    // (token rotates on relay restart; tailscale state can change externally).
    refreshTimer.current = window.setInterval(() => void refresh(), 5000);
    return () => {
      if (refreshTimer.current) window.clearInterval(refreshTimer.current);
    };
  }, [refresh]);

  // Generate QRs whenever the active URL changes.
  useEffect(() => {
    const url = info?.tailscaleUrl ?? info?.localUrl ?? "";
    if (url) {
      QRCode.toDataURL(url, { width: 240, margin: 1 })
        .then(setLocalQr)
        .catch(() => setLocalQr(""));
    } else {
      setLocalQr("");
    }
    // When both URLs exist, render a second QR for the tailscale URL.
    if (info?.tailscaleUrl && info?.localUrl) {
      QRCode.toDataURL(info.tailscaleUrl, { width: 240, margin: 1 })
        .then(setTsQr)
        .catch(() => setTsQr(""));
    } else {
      setTsQr("");
    }
  }, [info?.tailscaleUrl, info?.localUrl]);

  const handleStartRelay = async () => {
    setBusy(true);
    try {
      await startMobileRelay();
      await refresh();
      toastSuccess("Relay started");
    } catch (e) {
      toastError("Failed to start relay", e);
    } finally {
      setBusy(false);
    }
  };

  const handleStopRelay = async () => {
    setBusy(true);
    try {
      await stopMobileRelay();
      await refresh();
      toastSuccess("Relay stopped");
    } catch (e) {
      toastError("Failed to stop relay", e);
    } finally {
      setBusy(false);
    }
  };

  const handleEnableServe = async () => {
    setBusy(true);
    try {
      const url = await tailscaleServeEnable();
      if (url) {
        toastSuccess("Tailscale serve enabled", url);
      }
      await refresh();
    } catch (e) {
      toastError("Tailscale serve failed", e);
    } finally {
      setBusy(false);
    }
  };

  const handleDisableServe = async () => {
    setBusy(true);
    try {
      await tailscaleServeDisable();
      toastSuccess("Tailscale serve disabled");
      await refresh();
    } catch (e) {
      toastError("Failed to disable Tailscale serve", e);
    } finally {
      setBusy(false);
    }
  };

  const copyToClipboard = async (text: string | null, label: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toastSuccess(`${label} copied`);
    } catch {
      toastError("Clipboard copy failed");
    }
  };

  if (loading) {
    return <div className="panel-section"><p className="muted">Loading relay status…</p></div>;
  }

  const ts = info?.tailscale;
  const activeUrl = info?.tailscaleUrl ?? info?.localUrl;
  const isServing = !!info?.tailscaleUrl;

  return (
    <div className="panel-section">
      <div className="panel-head">
        <h3>Remote access</h3>
        <span className="panel-count">
          {info?.running ? `Relay on :${info.port}` : "Relay off"}
        </span>
      </div>
      <p className="muted" style={{ marginBottom: 16 }}>
        Connect your phone to this desktop over the Tailnet (cross-network) or via a USB bridge
        (same machine). Scan the QR with the mobile app to pair automatically.
      </p>

      {/* Relay controls */}
      <div className="settings-row" style={{ gap: 8, marginBottom: 20 }}>
        {info?.running ? (
          <button className="ghost" disabled={busy} onClick={() => void handleStopRelay()}>
            Stop relay
          </button>
        ) : (
          <button className="ghost" disabled={busy} onClick={() => void handleStartRelay()}>
            Start relay
          </button>
        )}
      </div>

      {/* Pairing QR + token */}
      {info?.running && info.token && activeUrl ? (
        <div className="remote-pairing-card" style={{ marginBottom: 20 }}>
          <div className="qr-section">
            {localQr ? (
              <img src={localQr} alt="Pairing QR code" width={200} height={200} />
            ) : (
              <div className="qr-placeholder" style={{ width: 200, height: 200 }} />
            )}
          </div>
          <div className="pairing-details">
            <div className="field" style={{ marginBottom: 12 }}>
              <label className="field-label">
                {isServing ? "Cross-network URL (Tailscale)" : "Local URL (USB bridge)"}
              </label>
              <div className="value-row">
                <code className="mono-text">{activeUrl}</code>
                <button className="ghost" style={{ padding: "2px 8px" }} onClick={() => void copyToClipboard(activeUrl, "URL")}>
                  Copy
                </button>
              </div>
            </div>
            <div className="field" style={{ marginBottom: 12 }}>
              <label className="field-label">Pairing token</label>
              <div className="value-row">
                <code className="mono-text">{info.token}</code>
                <button className="ghost" style={{ padding: "2px 8px" }} onClick={() => void copyToClipboard(info.token, "Token")}>
                  Copy
                </button>
              </div>
            </div>
            {isServing && tsQr && (
              <div className="field">
                <label className="field-label">Local fallback QR (USB bridge)</label>
                <img src={tsQr} alt="Local pairing QR" width={160} height={160} />
              </div>
            )}
          </div>
        </div>
      ) : info?.running ? (
        <p className="muted" style={{ marginBottom: 20 }}>
          Relay is running but no pairing token is available. Restart the relay.
        </p>
      ) : (
        <p className="muted" style={{ marginBottom: 20 }}>
          Start the relay to generate a pairing QR code.
        </p>
      )}

      {/* Tailscale card */}
      <div className="settings-card" style={{ padding: 16, borderRadius: 8 }}>
        <div className="panel-head" style={{ marginBottom: 12 }}>
          <h4>Tailscale (cross-network)</h4>
          {ts?.installed ? (
            <span className={`status-chip ${ts.loggedIn ? "ok" : "warn"}`}>
              {ts.loggedIn ? "Logged in" : "Not logged in"}
            </span>
          ) : (
            <span className="status-chip off">Not installed</span>
          )}
        </div>

        {!ts?.installed ? (
          <div>
            <p className="muted" style={{ marginBottom: 8 }}>
              Install <a href="https://tailscale.com/download" target="_blank" rel="noreferrer">Tailscale</a> and log in on both this machine and your phone
              to connect across different networks. The relay stays loopback-only; Tailscale fronts it with TLS.
            </p>
          </div>
        ) : !ts.loggedIn ? (
          <div>
            <p className="muted" style={{ marginBottom: 8 }}>
              Tailscale is installed but not running. Run <code className="mono-text">tailscale up</code> in a terminal
              to log in, then return here to enable remote access.
            </p>
            {ts.dnsName && (
              <p className="muted" style={{ fontSize: 12 }}>
                Machine: <code className="mono-text">{ts.dnsName}</code> · State: {ts.backendState}
              </p>
            )}
          </div>
        ) : (
          <div>
            <p className="muted" style={{ marginBottom: 8 }}>
              Machine: <code className="mono-text">{ts.dnsName}</code>
            </p>
            {isServing ? (
              <div>
                <p className="muted" style={{ marginBottom: 8 }}>
                  <strong>Serve is active.</strong> Your phone can connect from any network over the tailnet.
                </p>
                <button className="ghost" disabled={busy} onClick={() => void handleDisableServe()}>
                  Disable serve
                </button>
              </div>
            ) : (
              <div>
                <p className="muted" style={{ marginBottom: 8 }}>
                  Enable <code className="mono-text">tailscale serve</code> to expose the relay at a stable HTTPS
                  URL on your tailnet. TLS is terminated by tailscaled.
                </p>
                <button className="ghost" disabled={busy || !info?.running} onClick={() => void handleEnableServe()}>
                  {info?.running ? "Enable serve" : "Start relay first"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Usage notes */}
      <details style={{ marginTop: 16 }}>
        <summary style={{ cursor: "pointer", color: "var(--text-muted)" }}>Connection methods</summary>
        <div style={{ marginTop: 8, color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6 }}>
          <p><strong>Cross-network (Tailscale):</strong> Install Tailscale on both devices, log in to the same tailnet,
          enable serve above, then scan the QR on your phone. Works from any network — no port forwarding needed.</p>
          <p><strong>Same machine (USB bridge):</strong> Run <code className="mono-text">adb reverse tcp:{info?.port ?? "<port>"} tcp:{info?.port ?? "<port>"}</code> then
          use the local URL with <code className="mono-text">ws://localhost:{info?.port ?? "<port>"}/#token</code>.</p>
          <p>The relay never binds 0.0.0.0 — all remote traffic flows through Tailscale's encrypted tunnel.</p>
        </div>
      </details>
    </div>
  );
}
