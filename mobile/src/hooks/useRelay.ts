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
 *  is encrypted Binary (§3.2.11). There is NO legacy raw-token fallback: the
 *  desktop removed it (it rotates the token on every launch and accepts the
 *  proof exclusively), so a pairing rejection surfaces as an error with
 *  capped exponential reconnect backoff — never a plaintext downgrade. */
const RELAY_URL_STORAGE_KEY = 'relay.relayUrl';
// Pre-rebrand keys (conduit.*) written by older builds — read once so a
// paired phone keeps its URL/token across the rename, then re-homed under
// the new key. The token itself lives ONLY in the URL fragment (extracted on
// load) — a duplicate `relay.relayToken` key used to keep a second plaintext
// copy and is no longer written.
const LEGACY_URL_STORAGE_KEY = 'conduit.relayUrl';
const LEGACY_TOKEN_STORAGE_KEY = 'conduit.relayToken';

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
  // The approval was resolved on ANY surface — dismiss matching cards here.
  | { type: 'SessionApprovalResolved'; session_id: string; pending_id: string }
  | { type: 'SessionPlanProposal'; session_id: string; pending_id: string; title: string; plan: string }
  | { type: 'SessionModelSet'; session_id: string; provider_id: string; model: string }
  | { type: 'SessionDeleted'; session_id: string }
  | { type: 'SessionMeta'; session_id: string; provider: string; model: string; title?: string }
  | { type: 'PushAck'; ok: boolean; error?: string }
  | { type: 'SessionArtifacts'; session_id: string; artifacts: SessionArtifact[] }
  | { type: 'ArtifactContent'; session_id: string; path: string; filename: string; kind: string; text?: string; data_base64?: string; truncated?: boolean }
  | { type: 'Transcription'; text?: string; error?: string }
  | { type: 'SessionArtifact'; session_id: string; message_id?: number; artifact: { path: string; filename: string; kind?: string; inline?: { kind: 'jsx' | 'tsx'; code: string } } }
  // Broadcast (not session-scoped): an automation run finished on the desktop.
  // Shown as a local alert — fires only while the relay is connected.
  | { type: 'AutomationRunFinished'; automation_id: string; name: string; status: string; summary: string }
  // Broadcast: a project's monthly spend crossed its budget threshold.
  | { type: 'BudgetAlert'; project_id: string; project_name: string; monthly_usd: number; spent_usd: number };
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
  | { type: 'ResolveSessionApproval'; session_id: string; pending_id: string; decision: 'approve' | 'deny'; always_allow?: boolean }
  | { type: 'RenameSession'; session_id: string; title: string }
  | { type: 'SetSessionModel'; session_id: string; provider_id: string; model: string }
  | { type: 'DeleteChatSession'; session_id: string }
  | { type: 'GetSessionMeta'; session_id: string }
  | { type: 'RegisterPushToken'; token: string; platform: string }
  | { type: 'ListSessionArtifacts'; session_id: string }
  | { type: 'ReadArtifact'; session_id: string; path: string }
  | { type: 'TranscribeAudio'; data_base64: string; media_type?: string }
  | { type: 'ResolvePlanProposal'; session_id: string; pending_id: string; approved: boolean; feedback?: string };
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
export const onSessionApprovalResolved = new EventBus<{ sessionId: string; pendingId: string }>();
export const onSessionPlanProposal = new EventBus<{ sessionId: string; pendingId: string; title: string; plan: string }>();
export const onSessionModelSet = new EventBus<{ sessionId: string; providerId: string; model: string }>();
export const onSessionDeleted = new EventBus<{ sessionId: string }>();
export const onSessionMeta = new EventBus<{ sessionId: string; provider: string; model: string; title?: string }>();
export const onSessionArtifact = new EventBus<{ sessionId: string; messageId?: number; artifact: SessionArtifact }>();
export const onSessionArtifacts = new EventBus<{ sessionId: string; artifacts: SessionArtifact[] }>();
export const onArtifactContent = new EventBus<{ sessionId: string; path: string; filename: string; kind: string; text?: string; dataBase64?: string; truncated?: boolean }>();
export const onTranscription = new EventBus<{ text?: string; error?: string }>();
export const onBudgetAlert = new EventBus<{ projectId: string; projectName: string; monthlyUsd: number; spentUsd: number }>();

