# Local Model Log + Gateway — Implementation Plan

> **Status:** IMPLEMENTED (2026-09-29) — all three phases landed. See §12 for
> what live testing against a real `llama-server` changed, including three
> bugs that unit tests structurally could not have caught.
> API reference from the Ollama / llama.cpp / LM Studio doc sweep is folded into
> §3 and §5, then corrected by measurement in §12.

## 1. What we're building

Two things that share one store:

1. **A request log for local-model traffic.** Every call to a local model —
   llama.cpp sidecars Relay spawns, Ollama, LM Studio — is recorded with its
   verbatim request and response bodies plus normalized telemetry (token
   counts, TTFT, tok/s, timings). Surfaced in a new full-page **Logs** view
   reachable from a footer icon.
2. **A loopback gateway.** Other apps point their `base_url` at Relay, and
   Relay forwards the call to the real runtime, streams the response back
   unchanged, and logs it. Relay becomes a drop-in local gateway that happens
   to record everything.

## 2. The key design decision: byte-level passthrough

The three runtimes disagree on wire format in ways that would wreck a
re-framing proxy:

| Runtime | Streaming framing |
|---|---|
| Ollama | **newline-delimited bare JSON** — not SSE. No `data:` prefix at all. |
| llama.cpp | SSE `data: {...}`, terminated by `data: [DONE]`. Timings/usage arrive in a final event *after* `finish_reason`. |
| LM Studio | SSE with **named events** — `event: chat.start`, `event: message.delta`, `event: chat.end` — not plain OpenAI `data:` frames. |

So the gateway **never re-frames**. It forwards bytes unchanged and only
rewrites the upstream host/port plus headers. A copy of what it forwarded is
captured for the log, and *telemetry extraction happens after the fact* on
that copy, in an isolated normalizer that knows all three formats.

This matters more than it looks:

- The hot path cannot corrupt a response. Framing bugs are impossible by
  construction, because the proxy never interprets the stream.
- Streaming stays zero-buffer. No latency added to Relay or to other apps.
- Adding a fourth runtime later means adding one row to a match table, not
  touching the proxy.
- Raw bodies are stored, so **telemetry parsing can be fixed later without
  re-capturing anything.** A field-name mistake in the normalizer is a
  migration away from disaster.

The corollary: the log is *correct* even where the normalizer is *wrong*.
Every normalized field is optional and nullable.

## 3. Architecture

```
  Relay chat ──> existing streaming path ──┐
                                           │  in-process capture
                                           ├──> llm_log::record ──> SQLite `llm_log`
  other app ──> RELAY GATEWAY (127.0.0.1) ─┘         ▲
   (base_url)      │                                 │
                  ├─ passthrough ─> ollama    :11434 │ read-only IPC
                  ├─ passthrough ─> lmstudio  :1234  │ + Logs view
                  ├─ passthrough ─> llamacpp  :PORT  │
                  └─ /_relay/logs (read-only) ─────────┘
```

Two capture origins, one table:

- **`origin = 'relay'`** — Relay's own calls, captured in-process where the
  request and response are already in hand. No extra hop. Covers the
  llama.cpp sidecar *and*, for free, every cloud provider.
- **`origin = 'external'`** — anything arriving at the gateway.

### What we deliberately do NOT do

**We do not route Relay's own traffic through the gateway.** The explore
pass found that `chat/commands/send.rs:869-887` (the sidecar auto-warm path)
rewrites `chat.local_gguf.base_url` to the sidecar's real port, and
`llm_client.rs:20-32` gives `local_gguf` no default base at all. Putting the
gateway in that path means teaching the warm path about indirection, and it
buys nothing — in-process capture at the same call sites is cheaper and has
no hop. Existing chat behaviour stays byte-identical.

The gateway still enables a future Ollama/LM Studio chat provider: point
`chat.<provider>.base_url` at the gateway and it just works, with no warm-path
surgery, because those settings have no auto-warm rewrite.

## 4. Persistence

New table in `src-tauri/src/db/mod.rs`. Shaped after `chat_messages` (session-
independent, `created_at`-indexed) rather than `cost_events` — `cost_events`
is FK-scoped to harness `sessions(id)` and local-model usage never reaches it
today.

