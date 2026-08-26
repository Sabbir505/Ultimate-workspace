## Metrics row below the composer — full backend instrumentation

### Goal
Add a single text-only row under the composer notch bar showing, for the active chat session:
**LLM time** · **Tool call** · **TTFT avg** · **tok/s** · **Cache hit %** · **Input tokens** · **Output tokens**
(No background colors — plain text, well-spaced, per your request.)

Per your clarifications:
- **LLM time** = sum of all model-generation windows; **Tool time** = sum of all tool-execution windows (***execution only***, excluding approval waits).
- **Live tok/s + all cumulatives**: backend emits a throttled live perf event and persists final per-turn metrics to the DB; frontend reads persisted aggregates.

### 1. Backend types (`src-tauri/src/types.rs`)
Add fields (all `#[serde(default)]`, optional so legacy rows stay valid):
- `ChatDonePayload` — add `llm_time_ms: Option<i64>`, `tool_time_ms: Option<i64>`, `ttft_ms: Option<i64>`, `tokens_per_second: Option<f64>`, `cache_hit_rate: Option<f64>`.
- `ChatMessageRecord` — add the same persisted columns (mirrors existing `started_at`/`completed_at`).
- New `ChatPerfPayload` for the throttled live event: `{ chat_session_id, llm_time_ms, tool_time_ms, ttft_ms, tokens_per_second, output_tokens, elapsed_ms }`.

### 2. DB migration (`src/db/mod.rs` + `src/db/chat.rs`)
- New `migrate_chat_messages_perf(conn)` (same duplicate-column-tolerant pattern as `migrate_chat_messages_started_completed`) adding `llm_time_ms`, `tool_time_ms`, `ttft_ms`, `tokens_per_second` (INTEGER/REAL). Register in `migrate()` after line 110.
- `add_chat_message(...)` — extend signature + INSERT with the new columns.

### 3. Instrument the built-in chat (`chat/mod.rs`, `chat/streaming.rs`, `chat/dispatch.rs`)
- Add a small `TurnPerf` accumulator (`Instant`s + cumulative counters) threaded through the turn.
- **TTFT**: capture `Instant::now()` when the first token is emitted (around the `emit_token` sites in `run_chat_stream`, the tool loops, and `dispatch.rs`) → `ttft_ms = first_token_instant - turn_start`.
- **LLM time**: accumulate the time each generation window is actively emitting tokens (from stream-loop start to stream-loop completion of each model round).
- **Tool time**: `run_tool` measures execution duration (start→finish, excluding the approval pause). Because approval uses an await before execution, wrap *just* the execution segment.
- **tok/s** (persisted + live): `output_tokens_generated / llm_time_ms`.
- **cache hit %**: `cache_read_input_tokens / (cache_read + cache_creation + uncached_input)` from `ChatUsage`.
- Emit `ChatPerfPayload` via a new throttled `chat:perf` event (~every 500ms during streaming).
- Pass the cumulative numbers into the `Ok((full_response, usage))` branch and the `ChatDonePayload` emission in `chat/mod.rs`.

### 4. Instrument the harness/agent path (`agent_sessions.rs`)
- Same `TurnPerf` pattern around its streaming loop (`emit_token` helper at line ~1990) and its tool execution, wiring cumulative metrics into `emit_done` (line ~2002) and its DB persist.

### 5. IPC + frontend wiring
- `src/lib/ipc.ts`: extend `ChatDonePayload`/`ChatMessageRecord` TS types, add `ChatPerfPayload`, `listenChatPerf` listener, and `getChatSessionMetrics(sessionId)` command returning a session aggregate (summed from `chat_messages` rows: total llm/tool ms, avg ttft, weighted tok/s, cache %, input/output tokens).
- `src/hooks/useChatEvents.ts`: subscribe to `chat:perf` → update a per-session live-metrics slice in `useChatStore`.
- `src/state/chat.ts`: add `sessionMetrics[chatSessionId]` (live values during streaming) + merge on `onDone`.
- `src/components/chat/ChatView.tsx`: on session/messages change, call `getChatSessionMetrics` for the active session; pass a `metrics` object down to `<ChatComposer>`.
- `src/components/chat/ChatComposer.tsx` + `git`: render a `ComposerMetrics` row below the notch bar — plain text, spaced evenly, each labeled (`LLM 37.3s`, `Tool call 0.7s`, `TTFT avg 1.4s`, `72 tok/s`, `Cache hit 66%`, `Input 38.7K`, so on). Show `—` for metrics with no data yet; live values update during streaming.

### 6. CSS (`src/styles/global.css`)
`.composer-metrics-row` + `.composer-metric` styles — flex, even spacing, label dim + value bright, **no background/shadow**, small font (12px).

### 7. Verify
- `cargo check` (Rust) + `npx tsc --noEmit` (TS).
- Run app, send a chat turn, confirm live metrics stream and static row fills after completion. Then commit.

### Scope note
This touches ~8 files across Rust streaming, DB migration, IPC, state, and the composer. The tool-time "execution only" split means `run_tool` needs its execution segment wrapped in a timer (approval-wait excluded). TTFT is measured from turn start to first emitted token. Both built-in and harness paths are instrumented so the row works for all models.