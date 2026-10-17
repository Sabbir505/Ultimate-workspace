// Bottom bar (mirrored title bar): a full-window-width glass strip at the
// bottom edge, twin of the toolbar/caption at the top. It hosts the workspace
// view entries that used to be stacked into the sidebar's footer (Cost /
// phone pairing / Logs / Settings) plus Vault / Wiki / Bots, moved here
// icon-only from the sidebar's upper block — reachable even while the
// sidebar is collapsed.
//
// Empty space drags the window: the bar carries data-tauri-drag-region and
// installTitleBarDrag (lib/titleBarDrag) extends that to presses landing on
// child elements, while buttons keep their clicks.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BookOpen,
  Bot as BotIcon,
  DollarSign,
  QrCode,
  ScrollText,
  Settings,
  X,
} from "lucide-react";

import { VaultIcon } from "../../lib/icons";
import { getMobilePairingInfo, type MobilePairingInfo } from "../../lib/ipc";
import { preloadView } from "../../lib/viewPreload";
import { useOcclusion } from "../../hooks/useOcclusion";
import { useUiStore } from "../../state/ui";
import { useWikiStore } from "../../state/wiki";

export function BottomBar() {
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);
  // Wiki build pulse — moved down with the Wiki entry from the sidebar. A
  // single selector (see the hook-count warning in Sidebar history) keeps the
  // subscription stable and flips while a build runs from ANY view.
  const wikiBuilding = useWikiStore(
    (s) => s.progress?.state === "running" || s.status?.jobRunning === true,
  );

  // ── Pairing QR modal (moved with the footer's Pair button) ──────────────
  const [pairingModalOpen, setPairingModalOpen] = useState(false);
  const [pairingInfo, setPairingInfo] = useState<MobilePairingInfo | null>(null);
  const [pairingQr, setPairingQr] = useState<string>("");
  const [pairingLoading, setPairingLoading] = useState(false);
  const pairingTimer = useRef<number | null>(null);

  const loadPairingInfo = useCallback(async () => {
    try {
      const info = await getMobilePairingInfo();
      setPairingInfo(info);
      // Prefer: tailnet direct (no HTTPS serve needed) → HTTPS serve → local USB bridge.
      const url = info?.tailnetUrl ?? info?.tailscaleUrl ?? info?.localUrl ?? "";
      if (url) {
        const { default: QRCode } = await import("qrcode");
        const dataUrl = await QRCode.toDataURL(url, { width: 240, margin: 1 });
        setPairingQr(dataUrl);
      } else {
        setPairingQr("");
      }
    } catch {
      setPairingInfo(null);
      setPairingQr("");
    } finally {
      setPairingLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!pairingModalOpen) return;
    setPairingLoading(true);
    void loadPairingInfo();
    // Poll while modal is open so QR stays fresh if serve state changes.
    pairingTimer.current = window.setInterval(() => void loadPairingInfo(), 3000);
    return () => {
      if (pairingTimer.current) window.clearInterval(pairingTimer.current);
    };
  }, [pairingModalOpen, loadPairingInfo]);

  const closePairingModal = useCallback(() => {
    if (pairingTimer.current) window.clearInterval(pairingTimer.current);
    setPairingModalOpen(false);
  }, []);

  const openPairingModal = useCallback(() => {
    setPairingModalOpen(true);
  }, []);

  // The pairing QR popover isn't a Modal, so it must register itself with the
  // webview-occlusion system (M22) — a native browser webview would otherwise
  // paint on top of it.
  useOcclusion("bottombar:pairing-qr", pairingModalOpen);

  return (
    <div className="bottom-bar" data-tauri-drag-region="">
      <div className="bottom-bar-nav" role="navigation" aria-label="Workspace views">
        {/* Vault / Wiki / Bots — moved here from the sidebar's upper block.
            Icon-only at title-bar scale, like every other entry in the bar. */}
        <button
          type="button"
          className={`bottom-bar-btn${activeView === "vault" ? " is-active" : ""}`}
          onClick={() => setActiveView(activeView === "vault" ? "chat" : "vault")}
          onPointerEnter={() => preloadView("vault")}
          onFocus={() => preloadView("vault")}
          title="Open vault"
          aria-label="Open vault"
        >
          <VaultIcon size={15} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className={`bottom-bar-btn${activeView === "wiki" ? " is-active" : ""}`}
          onClick={() => setActiveView(activeView === "wiki" ? "chat" : "wiki")}
          onPointerEnter={() => preloadView("wiki")}
          onFocus={() => preloadView("wiki")}
          title={wikiBuilding ? "A wiki build is running" : "Open project wiki"}
          aria-label={
            wikiBuilding ? "A wiki build is running — open project wiki" : "Open project wiki"
          }
        >
          <BookOpen size={15} strokeWidth={1.8} />
          {wikiBuilding && <span className="sidebar-wiki-running" aria-hidden="true" />}
        </button>
        <button
          type="button"
          className={`bottom-bar-btn${activeView === "bots" ? " is-active" : ""}`}
          onClick={() => setActiveView(activeView === "bots" ? "chat" : "bots")}
          onPointerEnter={() => preloadView("bots")}
          onFocus={() => preloadView("bots")}
          title="Open bots"
          aria-label="Open bots"
        >
          <BotIcon size={15} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className={`bottom-bar-btn${activeView === "cost" ? " is-active" : ""}`}
          onClick={() => setActiveView(activeView === "cost" ? "chat" : "cost")}
          onPointerEnter={() => preloadView("cost")}
          onFocus={() => preloadView("cost")}
          title="Cost"
          aria-label="Cost"
        >
          <DollarSign size={15} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className={`bottom-bar-btn${activeView === "logs" ? " is-active" : ""}`}
          onClick={() => setActiveView(activeView === "logs" ? "chat" : "logs")}
          onPointerEnter={() => preloadView("logs")}
          onFocus={() => preloadView("logs")}
          title="Model request log"
          aria-label="Model request log"
        >
          <ScrollText size={15} strokeWidth={1.8} />
        </button>
        {/* Device/system utilities cluster at the right edge, next to Settings —
            the pairing QR is a modal action, not a workspace view, so it must
            not sit between the analytics views (Cost / Logs). */}
        <button
          type="button"
          className={`bottom-bar-btn${pairingModalOpen ? " is-active" : ""}`}
          onClick={openPairingModal}
          title="Phone pairing QR"
          aria-label="Phone pairing QR"
        >
          <QrCode size={15} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className={`bottom-bar-btn${activeView === "settings" ? " is-active" : ""}`}
          onClick={() => setActiveView(activeView === "settings" ? "chat" : "settings")}
          onPointerEnter={() => preloadView("settings")}
          onFocus={() => preloadView("settings")}
          title="Settings"
          aria-label="Settings"
        >
          <Settings size={15} strokeWidth={1.8} />
        </button>
      </div>

      {/* Pairing QR modal — rendered via portal to document.body so it
          overlays the entire app (the bar's backdrop-blur creates its own
          containing block, which would trap a position:fixed overlay). */}
      {pairingModalOpen &&
        createPortal(
          <div className="pairing-modal" onClick={closePairingModal}>
            <div className="pairing-modal-card" onClick={(e) => e.stopPropagation()}>
              <div className="pairing-modal-head">
                <span className="pairing-modal-title">Phone pairing</span>
                <button className="pairing-modal-close" onClick={closePairingModal} aria-label="Close">
                  <X size={16} />
                </button>
              </div>
              {pairingLoading ? (
                <p className="muted" style={{ fontSize: 12 }}>Loading…</p>
              ) : pairingInfo?.running && pairingQr ? (
                <>
                  <div className="pairing-modal-qr">
                    <img src={pairingQr} alt="Pairing QR" width={240} height={240} />
                  </div>
<p className="pairing-modal-hint">
                  Scan with the mobile app to pair. Works over Tailscale
                  {pairingInfo.tailnetUrl || pairingInfo.tailscaleUrl ? " (cross-network)" : " (local)"}.
                  Token rotates each time the relay restarts.
                </p>
                <div className="field">
                  <label className="field-label" style={{ fontSize: 11 }}>URL</label>
                  <code className="pairing-modal-url" style={{ color: "var(--text-dim)" }}>
                    {pairingInfo.tailnetUrl ?? pairingInfo.tailscaleUrl ?? pairingInfo.localUrl}
                  </code>
                </div>
                </>
              ) : (
                <p className="muted" style={{ fontSize: 12 }}>
                  Relay is not running. Open Settings → Remote to start it.
                </p>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
