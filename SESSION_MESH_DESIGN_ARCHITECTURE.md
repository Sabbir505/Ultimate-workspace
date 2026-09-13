# Session Mesh — cross-session awareness, messaging, and spawning

Status: **implemented** (P1+P2+P3 of §8; P4 hardening partially — settings
toggle `sessionMesh.enabled` is read by the runtime, the Settings panel
section and eval scenarios are still open). Companion docs:
`MEMORY_DESIGN_ARCHITECTURE.md` (its §2.5 G1 gap — "No cross-session state" — is exactly
this feature), `RESEARCH_MODE_IMPROVEMENTS_RESEARCH.md` (gap G4 / rec R11: orchestration
is one-shot and static).

Working name **Session Mesh**. Three capabilities, in dependency order:

1. **Awareness** — an agent knows which other chat sessions exist and what happened in
   them (registry + per-session summaries + transcript search).
2. **Messaging** — an agent can send a question or notice to another session and get the
   answer back into its own context.
3. **Spawning** — an agent can create a new, fully first-class chat session with a task,
   watch it, and message it.

Everything is built on existing rails: new entries in the `chat::tools` registry (built-in
loop) that are also whitelisted through the `relay-tools` MCP bridge (harness CLIs get them
for free — same dispatcher, `mcp_tools_bridge.rs`), new tables in `relay.db`, and new
`chat:*` Tauri events following the `chat:subagent-*` pattern.

---

## 1. Why now, and what exists today

- Sessions are already concurrent and enumerable: `AgentSessionManager` keeps a live
  per-chat map (`agent_sessions/mod.rs:69`), the store documents concurrent streaming
  (`src/state/chat.ts:681`), and `list_chat_sessions` gives every session's id, title,
  agent, project, and timestamps (`chat/commands/sessions.rs:37`).
- The model is currently told nothing about peers. The old doctrine line "No memory of
  other Relay sessions" was replaced by user-memory doctrine (`prompts.rs:810` test
  comment), but that memory is a user profile, not session knowledge. Nothing tells a
  session that 40 siblings exist or lets it reach one.
- The primitive ingredients all exist separately and are unused in combination:
  - `chat_messages_fts` — external-content FTS5 over every chat message, kept in sync by
    triggers, backfilled once (`db/mod.rs:908-928`, query helpers in `db/chat.rs`). Built
    for the command palette; nobody asks the *model* through it.
  - The `Task` tool — same-session ephemeral subagents, foreground or background
    (`chat/tools/mod.rs:132`, dispatch `chat/dispatch.rs:751-1029`). Not visible in the
    sidebar, dies with the chat, and cannot be resumed by the user.
  - `PendingAsk` — a turn parked awaiting an answer, with two routes: follow-up turn and
    opencode's native question parking (`agent_sessions/mod.rs:85-107`). Today only the
    *user* can answer.
  - `broadcastToSessions` — user-side fan-out of one prompt to N sessions, including
    background sessions that aren't open (`src/state/chat.ts:2387`). Proves a session can
    receive and run a turn it didn't originate from its own composer.
  - Automations — programmatically create a session and run turns in it, headless or
    in-app (`automations.rs:302-316`, `agent_sessions/oneshot.rs:14`).

What's missing is the connective tissue: a runtime that knows "who's out there", a mailbox
between sessions, and a spawn primitive that produces *first-class* sessions (resumable,
visible, user-ownable) rather than ephemeral subagents.

## 2. Prior art consulted

**Industry protocols.** MCP standardizes agent→tool; Google's A2A (agent2agent) standardizes
agent→agent task delegation over JSON-RPC with task lifecycle and artifacts. For a
single-user, local-first Tauri app, standing up an A2A HTTP transport, agent cards, and
OAuth between processes *inside one app* is unwarranted — but A2A's *shape* (declarative
peer discovery, task/message envelopes, async completion) is the right model, implemented
natively over SQLite + Tauri events.

