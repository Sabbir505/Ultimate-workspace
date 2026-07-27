import { useState, useEffect, useCallback } from 'react';

export const DEFAULT_RELAY_URL = 'ws://192.168.1.7:52506';

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
  | { type: 'Transcript'; session_id: string; text: string; cols: number; rows: number }
  | { type: 'SessionCreated'; session: SessionInfo }
  | { type: 'CostSummary'; today: number; week: number }
  | { type: 'CostDetails'; daily: DailyCostEntry[]; per_project: ProjectCostEntry[]; local_models: LocalModelUsageEntry[] };
interface MobileChatTurn {
  type: 'ChatTurn'; provider_id: string; model: string;
  messages: ChatMessage[]; system?: string; effort?: string; gguf_path?: string;
}
type MobileMessagePlain =
  | { type: 'ListAvailableProviders' } | { type: 'ListSessions' }
  | MobileChatTurn | { type: 'CancelChatTurn'; chat_session_id: string }
  | { type: 'SendToSession'; session_id: string; text: string }
  | { type: 'GetTranscript'; session_id: string }
  | { type: 'CreateSession'; project_id: string; harness: string }
  | { type: 'SpawnSession'; session_id: string }
  | { type: 'GetCostSummary' }
  | { type: 'GetCostDetails' };

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

let _ws: WebSocket | null = null;
let _url = DEFAULT_RELAY_URL;
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
function _send(msg: MobileMessagePlain) { if (_ws?.readyState === WebSocket.OPEN) _ws.send(JSON.stringify(msg)); }

function startPolling() {
  stopPolling();
  _pollTimer = setInterval(() => {
    if (_ws?.readyState === WebSocket.OPEN) {
      _ws.send(JSON.stringify({ type: 'ListSessions' }));
      _ws.send(JSON.stringify({ type: 'GetCostSummary' }));
      _ws.send(JSON.stringify({ type: 'GetCostDetails' }));
    }
  }, 5000);
  _providerTimer = setInterval(() => {
    if (_ws?.readyState === WebSocket.OPEN) _ws.send(JSON.stringify({ type: 'ListAvailableProviders' }));
  }, 30000);
}
function stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  if (_providerTimer) { clearInterval(_providerTimer); _providerTimer = null; }
}

function _doConnect(target: string) {
  if (_ws?.readyState === WebSocket.OPEN && target === _url) return;
  if (_ws) { _ws.onclose = null; _ws.close(); _ws = null; }
  _url = target; _connecting = true;
  try {
    const ws = new WebSocket(target); _ws = ws;
    ws.onopen = () => { _connecting = false; nc(true); startPolling(); _send({ type: 'ListAvailableProviders' }); _send({ type: 'ListSessions' }); _send({ type: 'GetCostSummary' }); _send({ type: 'GetCostDetails' }); };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as DesktopMessage;
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
        }
      } catch (e) { console.error('parse error', e); }
    };
    ws.onclose = () => { _connecting = false; stopPolling(); nc(false); _ws = null; if (_reconnectTimer === null) { _reconnectTimer = setTimeout(() => { _reconnectTimer = null; _doConnect(_url); }, 3000); } };
    ws.onerror = () => { _connecting = false; nc(false); };
  } catch (e) { _connecting = false; nc(false); }
}
function globalConnect(url?: string) { _doConnect(url ?? _url ?? DEFAULT_RELAY_URL); }
function globalDisconnect() { stopPolling(); if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; } if (_ws) { _ws.onclose = null; _ws.close(); _ws = null; } nc(false); }

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
  return { connected, desktopUnreachable: !connected, sessions, providers, costSummary, costDetails, connect, disconnect, sendChatTurn, sendToSession, getTranscript,
    cancelChatTurn: (id: string) => _send({ type: 'CancelChatTurn', chat_session_id: id }),
    refreshProviders: () => _send({ type: 'ListAvailableProviders' }),
    refreshCost: () => _send({ type: 'GetCostSummary' }),
    refreshCostDetails: () => _send({ type: 'GetCostDetails' }),
    createSession: (pid: string, h: string) => _send({ type: 'CreateSession', project_id: pid, harness: h }),
    spawnSession: (sid: string) => _send({ type: 'SpawnSession', session_id: sid }),
  };
}