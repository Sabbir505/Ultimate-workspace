# Mobile App: Cursor-style Session Chat

**Date:** 2026-08-01
**Status:** Approved
**Owner:** Mobile team

## Context

The Conduit mobile app currently has two parallel interfaces:

1. **`SessionScreen` (Home tab → tap session)** — opens a raw terminal emulator showing the pty transcript of a CLI agent (Claude Code, Kimi, OpenCode). TUI arrow keys, font zoom, and a `$` shell input. This is a faithful viewport of the desktop's pane grid, not a chat.
2. **`ChatScreen` (Chat tab)** — a standalone generic chat that talks to any provider but is not bound to a session. Sends `ChatTurn` events; the desktop creates an ephemeral session, streams tokens, then deletes the session. No persistence, no project context.

The result is two chat entry points and a terminal emulator where users expect a chat. Sessions on the phone are not conversations — they are escape-sequence transcripts.

**Goal:** Replace the terminal-emulator session view and the standalone Chat tab with a single Cursor-style chat UI per session. Each project has a list of chat sessions; tapping one opens a message stream with a composer that drives the desktop's existing chat agent pipeline (markdown rendering, tool calls, approvals, artifacts). The user types plain text; the agent runs the CLI underneath invisibly.

**Approved approach:** Mirror the desktop's chat pipeline per session over the existing mobile relay. Reuse the desktop's `useChatStore` message schema so the mobile UI is a faithful subset of `ChatView` + `MessageBubble` + `ChatComposer`.

## User-facing changes

### 1. Three tabs, not four

| Before | After |
|---|---|
| Home · Chat · Inbox · Settings | Home · Inbox · Settings |

The Chat tab is folded. "New chat" now lives on the Home tab — the user picks a project and a harness, hits the `+`, and gets a session card. Tapping it opens the new chat UI.

### 2. Home tab

Visually identical to today with one addition: each session card shows a **last-message preview** (first ~80 chars of the last assistant or user message) under the title.

Cards remain grouped by project. The harness picker stays per-project. The `+` button still creates a session via the existing `CreateSession` IPC. Status dots, provider/model tag, and time-ago are unchanged.

### 3. New `SessionChat` screen (replaces `SessionScreen`)

Header: back arrow, `project / session-title`, three-dot menu (rename, permission mode).

Body: a virtualized message list. Each message is a `MessageBubble` that mirrors the desktop component:
- **User messages** right-aligned, neutral surface.
- **Assistant messages** left-aligned, full markdown (gfm, math via KaTeX, syntax-highlighted code blocks via Prism, mermaid diagrams, inline JSX/TSX preview).
- **Tool-call cards** collapsible inline (Read, Edit, Bash, etc.) with status dot.
- **Diff cards** rendered via `parseUnifiedDiff` (same as desktop).
- **Artifact chips** (generated files) tappable to open an in-app preview pane.
- **Approval cards** (file-write/tool-execute requests) inline in the stream with Approve/Deny buttons. **Decision:** approvals render in the message stream (desktop-style) — not as a top banner.
- **Token-usage line** under assistant messages (input/output + cost).

Above the list: status notices (local model warm-up, desktop unreachable) using the same banners the old ChatScreen already had.

Below the list: model selector chip (cloud/local, picker, effort) and the composer.

### 4. Composer (replaces `$` prompt + TUI keys)

A single rounded card:
- **Left:** paperclip — tap to attach an image or text file. Phase-1: text only; images/docs come in a follow-up.
- **Center:** multiline `TextInput`. Enter sends, Shift+Enter inserts a newline.
- **Right:** circular send / stop button (same icon swap as desktop).

Sending fires a `SendChatMessage { session_id, text, attachments }` over the relay. The desktop's chat store handles the rest.

### 5. Message history — paginated

**Decision:** load the latest 50 messages on open. On scroll-to-top, fetch the next 50 older, prepend to the list, preserve scroll position. Implemented as an inverted FlatList with `onEndReached` (which on an inverted list fires on the older end).

Rationale: the desktop loads all messages on open because it has a fast local SQLite. The phone doesn't, and sessions can accumulate hundreds of messages. Paginated load keeps memory + initial paint fast while still letting users read old context.

### 6. Local model behavior

