// End-to-end agent-question test: create a Claude Code session, send a prompt
// that makes the harness call AskUserQuestion, wait for the relay to forward
// SessionQuestionRequest, answer it with ResolveSessionQuestion, and confirm
// SessionQuestionResolved arrives and the turn keeps streaming afterward.
//
// Usage: node agent_question_e2e.mjs [--port <n>] <token>
// The relay port can also come from the RELAY_PORT env var; it defaults to
// 54257 (the desktop relay binds a random port on first run).
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

// --port <n> / --port=<n> / RELAY_PORT env, falling back to 54257 — same
// convention as relay_probe.mjs.
function parseArgs(argv) {
  const rest = [];
  let port = null;
  const badPort = () => { console.error('invalid --port value'); process.exit(2); };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port <= 0) badPort();
    } else if (a.startsWith('--port=')) {
      port = Number(a.slice('--port='.length));
      if (!Number.isInteger(port) || port <= 0) badPort();
    } else {
      rest.push(a);
    }
  }
  if (port === null && process.env.RELAY_PORT) {
    const v = Number(process.env.RELAY_PORT);
    if (Number.isInteger(v) && v > 0) port = v;
  }
  return { port: port ?? 54257, rest };
}

const { port, rest } = parseArgs(process.argv.slice(2));
const token = rest[0];
if (!token) {
  console.error('usage: node agent_question_e2e.mjs [--port <n>] <token>');
  console.error('       port also via RELAY_PORT env; defaults to 54257');
  process.exit(2);
}

const ws = new WebSocket(`ws://127.0.0.1:${port}`);
let key = null, inCounter = 0, outCounter = 0;
const pending = [];
let sessionId = null;
let pendingId = null;
let answered = false;
let resolvedSeen = false;
let tokensAfterAnswer = 0;
const log = (o) => console.log(JSON.stringify(o));
const checks = [];
function check(name, ok, extra = '') {
  checks.push([name, ok]);
  log({ check: name, ok, extra });
}

function send(obj) {
  const json = JSON.stringify(obj);
  if (key) ws.send(encryptFrame(key, outCounter++, te.encode(json)));
  else pending.push(json);
}

ws.binaryType = 'arraybuffer';
ws.onopen = () => { log({ type: '__open' }); ws.send(JSON.stringify({ type: 'Pair', proof: computePairProof(token) })); };

ws.onmessage = (ev) => {
  let msg;
  if (typeof ev.data === 'string') {
    const parsed = JSON.parse(ev.data);
    if (parsed.type === 'PairOk') {
      key = deriveSessionKey(token, b64UrlToBytes(parsed.salt));
      for (const p of pending.splice(0)) ws.send(encryptFrame(key, outCounter++, te.encode(p)));
      log({ type: '__paired' });
      // Create a Claude Code session, then ask it to use AskUserQuestion.
      // The harness needs an explicit model — "auto" makes the CLI send
      // an empty model name and the turn 400s before any tool can run.
      send({ type: 'CreateSession', project_id: '', harness: process.env.QA_HARNESS || 'claude_code', model: process.env.QA_MODEL || 'opus[1m]', effort: 'low' });
      return;
    }
    msg = parsed;
  } else {
    const plain = decryptFrame(key, inCounter++, new Uint8Array(ev.data));
    if (!plain) { log({ type: '__decrypt_fail' }); return; }
    msg = JSON.parse(new TextDecoder().decode(plain));
  }
  log({ type: msg.type, ...msg, sessions: undefined, questions: undefined, session: undefined });
  if (msg.type === 'SessionChatToken' && msg.token) log({ note: 'token', text: String(msg.token).slice(0, 300) });

  switch (msg.type) {
    case 'SessionCreated': {
      sessionId = msg.session.id;
      log({ note: 'session created', sessionId });
      send({ type: 'SpawnSession', session_id: sessionId });
      setTimeout(() => {
        send({
          type: 'SendChatMessage',
          session_id: sessionId,
          text: "Ask me which deployment target I should use. End your reply with the RELAY_ASK marker line exactly as the question-channel directive describes, then stop. Do not guess the answer and do not continue past the marker.",
          attachments: [],
        });
      }, 4000);
      break;
    }
    case 'SessionQuestionRequest': {
      pendingId = msg.pending_id;
      check('question request reached the phone', true, JSON.stringify(msg.questions).slice(0, 200));
      // Answer exactly the way QuestionCard does.
      const answers = {};
      for (const q of msg.questions || []) {
        const opts = (q.options || []).map((o) => (typeof o === 'string' ? o : o.label));
        if (opts.length) answers[q.question || q.header || 'q'] = [opts[0]];
      }
      send({
        type: 'ResolveSessionQuestion',
        session_id: msg.session_id || sessionId,
        pending_id: pendingId,
        answers,
        response: 'staging',
      });
      answered = true;
      log({ note: 'answered', pendingId, answers });
      break;
    }
    case 'SessionQuestionResolved':
      resolvedSeen = true;
      check('question resolved ack', true, msg.pending_id);
      break;
    case 'SessionChatToken':
      if (answered) tokensAfterAnswer++;
      break;
    case 'SessionChatDone':
      if (answered && tokensAfterAnswer > 0) {
        check('turn continued after the answer', true, `${tokensAfterAnswer} tokens`);
        finish();
      } else {
        // A RELAY_ASK question is surfaced AFTER chat:done (the turn is
        // complete; the answer arrives as a follow-up turn), so don't
        // finish here — the question card is still on its way.
        log({ note: 'turn done, waiting for a possible question card' });
      }
      break;
    case 'ChatError':
      if (answered || msg.chat_session_id === 'session-chat') {
        check('no error on the question path', false, msg.error);
        finish();
      }
      break;
  }
};

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  if (!answered) check('question request reached the phone', false, 'no question arrived');
  const passed = checks.filter(([, ok]) => ok).length;
  log({ summary: `${passed}/${checks.length}`, checks: checks.map(([n, ok]) => `${ok ? 'PASS' : 'FAIL'} ${n}`) });
  setTimeout(() => process.exit(checks.every(([, ok]) => ok) ? 0 : 1), 500);
}

ws.onclose = () => { log({ type: '__closed' }); finish(); };
ws.onerror = (e) => { console.error('ws error', e.message ?? e); process.exit(1); };
setTimeout(() => { log({ type: '__timeout' }); finish(); }, 240000);
