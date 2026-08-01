# Cursor-style Mobile Session Chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mobile app's terminal-emulator session view and standalone Chat tab with a single Cursor-style chat UI per session that drives the desktop's chat agent pipeline.

**Architecture:** Mobile sessions stop being pty transcripts and become chat sessions. A new `SessionChat` screen renders message bubbles (markdown, code, tool cards, diffs, artifacts, approvals) by consuming a paginated history feed + a live streaming feed from the desktop. The desktop relay is extended with new message types that key streamed tokens, approvals, and artifacts by `session_id` instead of ephemeral `chat_session_id`. A feature flag gates the rollout so the protocol change can ship in a coordinated desktop+mobile release.

**Tech Stack:**
- Mobile: Expo SDK 57, React Native 0.86, React 19, react-navigation 7, zustand (existing), react-native-markdown-display (or react-native-render-html), no new top-level deps where possible.
- Desktop frontend: zustand chat store, react-markdown + Prism (existing).
- Desktop backend: Rust (Tauri commands), serde, tokio, rusqlite (existing).
- Relay: WebSocket JSON protocol over tokio-tungstenite (existing).
- Tests: vitest for mobile, cargo test for desktop.

## Global Constraints

- **Mobile bundler:** Expo SDK 57. Follow `mobile/AGENTS.md` — read https://docs.expo.dev/versions/v57.0.0/ before writing any code.
- **Relay security:** existing relay binds 127.0.0.1 only; preserves pairing-token handshake.
- **Theme:** already updated to match desktop Cursor palette (`#88C0D0` dark accent, `#0078a8` light accent). New components must use `theme.colors.*` — no hardcoded hex.
- **Atomic commits:** every task ends with `git commit`. No `--no-verify`.
- **TDD where it pays:** mobile stores / hooks get unit tests; UI components get snapshot or render tests only if cheap; relay protocol gets cargo unit tests for serialization.
- **No new top-level npm dependencies** unless a task explicitly adds one. Reuse what's installed.
- **Naming:** existing mobile uses `useRelay`, `useTheme`, file PascalCase. Match it.
- **Lines per file:** target ≤ 400. If a file grows beyond, split in a follow-up task inside the same feature.

---

## File Structure

### New files (mobile)

| Path | Responsibility |
|---|---|
| `mobile/src/screens/SessionChat.tsx` | Per-session chat UI: header, message list, composer, banners. Replaces `SessionScreen.tsx` and `ChatScreen.tsx`. |
| `mobile/src/components/MessageBubble.tsx` | Single message renderer (user/assistant, markdown, code, tool cards, diff, artifact, usage line). |
| `mobile/src/components/ChatComposer.tsx` | Rounded composer card with attach, textarea, model chip, send/stop button. |
| `mobile/src/components/ApprovalCard.tsx` | Inline file-write / tool-execute approval with Approve/Deny. |
| `mobile/src/components/ArtifactChip.tsx` | Generated-file chip + open in preview sheet. |
| `mobile/src/components/StatusBanner.tsx` | Reusable banner for "Loading local model…" and "Desktop unreachable" (replaces inline banners in old ChatScreen). |
| `mobile/src/hooks/useSessionChat.ts` | Per-session state: messages, streaming, approval, status, error + actions. |
| `mobile/src/lib/sessionMessage.ts` | Type for `SessionMessageRecord` mirroring desktop `ChatMessageRecord` shape. |
| `mobile/src/lib/featureFlags.ts` | Boolean `useChatSession` flag reader (AsyncStorage-persisted, default off until rollout). |

### Modified files (mobile)

| Path | Change |
|---|---|
| `mobile/App.tsx` | Drop the Chat tab; add a `SessionChat` screen to the Home stack. |
| `mobile/src/hooks/useRelay.ts` | Add senders + handlers for the new session-scoped message types. Keep existing surface; gate new paths behind `useChatSession`. |
| `mobile/src/screens/HomeScreen.tsx` | Add last-message preview to each session card; gate preview rendering behind `useChatSession`. |
| `mobile/src/screens/ApprovalsScreen.tsx` | Change `SessionDetail` target → `SessionChat` (gated). |
| `mobile/src/components/BottomNav.tsx` | Remove the Chat tab when `useChatSession` is on. |

### Deleted files (mobile — at end of plan, after flag is on by default)

- `mobile/src/screens/SessionScreen.tsx`
- `mobile/src/screens/ChatScreen.tsx`
- `mobile/src/components/AnsiRenderer.tsx`

### New files (desktop backend)

| Path | Responsibility |
|---|---|
| `src-tauri/src/mobile/session_chat.rs` | `SessionChatManager`: handles `GetSessionMessages`, `SendChatMessage`, `CancelSessionStream`, `ResolveSessionApproval`, `RenameSession`. Owns the per-session in-flight stream map. |
| `src-tauri/src/mobile/session_chat_tests.rs` | Unit tests for serialization, message attribution, history pagination. |

### Modified files (desktop)

| Path | Change |
|---|---|
| `src-tauri/src/mobile/mod.rs` | Export the new `session_chat` module. |
| `src-tauri/src/mobile/protocol.rs` | Add 5 `MobileMessage` variants + 7 `DesktopMessage` variants + `SessionMessageRecord` / `ChatAttachment` / `PendingApproval` / `ChatArtifactPayload` shared structs. |
| `src-tauri/src/mobile/relay.rs` | Dispatch the new `MobileMessage` variants to `SessionChatManager`; broadcast new `DesktopMessage` variants on the per-session stream. |
| `src/state/chat.ts` | Add `ownerSessionId?: string` on in-flight turn records; emit `session_chat:*` events the relay can re-broadcast over WS. |
| `src/components/chat/ChatComposer.tsx` | Add an optional `compact` prop for the mobile-port surface (no connectors/skills/menu — only model chip, textarea, send). |
| `src/components/chat/MessageBubble.tsx` | No functional change. The mobile port reimplements it in React Native primitives. |

---

## Task 1: Feature flag plumbing (mobile)

**Files:**
- Create: `mobile/src/lib/featureFlags.ts`
- Modify: `mobile/src/screens/SettingsScreen.tsx` (add a developer toggle for the flag, behind a 5-tap easter egg on the version row to avoid accidental flips)

**Interfaces:**
- Consumes: `AsyncStorage` (already installed via `react-native` polyfill in `app.json` if present — otherwise use in-memory only and log a warning)
- Produces: `getUseChatSession(): Promise<boolean>`, `setUseChatSession(v: boolean): Promise<void>`, `useUseChatSession(): boolean` (hook reading from a tiny in-memory store + AsyncStorage on mount)

- [ ] **Step 1: Write the failing test**

