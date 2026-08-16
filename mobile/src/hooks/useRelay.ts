import { useState, useEffect, useCallback } from 'react';
import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { computePairProof, deriveSessionKey, decryptFrame, encryptFrame } from '../lib/relayCrypto';

/** The desktop relay binds loopback ONLY (127.0.0.1) on a persisted-but-random
 *  port, so there is no universal default URL: physical devices connect via a
 *  USB bridge (`adb reverse tcp:<port> tcp:<port>` → ws://localhost:<port>) or
 *  over the tailnet (Tailscale serve → wss://<machine>.<tailnet>.ts.net).
 *
 *  The pairing token rides in the URL fragment: `ws://host:port/#<token>` or
 *  `wss://host/#<token>`. On connect the phone sends an HMAC proof of the
 *  token (never the raw token) as the first WS frame; both sides then derive
 *  an XChaCha20-Poly1305 session key from the token and every further frame
 *  is encrypted Binary (§3.2.11). A desktop that rejects the proof-only Pair
 *  frame (pre-E2E build) gets a legacy raw-token reconnect, which runs the
 *  connection in plaintext. URLs without a fragment fall back to the old
 *  unauthenticated path (legacy / dev). */
const RELAY_URL_STORAGE_KEY = 'conduit.relayUrl';
const RELAY_TOKEN_STORAGE_KEY = 'conduit.relayToken';

export interface ProviderInfo {
  id: string; display_name: string; models: string[];
  is_local: boolean; is_running: boolean; gguf_path?: string;
}
export interface ChatUsage { input_tokens: number; output_tokens: number; cost_usd: number; }
export interface ChatMessage { role: string; content: string; }
export interface SessionInfo {
  id: string; project_id: string; project_name: string; title: string;
  harness: string; status: string; last_active_at: number; is_live?: boolean;
}
function toSession(s: SessionInfo): Session {
  return { id: s.id, projectId: s.project_id, projectName: s.project_name, title: s.title,
    status: s.is_live ? ((s.status as Session['status']) || 'working') : 'idle' as Session['status'],
    provider: s.harness, model: '', lastActivity: s.last_active_at * 1000, isLive: s.is_live ?? false };
}
type DesktopMessage =
  | { type: 'AvailableProviders'; providers: ProviderInfo[] }
  | { type: 'SessionList'; sessions: SessionInfo[] }
  | { type: 'ChatToken'; chat_session_id: string; token: string }
  | { type: 'ChatDone'; chat_session_id: string; usage?: ChatUsage }
  | { type: 'ChatError'; chat_session_id: string; error: string }
  | { type: 'DesktopStatus'; connected: boolean }
  | { type: 'Transcript'; session_id: string; text: string; cols: number; rows: number; unchanged?: boolean }
  | { type: 'SessionCreated'; session: SessionInfo }
  | { type: 'CostSummary'; today: number; week: number }
  | { type: 'CostDetails'; daily: DailyCostEntry[]; per_project: ProjectCostEntry[]; local_models: LocalModelUsageEntry[] }
  | { type: 'LocalModelReady'; model: string; base_url: string }
  | { type: 'LocalModelError'; model: string; error: string }
  // Session-scoped chat events (Task 2). All keyed by `session_id` (the
  // mobile app's session id, NOT an ephemeral chat_session_id) so the
  // phone-side store can route them to the right conversation without
  // knowing about the desktop's internal chat_session_id mapping.
  | { type: 'SessionMessages'; session_id: string; messages: SessionMessageRecord[]; has_more: boolean }
  | { type: 'SessionChatToken'; session_id: string; token: string }
  | { type: 'SessionChatDone'; session_id: string; usage?: { input_tokens: number; output_tokens: number; cost_usd?: number } }
  | { type: 'SessionChatError'; session_id: string; error: string }
  | { type: 'SessionChatStatus'; session_id: string; reason: string; message: string }
  | { type: 'SessionApprovalRequest'; session_id: string; pending_id: string; tool: string; summary: string; args: unknown }
  | { type: 'SessionArtifact'; session_id: string; message_id?: number; artifact: { path: string; filename: string; inline?: { kind: 'jsx' | 'tsx'; code: string } } }
  // Broadcast (not session-scoped): an automation run finished on the desktop.
  // Shown as a local alert — fires only while the relay is connected.
  | { type: 'AutomationRunFinished'; automation_id: string; name: string; status: string; summary: string };