export interface SessionMessageRecord {
  id: number; role: string; content: string; created_at: number;
  input_tokens?: number; output_tokens?: number; cost_usd?: number;
  tool_calls?: unknown; artifact_paths?: string[];
}
export interface SessionChatUsage { input_tokens: number; output_tokens: number; cost_usd?: number; }
export interface SessionArtifact { path: string; filename: string; kind?: string; inline?: { kind: 'jsx' | 'tsx'; code: string }; }
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
// Loaded once from AsyncStorage; connect() awaits this so a persisted URL
// wins over the loopback default on cold start. Pre-rebuild builds stored
// the token under its own key — when the legacy URL carries no fragment, the
// legacy token is spliced into the migrated URL's fragment (the fragment is
// the one copy; no separate duplicate key is written).
const _storedUrlReady: Promise<string | null> = AsyncStorage.getItem(RELAY_URL_STORAGE_KEY)
  .then(async (stored) => {
    if (stored) { _url = stored; _token = extractToken(stored); return stored; }
    const legacyUrl = await AsyncStorage.getItem(LEGACY_URL_STORAGE_KEY).catch(() => null);
    if (!legacyUrl) return null;
    const legacyToken = await AsyncStorage.getItem(LEGACY_TOKEN_STORAGE_KEY).catch(() => null);
    const migrated = extractToken(legacyUrl) || !legacyToken
      ? legacyUrl
      : `${legacyUrl.split('#')[0]}#${legacyToken}`;
    _url = migrated;
    _token = extractToken(migrated) ?? legacyToken;
    void AsyncStorage.setItem(RELAY_URL_STORAGE_KEY, migrated).catch(() => {});
    return migrated;
  })
  .catch(() => null);
let _connecting = false;
let _reconnectTimer: any = null;
// Capped exponential reconnect backoff. The fixed 3s retry used to spin
// forever against a desktop that is down or rejects pairing (its token
// rotates on every restart); the delay doubles per failed attempt and
// resets when a connection actually pairs (first cleanly decrypted E2E
// frame) or when the user points the app at a URL/token explicitly.
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 60000;
let _reconnectDelay = RECONNECT_BASE_MS;
function resetReconnectBackoff() { _reconnectDelay = RECONNECT_BASE_MS; }
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
/// Send a plaintext/encrypted frame on the relay socket. Returns false when
/// the socket is not OPEN — callers that gate UI state on a reply (e.g. the
/// session-chat send) MUST check it, or the message is silently dropped
/// while the UI waits forever for events that will never arrive.
function _send(msg: MobileMessagePlain): boolean {
  if (_ws?.readyState !== WebSocket.OPEN) return false;
  const json = JSON.stringify(msg);
  if (_e2eKey) {
    _ws.send(encryptFrame(_e2eKey, _outCounter++, new TextEncoder().encode(json)));
  } else {
    _ws.send(json);
  }
  return true;
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
  // Cut at the first `?` or `&` that appears in the fragment (whichever
  // comes first) — taking Math.min of both indexes breaks when only ONE
  // separator exists (min(-1, x) === -1 swallowed the whole fragment).
  const ends = [frag.indexOf('?'), frag.indexOf('&')].filter((i) => i !== -1);
  const token = ends.length ? frag.slice(0, Math.min(...ends)) : frag;
  return token || null;
}