```ts
// mobile/src/lib/featureFlags.test.ts
import { setUseChatSession, getUseChatSession } from './featureFlags';

test('defaults to false', async () => {
  expect(await getUseChatSession()).toBe(false);
});

test('round-trips a value', async () => {
  await setUseChatSession(true);
  expect(await getUseChatSession()).toBe(true);
  await setUseChatSession(false);
  expect(await getUseChatSession()).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mobile && npx vitest run src/lib/featureFlags.test.ts`
Expected: FAIL — `Cannot find module './featureFlags'`.

- [ ] **Step 3: Implement `featureFlags.ts`**

```ts
// mobile/src/lib/featureFlags.ts
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'feature.useChatSession';
let cache: boolean | null = null;
const listeners = new Set<(v: boolean) => void>();

export async function getUseChatSession(): Promise<boolean> {
  if (cache !== null) return cache;
  const raw = await AsyncStorage.getItem(KEY);
  cache = raw === '1';
  return cache;
}

export async function setUseChatSession(v: boolean): Promise<void> {
  cache = v;
  await AsyncStorage.setItem(KEY, v ? '1' : '0');
  listeners.forEach((fn) => fn(v));
}

export function useUseChatSession(): boolean {
  // Subscribe to in-memory changes. Initial value resolved on mount by the
  // App-level provider so the first paint is correct.
  const [v, setV] = useStateLocal(cache ?? false);
  useEffect(() => {
    const fn = (next: boolean) => setV(next);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  return v;
}
```

