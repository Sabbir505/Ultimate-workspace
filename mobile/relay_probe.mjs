// Deterministic relay-protocol client for verifying mobile ops end-to-end.
// Speaks the real wire protocol (proof pairing + XChaCha20-Poly1305 E2E) with
// the SAME crypto as the app (mirrors mobile/src/lib/relayCrypto.ts), so op
// tests don't depend on flaky UI automation.
//
// Usage: node Random Stuff/relay_probe.mjs <token> <op-json> [...]
//   node relay_probe.mjs <token> '{"type":"ListChatSkills"}' \
//     '{"type":"SearchChatMessages","query":"hello","limit":5}'
// Prints every DesktopMessage received (decrypted) as JSON lines.
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

const te = new TextEncoder();
const HKDF_SALT = 'conduit-e2e-relay-salt-v1';
const HKDF_INFO = 'conduit-e2e-relay-v1';

function deriveSessionKey(token, salt) {
  return hkdf(sha256, te.encode(token), salt ?? te.encode(HKDF_SALT), te.encode(HKDF_INFO), 32);
}
function b64UrlToBytes(s) {
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const clean = s.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let bits = 0, acc = 0, o = 0;
  for (const ch of clean) {
    const v = table.indexOf(ch);
    if (v < 0) throw new Error('invalid base64url character');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 0xff; }
  }
  return out;
}
function computePairProof(token) {
  const mac = hmac(sha256, te.encode(token), te.encode('E2E'));
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}
function counterNonce(counter) {
  const nonce = new Uint8Array(24);
  new DataView(nonce.buffer).setBigUint64(16, BigInt(counter));
  return nonce;
}
function encryptFrame(key, counter, plaintext) {
  const nonce = counterNonce(counter);
  const ct = xchacha20poly1305(key, nonce).encrypt(plaintext);
  const frame = new Uint8Array(24 + ct.length);
  frame.set(nonce); frame.set(ct, 24);
  return frame;
}
function decryptFrame(key, counter, frame) {
  if (frame.length < 24 + 16) return null;
  const expected = counterNonce(counter);
  for (let i = 0; i < 24; i++) if (frame[i] !== expected[i]) return null;
  try { return xchacha20poly1305(key, frame.slice(0, 24)).decrypt(frame.slice(24)); }
  catch { return null; }
}

const token = process.argv[2];
const ops = process.argv.slice(3).map((a) => JSON.parse(a));
if (!token || ops.length === 0) {
  console.error('usage: node relay_probe.mjs <token> <op-json> [...]');
  process.exit(2);
}

const ws = new WebSocket('ws://127.0.0.1:54257');
let key = null;
let inCounter = 0;
let outCounter = 0;
const pending = [];
const done = new Set();
const seen = [];

function send(obj) {
  const json = JSON.stringify(obj);
  if (key) ws.send(encryptFrame(key, outCounter++, te.encode(json)));
  else pending.push(json);
}

ws.binaryType = 'arraybuffer';
ws.onopen = () => { console.log(JSON.stringify({ type: '__open' }));
  ws.send(JSON.stringify({ type: 'Pair', proof: computePairProof(token) }));
};

ws.onmessage = (ev) => {
  let msg = null;
  if (typeof ev.data === 'string') {
    msg = JSON.parse(ev.data);
    if (msg.type === 'PairOk') {
      key = deriveSessionKey(token, b64UrlToBytes(msg.salt));
      for (const p of pending.splice(0)) ws.send(encryptFrame(key, outCounter++, te.encode(p)));
      // send requested ops 400ms after pairing
      ops.forEach((op, i) => setTimeout(() => send(op), 400 + i * 350));
      console.log(JSON.stringify({ type: '__paired' }));
      return;
    }
  } else {
    const plain = decryptFrame(key, inCounter++, new Uint8Array(ev.data));
    if (!plain) { console.log(JSON.stringify({ type: '__decrypt_fail' })); return; }
    msg = JSON.parse(new TextDecoder().decode(plain));
  }
  seen.push(msg);
  console.log(JSON.stringify(msg));
  // Mark every op this frame answers. `done` is cumulative — checking
  // ops.every() against a single message could never be true once more
  // than one op was queued, so the probe always ran to its timeout.
  for (const op of ops) {
    if (msgMatches(msg, op)) done.add(op.type);
  }
  if (ops.every((op) => done.has(op.type))) {
    // grace period for trailing frames, then exit
    setTimeout(() => process.exit(0), 2500);
  }
};