Identical to the current `ChatScreen`:
- "Loading local model…" banner with spinner while the sidecar warms up.
- Cleared on `LocalModelReady` / `LocalModelError` ack.
- Tapping a stopped local model in the selector triggers `StartLocalModel` before the first message.

### 7. Inbox tab

Unchanged UI, but tapping an `AttentionCard` opens `SessionChat` (instead of the terminal `SessionScreen`). Pending tool-approval requests also surface as inline cards inside the message stream, so the user can resolve them without leaving the chat.

### 8. Settings tab

Unchanged.

## Architecture

### New mobile files

```
mobile/src/screens/SessionChat.tsx          — replaces SessionScreen + ChatScreen
mobile/src/components/MessageBubble.tsx     — desktop MessageBubble port
mobile/src/components/ChatComposer.tsx      — desktop ChatComposer port
mobile/src/components/ApprovalCard.tsx      — file-write / tool-execute approval
mobile/src/components/ArtifactPreview.tsx   — open / preview generated files
mobile/src/hooks/useSessionChat.ts          — local store for a single session
```

### Files to delete

- `mobile/src/screens/SessionScreen.tsx`
- `mobile/src/screens/ChatScreen.tsx`
- `mobile/src/components/AnsiRenderer.tsx` (terminal only)
- `mobile/src/hooks/useRelay.ts` chat paths get replaced; the relay connection layer stays

### Files to keep (with small edits)

- `mobile/App.tsx` — drop the Chat tab.
- `mobile/src/components/BottomNav.tsx` — 3 items instead of 4 (Home, Inbox, Settings).
- `mobile/src/screens/HomeScreen.tsx` — add last-message preview to session cards.
- `mobile/src/screens/ApprovalsScreen.tsx` — point navigation at `SessionChat`.
- `mobile/src/hooks/useRelay.ts` — extend with new message types and event handlers (no removal of existing surface).
- `mobile/src/theme.tsx` — already updated to match the desktop palette.

### Relay protocol — new mobile ↔ desktop messages

The existing relay has chat events keyed by `chat_session_id` (ephemeral) and CLI events keyed by `session_id` (persistent). We add a session-scoped chat channel that reuses the existing chat semantics but is tied to a long-lived `SessionInfo` row.

**Mobile → Desktop (additions to `MobileMessage`):**

```rust
// Paginated message history
GetSessionMessages { session_id: String, before_id: Option<i64>, limit: u32 }
// → SessionMessages { session_id, messages: Vec<SessionMessage>, has_more: bool }

// Send a chat message to a session (drives the desktop's chat agent)
SendChatMessage {
    session_id: String,
    text: String,
    attachments: Vec<ChatAttachment>,
}

// Cancel the in-progress stream for a session
CancelSessionStream { session_id: String }

// Resolve a pending tool approval
ResolveSessionApproval { session_id: String, pending_id: String, decision: String }

// Rename a session
RenameSession { session_id: String, title: String }
```

**Desktop → Mobile (additions to `DesktopMessage`):**

```rust
// Message history page
SessionMessages { session_id: String, messages: Vec<SessionMessageRecord>, has_more: bool }

// Streamed token (reuses ChatToken shape but keyed by session)
SessionChatToken { session_id: String, token: String }

// Stream completed
SessionChatDone { session_id: String, usage: Option<ChatUsage> }

// Stream failed
SessionChatError { session_id: String, error: String }

// Pre-token status (e.g. local model warming up)
SessionChatStatus { session_id: String, reason: String, message: String }

// Pending tool approval surfaced mid-turn
SessionApprovalRequest {
    session_id: String,
    pending_id: String,
    tool: String,
    summary: String,
    args: serde_json::Value,
}

// New artifact generated during a turn
SessionArtifact {
    session_id: String,
    message_id: Option<i64>,
    artifact: ChatArtifactPayload,
}
```

`SessionMessageRecord` mirrors the desktop's `ChatMessageRecord` shape: `id`, `role`, `content`, `created_at`, `input_tokens?`, `output_tokens?`, `cost_usd?`, `tool_calls?`, `artifact_paths?`. This lets the mobile `MessageBubble` render the same shapes the desktop does without a translation layer.

### Desktop changes (Rust + state/chat.ts)