**ChatGPT memory research** (our own `MEMORY_DESIGN_ARCHITECTURE.md` §3.1): OpenAI injects
a rolling profile of ~40 recent chats (titles + summaries + user messages) into every
system prompt. Two lessons we adopt and one we reject: (a) distilled *summaries*, not raw
transcripts; (b) confidence/labels on inferred knowledge. We reject always-injecting the
full roll — our frontier system-prompt budget is 9,250 bytes (`prompts.rs:772-796` test),
so the standing block must be tiny and depth must be on-demand via tools.

**Claude-Code-style agent messaging** (this harness's own SendMessage/agent model):
mailbox-style, addressable peers, results delivered as the agent's final message — the
shape `message_session` copies.

## 3. Architecture overview

```
                    ┌────────────────────────────────────────────┐
                    │            session_fabric (new)            │
                    │  registry block · summaries worker ·       │
                    │  mailbox · spawn · guards                  │
                    └──────┬───────────────┬─────────────┬───────┘
        chat::tools registry│               │             │
   ┌────────────────────────┘               │             └───────────────────┐
   ▼                                        ▼                                 ▼
built-in chat loop                   relay-tools MCP bridge           harness CLIs
(execute_tool dispatch.rs)          (ALLOWED_RELAY_TOOLS)            (claude/opencode/…)
   │                                        │                                 │
   └────────────── same tools: list_sessions · read_session · search_sessions ─┘
                             message_session · spawn_session

DB: session_summaries · session_mail · chat_sessions.origin   Events: chat:session-mail,
FTS: chat_messages_fts (existing)                             chat:session-spawn
```

One implementation, two consumers: dispatch for built-in chats goes through
`chat::tools::execute_tool` → `chat/dispatch.rs` (where `Task` already lives); harness CLIs
reach the identical handlers because `mcp_tools_bridge::execute_relay_tool`
(`mcp_tools_bridge.rs:70`) deliberately routes through the same dispatcher. New ops are
added to `ALLOWED_RELAY_TOOLS` (`:32`) and the MCP manifests
(`harness_bundle.rs:333`, opencode flavor `:405`).

### Caller identity

Tools are session-scoped (self-exclusion, project scope, mail routing), so the dispatcher
needs the calling chat's id. Built-in chats already have it in `dispatch.rs`. For the
relay-tools path, the sidecar is registered per chat bundle at spawn time — extend the
sidecar's CLI args (or the `relay_tools:` WS op envelope) with the chat session id, set
where the bundle is built (verification note: `bundle.rs` writes per-project files today;
per-chat worktree cwd gives per-chat bundles, and automations already thread run-log
session ids through `run_one_shot`, so the plumbing pattern exists). Fallback during
brings-up: the registry block states "your session id", and tools accept an explicit
`session_id` argument validated against live sessions.

## 4. Capability 1 — Awareness

### 4.1 Session summaries (the distillation layer)

New table (mirrors `session_summaries` pattern of memory's one-document store):

```sql
CREATE TABLE IF NOT EXISTS session_summaries (
  chat_session_id TEXT PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,            -- ≤ 2 sentences, what this session did/decided
  topics TEXT NOT NULL,             -- comma keywords for the registry line
  model TEXT,                       -- which model produced it
  updated_at INTEGER NOT NULL
);
ALTER TABLE chat_sessions ADD COLUMN origin TEXT;
-- origin: NULL = human-created; 'spawned_by:<chat_id>'; 'automation:<id>'
```

Worker (pattern-copy of `memory/worker.rs::spawn_turn_extraction`): on turn completion, if
the session has ≥ 2 user turns and the summary is absent or older than `last_active_at`,
schedule a background one-shot via the existing `openai_oneshot`/`anthropic_oneshot`
helpers (`chat/commands.rs`, consumers at `chat/mod.rs:1361`). Model default =
`memory.extractModel`; new setting `sessionMesh.summaryModel`. Tiny sessions are skipped.
Summaries are plain data — visible/editable in a future settings surface, like
ChatGPT's inspectable saved memories.

### 4.2 Tools

| Tool | Args | Returns |
|---|---|---|
| `list_sessions` | `scope?: "project"\|"all"` (default project+unscoped), `limit?` (default 12) | id, title, agent/model, project, status (`active_turn`/`idle`/`has_queued_mail`), age, summary line, origin. Excludes self. |
| `read_session` | `session_id`, `mode: "summary"\|"recent_turns"\|"transcript"`, `max_chars?` | summary, last N messages (role-tagged, char-capped), or full transcript capped ~24k chars |
| `search_sessions` | `query`, `scope?`, `limit?` | matching sessions with FTS excerpts (reuses `chat_messages_fts` query helpers in `db/chat.rs` + `session_summaries`) |

All read-only → immediately also whitelisted in `ALLOWED_RELAY_TOOLS`.

### 4.3 Injection (the standing hint)

A compact registry block, budget ≤ 600 tokens, assembled by
`session_fabric::registry_block(conn, self_id)`:

```
## Relay sessions (Session Mesh)
You are one of N active Relay chat sessions. Your session id: <id>.
Nearby peers (call list_sessions for the full index; read_session/search_sessions for depth):
- "<title>" (a1b2, claude_code, project relay, idle 3h) — <summary line>
- ...
Peers are separate conversations with the same user. Consult them instead of guessing
what happened elsewhere; ask before duplicating in-progress work.
```

- **Built-in:** slot in `build_system_prompt` after the memory block
  (`chat/prompts.rs:675-761`); raise the byte-budget test accordingly.
- **Harness:** appended in `harness_context_section` (`agent_sessions/bundle.rs:73-107`),
  riding the same first-turn assembly as the MCP manifest (`agent_sessions/mod.rs:528-596`).
- Order: same-project first, then starred, then most recent. Sessions with `origin` get a
  "spawned by <title>" suffix.

## 5. Capability 2 — Messaging

### 5.1 Mail table

```sql
CREATE TABLE IF NOT EXISTS session_mail (
  id TEXT PRIMARY KEY,
  from_session TEXT NOT NULL,
  to_session TEXT NOT NULL,
  mode TEXT NOT NULL,               -- 'question' | 'notify'
  body TEXT NOT NULL,
  status TEXT NOT NULL,             -- queued|delivered|answered|expired|rejected
  answer TEXT,
  depth INTEGER NOT NULL DEFAULT 0, -- forwarded-question chain depth
  created_at INTEGER NOT NULL,
  delivered_at INTEGER, answered_at INTEGER
);
```

The mail table *is* the audit log — every agent-to-agent exchange is inspectable, which is
the transparency ChatGPT's inferred-profile lacks.

### 5.2 Tool: `message_session`

```
message_session(session_id, body, mode: "question"|"notify", timeout_s?: ≤120, default 25)
```

**Delivery.** Build an envelope turn and hand it to the *normal* send path of the target —
`AgentSessionManager::send` for harness targets, the built-in pipeline for provider
targets — so persistence, streaming, worktrees, approvals, and event wiring all come free
(the same trick `broadcastToSessions` uses from the UI). Envelope (user-role, explicitly
not-from-human):

```
[Relay inter-session mail — NOT typed by the user]
From: session "<title>" (id <id>, agent claude_code, project relay) — depth 1
Mode: question — your final message this turn is delivered back to the asker.
Body:
<question>
```

**Busy target.** `send` rejects while `turn_in_flight` (`agent_sessions/mod.rs:451`);
instead of erroring, the mail row goes `queued` and is drained by a
`FabricRuntime::on_turn_complete(target_id)` hook called from both turn-end sites (harness:
where the flag clears at `mod.rs:736`; built-in: stream-finish in `chat/streaming.rs`).
Queue depth cap 5; overflow → `expired` with a clear tool result.

**Answers.** When the target's answering turn completes, its final assistant text is
stored as `answer`, the row flips to `answered`, and:
- if the asker's tool call is still parked → the call resolves with the answer;
- if it timed out → the answer is delivered to the asker as a follow-up turn
  ("Reply from session …"), reusing the proven `PendingAsk::FollowUpTurn` route
  (`dispatch_ask_follow_up`) so the asker's CLI session is resumed with it.

Blocking-by-default with graceful async fallback covers both patterns (quick consult vs.
long delegation) without a second tool.

**Guards.** No self-mail; forward depth ≤ 2 (A→B→C ok, no D); ≤ 10 mails per target
session per hour; question mode requires the target to be non-`origin:-cyclic` (cheap
ancestor check via `origin` chain); every delivery emits `chat:session-mail` to the UI.

### 5.3 UI

New payload `SessionMailPayload` in `types.rs` (from/to ids+titles, mode, status, excerpt)
→ `chat:session-mail` event → `useChatEvents.ts` → `useChatStore`. Inline mail cards in
the chat transcript, styled like `SubagentPanel` entries, with a jump-to-session link;
background arrivals light the existing `unread` badge (`set_chat_session_unread`,
`chat/commands/sessions.rs:547`). Both sides see the same card — no silent channel.

## 6. Capability 3 — Spawning

### 6.1 Tool: `spawn_session`

```
spawn_session(
  task,                       // what the new session should do (its first turn)
  title?, agent?, model?,     // defaults: parent's agent, parent's model
  project_id?,                // default: inherit parent's
  mode: "background"|"wait",  // wait = resolve tool call with the result, timeout ≤ 120s
)
```

Creates a **real, first-class session**: `db::create_chat_session` row → title from the
task → `origin = spawned_by:<parent>` → seed first turn with a task envelope
(`[Task from parent session <id/title>]` + expected deliverable) → run the turn in a
background tokio task through the same send path as messaging (harness: `AgentSessionManager::send`
with the fresh-CLI primer machinery handling first-turn instructions; provider: the
built-in pipeline). `wait` mode joins with the timeout and returns the final text +
session id (the `Task` tool's foreground/background split, but the artifact survives).

Why not reuse `Task`: subagents are invisible, ephemeral, same-model, and
read-only-gated (`SUBAGENT_TOOL_ALLOW`, `dispatch.rs:1023`). Spawns are the opposite
trade: visible in the sidebar, resumable by the user for days, full tool access, and —
Relay's differentiator — **cross-harness** (a claude_code session can delegate to an
opencode session, each in its own worktree).

**Guards.** ≤ 3 live spawned children per parent (spawn-tree depth ≤ 2 via `origin`
chain); global ≤ 8 active spawned sessions; spawned sessions inherit the parent's
permission/approval policy; a spawned session can `message_session` its parent by id (the
registry block gives it the parent's id via a "spawned by" line) but cannot spawn until
its first turn completes.

### 6.2 UI

`chat:session-spawn` event → inline card in the parent ("Spawned session *<title>* — open")
and the new session appears in the sidebar immediately with a subtle origin tag; the user
can watch its stream live (per-session `stream_events` channels already support this) and
take over at any time — the agent's session is just a session.

## 7. Consent, safety, cost

This feature lets agents spend the user's tokens and touch other conversations without the
user typing. Controls, in order of force:

1. **Visibility first** — every mail/spawn is a UI event on both sides; nothing is silent.
2. **Master toggle** — `sessionMesh.enabled` (default on) plus per-capability toggles
   (`messaging`, `spawning`) in Settings; when off, tools return a clear "disabled" result
   so the model can tell the user.
3. **Hard caps** — depth, rate, and concurrency limits above; a runaway mesh hits them in
   seconds, and the mail table shows exactly where it went.
4. **Permission-mode respect** — messaging/spawn dispatch runs under the target's existing
   `approval_policy`; a target in a strict mode surfaces approval cards as usual. Peer
   mail is *not* exempt from approvals.
5. **Scope defaults** — awareness defaults to the session's own project; `scope:"all"` is
   explicit in the tool call, and the registry block labels cross-project peers.

Deliberately **not** built: pub-sub broadcast between agents (chaotic, unauditable —
point-to-point only), autonomous message loops without user-visible cards, agent-initiated
deletion/rename of other sessions, raw full-transcript injection into prompts, and any
network transport (A2A-over-HTTP) — peers are always local sessions.

## 8. Implementation phases

| Phase | Scope | Key files |
|---|---|---|
| **P1 — Awareness** (foundation, read-only, shippable alone) | `session_summaries` + `origin` migration; `src-tauri/src/session_fabric/mod.rs` (registry block, summary worker); `list_sessions`/`read_session`/`search_sessions` tools + specs + dispatch; injection into both prompt paths; doctrine text update + `prompts.rs:810` test anchors; whitelist the three tools in `mcp_tools_bridge.rs:32` | `db/mod.rs`, `session_fabric/*`, `chat/tools/{mod,specs}.rs`, `chat/dispatch.rs`, `chat/prompts.rs`, `agent_sessions/bundle.rs`, `chat/commands/send.rs:988` |
| **P2 — Messaging** | `session_mail`; envelope build + queue + drain-on-turn-complete hook; answer capture + blocking/async routes; guards; `chat:session-mail` events, store wiring, mail cards, unread; caller-identity plumbing for the relay-tools sidecar | `session_fabric/mail.rs`, `agent_sessions/mod.rs:451,736`, `chat/streaming.rs`, `mcp_tools_bridge.rs`, `types.rs`, `src/hooks/useChatEvents.ts`, `src/state/chat.ts`, new `SessionMailCard.tsx` |
| **P3 — Spawning** | `spawn_session` (bg + wait); caps; origin tag in sidebar; `chat:session-spawn` event + card; parent↔child mail ergonomics | `session_fabric/spawn.rs`, `chat/tools/*`, `Sidebar.tsx`, `ChatSessionRow.tsx` |
| **P4 — Hardening** | Settings panel section; summary viewer/editor; eval scenarios (`session_fabric/eval.rs`, pattern of `memory/eval.rs`); CHANGELOG + docs | settings, `session_fabric/eval.rs` |

P1 is ~1 day of Rust + a test pass; P2 is the bulk (mailbox + two turn-end hooks + UI);
P3 is small once P2's send-into-session plumbing exists; P4 is polish.

### Test plan

- Rust unit tests beside each module (repo pattern: inline `#[cfg(test)]`, e.g.
  `prompts.rs:800`): registry block budget/ordering; envelope shape; queue→drain on
  turn-complete; answer round-trip incl. timeout→follow-up-turn path; guard caps; origin
  chain depth; migration add-column on a legacy DB.
- Vitest: `useChatEvents` mail/spawn dispatch; store unread wiring.
- Eval scenarios (P4): "ask the peer that wrote the auth doc"; "spawn a worker to migrate
  tests, wait, incorporate result"; "cross-harness: claude session consults opencode
  session"; runaway-mesh cap test; disabled-toggle tool result.

## 9. Open questions (implementation-time)

1. Sidecar caller-identity: per-chat `--chat-session-id` arg vs. WS op envelope field —
   decide when touching `bundle.rs` (§3 fallback works meanwhile).
2. Built-in turn-end hook placement: confirm single choke point in `chat/streaming.rs`
   covers the approval-question parked path too (opencode's native `question` route parks
   differently — mail to a parked session should deliver *after* the park resolves).
3. Should `read_session` transcript mode require the target to be idle, to avoid reading a
   turn mid-flight? (Likely: return summary + "target is streaming" note.)
4. Summary staleness vs. cost: re-summarize on every Nth turn vs. session close only —
   start with close + every 10th user turn, tune via eval.