```sql
CREATE TABLE IF NOT EXISTS llm_log (
  id                TEXT PRIMARY KEY,          -- uuid v4
  created_at        INTEGER NOT NULL,
  origin            TEXT NOT NULL,            -- 'relay' | 'external'
  target            TEXT NOT NULL,            -- 'llamacpp' | 'ollama' | 'lmstudio' | provider id
  method            TEXT NOT NULL,
  path              TEXT NOT NULL,
  model             TEXT,
  upstream_status   INTEGER,
  error             TEXT,
  duration_ms       INTEGER,
  ttft_ms           INTEGER,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  tokens_per_second REAL,
  request_bytes     INTEGER NOT NULL DEFAULT 0,
  response_bytes    INTEGER NOT NULL DEFAULT 0,
  truncated         INTEGER NOT NULL DEFAULT 0,
  request_body      TEXT,
  response_body     TEXT,
  timings_json      TEXT                      -- raw per-runtime timings, verbatim
);
CREATE INDEX IF NOT EXISTS idx_llm_log_created ON llm_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_log_target  ON llm_log(target, created_at DESC);
```

`timings_json` stores the runtime's own timings object untouched, so a
normalizer bug is always recoverable and a future runtime's extra fields
survive without a migration.

**Migration rule (easy to get wrong):** a new migration must be registered in
*both* `init` (`db/mod.rs:299-325`) and the test helper `mem()`
(`db/mod.rs:1764-1802`), or the in-memory test DB diverges from production.
Follow the duplicate-column-tolerant `ALTER` idiom from
`migrate_chat_messages_perf` (`db/mod.rs:842-856`).

### Retention

Settings-driven, pruned by a background hourly task (never inline on the hot
path):

- `logs.retentionDays` — default 7
- `logs.maxRows` — default 5,000
- `logs.maxBodyKb` — default 256; a longer body is truncated with `truncated = 1`.
  Embedding vectors would otherwise dominate the row size.

### Target classification

Derived from the resolved base URL, so it works without new provider plumbing:

- port `11434` → `ollama`
- port `1234` → `lmstudio`
- a sidecar in `LocalModelRegistry` → `llamacpp`
- otherwise → the provider id verbatim (`anthropic`, `openai`, …)

## 5. Normalization

Pure, table-driven, no I/O — the easiest thing in the plan to test. Every field
is `Option`; a missing or renamed field yields `None`, never an error.

| Format | `input_tokens` | `output_tokens` | `tokens_per_second` | `ttft_ms` |
|---|---|---|---|---|
| Ollama NDJSON (final `done:true`) | `prompt_eval_count` | `eval_count` | `eval_count / (eval_duration/1e9)` | `prompt_eval_duration` ns → ms |
| llama.cpp SSE (final event) | `usage.prompt_tokens`, else `timings.prompt_n` | `usage.completion_tokens`, else `timings.predicted_n` | `timings.predicted_per_second` | first `data:` frame − send |
| LM Studio named SSE (`chat.end`) | `usage.prompt_tokens` | `usage.completion_tokens` | `stats.tokens_per_second` | `stats.time_to_first_token` |
| OpenAI-compat (llama.cpp `/v1`, LM Studio `/v1`) | `usage.prompt_tokens` | `usage.completion_tokens` | derived from duration | first frame − send |

Durations normalize to ms; Ollama reports nanoseconds. One match table keyed on
`(detected framing, detected field probe)` drives all four rows — adding a
runtime is a new row, not a new code path.

## 6. Gateway

`src-tauri/src/llm_log/gateway.rs`, on the raw `tokio::net::TcpListener` idiom
from `automation_webhook.rs:57-209` (consistent with the four existing loopback
servers and zero new dependencies — no axum/hyper in the tree today).

**This is the first thing in the repo that needs real HTTP**: full header
parsing (not just the request line), `Content-Length` body reads, and
**chunked response writing**. That last one is the real work — `respond()` at
`automation_webhook.rs:201-209` writes a fixed body and closes. Budget ~200
lines and unit-test the request parser as a pure function first, the way
`automation_webhook.rs:211-230` tests `parse_trigger_path`.

### Routes

| Route | Purpose |
|---|---|
| `/v1/*`, `/api/*`, `/api/v0/*`, `/completion`, … | Passthrough. Path forwarded verbatim to the resolved target. |
| `GET /_relay/health` | Gateway status + per-target reachability. |
| `GET /_relay/logs` | Read-only listing (filters, pagination). |
| `GET /_relay/logs/{id}` | One entry, full bodies. |
| `DELETE /_relay/logs` | Clear. |

Target selection, in precedence order: `X-Relay-Target` header → `/t/<target>/…`
path prefix → the configured default target. Unknown target → 404.

### Auth