function msgMatches(msg, op) {
  switch (op.type) {
    case 'ListChatSkills': return msg.type === 'ChatSkills';
    case 'SearchChatMessages': return msg.type === 'ChatSearchResults';
    case 'ListChatCheckpoints': return msg.type === 'ChatCheckpoints';
    case 'RestoreChatCheckpoint': return msg.type === 'SessionCheckpointRestored' || msg.type === 'ChatError';
    case 'SetSessionPermissionMode': return msg.type === 'SessionPermissionModeSet' || msg.type === 'ChatError';
    case 'CompactSession': return msg.type === 'SessionCompacted' || msg.type === 'ChatError';
    case 'DeleteChatMessage': return msg.type === 'SessionMessageDeleted' || msg.type === 'ChatError';
    case 'EditUserMessage': return msg.type === 'SessionChatToken' || msg.type === 'SessionChatDone' || msg.type === 'ChatError';
    case 'RegenerateMessage': return msg.type === 'SessionChatToken' || msg.type === 'SessionChatDone' || msg.type === 'ChatError';
    case 'GetSessionMeta': return msg.type === 'SessionMeta' || msg.type === 'ChatError';
    case 'GetSessionMessages': return msg.type === 'SessionMessages';
    case 'ListSessions': return msg.type === 'SessionList' || msg.type === 'ChatError';
    case 'ListAutomations': return msg.type === 'AutomationList' || msg.type === 'ChatError';
    // Error-converted arms: a success payload OR an explicit ChatError
    // (never silence — a failed list must be visible to the phone).
    case 'ListInstalledSkills': return msg.type === 'InstalledSkillList' || msg.type === 'ChatError';
    case 'ListMemoryRecords': return msg.type === 'MemoryList' || msg.type === 'ChatError';
    case 'PurgeMemories': return msg.type === 'MemoryPurged' || msg.type === 'ChatError';
    case 'ListProjects': return msg.type === 'ProjectList' || msg.type === 'ChatError';
    case 'ListBudgets': return msg.type === 'BudgetList' || msg.type === 'ChatError';
    case 'SetBudget': return msg.type === 'BudgetList' || msg.type === 'ChatError';
    case 'ListHiddenCostProjects': return msg.type === 'HiddenCostProjects' || msg.type === 'ChatError';
    case 'ListArtifacts': return msg.type === 'ArtifactLibrary' || msg.type === 'ChatError';
    case 'ListAcpAgents': return msg.type === 'AcpAgentList' || msg.type === 'ChatError';
    case 'ListChatSkills': return msg.type === 'ChatSkills';
    case 'GitDiff': return msg.type === 'GitOutput' || msg.type === 'ChatError';
    case 'GitBranches': return msg.type === 'GitBranchesMsg' || msg.type === 'ChatError';
    case 'GitLog': return msg.type === 'GitLogMsg' || msg.type === 'ChatError';
    case 'GetSessionConnectors': return msg.type === 'SessionConnectors' || msg.type === 'ChatError';
    case 'CreateAutomation': return msg.type === 'AutomationUpdated' || msg.type === 'ChatError';
    case 'UpdateAutomation': return msg.type === 'AutomationUpdated' || msg.type === 'ChatError';
    case 'SetAutomationEnabled': return msg.type === 'AutomationUpdated' || msg.type === 'ChatError';
    case 'DeleteAutomation': return msg.type === 'AutomationDeleted' || msg.type === 'ChatError';
    case 'RunAutomationNow': return msg.type === 'AutomationRunStarted' || msg.type === 'ChatError';
    case 'StopAutomationRun': return msg.type === 'AutomationRunStopped' || msg.type === 'ChatError';
    case 'ListAutomationRuns': return msg.type === 'AutomationRuns';
    default: return false;
  }
}

ws.onclose = (e) => { console.log(JSON.stringify({ type: '__closed', code: e.code, reason: String(e.reason||'') })); };
ws.onerror = (e) => { console.error('ws error', e.message ?? e); process.exit(1); };
setTimeout(() => { console.error("readyState=" + ws.readyState); console.error('TIMEOUT — no matching replies'); process.exit(3); }, 45000);
