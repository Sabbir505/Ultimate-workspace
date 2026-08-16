// Settings → Remote: mobile relay pairing + Tailscale cross-network access.
//
// The desktop relay binds 127.0.0.1 (security-first). Two paths reach it:
//   1. USB bridge (adb reverse) → ws://localhost:<port> — same machine only
//   2. Tailscale serve → wss://<machine>.<tailnet>.ts.net — cross-network
//
// The panel auto-starts the relay on mount. If Tailscale is installed and
// already logged in, it auto-enables serve so the QR is immediately scannable
// from any network. If Tailscale is installed but not logged in, a "Log in"
// button spawns `tailscale up` (opens browser) and the panel polls until
// login completes, then auto-enables serve.

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  getMobilePairingInfo,
  tailscaleServeEnable,
  tailscaleServeDisable,
  tailscaleLogin,
  startMobileRelay,
  stopMobileRelay,
  type MobilePairingInfo,
} from "../../lib/ipc";
import { toastError, toastSuccess } from "../../lib/ipc";

export function RemotePanel() {
  const [info, setInfo] = useState<MobilePairingInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tsLoginInProgress, setTsLoginInProgress] = useState(false);
  const [localQr, setLocalQr] = useState<string>("");
  const [tsQr, setTsQr] = useState<string>("");
  const refreshTimer = useRef<number | null>(null);
  // Guard: only auto-start/auto-serve once per panel open (not on every refresh).
  const didAutoStart = useRef(false);

  const refresh = useCallback(async () => {
    const data = await getMobilePairingInfo();
    setInfo(data);
    setLoading(false);
    return data;
  }, []);

  useEffect(() => {
    void refresh();
    refreshTimer.current = window.setInterval(() => void refresh(), 5000);
    return () => {
      if (refreshTimer.current) window.clearInterval(refreshTimer.current);
    };
  }, [refresh]);

  // ── Auto-start relay + auto-serve on mount ──────────────────────────────
  useEffect(() => {
    if (didAutoStart.current || loading) return;
    didAutoStart.current = true;
    void ensurePairingReady();
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

  async function ensurePairingReady() {
    const data = await refresh();
    const ts = data?.tailscale;

    // 1. Start relay if not running.
    if (!data?.running) {
      setBusy(true);
      try {
        await startMobileRelay();
        await new Promise(r => setTimeout(r, 600));
      } catch (e) {
        toastError("Failed to start relay", e);
        return;
      } finally {
        setBusy(false);
      }
    }

    // Re-read state after relay started.
    const afterRelay = await refresh();
    const ts2 = afterRelay?.tailscale;

    // 2. If Tailscale installed + logged in, auto-enable serve.
    if (ts2?.installed && ts2?.loggedIn) {
      setBusy(true);
      try {
        await tailscaleServeEnable();
        toastSuccess("Remote access ready", "Phone can now scan the QR from any network");
      } catch (e) {
        toastError("Failed to enable Tailscale serve", e);
      } finally {
        setBusy(false);
        await refresh();
      }
    }
  }

  // ── QR generation ─────────────────────────────────────────────────────────
  // Priority: tailnet (direct WireGuard, no HTTPS serve needed) → tailscale
  // (HTTPS serve, requires tailnet admin) → local (USB bridge).
  const primaryUrl = info?.tailnetUrl ?? info?.tailscaleUrl ?? info?.localUrl ?? "";
  useEffect(() => {
    if (primaryUrl) {
      QRCode.toDataURL(primaryUrl, { width: 240, margin: 1 })
        .then(setLocalQr)
        .catch(() => setLocalQr(""));
    } else {
      setLocalQr("");
    }
    // Show a second QR for HTTPS serve when the primary is the direct tailnet URL.
    if (info?.tailscaleUrl && info?.tailnetUrl) {
      QRCode.toDataURL(info.tailscaleUrl, { width: 240, margin: 1 })
        .then(setTsQr)
        .catch(() => setTsQr(""));
    } else {
      setTsQr("");
    }
  }, [info?.tailnetUrl, info?.tailscaleUrl, info?.localUrl]);

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
      await tailscaleServeEnable();
      toastSuccess("Tailscale serve enabled");
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

  const handleLogin = async () => {
    setTsLoginInProgress(true);
    try {
      await tailscaleLogin();
      // The browser is now open. Poll until Tailscale reports "Running".
      toastSuccess("Browser opened", "Complete Tailscale login, then return here");
    } catch (e) {
      toastError("Failed to start Tailscale login", e);
      setTsLoginInProgress(false);
    }
  };

  // Once logged in (polled via refresh), auto-enable serve and stop the spinner.
  useEffect(() => {
    if (tsLoginInProgress && info?.tailscale?.loggedIn) {
      setTsLoginInProgress(false);
      void (async () => {
        setBusy(true);
        try {
          await tailscaleServeEnable();
          toastSuccess("Remote access ready", "Phone can now scan the QR from any network");
        } catch (e) {
          toastError("Failed to enable Tailscale serve", e);
        } finally {
          setBusy(false);
          await refresh();
        }
      })();
    }
  }, [tsLoginInProgress, info?.tailscale?.loggedIn]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const activeUrl = primaryUrl;
  // True when a cross-network path is active (tailnet direct or HTTPS serve).
  const isServing = !!(info?.tailnetUrl || info?.tailscaleUrl);
  // QR is shown whenever the relay is running.
  const showQr = info?.running && info.token && activeUrl;

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
      {showQr ? (
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
                {info?.tailnetUrl
                  ? "Tailnet URL (cross-network)"
                  : isServing
                    ? "HTTPS serve URL (cross-network)"
                    : "Local URL (USB bridge)"}
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
                <code className="mono-text">{info!.token}</code>
                <button className="ghost" style={{ padding: "2px 8px" }} onClick={() => void copyToClipboard(info!.token, "Token")}>
                  Copy
                </button>
              </div>
            </div>
            {isServing && tsQr && (
              <div className="field">
                <label className="field-label">
                  {info?.tailnetUrl ? "HTTPS serve QR (optional)" : "Local fallback QR (USB bridge)"}
                </label>
                <img src={tsQr} alt="Secondary pairing QR" width={160} height={160} />
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
              {tsLoginInProgress ? "Logging in…" : ts.loggedIn ? "Logged in" : "Not logged in"}
            </span>
          ) : (
            <span className="status-chip off">Not installed</span>
          )}
        </div>

        {!ts?.installed ? (
          <div>
            <p className="muted" style={{ marginBottom: 8 }}>
              Install <a href="https://tailscale.com/download" target="_blank" rel="noreferrer">Tailscale</a> on this machine and your phone,
              then log in to connect across different networks. The relay stays loopback-only; Tailscale fronts it with TLS.
            </p>
          </div>
        ) : !ts.loggedIn ? (
          <div>
            <p className="muted" style={{ marginBottom: 8 }}>
              Tailscale is installed but not logged in. Click <strong>Log in</strong> to open the browser,
              complete the login, then return here — serve enables automatically.
            </p>
            {ts.dnsName && (
              <p className="muted" style={{ fontSize: 12 }}>
                Machine: <code className="mono-text">{ts.dnsName}</code> · State: {ts.backendState}
              </p>
            )}
            <button
              className="ghost"
              style={{ marginTop: 10 }}
              disabled={busy || tsLoginInProgress}
              onClick={() => void handleLogin()}
            >
              {tsLoginInProgress ? "Opening browser…" : "Log in with Tailscale"}
            </button>
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