Bearer token, generated at startup, rotated each launch, compared in constant
time. `subtle` **2.6.1 is already a direct dependency** (`Cargo.toml:134`) and
already imported two ways in-tree — copy `use subtle::ConstantTimeEq` from
`automation_triggers.rs:300` rather than the hand-rolled XOR fold in
`browser_mcp.rs:227-243` (which hand-rolls it *despite* knowing the crate is
available — see its own comment at :231). Pre-auth budget of 5s /
8 KiB, matching `automation_webhook.rs:181-199`, so an unauthenticated peer
can't hold a socket open. Token is shown in the Logs view with a copy button.

Port is persisted to `gateway.port` so other apps get a stable URL across
restarts (binds `:0`, then writes the actual port — same pattern as
`automations.triggerPort`). Default `gateway.requireAuth = true`; loopback-only
is available as an explicit opt-out, not the default.

## 7. In-process capture (Relay's own calls)

Two helpers in `llm_log`:

- `llm_log::begin(origin, target, method, path, model, request_body) -> RequestId`
- `llm_log::finish(id, Outcome)` — status, assembled response body, usage, timing

Call sites — all already hold both halves of the exchange:

- `chat/mod.rs::run_chat_stream` (~1814) — build request, stream, `parse_usage`
- `chat/streaming.rs::run_openai_tool_loop` (~1292) / `run_anthropic_tool_loop` (~1664)
- `chat/llm_client.rs::oneshot` (117-149) — titles, commits, memory, compaction

Assembling the response body for streaming means accumulating the deltas the
pump already produces, truncated to `logs.maxBodyKb`. Tool-loop turns record
one entry per model round, not one per turn — otherwise a 20-tool turn becomes
20 rows and the log stops being readable.

`chat/turn_perf.rs` already computes TTFT and tok/s per turn
(`ChatPerfPayload`, `types.rs:770-791`); reuse those values rather than
re-deriving them.

## 8. Frontend

**A full-page real view**, matching crew/automations/vault — not an overlay.
Footer-icon-plus-overlay is the cost pattern, but Logs wants vertical space for
a scrolling table with a detail pane.

| # | File | Change |
|---|---|---|
| 1 | `src/state/ui.ts:20-27` | Add `\| "logs"` to `ActiveView`; update the doc comment at :17-19. |
| 2 | `src/lib/viewKinds.ts` | **No change** — omitting it from `isOverlayView` is what makes it a real view. |
| 3 | `src/App.tsx:87-101` | `lazy` import, matching the `lazy(() => import(…).then(m => ({default: m.X})))` shape (named exports). |
| 4 | `src/App.tsx:503` | Add `"logs"` to the exclusion list. |
| 5 | `src/App.tsx:509-522` | Add a `baseView === "logs"` branch **in the same ternary chain** — order matters, both edits are required. |
| 6 | `src/App.tsx:488-501` | Update the "only automations/vault/crew" comment. |
| 7 | `src/components/sidebar/Sidebar.tsx:513-563` | Footer button. Verified available in `lucide-react`: **`ScrollText`** (also `FileClock`, `NotebookPen`). Reuse the `sidebar-quiet-btn` + active-state ternary pattern verbatim. |
| 8 | `src/components/logs/LogsView.tsx` | New. `<ToolbarHeader>` wrapper (portal to `#relay-toolbar-slot`, per `CrewView.tsx:77-91`) + filter bar + virtualized list + detail pane. |
| 9 | `src/components/logs/LogDetail.tsx` | New. Request/response viewer; `react-syntax-highlighter` is already a dep. |
| 10 | `src/lib/ipc/llmLogs.ts` | New. IPC wrappers over `src/lib/ipcCore.ts`. |
| 11 | `src/hooks/useLlmLogs.ts` | New. Mirrors `useCostRollups.ts`: fetch on filter change + debounced silent refresh on a `llm-log:appended` event, with a `hasDataRef` guard so refreshes don't flash a spinner. |
| 12 | `src/components/settings/LocalModelsPanel.tsx` | Add a "Request Log & Gateway" card — it's already the local-models home. |
| 13 | `src/styles/logs.css` | New. Compact header must fit the caption's 28px box (`ToolbarHeader.tsx:19-21`). |

Back/forward, the command palette, and view history need no work —
`setActiveView` (`ui.ts:435-466`) pushes history automatically for any
non-overlay view.

**IPC commands:** `llm_log_list(filter, limit, beforeId)`, `llm_log_get(id)`,
`llm_log_clear()`, `llm_log_stats()`, `gateway_status()`,
`gateway_set_enabled(bool)`, `gateway_rotate_token()`.