interface MobileChatTurn {
  type: 'ChatTurn'; provider_id: string; model: string;
  messages: ChatMessage[]; system?: string; effort?: string; gguf_path?: string;
}
// Session-scoped chat senders (Task 2). These run on the SAME persistent WS
// as everything else, but they key off the mobile app's session id
// (`session_id`) so the desktop's SessionChatManager can route them through
// the existing ChatManager pipeline + owner-map streaming.
type SessionChatMessage =
  | { type: 'GetSessionMessages'; session_id: string; before_id?: number; limit: number }
  | { type: 'SendChatMessage'; session_id: string; text: string; attachments: SessionChatAttachment[] }
  | { type: 'CancelSessionStream'; session_id: string }
  | { type: 'ResolveSessionApproval'; session_id: string; pending_id: string; decision: 'approve' | 'deny' }
  | { type: 'RenameSession'; session_id: string; title: string };
type MobileMessagePlain =
  | { type: 'ListAvailableProviders' } | { type: 'ListSessions' }
  | MobileChatTurn | { type: 'CancelChatTurn'; chat_session_id: string }
  | { type: 'SendToSession'; session_id: string; text: string }
  | { type: 'GetTranscript'; session_id: string }
  | { type: 'CreateSession'; project_id: string; harness: string }
  | { type: 'SpawnSession'; session_id: string }
  | { type: 'GetCostSummary' }
  | { type: 'GetCostDetails' }
  | { type: 'StartLocalModel'; model: string; gguf_path: string }
  | SessionChatMessage;

export interface Session {
  id: string; projectId: string; projectName: string; title: string;
  status: 'working' | 'waiting' | 'diff_ready' | 'idle';
  provider: string; model: string; lastActivity: number; isLive: boolean;
}
export interface CostSummary { today: number; week: number; }

export interface DailyCostEntry { day: string; cost_usd: number; }
export interface ProjectCostEntry {
  project_id: string; project_name: string; total_cost_usd: number;
  total_input_tokens: number; total_output_tokens: number;
}
export interface LocalModelUsageEntry {
  model: string; input_tokens: number; output_tokens: number;
  message_count: number; last_used: string;
}
export interface CostDetails {
  daily: DailyCostEntry[];
  per_project: ProjectCostEntry[];
  local_models: LocalModelUsageEntry[];
}

type Listener<T> = (data: T) => void;
class EventBus<T> {
  private ls = new Set<Listener<T>>();
  on(fn: Listener<T>) { this.ls.add(fn); return () => { this.ls.delete(fn); }; }
  emit(data: T) { this.ls.forEach(fn => fn(data)); }
}
export const onChatToken = new EventBus<{ chatSessionId: string; token: string }>();
export const onChatDone = new EventBus<{ chatSessionId: string; usage?: ChatUsage }>();
export const onChatError = new EventBus<{ chatSessionId: string; error: string }>();
export const onProviderList = new EventBus<ProviderInfo[]>();
export const onConnected = new EventBus<boolean>();
export const onSessionList = new EventBus<Session[]>();
export const onTranscript  = new EventBus<{ sessionId: string; text: string; cols: number; rows: number }>();
export const onSessionCreated = new EventBus<Session>();
export const onCostDetails = new EventBus<CostDetails>();
export const onLocalModelReady = new EventBus<{ model: string; baseUrl: string }>();
export const onLocalModelError = new EventBus<{ model: string; error: string }>();

// Session-scoped chat event buses (Task 6). Keyed by the mobile session id.
export const onSessionMessages = new EventBus<{ sessionId: string; messages: SessionMessageRecord[]; hasMore: boolean }>();
export const onSessionChatToken = new EventBus<{ sessionId: string; token: string }>();
export const onSessionChatDone = new EventBus<{ sessionId: string; usage?: SessionChatUsage }>();
export const onSessionChatError = new EventBus<{ sessionId: string; error: string }>();
export const onSessionChatStatus = new EventBus<{ sessionId: string; reason: string; message: string }>();
export const onSessionApprovalRequest = new EventBus<{ sessionId: string; pendingId: string; tool: string; summary: string; args: unknown }>();
export const onSessionArtifact = new EventBus<{ sessionId: string; messageId?: number; artifact: SessionArtifact }>();