In `src-tauri/src/mobile/relay.rs`:
- Handle the new `MobileMessage` variants.
- Forward them to the chat store (`useChatStore` on the React side, or a direct `chat::commands` call from Rust — the latter is cleaner since relays run server-side).
- Emit the new `DesktopMessage` variants back over WS as the chat pipeline progresses.

In `src/state/chat.ts`:
- The desktop already has the full chat machinery. It needs to know which session (`SessionInfo.id`) is the "owner" of a given chat turn, so the relay can attribute streamed tokens back to the right mobile listener. Either:
  - Add an optional `owner_session_id` column to the chat DB, or
  - Keep an in-memory map in the relay keyed by `SessionInfo.id → ChatMessage` while the turn is in flight.

The mobile app does **not** need a new chat DB. It queries the existing desktop `chat_sessions` / `chat_messages` tables via the relay.

### Mobile store

`useSessionChat` wraps a single session:

```ts
interface SessionChatState {
  messages: SessionMessageRecord[];     // current page
  hasMore: boolean;                     // older pages exist
  streaming: string;                    // accumulating assistant text
  isStreaming: boolean;
  status: { reason: string; message: string } | null;
  pendingApproval: PendingApproval | null;
  artifacts: Record<number, ChatArtifactPayload[]>;
  error: string | null;
  // actions
  loadInitial: () => Promise<void>;
  loadMore: () => Promise<void>;        // called from onEndReached
  send: (text: string, attachments: Attachment[]) => void;
  cancel: () => void;
  resolveApproval: (pendingId: string, decision: "approve" | "deny") => void;
  rename: (title: string) => void;
}
```

Subscriptions to `SessionChatToken`, `SessionChatDone`, `SessionChatError`, `SessionChatStatus`, `SessionApprovalRequest`, `SessionArtifact` are per-session — when `SessionChat` mounts, it subscribes; on unmount it unsubscribes and resets the in-memory buffer.

## Error handling

- **Desktop unreachable** — banner at the top of the message list, send button disabled, retry on reconnect. Mirrors current ChatScreen behavior.
- **Stream error mid-turn** — bubble for the in-flight message gets an inline error row (red `XCircle` + message), action bar hidden, composer re-enabled. User can retry by sending again.
- **Approval denied / expired** — turn continues with a "Denied" notice, message is finalized as if the agent had moved on. The desktop's existing chat agent already handles this.
- **Pagination race** — if `loadMore` is in flight when a new message arrives, append the new message without disturbing the older page; a single `setMessages` per event keeps order stable.
- **WS reconnect** — `useSessionChat` re-subscribes on reconnect and re-runs `loadInitial` to catch up.

## Testing

- **Unit (`mobile/` Vitest):** `useSessionChat` reducer: paginated loads, streaming accumulation, approval resolution, error states.
- **Integration:** run the desktop, point the mobile app at the relay, verify:
  - Create a session from Home → it appears in the list.
  - Tap the card → message list loads.
  - Send "hi" → assistant streams a response.
  - Approve a tool call inline → turn continues.
  - Kill the desktop → banner shows; restart → banner clears, list re-paginates.
  - Scroll to top on a 100-message session → older page loads, scroll position preserved.
- **Manual visual:** light + dark, every tab, empty session, 1-message session, 200-message session, session with diff cards, session with artifact chips, session waiting on approval.

## Out of scope (deferred)

- **Image / doc attachments** — composer paperclip is wired but the upload path is a follow-up.
- **Voice input** — Tauri desktop doesn't have it; mobile could add it but it's a separate spec.
- **Skills (`/slug`) menu** — desktop has it; mobile can add a long-press on the composer or a separate chip.
- **Connectors (Notion, etc.)** — desktop-only for now.
- **Edit / regenerate / delete per-message** — desktop has them; mobile can add as a follow-up once the chat foundation is stable.
- **Offline replay** — paginated history queries work on reconnect but we don't queue outgoing messages while disconnected.

## Migration / rollout

1. Land the new `SessionChat` + relay protocol changes behind a feature flag (`mobile.use_chat_session` in settings, default off).
2. Ship to a small cohort via EAS update.
3. Once the cohort reports no regressions, flip the default and delete `SessionScreen`, `ChatScreen`, `AnsiRenderer`.
4. Drop the Chat tab.

The flag is necessary because the relay protocol change requires a coordinated desktop + mobile release. Until both ship, the old terminal view stays as a fallback.
