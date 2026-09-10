// Extracted domain of lib/ipc.ts (see its header). Command names and
// payload shapes are binding (CONTRACT.md).
import { safeInvoke, safeListen } from "../ipcCore";

// ---- Workspaces (pane layout save/restore) ----

export interface WorkspaceRecord {
  id: string;
  projectId: string;
  name: string;
  data: string; // JSON string
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceData {
  panes: Array<{
    kind: "terminal" | "browser";
    harness?: string;
    sessionId?: string;
    label?: string;
    url?: string;
    cwd?: string;
  }>;
  splitFractions?: { colFrac?: number; rowFracs?: number[] };
}

export const listWorkspaces = (projectId: string) =>
  safeInvoke<WorkspaceRecord[] | null>("list_workspaces", { projectId });

export const saveWorkspace = (projectId: string, name: string, data: string) =>
  safeInvoke<WorkspaceRecord | null>("save_workspace", { projectId, name, data });

export const deleteWorkspace = (id: string) =>
  safeInvoke<void>("delete_workspace", { id });

// ---- Mobile relay (desktop ↔ mobile companion app) ----

export interface MobileRelayStatus {
  running: boolean;
  port: number;
}

export const startMobileRelay = () =>
  safeInvoke<number | null>("start_mobile_relay");

export const stopMobileRelay = () =>
  safeInvoke<void>("stop_mobile_relay");

export const getMobileRelayStatus = () =>
  safeInvoke<MobileRelayStatus | null>("get_mobile_relay_status");

// ---- Mobile pairing + Tailscale remote access ----

export interface TailscaleStatus {
  installed: boolean;
  loggedIn: boolean;
  dnsName: string | null;
  /** The machine's Tailscale IP (CGNAT range). Used for direct tailnet
   *  WebSocket connections without needing HTTPS serve enabled on the tailnet. */
  tailscaleIp: string | null;
  backendState: string;
}

export interface MobilePairingInfo {
  running: boolean;
  port: number;
  token: string | null;
  /** ws://127.0.0.1:<port> — for USB-bridge / same-machine connections. */
  localUrl: string | null;
  tailscale: TailscaleStatus;
  /** wss://<machine>.<tailnet>.ts.net — requires HTTPS serve enabled on tailnet. */
  tailscaleUrl: string | null;
  /** ws://<tailscale-ip>:<port> — direct tailnet connection, no HTTPS serve needed. */
  tailnetUrl: string | null;
}

export const getMobilePairingInfo = () =>
  safeInvoke<MobilePairingInfo | null>("get_mobile_pairing_info");

export const tailscaleServeEnable = () =>
  safeInvoke<string | null>("tailscale_serve_enable");

export const tailscaleServeDisable = () =>
  safeInvoke<void>("tailscale_serve_disable");

/** Trigger `tailscale up` in the background (opens browser for login). */
export const tailscaleLogin = () =>
  safeInvoke<void>("tailscale_login");