export interface SessionMessageRecord {
  id: number; role: string; content: string; created_at: number;
  input_tokens?: number; output_tokens?: number; cost_usd?: number;
  tool_calls?: unknown; artifact_paths?: string[];
}
export interface SessionChatUsage { input_tokens: number; output_tokens: number; cost_usd?: number; }
export interface SessionArtifact { path: string; filename: string; inline?: { kind: 'jsx' | 'tsx'; code: string }; }
export interface SessionChatAttachment {
  name: string; kind: 'text' | 'image' | 'doc';
  text?: string; data?: string; media_type?: string; format?: string;
}

let _ws: WebSocket | null = null;
let _url: string | null = null;
let _token: string | null = null;
// E2E session state (§3.2.11). `_e2eKey` is set the moment we decide to pair
// with a proof (before the Pair frame leaves) so every subsequent send is
// encrypted; the desktop enables its side when the proof verifies. Counters
// are per-direction and reset on every (re)connect.
let _e2eKey: Uint8Array | null = null;
let _outCounter = 0;
let _inCounter = 0;
// Flipped when an E2E pair attempt is rejected by a pre-E2E desktop; the
// reconnect then falls back to legacy raw-token pairing (plaintext). Cleared
// whenever a new URL is explicitly set (fresh QR scan → maybe new desktop).
let _desktopLegacy = false;
// Loaded once from AsyncStorage; connect() awaits this so a persisted URL
// wins over the loopback default on cold start.
const _storedUrlReady: Promise<string | null> = AsyncStorage.getItem(RELAY_URL_STORAGE_KEY)
  .then((stored) => { if (stored) { _url = stored; _token = extractToken(stored); } return stored; })
  .catch(() => null);
let _connecting = false;
let _reconnectTimer: any = null;
let _pollTimer: any = null;
// Providers change rarely (key added/removed, local model scanned), and each
// ListAvailableProviders triggers outbound /v1/models calls per provider on
// the desktop — so refresh on a slower 30s cadence, not the 5s session poll.
// Crucially this also covers the case where the WS stayed open across a
// desktop rebuild and `onopen` never re-fired: the provider list would
// otherwise never be (re)requested.
let _providerTimer: any = null;
const _cl = new Set<(v: boolean) => void>();
const _pl = new Set<(v: ProviderInfo[]) => void>();
const _sl = new Set<(v: Session[]) => void>();
const _csl = new Set<(v: CostSummary) => void>();
const _cdl = new Set<(v: CostDetails) => void>();

function nc(v: boolean) { onConnected.emit(v); _cl.forEach(fn => fn(v)); }
function np(v: ProviderInfo[]) { onProviderList.emit(v); _pl.forEach(fn => fn(v)); }
function ns(v: Session[]) { onSessionList.emit(v); _sl.forEach(fn => fn(v)); }
function ncs(v: CostSummary) { _csl.forEach(fn => fn(v)); }
function ncd(v: CostDetails) { onCostDetails.emit(v); _cdl.forEach(fn => fn(v)); }
function _send(msg: MobileMessagePlain) {
  if (_ws?.readyState !== WebSocket.OPEN) return;
  const json = JSON.stringify(msg);
  if (_e2eKey) {
    _ws.send(encryptFrame(_e2eKey, _outCounter++, new TextEncoder().encode(json)));
  } else {
    _ws.send(json);
  }
}

function startPolling() {
  stopPolling();
  _pollTimer = setInterval(() => {
    if (_ws?.readyState === WebSocket.OPEN) {
      _send({ type: 'ListSessions' });
      _send({ type: 'GetCostSummary' });
      // NOTE: GetCostDetails is deliberately NOT polled — it runs three SQL
      // aggregations under the desktop's DB mutex (~15-30 ms of lock every
      // tick, ~6 KB payload) and changes at most once per completed turn.
      // It's fetched on connect (ws.onopen) and on demand via
      // refreshCostDetails() when the Settings/cost view opens or the user
      // pulls to refresh.
    }
  }, 5000);
  _providerTimer = setInterval(() => {
    if (_ws?.readyState === WebSocket.OPEN) _send({ type: 'ListAvailableProviders' });
  }, 30000);
}
function stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  if (_providerTimer) { clearInterval(_providerTimer); _providerTimer = null; }
}