function _doConnect(target: string) {
  // Skip when already OPEN *or* CONNECTING to the same target — tearing down
  // an in-flight CONNECTING socket to redo it reset the pairing handshake
  // every time a screen mounted and called connect() (e.g. HomeScreen).
  if (
    (_ws?.readyState === WebSocket.OPEN || _ws?.readyState === WebSocket.CONNECTING) &&
    target === _url
  ) return;
  // Cancel any pending reconnect first: a stale timer closing over the OLD
  // target would fire ~3s later and silently reconnect to the previous
  // desktop, overriding a URL the user just changed (audit M8).
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
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
      // every following send is already encrypted. Pairing is proof-
      // EXCLUSIVE: the desktop removed raw-token pairing (and rotates the
      // token per launch), so a generic pair rejection must never downgrade
      // this side into a plaintext retry loop — it could never succeed. No
      // token in the URL (legacy/dev) → skip Pair; the relay rejects and the
      // user sees the connect error state.
      if (_token) {
        _e2eKey = deriveSessionKey(_token);
        ws.send(JSON.stringify({ type: 'Pair', proof: computePairProof(_token) }));
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
          // A frame that decrypts clean proves the desktop verified our
          // proof (it only enables E2E after that) — pairing succeeded, so
          // the reconnect backoff resets to the base delay.
          resetReconnectBackoff();
        } else {
          // Binary frame with no E2E session — protocol violation; ignore.
          return;
        }
        const msg = JSON.parse(text) as DesktopMessage;
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
          case 'SessionApprovalResolved': onSessionApprovalResolved.emit({ sessionId: msg.session_id, pendingId: msg.pending_id }); break;
          case 'SessionPlanProposal': onSessionPlanProposal.emit({ sessionId: msg.session_id, pendingId: msg.pending_id, title: msg.title, plan: msg.plan }); break;
          case 'SessionModelSet': onSessionModelSet.emit({ sessionId: msg.session_id, providerId: msg.provider_id, model: msg.model }); break;
          case 'SessionDeleted': onSessionDeleted.emit({ sessionId: msg.session_id }); break;
          case 'SessionMeta': onSessionMeta.emit({ sessionId: msg.session_id, provider: msg.provider, model: msg.model, title: msg.title }); break;
          case 'SessionArtifacts': onSessionArtifacts.emit({ sessionId: msg.session_id, artifacts: msg.artifacts || [] }); break;
          case 'ArtifactContent': onArtifactContent.emit({ sessionId: msg.session_id, path: msg.path, filename: msg.filename, kind: msg.kind, text: msg.text, dataBase64: msg.data_base64, truncated: msg.truncated }); break;
          case 'Transcription': onTranscription.emit({ text: msg.text, error: msg.error }); break;
          case 'SessionArtifact': onSessionArtifact.emit({ sessionId: msg.session_id, messageId: msg.message_id, artifact: msg.artifact }); break;
          case 'BudgetAlert': {
            onBudgetAlert.emit({ projectId: msg.project_id, projectName: msg.project_name, monthlyUsd: msg.monthly_usd, spentUsd: msg.spent_usd });
            Alert.alert(
              `Budget: ${msg.project_name}`,
              `Spent $${msg.spent_usd.toFixed(2)} of $${msg.monthly_usd.toFixed(2)} this month.`,
            );
            break;
          }
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
    // Reconnect with capped exponential backoff (reset on a successful pair
    // or an explicit URL/token change) — re-reading _url (not the captured
    // target) so a URL change between close and reconnect wins (audit M8).
    ws.onclose = () => {
      _connecting = false; stopPolling(); nc(false); _ws = null;
      if (_reconnectTimer === null) {
        const delay = _reconnectDelay;
        _reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
        _reconnectTimer = setTimeout(() => { _reconnectTimer = null; if (_url) _doConnect(_url); }, delay);
      }
    };
    ws.onerror = () => { _connecting = false; nc(false); };
  } catch (e) { _connecting = false; nc(false); }
}
function globalConnect(url?: string) {
  if (url) {
    // Explicit URL from the Settings field, a QR scan, or a deep link: use it
    // and persist it so the next cold start reconnects without re-entry. The
    // token rides in the URL fragment — that is the ONE stored copy (no
    // separate duplicate key). A fresh URL restarts the reconnect backoff.
    _url = url;
    _token = extractToken(url);
    resetReconnectBackoff();
    void AsyncStorage.setItem(RELAY_URL_STORAGE_KEY, url).catch(() => {});
    _doConnect(url);
    return;
  }
  // No explicit URL: use the persisted one once loaded. If none exists yet
  // (fresh install), stay disconnected — the Settings screen shows the URL
  // input whenever `connected` is false.
  void _storedUrlReady.then(() => { if (_url) _doConnect(_url); });
}
/** Pairing-token update from a token-only deep link (`relay://connect#<token>`).
 *  Such a link carries NO host, so it must never be fed to connect() as a
 *  URL — that overwrote the stored relay URL with the bare token string and
 *  un-paired the phone. Instead the token is spliced into the existing URL's
 *  fragment and the connection retried. */