If `@react-native-async-storage/async-storage` is not already a dep, fall back to an in-memory-only `Map` and log a warning — do not add a new top-level dep in this task. (Re-check in Task 9; if the user expects persistence, add the dep there.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd mobile && npx vitest run src/lib/featureFlags.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the flag into the App shell + Settings**

In `mobile/App.tsx`, on mount call `getUseChatSession()` and store in a `zustand` slice or simple context so screens can read it synchronously. In `SettingsScreen.tsx`, add a hidden 5-tap version row that toggles the flag; show a "Chat session UI: ON/OFF" line for confirmation.

- [ ] **Step 6: Commit**

```bash
git add mobile/src/lib/featureFlags.ts mobile/src/lib/featureFlags.test.ts mobile/App.tsx mobile/src/screens/SettingsScreen.tsx
git commit -m "feat(mobile): add useChatSession feature flag"
```

---

## Task 2: Relay protocol — shared types (desktop backend)

**Files:**
- Modify: `src-tauri/src/mobile/protocol.rs`

**Interfaces:**
- Consumes: existing `MobileMessage`, `DesktopMessage`, `ChatUsage`, `ChatMessage` (from `crate::chat::providers`)
- Produces: 5 new `MobileMessage` variants, 7 new `DesktopMessage` variants, 4 new shared structs

- [ ] **Step 1: Write the failing test**

```rust
// src-tauri/src/mobile/session_chat_tests.rs
use crate::mobile::protocol::*;

#[test]
fn serialize_send_chat_message() {
    let msg = MobileMessage::SendChatMessage {
        session_id: "s1".into(),
        text: "hi".into(),
        attachments: vec![],
    };
    let json = serde_json::to_string(&msg).unwrap();
    assert!(json.contains("\"type\":\"SendChatMessage\""));
    assert!(json.contains("\"session_id\":\"s1\""));
    assert!(json.contains("\"text\":\"hi\""));
}

#[test]
fn deserialize_session_messages() {
    let json = r#"{"type":"SessionMessages","session_id":"s1","messages":[],"has_more":false}"#;
    let msg: DesktopMessage = serde_json::from_str(json).unwrap();
    match msg {
        DesktopMessage::SessionMessages { session_id, has_more, .. } => {
            assert_eq!(session_id, "s1");
            assert!(!has_more);
        }
        _ => panic!("wrong variant"),
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test --lib mobile::session_chat_tests`
Expected: FAIL — variants do not exist.

- [ ] **Step 3: Add the new types to `protocol.rs`**

Append to `MobileMessage` enum:

```rust
GetSessionMessages {
    session_id: String,
    before_id: Option<i64>,
    limit: u32,
},
SendChatMessage {
    session_id: String,
    text: String,
    attachments: Vec<ChatAttachment>,
},
CancelSessionStream { session_id: String },
ResolveSessionApproval {
    session_id: String,
    pending_id: String,
    decision: String, // "approve" | "deny"
},
RenameSession {
    session_id: String,
    title: String,
},
```

Append to `DesktopMessage` enum:

```rust
SessionMessages {
    session_id: String,
    messages: Vec<SessionMessageRecord>,
    has_more: bool,
},
SessionChatToken {
    session_id: String,
    token: String,
},
SessionChatDone {
    session_id: String,
    usage: Option<MobileChatUsage>,
},
SessionChatError {
    session_id: String,
    error: String,
},
SessionChatStatus {
    session_id: String,
    reason: String,
    message: String,
},
SessionApprovalRequest {
    session_id: String,
    pending_id: String,
    tool: String,
    summary: String,
    args: serde_json::Value,
},
SessionArtifact {
    session_id: String,
    message_id: Option<i64>,
    artifact: ChatArtifactPayload,
},
```

Append shared structs:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatAttachment {
    pub name: String,
    pub kind: String, // "text" | "image" | "doc"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>, // base64, no data: prefix
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMessageRecord {
    pub id: i64,
    pub role: String, // "user" | "assistant" | "system"
    pub content: String,
    pub created_at: i64,
    #[serde(default)]
    pub input_tokens: Option<i64>,
    #[serde(default)]
    pub output_tokens: Option<i64>,
    #[serde(default)]
    pub cost_usd: Option<f64>,
    #[serde(default)]
    pub tool_calls: Option<serde_json::Value>,
    #[serde(default)]
    pub artifact_paths: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatArtifactPayload {
    pub path: String,
    pub filename: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inline: Option<ChatArtifactInline>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatArtifactInline {
    pub kind: String, // "jsx" | "tsx"
    pub code: String,
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src-tauri && cargo test --lib mobile::session_chat_tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/mobile/protocol.rs src-tauri/src/mobile/session_chat_tests.rs
git commit -m "feat(mobile-relay): add session-scoped chat protocol types"
```

---

## Task 3: Desktop — `SessionChatManager` (history + dispatch)

**Files:**
- Create: `src-tauri/src/mobile/session_chat.rs`
- Create: `src-tauri/src/mobile/session_chat_tests.rs` (extend)
- Modify: `src-tauri/src/mobile/mod.rs`

**Interfaces:**
- Consumes: `Arc<ChatManager>`, `Arc<Mutex<Connection>>` (existing), `AppHandle`
- Produces: `SessionChatManager::handle(msg: MobileMessage, app: &AppHandle, db: &Connection, chat_mgr: &ChatManager) -> Result<Vec<DesktopMessage>, String>`

- [ ] **Step 1: Write the failing test for history pagination**

```rust
#[test]
fn history_pagination_query() {
    // Seed DB with 5 messages for session "s1" (ids 1..5).
    // Call SessionChatManager::fetch_page(db, "s1", before_id=None, limit=2).
    // Assert it returns ids [5, 4] with has_more=true.
    // Call again with before_id=4; expect [3, 2] has_more=true.
    // Call with before_id=2; expect [1] has_more=false.
}
```

Use an in-memory `Connection::open_in_memory()` and call the same `db::insert_chat_message` helper the production code uses. If the helper signature is too gnarly to call directly, write a thin `seed_chat_message(conn, session_id, content, role)` test helper inside `session_chat_tests.rs` that the production module can also use.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test --lib mobile::session_chat_tests::history_pagination_query`
Expected: FAIL — `SessionChatManager` does not exist.

- [ ] **Step 3: Implement `SessionChatManager` skeleton with `fetch_page`**

```rust
pub struct SessionChatManager;

impl SessionChatManager {
    pub fn fetch_page(
        db: &Connection,
        session_id: &str,
        before_id: Option<i64>,
        limit: u32,
    ) -> Result<(Vec<SessionMessageRecord>, bool), String> {
        // SELECT id, role, content, created_at, input_tokens, output_tokens, cost_usd, tool_calls, artifact_paths
        // FROM chat_messages WHERE chat_session_id = (SELECT id FROM chat_sessions WHERE owner_session_id = ?1)
        //   AND (?2 IS NULL OR id < ?2)
        // ORDER BY id DESC LIMIT ?3 + 1
        //
        // If we got limit+1 rows, has_more = true and pop the extra.
    }

    pub fn handle(
        msg: MobileMessage,
        app: &AppHandle,
        db: Arc<Mutex<Connection>>,
        chat_mgr: Arc<ChatManager>,
    ) -> Result<Vec<DesktopMessage>, String> {
        // Dispatch on msg:
        //  GetSessionMessages -> fetch_page + SessionMessages
        //  SendChatMessage -> ensure a chat_session row exists keyed by owner_session_id,
        //                     call chat_mgr.send(...) with the user's text,
        //                     route streamed events back to mobile via app.emit("mobile:session_chat_event", ...)
        //  CancelSessionStream -> chat_mgr.cancel(...)
        //  ResolveSessionApproval -> chat::commands::resolve_tool_action(...)
        //  RenameSession -> chat::commands::update_chat_session_title(...)
        //
        // For now implement GetSessionMessages + CancelSessionStream + RenameSession + ResolveSessionApproval fully.
        // Stub SendChatMessage behind an unimplemented!() and follow up in Task 4.
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src-tauri && cargo test --lib mobile::session_chat_tests`
Expected: PASS for `history_pagination_query` and the protocol tests from Task 2.

- [ ] **Step 5: Wire the module**

In `src-tauri/src/mobile/mod.rs`, add `pub mod session_chat;` and `#[cfg(test)] mod session_chat_tests;`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/mobile/session_chat.rs src-tauri/src/mobile/session_chat_tests.rs src-tauri/src/mobile/mod.rs
git commit -m "feat(mobile-relay): SessionChatManager skeleton with history pagination"
```

---

## Task 4: Desktop — `SendChatMessage` wiring + event re-broadcast

**Files:**
- Modify: `src-tauri/src/mobile/session_chat.rs`
- Modify: `src/state/chat.ts` (add `ownerSessionId` on in-flight turns, emit events)
- Modify: `src-tauri/src/mobile/relay.rs` (subscribe to the new Tauri events, re-broadcast as `DesktopMessage::SessionChatToken` etc. on the WS connection that originated the message)

**Interfaces:**
- Consumes: `chat::commands::send_chat_message` (existing), the new `chat:token` / `chat:status` / `chat:done` / `chat:error` / `chat:approval_request` / `chat:artifact` Tauri events (existing)
- Produces: A new Tauri event family `mobile:session_chat_event` carrying `{ session_id, kind, payload }`. The relay listens to that event and forwards over the per-WS event bus.

- [ ] **Step 1: Write the failing test for owner attribution**

```rust
#[test]
fn send_chat_message_attaches_owner_session_id() {
    // Call SessionChatManager::handle(SendChatMessage { session_id: "s1", .. }, ...)
    // Assert a chat_sessions row is created/updated with owner_session_id="s1".
    // Assert the row's id is returned so the relay can key future events.
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test --lib mobile::session_chat_tests::send_chat_message_attaches_owner_session_id`
Expected: FAIL.

- [ ] **Step 3: Implement `SendChatMessage` in `SessionChatManager`**

```rust
// In handle():
MobileMessage::SendChatMessage { session_id, text, attachments } => {
    // 1. Look up (or create) a chat_session row keyed by owner_session_id=session_id.
    // 2. Persist the user message (text + attachments).
    // 3. Call chat::commands::send_chat_message(chat_session_id, text, attachments).
    //    The chat command emits the existing chat:token / chat:status / chat:done / chat:error events.
    // 4. The chat state in src/state/chat.ts (modified in Step 4 below) attaches
    //    owner_session_id to the in-flight turn, so the relay can forward events
    //    to the right WS connection.
    Ok(vec![])
}
```

- [ ] **Step 4: Modify `src/state/chat.ts` to attach `ownerSessionId`**

Find the `sendMessage` action in the store. Add a new optional parameter `ownerSessionId?: string`. When provided, store it in module-scope (`ownerTurns.set(turnId, ownerSessionId)`). Expose a getter `getOwnerSessionId(turnId): string | undefined` that the Rust side can call to attribute a stream back to a session.

Wire the existing `chat:token` / `chat:status` / `chat:done` / `chat:error` / `chat:approval_request` / `chat:artifact` Tauri event listeners (search for `listen("chat:token"` and similar) so that when they fire AND an `ownerSessionId` is associated, they also emit a new Tauri event `mobile:session_chat_event` with payload `{ session_id, kind, payload }`.

- [ ] **Step 5: In `relay.rs`, subscribe to `mobile:session_chat_event` and forward**

The relay already has a per-WS sender. Add a Tauri event listener at relay-start that, on every `mobile:session_chat_event`, looks up which WS connection owns that `session_id` (the most recent `SendChatMessage` from that connection), and writes the corresponding `DesktopMessage` variant to that WS.

Implement the `kind` → `DesktopMessage` mapping:
- `kind === "token"` → `SessionChatToken`
- `kind === "status"` → `SessionChatStatus`
- `kind === "done"` → `SessionChatDone`
- `kind === "error"` → `SessionChatError`
- `kind === "approval"` → `SessionApprovalRequest`
- `kind === "artifact"` → `SessionArtifact`

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd src-tauri && cargo test --lib mobile::session_chat_tests`
Expected: PASS for the new test plus all earlier ones.

- [ ] **Step 7: Manual smoke test**

With the desktop running, hit the relay manually (use `wscat` or a small `node -e` script) and:
- Send `SendChatMessage { session_id: <existing>, text: "hi" }`
- Confirm you receive `SessionChatToken` events on the WS.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/mobile/session_chat.rs src-tauri/src/mobile/session_chat_tests.rs src-tauri/src/mobile/relay.rs src/state/chat.ts
git commit -m "feat(mobile-relay): wire SendChatMessage + per-session event re-broadcast"
```

---

## Task 5: Relay — dispatch new `MobileMessage` variants to `SessionChatManager`

**Files:**
- Modify: `src-tauri/src/mobile/relay.rs`

**Interfaces:**
- Consumes: every `MobileMessage` variant
- Produces: dispatch routes for the 5 new variants, ownership tracking of which `session_id` is owned by which `WsWriter`

- [ ] **Step 1: Write the failing test for dispatch routing**

```rust
#[test]
fn dispatch_get_session_messages_calls_session_chat_manager() {
    // Construct a MobileMessage::GetSessionMessages.
    // Call relay::dispatch_mobile(...).
    // Assert SessionChatManager was called (use a trait indirection or
    // call the function under test directly with a captured db).
}
```

If `relay::dispatch_mobile` is not a unit-testable function yet, extract one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test --lib mobile::session_chat_tests::dispatch_get_session_messages_calls_session_chat_manager`
Expected: FAIL.

- [ ] **Step 3: Extract `dispatch_mobile` and route the new variants**

In `relay.rs`, factor the body of the WS message handler into:

```rust
async fn dispatch_mobile(
    msg: MobileMessage,
    app: &AppHandle,
    db: Arc<Mutex<Connection>>,
    chat_mgr: Arc<ChatManager>,
    owner: Arc<Mutex<HashMap<String, WsWriter>>>,
) -> Vec<DesktopMessage>
```

The existing variants stay where they are. The 5 new variants forward to `SessionChatManager::handle`. The function returns the `Vec<DesktopMessage>` that should be sent back to the originating WS.

The WS handler writes each returned `DesktopMessage` to the socket and — for `SendChatMessage` — registers `owner_session_id → WsWriter` in the `owner` map so the `mobile:session_chat_event` listener (Task 4 Step 5) can find the right socket.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src-tauri && cargo test --lib mobile::session_chat_tests`
Expected: PASS for the new test plus all earlier ones.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/mobile/relay.rs src-tauri/src/mobile/session_chat.rs
git commit -m "feat(mobile-relay): dispatch new MobileMessage variants"
```

---

## Task 6: Mobile — extend `useRelay` with session-scoped senders + handlers

**Files:**
- Modify: `mobile/src/hooks/useRelay.ts`
- Modify: `mobile/src/lib/featureFlags.ts` (export `getUseChatSessionCached()` so useRelay can gate without await)

**Interfaces:**
- Consumes: existing `useRelay` API
- Produces: `getSessionMessages(sessionId, beforeId?, limit?)`, `sendSessionChatMessage(sessionId, text, attachments?)`, `cancelSessionStream(sessionId)`, `resolveSessionApproval(sessionId, pendingId, decision)`, `renameSession(sessionId, title)`. New event buses: `onSessionChatToken`, `onSessionChatDone`, `onSessionChatError`, `onSessionChatStatus`, `onSessionApprovalRequest`, `onSessionArtifact`, `onSessionMessages`.

- [ ] **Step 1: Write the failing test**

```ts
// mobile/src/hooks/useRelay.test.ts
import { encodeFrame, decodeFrame } from './useRelay';

test('round-trips a SendChatMessage frame', () => {
  const frame = encodeFrame({ type: 'SendChatMessage', session_id: 's1', text: 'hi', attachments: [] });
  const parsed = decodeFrame(frame);
  expect(parsed).toEqual({ type: 'SendChatMessage', session_id: 's1', text: 'hi', attachments: [] });
});
```

The test is a sanity check on the wire format. `encodeFrame` / `decodeFrame` are small helpers extracted from the handler so we can unit-test them without a WS.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mobile && npx vitest run src/hooks/useRelay.test.ts`
Expected: FAIL — helpers don't exist.

- [ ] **Step 3: Extract `encodeFrame` / `decodeFrame` and add the new senders**

```ts
// At the top of useRelay.ts:
export function encodeFrame(msg: object): string { return JSON.stringify(msg); }
export function decodeFrame(text: string): any { return JSON.parse(text); }

// In the DesktopMessage switch, add the 7 new cases (no-op dispatch is fine —
// the consumer hooks will subscribe directly to the event buses).

// New event buses (after the existing ones):
export const onSessionChatToken = new EventBus<{ sessionId: string; token: string }>();
export const onSessionChatDone = new EventBus<{ sessionId: string; usage?: ChatUsage }>();
export const onSessionChatError = new EventBus<{ sessionId: string; error: string }>();
export const onSessionChatStatus = new EventBus<{ sessionId: string; reason: string; message: string }>();
export const onSessionApprovalRequest = new EventBus<{ sessionId: string; pendingId: string; tool: string; summary: string; args: any }>();
export const onSessionArtifact = new EventBus<{ sessionId: string; messageId: number | null; artifact: { path: string; filename: string; inline?: { kind: 'jsx' | 'tsx'; code: string } } }>();
export const onSessionMessages = new EventBus<{ sessionId: string; messages: SessionMessage[]; hasMore: boolean }>();

// In useRelay() return:
getSessionMessages: (sid: string, beforeId?: number, limit = 50) =>
  _send({ type: 'GetSessionMessages', session_id: sid, before_id: beforeId ?? null, limit }),
sendSessionChatMessage: (sid: string, text: string, attachments: ChatAttachment[] = []) =>
  _send({ type: 'SendChatMessage', session_id: sid, text, attachments }),
cancelSessionStream: (sid: string) => _send({ type: 'CancelSessionStream', session_id: sid }),
resolveSessionApproval: (sid: string, pendingId: string, decision: 'approve' | 'deny') =>
  _send({ type: 'ResolveSessionApproval', session_id: sid, pending_id: pendingId, decision }),
renameSession: (sid: string, title: string) => _send({ type: 'RenameSession', session_id: sid, title }),
```

Also add a `SessionMessage` type in `mobile/src/lib/sessionMessage.ts` mirroring the desktop's `SessionMessageRecord` (id, role, content, created_at, input_tokens?, output_tokens?, cost_usd?, tool_calls?, artifact_paths?).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd mobile && npx vitest run src/hooks/useRelay.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/hooks/useRelay.ts mobile/src/hooks/useRelay.test.ts mobile/src/lib/sessionMessage.ts
git commit -m "feat(mobile): add session-scoped senders to useRelay"
```

---

## Task 7: Mobile — `useSessionChat` hook

**Files:**
- Create: `mobile/src/hooks/useSessionChat.ts`
- Create: `mobile/src/hooks/useSessionChat.test.ts`

**Interfaces:**
- Consumes: `useRelay` senders and event buses
- Produces:

```ts
interface UseSessionChat {
  messages: SessionMessage[];
  streamingText: string;          // accumulating assistant text mid-turn
  isStreaming: boolean;
  status: { reason: string; message: string } | null;
  pendingApproval: { pendingId: string; tool: string; summary: string } | null;
  artifacts: Record<number /* messageId */, Artifact[]>;
  error: string | null;
  hasMore: boolean;               // older pages exist
  loadMore: () => Promise<void>;
  send: (text: string, attachments?: Attachment[]) => void;
  cancel: () => void;
  resolveApproval: (pendingId: string, decision: 'approve' | 'deny') => void;
  rename: (title: string) => Promise<void>;
}

function useSessionChat(sessionId: string | null): UseSessionChat
```

- [ ] **Step 1: Write the failing test**

```ts
// mobile/src/hooks/useSessionChat.test.ts
import { renderHook, act } from '@testing-library/react-native';
import { useSessionChat } from './useSessionChat';
import { onSessionChatToken, onSessionChatDone } from './useRelay';

test('initial load fetches the latest 50 messages', async () => {
  const { result } = renderHook(() => useSessionChat('s1'));
  await act(async () => { /* let useEffect fire */ });
  expect(result.current.messages.length).toBe(0); // mocked relay returns []
  expect(result.current.hasMore).toBe(false);
});

test('streaming accumulates tokens and clears on done', () => {
  const { result } = renderHook(() => useSessionChat('s1'));
  act(() => onSessionChatToken.emit({ sessionId: 's1', token: 'hello ' }));
  act(() => onSessionChatToken.emit({ sessionId: 's1', token: 'world' }));
  expect(result.current.streamingText).toBe('hello world');
  expect(result.current.isStreaming).toBe(true);
  act(() => onSessionChatDone.emit({ sessionId: 's1' }));
  expect(result.current.isStreaming).toBe(false);
  expect(result.current.streamingText).toBe('');
});
```

Mock `useRelay` via a test-time module override (`vi.mock('./useRelay', ...)`) so the test doesn't open a real WS.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mobile && npx vitest run src/hooks/useSessionChat.test.ts`
Expected: FAIL — `useSessionChat` does not exist.

- [ ] **Step 3: Implement `useSessionChat`**

```ts
import { useCallback, useEffect, useReducer } from 'react';
import { useRelay, onSessionChatToken, onSessionChatDone, onSessionChatError,
  onSessionChatStatus, onSessionApprovalRequest, onSessionArtifact } from './useRelay';
import type { SessionMessage } from '../lib/sessionMessage';

const PAGE = 50;

interface State {
  messages: SessionMessage[];
  streamingText: string;
  isStreaming: boolean;
  status: { reason: string; message: string } | null;
  pendingApproval: { pendingId: string; tool: string; summary: string } | null;
  artifacts: Record<number, any[]>;
  error: string | null;
  hasMore: boolean;
}

type Action =
  | { type: 'set-messages'; messages: SessionMessage[]; hasMore: boolean }
  | { type: 'prepend-messages'; messages: SessionMessage[]; hasMore: boolean }
  | { type: 'append-message'; message: SessionMessage }
  | { type: 'token'; token: string }
  | { type: 'done' }
  | { type: 'error'; error: string }
  | { type: 'status'; status: State['status'] }
  | { type: 'approval'; approval: State['pendingApproval'] }
  | { type: 'artifact'; messageId: number; artifact: any }
  | { type: 'reset' };

function reducer(s: State, a: Action): State { /* …standard reduce… */ }

export function useSessionChat(sessionId: string | null) {
  const [state, dispatch] = useReducer(reducer, {
    messages: [], streamingText: '', isStreaming: false,
    status: null, pendingApproval: null, artifacts: {}, error: null, hasMore: false,
  });
  const relay = useRelay();

  // Reset + initial load on session change.
  useEffect(() => {
    if (!sessionId) return;
    dispatch({ type: 'reset' });
    relay.getSessionMessages(sessionId, undefined, PAGE);
  }, [sessionId]);

  // Subscribe to live events for this session only.
  useEffect(() => {
    if (!sessionId) return;
    const offToken = onSessionChatToken.on(({ sessionId: sid, token }) => {
      if (sid !== sessionId) return;
      dispatch({ type: 'token', token });
    });
    const offDone = onSessionChatDone.on(({ sessionId: sid }) => {
      if (sid !== sessionId) return;
      dispatch({ type: 'done' });
    });
    const offErr = onSessionChatError.on(({ sessionId: sid, error }) => {
      if (sid !== sessionId) return;
      dispatch({ type: 'error', error });
    });
    const offStatus = onSessionChatStatus.on(({ sessionId: sid, reason, message }) => {
      if (sid !== sessionId) return;
      dispatch({ type: 'status', status: { reason, message } });
    });
    const offApproval = onSessionApprovalRequest.on(({ sessionId: sid, pendingId, tool, summary }) => {
      if (sid !== sessionId) return;
      dispatch({ type: 'approval', approval: { pendingId, tool, summary } });
    });
    const offArtifact = onSessionArtifact.on(({ sessionId: sid, messageId, artifact }) => {
      if (sid !== sessionId) return;
      dispatch({ type: 'artifact', messageId: messageId ?? 0, artifact });
    });
    return () => { offToken(); offDone(); offErr(); offStatus(); offApproval(); offArtifact(); };
  }, [sessionId]);

  // Listen for SessionMessages responses (re-keyed by the relay).
  useEffect(() => {
    if (!sessionId) return;
    const off = relay.onSessionMessages?.on?.(({ sessionId: sid, messages, hasMore }) => {
      if (sid !== sessionId) return;
      dispatch({ type: 'set-messages', messages, hasMore });
    });
    return () => { off?.(); };
  }, [sessionId]);

  const loadMore = useCallback(async () => {
    if (!sessionId || !state.hasMore || state.messages.length === 0) return;
    const oldestId = state.messages[0].id;
    relay.getSessionMessages(sessionId, oldestId, PAGE);
  }, [sessionId, state.hasMore, state.messages]);

  const send = useCallback((text: string, attachments: any[] = []) => {
    if (!sessionId) return;
    relay.sendSessionChatMessage(sessionId, text, attachments);
  }, [sessionId, relay]);

  const cancel = useCallback(() => sessionId && relay.cancelSessionStream(sessionId), [sessionId, relay]);
  const resolveApproval = useCallback((pendingId: string, decision: 'approve' | 'deny') => {
    if (!sessionId) return;
    relay.resolveSessionApproval(sessionId, pendingId, decision);
    dispatch({ type: 'approval', approval: null });
  }, [sessionId, relay]);
  const rename = useCallback(async (title: string) => {
    if (!sessionId) return;
    relay.renameSession(sessionId, title);
  }, [sessionId, relay]);

  return { ...state, loadMore, send, cancel, resolveApproval, rename };
}
```

If `relay.onSessionMessages` is not exposed (it's an event bus, not a per-hook subscription), expose it from `useRelay.ts` (Task 6 already declares the bus; just add it to the return).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd mobile && npx vitest run src/hooks/useSessionChat.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/hooks/useSessionChat.ts mobile/src/hooks/useSessionChat.test.ts
git commit -m "feat(mobile): useSessionChat hook with streaming + pagination"
```

---

## Task 8: Mobile — `MessageBubble` component

**Files:**
- Create: `mobile/src/components/MessageBubble.tsx`
- Create: `mobile/src/components/MessageBubble.test.tsx`

**Interfaces:**
- Consumes: `SessionMessage`, `artifact?`, `onPreviewArtifact?`
- Produces: A `View` rendering the message in the right alignment + markdown + (when present) usage line, tool-call cards, diff, artifact chip, approval card slot

- [ ] **Step 1: Write the failing test**

```tsx
// mobile/src/components/MessageBubble.test.tsx
import { render } from '@testing-library/react-native';
import { MessageBubble } from './MessageBubble';

test('renders user message right-aligned', () => {
  const { getByTestId } = render(
    <MessageBubble message={{ id: 1, role: 'user', content: 'hi', created_at: 0 }} testID="bubble" />,
  );
  const bubble = getByTestId('bubble');
  expect(bubble.props.style).toMatchObject({ alignSelf: 'flex-end' });
});

test('renders assistant message with markdown', () => {
  const { getByText } = render(
    <MessageBubble message={{ id: 1, role: 'assistant', content: '# Hello', created_at: 0 }} />,
  );
  // The exact text node depends on the markdown renderer. Test for a substring
  // that survives markdown parsing: 'Hello' is in the heading text.
  expect(getByText(/Hello/)).toBeTruthy();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mobile && npx vitest run src/components/MessageBubble.test.tsx`
Expected: FAIL — `MessageBubble` does not exist.

- [ ] **Step 3: Implement `MessageBubble`**

```tsx
// mobile/src/components/MessageBubble.tsx
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { useTheme } from '../theme';

export interface BubbleProps {
  message: SessionMessage;
  streaming?: boolean;
  artifacts?: Artifact[];
  onPreviewArtifact?: (a: Artifact) => void;
  testID?: string;
}

export function MessageBubble({ message, streaming, artifacts, onPreviewArtifact, testID }: BubbleProps) {
  useTheme();
  const c = theme.colors;
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';

  return (
    <View testID={testID} style={[
      styles.bubble,
      isUser ? styles.user : styles.assistant,
      { backgroundColor: isUser ? c.surface2 : c.surface, borderColor: c.border },
    ]}>
      <View style={styles.header}>
        <Text style={[styles.role, { color: isUser ? c.primary : c.textSecondary }]}>
          {isUser ? 'You' : 'Assistant'}
        </Text>
      </View>
      <Markdown
        style={{
          body: { color: c.text, fontSize: 14, lineHeight: 20 },
          code_inline: { backgroundColor: c.surface2, color: c.text, fontFamily: 'monospace' },
          fence: { backgroundColor: c.surface2, borderColor: c.border, color: c.text, fontFamily: 'monospace' },
          link: { color: c.primary },
        }}
      >
        {message.content}
      </Markdown>
      {streaming && <Text style={{ color: c.primary }}>▌</Text>}
      {isAssistant && message.usage && (
        <Text style={[styles.usage, { color: c.textSecondary, borderTopColor: c.border }]}>
          {message.usage.input_tokens} in / {message.usage.output_tokens} out
          {message.usage.cost_usd > 0 ? ` · $${message.usage.cost_usd.toFixed(4)}` : ''}
        </Text>
      )}
      {artifacts && artifacts.length > 0 && (
        <View style={styles.artifactRow}>
          {artifacts.map((a) => (
            <ArtifactChip key={a.path} artifact={a} onPress={() => onPreviewArtifact?.(a)} />
          ))}
        </View>
      )}
    </View>
  );
}
```

If `react-native-markdown-display` is not installed, install it (`npm i react-native-markdown-display`) — this is the one allowed new top-level dep for the chat foundation. Otherwise use `react-markdown` with a custom RN renderer (heavier; not preferred).

For code blocks beyond what the markdown display handles natively, fall back to a `Text` with `fontFamily: 'monospace'` and `c.surface2` background — sufficient for v1.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd mobile && npx vitest run src/components/MessageBubble.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/components/MessageBubble.tsx mobile/src/components/MessageBubble.test.tsx
git commit -m "feat(mobile): MessageBubble component with markdown + usage + artifacts"
```

---

## Task 9: Mobile — `ChatComposer`, `ApprovalCard`, `StatusBanner`, `ArtifactChip`

**Files:**
- Create: `mobile/src/components/ChatComposer.tsx`
- Create: `mobile/src/components/ApprovalCard.tsx`
- Create: `mobile/src/components/StatusBanner.tsx`
- Create: `mobile/src/components/ArtifactChip.tsx`

**Interfaces:**
- `ChatComposer({ value, onChange, onSend, onStop, isStreaming, disabled, modelLabel, onPickModel, placeholder? })`
- `ApprovalCard({ approval, onApprove, onDeny })`
- `StatusBanner({ kind: 'unreachable' | 'loading-model' | 'info', title, subtitle? })`
- `ArtifactChip({ artifact, onPress })`

- [ ] **Step 1: Write the failing test for `ChatComposer`**

```tsx
import { render, fireEvent } from '@testing-library/react-native';
import { ChatComposer } from './ChatComposer';

test('send button fires onSend with trimmed text', () => {
  const onSend = vi.fn();
  const { getByTestId } = render(
    <ChatComposer value="  hi  " onChange={() => {}} onSend={onSend} onStop={() => {}} isStreaming={false} modelLabel="sonnet" />,
  );
  fireEvent.press(getByTestId('composer-send'));
  expect(onSend).toHaveBeenCalledWith('hi', []);
});

test('send button shows stop icon while streaming', () => {
  const { getByTestId } = render(
    <ChatComposer value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} isStreaming modelLabel="x" />,
  );
  expect(getByTestId('composer-send').props.accessibilityLabel).toBe('Stop generating');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mobile && npx vitest run src/components/ChatComposer.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the four components**

`ChatComposer`:
- Outer `View` with rounded border, `c.surface` background.
- Top row: model chip (shows `modelLabel`, tap → `onPickModel`).
- Middle: multiline `TextInput` with `placeholder` (default `'Message…'`), `onChangeText` → `onChange`. Enter sends; Shift+Enter newline. `onSubmitEditing` calls `onSend(value.trim(), [])`.
- Bottom row: paperclip icon (no-op for now — wired in a follow-up), send/stop circular button (testID `composer-send`, accessibilityLabel `'Stop generating'` when streaming, `'Send message'` otherwise). Disabled when `disabled` or `value.trim()` empty (unless streaming).

`ApprovalCard`:
- Row layout: warning icon + body (tool name bold, summary in monospace) + Deny + Approve once buttons. `c.warning` and `c.danger` for icon and Deny; `c.primary` for Approve. Calls `onApprove()` / `onDeny()`.

`StatusBanner`:
- Colored bar at the top. `unreachable` → `c.error` background tint; `loading-model` → `c.warning` tint with ActivityIndicator; `info` → `c.primary` tint. Renders `title` and optional `subtitle`.

`ArtifactChip`:
- Rounded pill: file icon + truncated filename. `onPress` → `onPress(artifact)`.

All use `theme.colors.*` and `theme.spacing.*`. No hardcoded colors.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd mobile && npx vitest run src/components/ChatComposer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/components/ChatComposer.tsx mobile/src/components/ChatComposer.test.tsx \
        mobile/src/components/ApprovalCard.tsx mobile/src/components/StatusBanner.tsx \
        mobile/src/components/ArtifactChip.tsx
git commit -m "feat(mobile): composer, approval card, status banner, artifact chip"
```

---

## Task 10: Mobile — `SessionChat` screen

**Files:**
- Create: `mobile/src/screens/SessionChat.tsx`
- Create: `mobile/src/screens/SessionChat.test.tsx`

**Interfaces:**
- Consumes: route param `{ session: Session }`, `useSessionChat(session.id)`, `useTheme`, `useRelay` (for `connect`, `providers`, `startLocalModel`, `onLocalModelReady`, `onLocalModelError`)
- Produces: A screen with header, status banner, inverted FlatList of `MessageBubble` + `ApprovalCard` slots, `ChatComposer`, and rename modal

- [ ] **Step 1: Write the failing test**

```tsx
import { render } from '@testing-library/react-native';
import { SessionChat } from './SessionChat';

test('renders composer + empty list when no messages', () => {
  const { getByTestId } = render(<SessionChat route={{ params: { session: { id: 's1', projectName: 'p', title: 't', status: 'idle', provider: 'claude', model: '', lastActivity: 0, isLive: true } } }} />);
  expect(getByTestId('chat-composer')).toBeTruthy();
});
```

Mock `useSessionChat` and `useRelay` via `vi.mock`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mobile && npx vitest run src/screens/SessionChat.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `SessionChat`**

```tsx
// mobile/src/screens/SessionChat.tsx
export function SessionChat({ route, navigation }: any) {
  const session: Session = route.params.session;
  const { connected, providers, connect, startLocalModel, desktopUnreachable } = useRelay();
  useTheme();
  const c = theme.colors;
  const chat = useSessionChat(connected ? session.id : null);
  const listRef = useRef<FlatList>(null);

  // Warm-up banner for local models — copy the ChatScreen logic.
  const [localStarting, setLocalStarting] = useState(false);
  useEffect(() => {
    const offReady = onLocalModelReady.on(() => setLocalStarting(false));
    const offErr = onLocalModelError.on(() => setLocalStarting(false));
    return () => { offReady(); offErr(); };
  }, []);
  useEffect(() => { if (session.isLocal) setLocalStarting(true); }, [session.isLocal]);

  // Auto-scroll to bottom on new message / streaming update.
  useEffect(() => {
    setTimeout(() => listRef.current?.scrollToOffset({ offset: 0, animated: true }), 50);
  }, [chat.messages.length, chat.streamingText]);

  const localModel = session.provider === 'local_gguf';
  const banner = !connected
    ? { kind: 'unreachable' as const, title: 'Desktop unreachable' }
    : localStarting
      ? { kind: 'loading-model' as const, title: 'Loading local model…' }
      : chat.status
        ? { kind: 'info' as const, title: chat.status.message }
        : null;

  // FlatList is inverted: onEndReached fires when the user scrolls to the
  // OLDEST end of the list (the bottom of an inverted list).
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.background }} edges={['top']}>
      <View style={[styles.header, { backgroundColor: c.surface, borderBottomColor: c.border }]}>
        <TouchableOpacity onPress={() => navigation.goBack()}><ArrowLeft size={20} color={c.primary} /></TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>
            {session.projectName} / {session.title}
          </Text>
        </View>
        <TouchableOpacity onPress={() => /* open rename modal */}><MoreHorizontal size={20} color={c.textSecondary} /></TouchableOpacity>
      </View>

      {banner && <StatusBanner {...banner} />}

      <FlatList
        ref={listRef}
        inverted
        data={[...chat.messages].reverse()}
        keyExtractor={(m) => String(m.id)}
        onEndReached={() => chat.loadMore()}
        onEndReachedThreshold={0.4}
        renderItem={({ item }) => (
          <MessageBubble
            message={item}
            streaming={chat.isStreaming && item === chat.messages[chat.messages.length - 1]}
            artifacts={chat.artifacts[item.id]}
          />
        )}
        ListFooterComponent={chat.pendingApproval ? (
          <ApprovalCard
            approval={chat.pendingApproval}
            onApprove={() => chat.resolveApproval(chat.pendingApproval!.pendingId, 'approve')}
            onDeny={() => chat.resolveApproval(chat.pendingApproval!.pendingId, 'deny')}
          />
        ) : null}
        contentContainerStyle={{ padding: 12, gap: 8 }}
      />

      {chat.streamingText ? (
        <View style={[styles.streamingPreview, { borderTopColor: c.border, backgroundColor: c.surface2 }]}>
          <Markdown>{chat.streamingText + '▌'}</Markdown>
        </View>
      ) : null}

      <ChatComposer
        value={composerText}
        onChange={setComposerText}
        onSend={(text) => { chat.send(text); setComposerText(''); }}
        onStop={chat.cancel}
        isStreaming={chat.isStreaming}
        disabled={!connected}
        modelLabel={session.model || session.provider}
        onPickModel={() => /* open model picker bottom sheet */}
      />
    </SafeAreaView>
  );
}
```

Add a rename modal (a centered overlay with a `TextInput` + Save/Cancel).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd mobile && npx vitest run src/screens/SessionChat.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/screens/SessionChat.tsx mobile/src/screens/SessionChat.test.tsx
git commit -m "feat(mobile): SessionChat screen with message list, approval, banners"
```

---

## Task 11: Mobile — wire `SessionChat` into navigation; gate old screens behind the flag

**Files:**
- Modify: `mobile/App.tsx`
- Modify: `mobile/src/screens/HomeScreen.tsx` (add last-message preview)
- Modify: `mobile/src/screens/ApprovalsScreen.tsx` (route to `SessionChat` when flag is on)
- Modify: `mobile/src/components/BottomNav.tsx` (drop Chat tab when flag is on)

**Interfaces:**
- Consumes: `useUseChatSession()` from `featureFlags`
- Produces: A `SessionChat` route on the Home stack. When the flag is off, navigation falls back to `SessionScreen`. When on, navigation lands on `SessionChat`.

- [ ] **Step 1: Write the failing test**

```tsx
// mobile/App.test.tsx
import { render } from '@testing-library/react-native';
import App from './App';

test('renders Home tab by default', () => {
  const { getByText } = render(<App />);
  // BottomNav labels: Home, Inbox, Settings (no Chat) when flag is on.
  // This test is gated on the flag's resolved value — run with feature on.
});
```

Skip if too brittle. The unit tests on `useUseChatSession` (Task 1) cover the gate logic; the App-level test is a smoke test only.

- [ ] **Step 2: Wire navigation**

In `App.tsx`:

```tsx
function HomeStackScreen() {
  return (
    <HomeStack.Navigator screenOptions={{ headerShown: false }}>
      <HomeStack.Screen name="HomeMain" component={HomeScreen} />
      <HomeStack.Screen name="SessionDetail" component={SessionScreen} />
      <HomeStack.Screen name="SessionChat" component={SessionChat} />
    </HomeStack.Navigator>
  );
}
```

In `BottomNav.tsx`, drop the Chat `Tab.Screen` when `useUseChatSession()` is true.

In `HomeScreen.tsx`, when the flag is on, render a last-message preview under the session title. For now, use `session.preview` (a new optional field) — the desktop doesn't supply it yet, so render `'(empty)'` if absent. (Follow-up: add a `preview` field to `SessionInfo`.)

In `ApprovalsScreen.tsx`, switch the `navigation.navigate('Home', { screen: ... })` target between `SessionDetail` and `SessionChat` based on the flag.

- [ ] **Step 3: Manual smoke test**

Run `npx expo start`, open the app, toggle the flag ON in Settings (5-tap easter egg), then:
- Tap a session card → opens `SessionChat` (not terminal).
- Send a message → bubbles stream in.
- Approve a tool call → turn continues.
- Toggle the flag OFF → restart → tap a session → old `SessionScreen` (terminal) shows.

- [ ] **Step 4: Commit**

```bash
git add mobile/App.tsx mobile/src/screens/HomeScreen.tsx mobile/src/screens/ApprovalsScreen.tsx mobile/src/components/BottomNav.tsx mobile/App.test.tsx
git commit -m "feat(mobile): gate SessionChat behind feature flag, drop Chat tab when on"
```

---

## Task 12: Mobile — flip the flag on by default + delete old screens

**Files:**
- Modify: `mobile/src/lib/featureFlags.ts` (change default to `true`)
- Delete: `mobile/src/screens/SessionScreen.tsx`
- Delete: `mobile/src/screens/ChatScreen.tsx`
- Delete: `mobile/src/components/AnsiRenderer.tsx`
- Modify: `mobile/App.tsx` (remove the Chat tab unconditionally; remove the `SessionDetail` route from the Home stack)
- Modify: `mobile/src/screens/ApprovalsScreen.tsx` (drop the flag check, always navigate to `SessionChat`)
- Modify: `mobile/src/components/BottomNav.tsx` (drop the Chat tab unconditionally)

- [ ] **Step 1: Update the default**

In `featureFlags.ts`, flip the default to `true` (set `cache` initial to `true` and treat absence as `true`). Existing users who set it to `false` keep it off (set `'0'` still wins).

- [ ] **Step 2: Delete the three files and the routes**

```bash
rm mobile/src/screens/SessionScreen.tsx mobile/src/screens/ChatScreen.tsx mobile/src/components/AnsiRenderer.tsx
```

Edit `App.tsx` and `BottomNav.tsx` to remove the now-dead code paths. Run `grep -r "AnsiRenderer\|SessionScreen\|ChatScreen" mobile/src` to find any remaining references; fix them.

- [ ] **Step 3: Run the full mobile test suite**

Run: `cd mobile && npx vitest run`
Expected: all green.

- [ ] **Step 4: Manual smoke test**

Rebuild the app, walk through every tab. Confirm:
- Home shows session cards with last-message preview.
- Tap a card → opens `SessionChat`.
- Inbox → tap an attention card → opens `SessionChat`.
- No Chat tab.
- No terminal artifacts anywhere.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(mobile): default to chat sessions, remove terminal screens"
```

---

## Verification (end-to-end)

1. **Desktop running**, relay up.
2. **Mobile app** with flag on:
   - Home tab shows project groups with session cards, each with a preview.
   - Tap a session → `SessionChat` opens with the latest 50 messages.
   - Scroll to the top → older page loads, scroll position preserved.
   - Type a message → sends, streams in.
   - If a tool call needs approval → inline card with Approve/Deny.
   - Local model session → warm-up banner appears, clears on ack.
   - Kill desktop → "Desktop unreachable" banner; restart → banner clears, list re-paginates.
3. **Light + dark** — toggle theme in Settings, walk every screen.
4. **Empty / 1-message / 200-message** sessions all render correctly.
5. **cargo test** green; **vitest** green.

## Out of scope (deferred, list kept for follow-up planning)

- Image / doc attachments through the composer.
- Voice input.
- Skills (`/slug`) menu on mobile.
- Connectors (Notion etc.) on mobile.
- Per-message edit / regenerate / delete actions.
- Offline outgoing message queue.
- Syncing `SessionInfo.preview` from the desktop (the last-message field on the session card).
