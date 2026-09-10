// Extracted panel of SettingsView (see its header for context).
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  deleteDownloadedModel,
  detectGpuPower,
  exportProjectZip,
  getChatDbPath,
  getDataPaths,
  getSetting,
  importChatZip,
  listChatModels,
  listConnectors,
  connectorConnect,
  connectorConnectFamily,
  connectorDisconnect,
  listenOAuthCallback,
  setChatDbDir,
  setChatDefaultModel,
  setSetting,
  toastError,
  toastSuccess,
  type ChatProvider,
  type ConnectorWithStatus,
  type DataPaths,
  type GgufModel,
  type OAuthCallbackPayload,
  type SelectedModelEntry,
} from "../../lib/ipc";
import { runLoginFlow } from "../../lib/sessionLauncher";
import { ConnectorIcon, FamilyIcon, FAMILY_NAMES } from "./ConnectorIcon";
import type { HarnessId } from "../../types";
import { useProjectsStore } from "../../state/projects";
import { useSettingsStore } from "../../state/settings";
import { useUiStore } from "../../state/ui";
import { GlassSelect } from "../common/GlassSelect";
import { Modal } from "../common/Modal";
import { ToggleSwitch } from "./ToggleSwitch";
import {
  Database,
  Eye,
  EyeOff,
  KeyRound,
  Shield,
  ShieldOff,
  ChevronRight,
  Plug,
  Plus,
  Pencil,
  Trash2,
} from "lucide-react";