function globalApplyPairingToken(token: string) {
  const base = _url ? _url.split('#')[0] : null;
  if (!base) {
    Alert.alert(
      'Pairing link',
      'This link only carries a token. Connect to the desktop once (Settings), then re-scan.',
    );
    return;
  }
  globalConnect(`${base}#${token}`);
}
/** The URL the relay is currently connected/connecting to (null before any
 *  successful or attempted connect). Used to prefill the Settings field. */
export function getRelayUrl(): string | null { return _url; }
/** The pairing token extracted from the current URL's fragment (null when no
 *  token is present — legacy/dev connect). Used by the Settings screen to
 *  show the token status. */
export function getRelayToken(): string | null { return _token; }
function globalDisconnect() { stopPolling(); resetReconnectBackoff(); if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; } if (_ws) { _ws.onclose = null; _ws.close(); _ws = null; } _e2eKey = null; _outCounter = 0; _inCounter = 0; nc(false); }

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
  const applyPairingToken = useCallback((token: string) => { globalApplyPairingToken(token); }, []);
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
    (sessionId: string, text: string, attachments: SessionChatAttachment[] = []): boolean =>
      _send({ type: 'SendChatMessage', session_id: sessionId, text, attachments } as SessionChatMessage),
    [],
  );
  const cancelSessionStream = useCallback(
    (sessionId: string) => { _send({ type: 'CancelSessionStream', session_id: sessionId } as SessionChatMessage); },
    [],
  );
  const resolveSessionApproval = useCallback(
    (sessionId: string, pendingId: string, decision: 'approve' | 'deny', alwaysAllow = false) => {
      _send({ type: 'ResolveSessionApproval', session_id: sessionId, pending_id: pendingId, decision, always_allow: alwaysAllow } as SessionChatMessage);
    },
    [],
  );
  const setSessionModel = useCallback(
    (sessionId: string, providerId: string, model: string) => {
      _send({ type: 'SetSessionModel', session_id: sessionId, provider_id: providerId, model } as SessionChatMessage);
    },
    [],
  );
  const deleteSession = useCallback(
    (sessionId: string) => {
      _send({ type: 'DeleteChatSession', session_id: sessionId } as SessionChatMessage);
    },
    [],
  );
  const getSessionMeta = useCallback(
    (sessionId: string) => {
      _send({ type: 'GetSessionMeta', session_id: sessionId } as SessionChatMessage);
    },
    [],
  );
  const registerPushToken = useCallback(
    (token: string, platform: string) => {
      _send({ type: 'RegisterPushToken', token, platform } as SessionChatMessage);
    },
    [],
  );
  const listSessionArtifacts = useCallback(
    (sessionId: string) => {
      _send({ type: 'ListSessionArtifacts', session_id: sessionId } as SessionChatMessage);
    },
    [],
  );
  const readArtifact = useCallback(
    (sessionId: string, path: string) => {
      _send({ type: 'ReadArtifact', session_id: sessionId, path } as SessionChatMessage);
    },
    [],
  );
  const transcribeAudio = useCallback(
    (dataBase64: string, mediaType?: string) => {
      _send({ type: 'TranscribeAudio', data_base64: dataBase64, media_type: mediaType } as SessionChatMessage);
    },
    [],
  );
  const resolvePlanProposal = useCallback(
    (sessionId: string, pendingId: string, approved: boolean, feedback?: string) => {
      _send({ type: 'ResolvePlanProposal', session_id: sessionId, pending_id: pendingId, approved, feedback } as SessionChatMessage);
    },
    [],
  );
  const renameSession = useCallback(
    (sessionId: string, title: string) => {
      _send({ type: 'RenameSession', session_id: sessionId, title } as SessionChatMessage);
    },
    [],
  );

  return { connected, desktopUnreachable: !connected, sessions, providers, costSummary, costDetails, connect, applyPairingToken, disconnect, sendChatTurn, sendToSession, getTranscript,
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
    setSessionModel,
    deleteSession,
    getSessionMeta,
    registerPushToken,
    listSessionArtifacts,
    readArtifact,
    transcribeAudio,
    resolvePlanProposal,
  };
}