/** Extract the pairing token from a URL's fragment (`ws://host:port/#token`
 *  or `wss://host/#token`). Returns null when no fragment is present (legacy
 *  unauthenticated connect — the relay will reject this, but we fall through
 *  so the error surfaces as a connection close rather than a silent skip). */
function extractToken(url: string): string | null {
  const hashIdx = url.indexOf('#');
  if (hashIdx === -1) return null;
  const frag = url.slice(hashIdx + 1);
  // Strip any trailing path/query that snuck into the fragment.
  const endIdx = Math.min(frag.indexOf('?'), frag.indexOf('&')) === -1
    ? frag.length
    : Math.min(frag.indexOf('?'), frag.indexOf('&'));
  const token = frag.slice(0, endIdx === -1 ? frag.length : endIdx);
  return token || null;
}

function _doConnect(target: string) {
  if (_ws?.readyState === WebSocket.OPEN && target === _url) return;
  if (_ws) { _ws.onclose = null; _ws.close(); _ws = null; }
  _url = target;
  _token = extractToken(target);
  _e2eKey = null; _outCounter = 0; _inCounter = 0;
  _connecting = true;
  try {
    const ws = new WebSocket(target); _ws = ws;
    // Binary frames (E2E-encrypted payloads) arrive as ArrayBuffer; without
    // this React Native may hand us a Blob we'd have to read asynchronously.
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      _connecting = false; nc(true); startPolling();
      // The relay requires the FIRST frame to be a Pair message (token
      // check at relay.rs). E2E flow (§3.2.11): send an HMAC proof of the
      // token — never the raw token — and derive the session key up front so
      // every following send is already encrypted. Pre-E2E desktops reject
      // the proof-only frame with a pairing ChatError and close; the
      // `_desktopLegacy` fallback then reconnects with the raw token.
      // No token in the URL (legacy) → skip Pair; the relay rejects with a
      // ChatError frame and the user sees the connect error state.
      if (_token) {
        if (_desktopLegacy) {
          ws.send(JSON.stringify({ type: 'Pair', token: _token }));
        } else {
          _e2eKey = deriveSessionKey(_token);
          ws.send(JSON.stringify({ type: 'Pair', proof: computePairProof(_token) }));
        }
      }
      _send({ type: 'ListAvailableProviders' });
      _send({ type: 'ListSessions' });
      _send({ type: 'GetCostSummary' });
      _send({ type: 'GetCostDetails' });
    };
    ws.onmessage = (event) => {
      try {
        // Inbound: Text = plaintext (pre-pair frames, or a legacy
        // connection). Binary = E2E-encrypted payload — decrypt with the
        // inbound counter, which advances regardless of success so it stays
        // in lockstep with the desktop's send counter.
        let text: string;
        if (typeof event.data === 'string') {
          text = event.data;
        } else if (_e2eKey) {
          const frame = new Uint8Array(event.data as ArrayBuffer);
          const plain = decryptFrame(_e2eKey, _inCounter, frame);
          _inCounter++;
          if (!plain) { console.warn('[relay] E2E frame failed to decrypt'); return; }
          text = new TextDecoder().decode(plain);
        } else {
          // Binary frame with no E2E session — protocol violation; ignore.
          return;
        }
        const msg = JSON.parse(text) as DesktopMessage;
        // A pairing ChatError during an E2E attempt means the desktop build
        // predates E2E (it can't parse the proof-only Pair frame). Flip to
        // legacy so the automatic reconnect pairs with the raw token.
        if (msg.type === 'ChatError' && msg.chat_session_id === 'pair' && _e2eKey && !_desktopLegacy) {
          _desktopLegacy = true;
        }
        switch (msg.type) {
          case 'AvailableProviders': np(msg.providers || []); break;
          case 'SessionList': ns((msg.sessions || []).map(toSession)); break;
          case 'ChatToken': onChatToken.emit({ chatSessionId: msg.chat_session_id, token: msg.token }); break;
          case 'ChatDone': onChatDone.emit({ chatSessionId: msg.chat_session_id, usage: msg.usage }); break;
          case 'ChatError': onChatError.emit({ chatSessionId: msg.chat_session_id, error: msg.error }); break;
          case 'DesktopStatus': nc(msg.connected); break;
          case 'Transcript': onTranscript.emit({ sessionId: msg.session_id, text: msg.text, cols: msg.cols ?? 0, rows: msg.rows ?? 0 }); break;
          case 'SessionCreated': onSessionCreated.emit(toSession(msg.session)); break;
          case 'CostSummary': ncs({ today: msg.today, week: msg.week }); break;
          case 'CostDetails': ncd({
            daily: msg.daily || [],
            per_project: msg.per_project || [],
            local_models: msg.local_models || [],
          }); break;
          case 'LocalModelReady': onLocalModelReady.emit({ model: msg.model, baseUrl: msg.base_url }); break;
          case 'LocalModelError': onLocalModelError.emit({ model: msg.model, error: msg.error }); break;
          // Session-scoped chat events (Task 6). Route to the new event buses.
          case 'SessionMessages': onSessionMessages.emit({ sessionId: msg.session_id, messages: msg.messages, hasMore: msg.has_more }); break;
          case 'SessionChatToken': onSessionChatToken.emit({ sessionId: msg.session_id, token: msg.token }); break;
          case 'SessionChatDone': onSessionChatDone.emit({ sessionId: msg.session_id, usage: msg.usage }); break;
          case 'SessionChatError': onSessionChatError.emit({ sessionId: msg.session_id, error: msg.error }); break;
          case 'SessionChatStatus': onSessionChatStatus.emit({ sessionId: msg.session_id, reason: msg.reason, message: msg.message }); break;
          case 'SessionApprovalRequest': onSessionApprovalRequest.emit({ sessionId: msg.session_id, pendingId: msg.pending_id, tool: msg.tool, summary: msg.summary, args: msg.args }); break;
          case 'SessionArtifact': onSessionArtifact.emit({ sessionId: msg.session_id, messageId: msg.message_id, artifact: msg.artifact }); break;
          case 'AutomationRunFinished': {
            const ok = msg.status === 'ok';
            Alert.alert(
              ok ? `Automation finished: ${msg.name}` : `Automation failed: ${msg.name}`,
              msg.summary,
            );
            break;
          }
        }
      } catch (e) { console.error('parse error', e); }
    };
    ws.onclose = () => { _connecting = false; stopPolling(); nc(false); _ws = null; if (_reconnectTimer === null) { _reconnectTimer = setTimeout(() => { _reconnectTimer = null; _doConnect(target); }, 3000); } };
    ws.onerror = () => { _connecting = false; nc(false); };
  } catch (e) { _connecting = false; nc(false); }
}
function globalConnect(url?: string) {
  if (url) {
    // Explicit URL from the Settings field or QR scan: use it and persist it
    // so the next cold start reconnects without re-entry. The token is split
    // out of the fragment and persisted separately for diagnostics. A fresh
    // URL clears the legacy-desktop flag — the user may have pointed the app
    // at an updated desktop that speaks E2E.
    _url = url;
    _token = extractToken(url);
    _desktopLegacy = false;
    void AsyncStorage.setItem(RELAY_URL_STORAGE_KEY, url).catch(() => {});
    void AsyncStorage.setItem(RELAY_TOKEN_STORAGE_KEY, _token ?? '').catch(() => {});
    _doConnect(url);
    return;
  }
  // No explicit URL: use the persisted one once loaded. If none exists yet
  // (fresh install), stay disconnected — the Settings screen shows the URL
  // input whenever `connected` is false.
  void _storedUrlReady.then(() => { if (_url) _doConnect(_url); });
}
/** The URL the relay is currently connected/connecting to (null before any
 *  successful or attempted connect). Used to prefill the Settings field. */