**Settings keys:** `logs.enabled`, `logs.retentionDays`, `logs.maxBodyKb`,
`gateway.enabled`, `gateway.requireAuth`, `gateway.port` (written, not
user-set), `gateway.defaultTarget`.

## 9. Tests

Rust, inline `#[cfg(test)] mod tests` at the bottom of each file (repo
convention — no `tests/` dir):

- `normalize` — table-driven, one case per wire format above, all pure. Cheapest
  coverage-per-line in the plan; write these first.
- `store` — round-trip via `super::super::mem()`; retention prune deletes oldest
  and respects `maxRows`; body truncation sets `truncated`.
- migration — build the pre-migration schema by hand, run the migration, assert
  the column set (the `cost_v2_migration_preserves_rows_and_adds_columns`
  pattern, `db/cost.rs:118-175`).
- `gateway` — request parsing, target routing, and the auth comparison as pure
  functions (`automation_webhook.rs:211-230`).

Frontend, vitest in `src/test/`:

- `logsView.test.tsx` — mock the IPC barrel with `importOriginal` spread, the
  `costDashboard.test.tsx` pattern; assert rows render and a row opens detail.
- `viewNavHistory.test.ts` — **its hand-written `entry()` helper has a literal
  view union** (`view: "chat" | "settings" | "skills" | "cost"`) that must gain
  `"logs"` or the test file won't typecheck against the widened union.

## 10. Phasing

| Phase | Ships | Why it's separable |
|---|---|---|
| **1 — Log** | Schema, normalizer, in-process capture, IPC, Logs view, footer icon | Delivers "logs for llama.cpp" (and every cloud provider) end-to-end and proves the UI with no new attack surface. |
| **2 — Gateway** | Loopback server, auth, target registry, external-app endpoints | Independent of the UI; can ship and be tested with curl alone. |
| **3 — Runtimes** | Ollama + LM Studio as first-class targets (health probes, target picker); `gateway.requireAuth` docs | Phase 2 is what makes this possible. Adding Ollama as a *chat provider* pointed at the gateway is a natural follow-on and needs no warm-path changes. |

## 11. Risks & open questions

- **Chunked-encoding correctness** in the gateway is the highest-risk item.
  Nothing in the repo writes chunked responses today, so there is no in-house
  precedent to copy and no regression suite to lean on. Consider adding `axum`
  purely for the server side if the hand-rolled version gets gnarly — but
  that's the one dependency this codebase's conventions would argue against.
- **Body storage vs. disk.** Full bodies are the right call for debuggability
  and they make telemetry reparsable, but prompts can carry sensitive content.
  Retention defaults are a product decision, not a technical one — 7 days is a
  suggestion, not a requirement.
- **SSE keep-alive comments.** llama.cpp emits periodic SSE comment pings;
  the parser must skip `:`-prefixed lines rather than treating them as data.
- **LM Studio's `event:` lines** mean the normalizer must track event names,
  not just parse data payloads. `chat.end` carries the aggregate + `stats`; the
  `message.delta` events do not.
- **Field-name drift** is the residual risk the raw-body design absorbs. If
  Ollama or LM Studio renames a telemetry field, the log row still has the
  verbatim original and can be reparsed.

---

## 12. What actually shipped, and what live testing changed

Implementation layout (all paths real, `master` @ 2026-09-29):

| Concern | File |
|---|---|
| Schema, queries, retention | `src-tauri/src/db/llm_log.rs` |
| Normalizer (pure, no I/O) | `src-tauri/src/llm_log/normalize.rs` |
| Capture sink, `Capture`, `CaptureGuard`, target classification | `src-tauri/src/llm_log/mod.rs` |
| The proxy | `src-tauri/src/llm_log/gateway.rs` |
| Tauri commands | `src-tauri/src/llm_log/commands.rs` |
| End-to-end tests against a real server | `src-tauri/src/llm_log/live_tests.rs` |
| Test runner (starts llama-server) | `scripts/live-llm-log-test.sh` |
| Logs view + detail pane | `src/components/logs/LogsView.tsx`, `LogDetail.tsx` |
| Live list hook | `src/hooks/useLlmLogs.ts` |
| IPC + types | `src/lib/ipc/llmLogs.ts`, `src/types.ts` |
| Styles | `src/styles/logs.css` |
| Settings card | `src/components/settings/LogGatewayPanel.tsx` |