export function ConnectorsPanel() {
  const [connectors, setConnectors] = useState<ConnectorWithStatus[] | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ id: string; text: string } | null>(null);
  const [modalFamily, setModalFamily] = useState<string | null>(null);

  const refresh = () => {
    void listConnectors().then((cs) => setConnectors(cs ?? []));
  };
  useEffect(refresh, []);

  // Refresh on every OAuth callback (connect/deny/error) so the status flips
  // as soon as the webview flow resolves. Surface the error/denial reason via
  // the existing note slot — otherwise a failed flow just silently clears the
  // spinner with no feedback.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listenOAuthCallback((payload) => {
      setConnecting(null);
      if (payload.status === "error" || payload.status === "denied") {
        const reason = payload.error ?? (payload.status === "denied" ? "Authorization denied." : "Authorization failed.");
        setNote({ id: payload.connectorId, text: reason });
      } else if (payload.status === "connected") {
        setNote(null);
      }
      refresh();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const handleConnect = (id: string) => {
    setNote(null);
    setConnecting(id);
    void connectorConnect(id).catch((e) => {
      setConnecting(null);
      setNote({ id, text: String(e) });
    });
  };

  const handleDisconnect = async (id: string) => {
    setNote(null);
    setBusy(id);
    try {
      const out = await connectorDisconnect(id);
      if (out?.note) setNote({ id, text: out.note });
      refresh();
    } catch (e) {
      setNote({ id, text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  // One OAuth flow (one consent screen) connects every member of the family.
  const handleConnectFamily = (family: string) => {
    setNote(null);
    setConnecting(family);
    void connectorConnectFamily(family).catch((e) => {
      setConnecting(null);
      setNote({ id: family, text: String(e) });
    });
  };

  // Group connectors under their product family — one card per vendor. The
  // Google Workspace set shares a single OAuth client/consent, so it collapses
  // into one "Google" card (big logo, member chips, one Connect-all flow).
  const families = useMemo(() => {
    const out: { family: string; name: string; members: ConnectorWithStatus[] }[] = [];
    const byFamily = new Map<string, ConnectorWithStatus[]>();
    for (const c of connectors ?? []) {
      const list = byFamily.get(c.family) ?? [];
      list.push(c);
      byFamily.set(c.family, list);
    }
    for (const [family, members] of byFamily) {
      out.push({ family, name: FAMILY_NAMES[family] ?? members[0].displayName, members });
    }
    return out;
  }, [connectors]);

  const openFam = modalFamily ? (families.find((f) => f.family === modalFamily) ?? null) : null;
  const totalConnectors = connectors?.length ?? 0;
  const connectedTotal = (connectors ?? []).filter(
    (c) => c.status.connected && !c.status.expired,
  ).length;

  return (
    <>
      <div className="panel-head">
        <h3>Connectors</h3>
        {totalConnectors > 0 && (
          <span className="panel-count">
            {connectedTotal}/{totalConnectors} connected
          </span>
        )}
      </div>

      <div className="conn-info-card">
        <Shield className="conn-info-icon" size={18} />
        <div>
          <div className="conn-info-title">Connect third-party accounts</div>
          <div className="conn-info-body">
            After connecting, the model can use tools like search, read, create, and send on your
            behalf. Read actions run automatically; write/create/delete/send follow the conversation&apos;s
            approval mode.
          </div>
        </div>
      </div>

      <div className="conn-grid">
        {families.map((f) => {
          const connectedCount = f.members.filter(
            (c) => c.status.connected && !c.status.expired,
          ).length;
          const allConnected = connectedCount === f.members.length;
          const single = f.members.length === 1;
          const isConnecting = connecting === f.family || (single && connecting === f.members[0].id);
          const connect = () =>
            single ? handleConnect(f.members[0].id) : handleConnectFamily(f.family);
          const openModal = () => setModalFamily(f.family);
          const familyLabel = allConnected
            ? `All ${f.members.length} connected`
            : connectedCount > 0
              ? `${connectedCount} of ${f.members.length} connected`
              : "Not connected";
          return (
            <div className={`conn-family-card${allConnected ? " done" : ""}`} key={f.family}>
              <button
                type="button"
                className="conn-family-head"
                onClick={openModal}
                title={single ? undefined : "View every product"}
              >
                <span className="conn-family-icon">
                  <FamilyIcon family={f.family} size={30} />
                </span>
                <span className="conn-family-meta">
                  <strong className="conn-family-title">{f.name}</strong>
                  <span
                    className={`conn-family-count${connectedCount > 0 ? (allConnected ? " on" : " partial") : ""}`}
                  >
                    {familyLabel}
                  </span>
                </span>
                {!single && (
                  <ChevronRight className="conn-family-chevron" size={15} aria-hidden />
                )}
              </button>

              {f.members.length > 1 && (
                <div className="conn-member-chips">
                  {f.members.slice(0, 6).map((c) => {
                    const on = c.status.connected && !c.status.expired;
                    return (
                      <span
                        className={`conn-member-chip${on ? "" : " off"}`}
                        key={c.id}
                        title={`${c.displayName}${on ? "" : " — not connected"}`}
                      >
                        {ConnectorIcon({ id: c.id, size: 13 }) ?? (
                          <span className="conn-fallback-icon">{c.icon}</span>
                        )}
                      </span>
                    );
                  })}
                  {f.members.length > 6 && (
                    <span className="conn-more">+{f.members.length - 6}</span>
                  )}
                </div>
              )}

              <div className="conn-family-foot">
                {allConnected ? (
                  <span className="conn-all-done">✓ Connected</span>
                ) : (
                  <button
                    type="button"
                    className="primary conn-connect-btn"
                    disabled={isConnecting}
                    onClick={connect}
                  >
                    {isConnecting ? "Authorizing…" : single ? "Connect" : "Connect all"}
                  </button>
                )}
              </div>

              {note?.id === f.family && <div className="conn-note">{note.text}</div>}
            </div>
          );
        })}
        {totalConnectors === 0 && (
          <div className="empty-reserved conn-empty">
            <ShieldOff className="empty-icon" size={22} />
            <div className="empty-text">
              No connectors available yet.
            </div>
          </div>
        )}
      </div>
      {openFam && (
        <Modal
          title={openFam.name}
          onClose={() => setModalFamily(null)}
          actions={<button className="ghost" onClick={() => setModalFamily(null)}>Close</button>}
        >
          <p className="estimate-note">
            {openFam.members.length > 1
              ? "One OAuth consent covers every product below — use the card's Connect all, or manage each connection here."
              : "Manage this connection."}
          </p>
          <div className="conn-modal-list">
            {openFam.members.map((c) => {
              const st = c.status;
              const statusLabel = st.connected && st.expired ? "Token expired" : "Not connected";
              const isConnecting = connecting === c.id;
              const isBusy = busy === c.id;
              const canConnect = openFam.members.length === 1;
              return (
                <div className="conn-sub-row" key={c.id}>
                  <div className="conn-sub-icon">
                    {ConnectorIcon({ id: c.id, size: 20 }) ?? (
                      <span className="conn-fallback-icon">{c.icon}</span>
                    )}
                  </div>
                  <div className="conn-card-info">
                    <div className="conn-card-title-row">
                      <strong className="conn-card-title">{c.displayName}</strong>
                      {(!st.connected || st.expired) && (
                        <span
                          className={`conn-status${st.expired ? " expired" : ""}${st.connected ? " ok" : ""}`}
                        >
                          {statusLabel}
                        </span>
                      )}
                    </div>
                    {note?.id === c.id && <div className="conn-note">{note.text}</div>}
                  </div>
                  <div className="conn-sub-action">
                    {st.connected ? (
                      <button
                        className="ghost"
                        disabled={isBusy}
                        onClick={() => void handleDisconnect(c.id)}
                      >
                        {isBusy ? "Disconnecting…" : "Disconnect"}
                      </button>
                    ) : canConnect ? (
                      <button
                        className="primary"
                        disabled={isConnecting}
                        onClick={() => handleConnect(c.id)}
                      >
                        {isConnecting ? "Authorizing…" : "Connect"}
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
            {note?.id === modalFamily && (
              <div className="conn-note">{note.text}</div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

/** Numeric input bound to an app_settings key; loads on mount, saves on blur. */
// ---- Data (chat DB + artifacts storage + delete) ----