export function getRelayUrl(): string | null { return _url; }
/** The pairing token extracted from the current URL's fragment (null when no
 *  token is present — legacy/dev connect). Used by the Settings screen to
 *  show the token status. */
export function getRelayToken(): string | null { return _token; }
function globalDisconnect() { stopPolling(); if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; } if (_ws) { _ws.onclose = null; _ws.close(); _ws = null; } _e2eKey = null; _outCounter = 0; _inCounter = 0; nc(false); }

// Stable sender identities (module-level) so screens can safely put them in
// useEffect dependency arrays — an inline arrow in the return object would
// change identity every render and re-fire effects on every state update.
function refreshProvidersSend() { _send({ type: 'ListAvailableProviders' }); }
function refreshCostSend() { _send({ type: 'GetCostSummary' }); }
function refreshCostDetailsSend() { _send({ type: 'GetCostDetails' }); }

export function useRelay() {
  const [connected, setConnected] = useState(_ws?.readyState === WebSocket.OPEN);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [costSummary, setCostSummary] = useState<CostSummary>({ today: 0, week: 0 });
  const [costDetails, setCostDetails] = useState<CostDetails>({ daily: [], per_project: [], local_models: [] });
  useEffect(() => {
    const c = (v: boolean) => setConnected(v);
    const p = (v: ProviderInfo[]) => setProviders(v);
    const s = (v: Session[]) => setSessions(v);
    const cs = (v: CostSummary) => setCostSummary(v);
    const cd = (v: CostDetails) => setCostDetails(v);
    _cl.add(c); _pl.add(p); _sl.add(s); _csl.add(cs); _cdl.add(cd);
    setConnected(_ws?.readyState === WebSocket.OPEN);
    return () => { _cl.delete(c); _pl.delete(p); _sl.delete(s); _csl.delete(cs); _cdl.delete(cd); };
  }, []);
  const connect = useCallback((url?: string) => { globalConnect(url); }, []);
  const disconnect = useCallback(() => { globalDisconnect(); }, []);
  const sendChatTurn = useCallback((pid: string, model: string, msgs: ChatMessage[], opts?: { system?: string; effort?: string; ggufPath?: string }) => {
    const p: MobileChatTurn = { type: 'ChatTurn', provider_id: pid, model, messages: msgs };
    if (opts?.system) p.system = opts.system;
    if (opts?.effort) p.effort = opts.effort;
    if (opts?.ggufPath) p.gguf_path = opts.ggufPath;
    _send(p);
  }, []);
  const sendToSession = useCallback((sid: string, text: string) => { _send({ type: 'SendToSession', session_id: sid, text }); }, []);
  const getTranscript = useCallback((sid: string) => { _send({ type: 'GetTranscript', session_id: sid }); }, []);
  useEffect(() => { if (!_ws && !_connecting) globalConnect(); }, []);

  // Session-scoped chat senders (Task 6). These go on the same WS connection
  // but route through SessionChatManager on the desktop, which manages the
  // owner map and persists messages on the chat_sessions table.
  const getSessionMessages = useCallback(
    (sessionId: string, beforeId?: number, limit = 50) => {
      _send({ type: 'GetSessionMessages', session_id: sessionId, before_id: beforeId, limit } as SessionChatMessage);
    },
    [],
  );
  const sendSessionChat = useCallback(
    (sessionId: string, text: string, attachments: SessionChatAttachment[] = []) => {
      _send({ type: 'SendChatMessage', session_id: sessionId, text, attachments } as SessionChatMessage);
    },
    [],
  );
  const cancelSessionStream = useCallback(
    (sessionId: string) => { _send({ type: 'CancelSessionStream', session_id: sessionId } as SessionChatMessage); },
    [],
  );
  const resolveSessionApproval = useCallback(
    (sessionId: string, pendingId: string, decision: 'approve' | 'deny') => {
      _send({ type: 'ResolveSessionApproval', session_id: sessionId, pending_id: pendingId, decision } as SessionChatMessage);
    },
    [],
  );
  const renameSession = useCallback(
    (sessionId: string, title: string) => {
      _send({ type: 'RenameSession', session_id: sessionId, title } as SessionChatMessage);
    },
    [],
  );

  return { connected, desktopUnreachable: !connected, sessions, providers, costSummary, costDetails, connect, disconnect, sendChatTurn, sendToSession, getTranscript,
    cancelChatTurn: (id: string) => _send({ type: 'CancelChatTurn', chat_session_id: id }),
    refreshProviders: refreshProvidersSend,
    refreshCost: refreshCostSend,
    refreshCostDetails: refreshCostDetailsSend,
    createSession: (pid: string, h: string) => _send({ type: 'CreateSession', project_id: pid, harness: h }),
    spawnSession: (sid: string) => _send({ type: 'SpawnSession', session_id: sid }),
    startLocalModel: (model: string, ggufPath: string) => _send({ type: 'StartLocalModel', model, gguf_path: ggufPath }),
    // Session-scoped chat (Task 6).
    getSessionMessages,
    sendSessionChat,
    cancelSessionStream,
    resolveSessionApproval,
    renameSession,
  };
}