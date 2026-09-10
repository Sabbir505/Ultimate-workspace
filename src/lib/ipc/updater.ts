// Extracted domain of lib/ipc.ts (see its header). Command names and
// payload shapes are binding (CONTRACT.md).
import { safeInvoke, safeListen } from "../ipcCore";

// ---- Auto-updater (Tauri updater plugin) ----

/** Info about an available update, or update_available:false when current. */
export interface UpdateInfo {
  updateAvailable: boolean;
  version: string | null;
  notes: string | null;
  pubDate: string | null;
}

export interface UpdateProgressPayload {
  downloaded: number;
  total: number | null;
}

/** Check the configured endpoint for a newer version. Non-throwing on network
 *  failure — the backend returns update_available:false instead. */
export const checkForUpdate = (): Promise<UpdateInfo | null> =>
  safeInvoke<UpdateInfo | null>("check_for_update");

/** Download + verify + install the pending update. Emits `updater:progress`
 *  during download, then `updater:installed`. The backend restarts the app
 *  automatically after a successful install. */
export const downloadAndInstallUpdate = (): Promise<void> =>
  safeInvoke<void>("download_and_install_update");

export const listenUpdaterProgress = (handler: (payload: UpdateProgressPayload) => void) =>
  safeListen<UpdateProgressPayload>("updater:progress", handler);

export const listenUpdaterInstalled = (handler: () => void) =>
  safeListen("updater:installed", () => handler());

// --- Connectors (OAuth + remote MCP) ---

export interface ConnectorStatus {
  connected: boolean;
  /** True when the stored access token has expired (the backend transparently
   *  refreshes on next use; if no refresh token exists — Notion — the user
   *  must reconnect). */
  expired: boolean;
  accountDisplay?: string | null;
  grantedScopes?: string | null;
  expiresAt?: number | null;
}

/** A supported connector + its current connection status. Mirrors the Rust
 *  `ConnectorWithStatus` (the Connector fields are flattened in). */
export interface ConnectorWithStatus {
  id: string;
  displayName: string;
  icon: string;
  /** Product family the Settings UI groups this connector under (e.g. "google"). */
  family: string;
  mcpServerUrl: string;
  revokeUrl?: string | null;
  status: ConnectorStatus;
}

export interface DisconnectOutcome {
  revoked: boolean;
  note?: string | null;
}

export interface OAuthCallbackPayload {
  flowId: number;
  connectorId: string;
  /** "connected" | "denied" | "error" */
  status: string;
  error?: string | null;
  accountDisplay?: string | null;
}

export const listConnectors = () =>
  safeInvoke<ConnectorWithStatus[] | null>("list_connectors");
export const connectorConnect = (connectorId: string) =>
  safeInvoke<number>("connector_connect", { connectorId });
/** One OAuth flow for a whole connector family ("google") — connects every member. */
export const connectorConnectFamily = (family: string) =>
  safeInvoke<number>("connector_connect_family", { family });
export const connectorDisconnect = (connectorId: string) =>
  safeInvoke<DisconnectOutcome>("connector_disconnect", { connectorId });
export const setSessionConnectors = (chatSessionId: string, connectorIds: string[]) =>
  safeInvoke<void>("set_session_connectors", { chatSessionId, connectorIds });
/** Attach-on-demand: append/remove ONE attachment (@-picker click / chip ×). */
export const addSessionConnector = (chatSessionId: string, connectorId: string) =>
  safeInvoke<void>("add_session_connector", { chatSessionId, connectorId });
export const removeSessionConnector = (chatSessionId: string, connectorId: string) =>
  safeInvoke<void>("remove_session_connector", { chatSessionId, connectorId });
export const listSessionConnectors = (chatSessionId: string) =>
  safeInvoke<string[]>("list_session_connectors", { chatSessionId });
export const listenOAuthCallback = (handler: (payload: OAuthCallbackPayload) => void) =>
  safeListen<OAuthCallbackPayload>("oauth:callback", handler);