Provider hook: `capture_request` in `chat/providers.rs`, one line in each of
the two wire-body builders. Relay's own streaming turns capture at
`chat/mod.rs::run_chat_stream`, with a `CaptureGuard` that writes the row on
drop so every exit path — success, HTTP error, stream error — is logged once.

### Corrections to §3/§5, from measurement

The doc sweep was right about the framing and wrong about two details:

1. **`timings` arrives on the SAME chunk as `finish_reason`**, not in a
   separate event after it. The sweep said the timings chunk follows; on
   `llama-server` 0.1.2-dev they are the same JSON object. This only matters
   if a reader stops at `finish_reason` — the normalizer scans every payload,
   so it is insensitive to either behaviour.
2. **Streaming chunks carry no `usage` block at all.** `timings` is the only
   source during a stream; `usage` appears on the non-streaming response. So
   the §5 priority is inverted for streaming: `usage` first is right, but
   `timings` is not the fallback there, it is the source.
3. Non-streaming, the two disagree and `usage` is right: a real response gave
   `usage.prompt_tokens: 13` against `timings.prompt_n: 7`, the difference
   being 6 cached tokens. Confirms the §5 "prefer usage" rule.

`--api-key` on `llama-server` is enforced on inference endpoints but **not** on
`/v1/models` — a live `curl` to `/v1/models` without a key returns 200 while
`/v1/chat/completions` returns 401. Worth knowing before debugging auth.

### The three bugs live testing found

None of these were reachable from a unit test, because each needs a real
socket on the other end.

1. **The `Content-Length` path relayed nothing.** The relay buffered the body
   but only ever flushed inside the chunked branch, so every fixed-length
   response reached the client truncated to zero bytes — surfacing as
   reqwest's `IncompleteBody`. The streaming path was fine, which is why it
   looked healthy. Caught by `relays_a_non_streamed_completion_with_content_length`.

2. **Relay's own bearer token was being forwarded upstream.** The client's
   `Authorization` header is consumed by the gateway's auth check, but the
   original code copied every non-hop-by-hop header to the runtime. Against a
   keyed `llama-server` the client got a 401 that looked like a gateway auth
   failure and was in fact the runtime's. Fixed by stripping `Authorization`
   on the way out and adding `ResolvedTarget::api_key` — a per-target upstream
   credential, configured as
   `{"name": {"url": "...", "apiKey": "..."}}` in `gateway.targets`.
   Covered by `the_clients_gateway_token_is_never_forwarded_upstream`.

3. **The capture buffer was never populated.** `forward()` teed bytes into its
   own relay buffer and never into `Capture::response_buf`, so every row had
   an empty `response_body` while the client still got a correct response.

A fourth issue was in the tests rather than the product: `BOUND_PORT` is a
process-wide static, and the live tests run in parallel, so each was dialling
whichever gateway bound last. The tests now read the port back out of their own
`gateway.port` setting — which doubles as a check that persistence works.

### Test coverage as shipped

- `cargo test --lib` — 1440 passed, 0 failed. 39 of those are new (store,
  normalizer, gateway parsing/auth, capture sink, classification) plus the 5
  live tests.
- The 5 live tests skip with a printed reason when no `llama-server` is
  listening, so the suite stays green without one. Run them for real with
  `scripts/live-llm-log-test.sh`.
- `npx vitest run` — 197 files, 1540 tests, all passing, including
  `src/test/logsView.test.tsx` (4 tests).
- `npm run build` succeeds; `LogsView` is a lazy chunk, so the log table never
  rides in the entry bundle.

### Not done

- **The tool loops were initially unwired, which made the feature look
  broken.** With tools enabled (Relay's default) a turn goes to
  `run_openai_tool_loop` / `run_anthropic_tool_loop`, not to
  `run_chat_stream` — so the first implementation logged nothing at all for
  a normal chat. Both `openai_stream_round` and `anthropic_stream_round` now
  arm a guard at their top; the `for round in 0..cap` loop means a multi-tool
  turn produces one row per model round, which is the useful granularity.
  `the_round_guard_turns_real_stream_bytes_into_a_row` covers the guard with
  bytes a real server produced.
- **Ollama and LM Studio are configured, not exercised.** `resolve_target`
  ships both, and the normalizer has fixtures for both wire formats, but no
  instance of either was available on the test machine, so their rows are
  unproven against a real server.
- **`gateway.targets` has no UI.** It is settable over IPC only; the settings
  card exposes the built-in runtimes and the default target.
