# Local Model Prompt Caching — Contract & Maintenance Guide

**Status:** Implemented (2026-10-04) · **Environment measured on:** GTX 1660 Ti 6GB, llama.cpp 0.4.1-dev (build 10985) at `%APPDATA%/dev.relay.app/bin/llama-cpp-cuda/llama-server.exe`, models under `D:\local models\models`

This is the **living contract** for how Relay keeps llama-server prompt-cache hits high across turns. If you change anything in the request path, the sidecar spawn, the system prompt, the warmup, or the history rebuild — read §3 first and update this doc in the same change. The code is the source of truth; this doc exists so the next change doesn't silently re-introduce a 83-second first turn.

---

## 1. Why this exists (the incident that produced it)

First message in a fresh local session took **83s TTFT** (13,770 input tokens, zero cache hit) while turn 2 took **0.58s** (13,769 of 13,787 tokens cache-read). Root cause: the model was loaded from **Settings → Local Models → "Use model"**, which started the sidecar but never ran the prompt warmup — the chat-picker path did, that panel didn't. Every fix in this doc traces back to either that gap or the measurements taken while diagnosing it.

Forensic sources that diagnosed it (use them again first, before guessing):
- `chat_messages` rows: `ttft_ms`, `llm_time_ms`, `input_tokens`, `cache_read_input_tokens` (stored as NULL when 0 — `cache_read_input_tokens = NULL` **means zero cache hit**, not "unknown"). See §5 for the query.
- Sidecar process start time (`Get-Process llama-server`) vs. the turn's timestamp — discriminates "picker/Settings load" from "send-path auto-respawn".

## 2. How the pieces fit

### 2.1 Sidecar spawn (`chat/local_models.rs`, `LocalModelRegistry::start`)

Args template: `--model <path> --port <p> --host 127.0.0.1 -c <auto_ctx> --jinja --cache-reuse 256` (+ `--mmproj`, then `apply_overrides_args`, then `--n-gpu-layers` from the ladder).

- **No `--parallel`:** this build defaults `-np` to **auto (4 slots)**. Slot selection is longest-common-prefix based, so background one-shots (memory extraction, compaction summarizer) land on a free slot and **do not evict the chat prefix**. Do not "optimize" this to 1 slot — you reintroduce eviction.
- `-c` is **per-slot** on this build (each slot reports `n_ctx = -c`; total KV = `-c × slots`). Keep that in mind for VRAM math on 6GB cards.
- **Legacy-binary fallback:** the spawn ladder treats `unrecognized argument` / `invalid option flag` as "drop ONE optional flag and retry the same rung", order `["--cache-reuse", "--jinja"]` (least-essential first; `--cache-reuse` drains flag+value). If you add another optional spawn flag, add it to that list — otherwise an old user-registered binary fails to start outright.
- `--cache-reuse 256` enables KV chunk reuse beyond the exact common prefix (divergence mid-history from elision/flat-row re-sends/compaction). This build reuses tails even with the flag at its default 0, but the flag keeps the behavior on builds where the default is off.

### 2.2 The warmup (`run_prompt_warmup` in `chat/commands/send.rs`; frontend caller `warmLocalPromptForChat` in `src/components/chat/useLocalModelSidecar.ts`)

The warmup sends `system + tools + "Warmup — reply with: ok"`, `max_tokens: 1`, `stream: false`, `cache_prompt: true`, with a system prompt that must be **byte-identical** to the next real send's prefix. It works because the whole prefix is deterministic per session:

1. `core_prompt_for(LocalGguf, …)` — compact local CORE + STRICT addendum (constant; `provider_capabilities` pins LocalGguf to `ModelClass::Local` regardless of the model string, so warmup-vs-send model-id differences don't leak into text)
2. `current_datetime_segment()` — day-granularity, stable within a session
3. `available_skills_segment()` (tools on)
4. attach manifest (tools on) — same `attach_availability` inputs in warmup and send
5. custom `assistant.systemPrompt`
6. freshness reminder tail (tools on)
7. AGENTS.md section → wiki section (send path appends via `agents_md::append_to_system`)
8. `working_directory_section(root)` — same root resolution on both sides (unbound chat → artifacts fallback dir)

**Every surface that starts a sidecar MUST warm it** while its spinner is up, via the shared frontend helper `warmLocalPromptForChat(sessionId)`:
- chat-picker spawn — `useLocalModelSidecar.spawnLocalModel`
- chat-switch re-warm — the effect in the same hook (deduped by `lastWarmRef`)
- Settings → "Use model" — `LocalModelsPanel.handleUseModel` (both the reuse-existing and new-session branches)
- Settings "↻ Restart with new settings" — re-warms the active session (the restart wipes KV)

The backend command is `warmup_local_prompt` (`send.rs`), capped at 90s, best-effort — a failed warmup only means a cold first send.

**The send path's auto-respawn (3b, `send.rs` ~781) deliberately does NOT warm.** A fire-and-forget warmup there used to "prime turn 2" per its comment — wrong on this build: llama-server continuous-batches across slots, so the warmup *races* the in-flight turn's prefill, splits the GPU, and stretches that turn's TTFT (~+40% measured). The turn's own prefill is the primer; turn 2 reuses turn 1's KV. If you add a spawn path that can't warm-before-traffic, leaving it cold is better than racing.

### 2.3 The request path (`ChatRequest.cache_prompt`)

`ChatRequest.cache_prompt` (providers.rs) is set **only for `LocalGguf`** (`chat/mod.rs` `send()`), and:
- `openai_wire_body` (providers.rs) emits `"cache_prompt": true` on the wire body (skipped when false);
- `build_openai_body` (streaming.rs) emits it for the tool-loop rounds;
- the warmup body hardcodes it.

llama-server's `cache_prompt` default has flipped across releases; explicit `true` makes prefix reuse vintage-proof. **Never set it for cloud OpenAI-family providers** — those endpoints 400 on unknown parameters. Pinned by tests: `openai_wire_body_sends_cache_prompt_only_when_requested` (providers.rs), `openai_body_sends_cache_prompt_only_for_local` (streaming.rs).

### 2.4 History rebuild & divergence recovery

- Turn history is rebuilt from the DB in `load_compaction_entries` (`chat/compaction.rs`), which runs `strip_think_blocks` (`chat/commands/sessions.rs`) — removes `<think>…</think>` AND `<tool>…</tool>` display spans.
- This makes the *shared* prefix (everything up to the newest message) byte-stable across turns. The previous turn's own answer re-sends as a flattened row — it always diverges from the live tool-loop shape, but `--cache-reuse` re-matches the unchanged chunks after the divergence point, so the recompute is small (§4).
- `elide_stale_tool_results` (streaming.rs, `KEEP_LAST_TOOL_RESULTS = 3`) rewrites all-but-the-last-3 tool results into stubs mid-turn — same divergence-recovery story.

## 3. Maintenance checklist — if you touch X, also do Y

| You're changing… | You must… |
|---|---|
| `build_system_prompt` / any new segment | Add it to `run_prompt_warmup` **in the same position**, or first turn loses the cache. The warmup must mirror the send byte-for-byte (see the segment list in §2.2; the 7,139-vs-7,819-char mismatch history in old comments is the cautionary tale). |
| `ToolCaps` gates / tool specs | Mirror the new gate in `run_prompt_warmup`'s `caps` construction. A warmup that ships different tool specs than the first send warms nothing. |
| Working-directory resolution | Keep the send path and `warmLocalPromptForChat` + `run_prompt_warmup` aligned (unbound chat → artifacts fallback on both sides). |
| A surface that starts the sidecar (new button, panel, command palette…) | Call `warmLocalPromptForChat(sessionId)` before handing the user back to the composer, under a spinner if possible. |
| Spawn args in `local_models.rs` | Add the flag to the rejected-argument fallback list if it's optional. Never add `--parallel 1`. Re-check VRAM math (KV = `-c × auto slots`). |
| `ChatRequest` shape / wire body | Keep `cache_prompt` LocalGguf-only; keep the two pinned tests passing. |
| Background LLM calls that may target `local_gguf` (titles, extraction, summarizers, automations oneshots) | They share the sidecar. Multi-slot routing protects the chat prefix, but they still burn GPU compute — don't fire them right after a turn completes (see the title skip in `commands/generators.rs` for the pattern). |
| History/DB message content (what gets persisted) | Remember it's re-sent stripped via `strip_think_blocks`; anything byte-unstable in persisted rows re-prefills every turn. |
| Compaction thresholds / `auto_ctx_size` | `-c` is per-slot and feeds both the compaction trigger (`status.n_ctx`) and the 400-on-overflow boundary. |

## 4. Measured numbers (2026-10-04, keep these as the regression baseline)

All on the 1660 Ti, prefill ~185 tok/s on Spark-X2.5-4B-Q4_K_M (32k ctx, ngl 99), ~300 tok/s on MiniCPM5-2B-Q8_0. Requests used `max_tokens: 1` to isolate prefill.

| Scenario | Spark 4B | MiniCPM 2B |
|---|---|---|
| Cold prefill, ~6.7k-token system+tools (the warmup) | 36.6s | 21.7s |
| First turn after that warmup (same prefix + user msg) | **0.2s** (11 tokens recomputed) | **0.14s** |
| Next turn, flattened + think-stripped history (what the app re-sends) | **2.1s** (320 recomputed) | **1.5s** (292) |
| Turn while a title one-shot is in flight | 1.2s | 0.35s |
| Next turn with think KEPT in history (rejected design) | **14.7s** (2,490 recomputed) | 9.5s |
| The production incident (no warmup ran) | **83s** (13,770 tokens, zero cache) | — |

Design decisions recorded by these numbers:
- **Keep `strip_think_blocks`** — keeping `<think>` in re-sent history is ~8× worse after tool rounds (the think text lands at a different cache position than the flat row). Don't "fix" this without re-measuring.
- **Keep auto `--parallel`** (4 slots) — it's what protects the chat prefix from background one-shots.
- **Skip LLM titles for local sessions** (`generators.rs`) — the derived client-side title stands in; the call only ever competed with the user's next message.

## 5. How to verify a change

1. **Unit pins:** `cargo test --lib -- chat::providers::tests chat::streaming` (cache_prompt wire shape), plus the spawn-arg tests in `chat::local_models`.
2. **Live A/B against real models** (`scripts/live-cache-test.py`, `scripts/live-cache-e2e-test.py`): each spawns the app's own llama-server binary with the current flag set, replays warmup → turn → title one-shot → next turn, and prints `timings.cache_n` / `prompt_n` / `prompt_ms`. Pass `--model "D:/local models/models/…"`. Warm turns should recompute only ~300 tokens; anything in the thousands is a regression.
3. **In-app, after a real session** — query the DB for the turn rows (ttft should be ~1s warm):

   ```python
   import os, sqlite3
   db = os.path.join(os.environ["APPDATA"], "dev.relay.app", "relay.db")
   conn = sqlite3.connect(db)
   for r in conn.execute("""
     SELECT m.created_at, m.ttft_ms, m.input_tokens, m.cache_read_input_tokens
     FROM chat_messages m JOIN chat_sessions s ON s.id=m.chat_session_id
     WHERE s.provider='local_gguf' AND m.role='assistant'
     ORDER BY m.created_at DESC LIMIT 10"""):
       print(r)
   ```

   `cache_read_input_tokens IS NULL` on anything but the very first turn after a (re)spawn = the cache is being thrown away; go re-read §2.2/§3.
4. **Sidecar introspection while it's live:** `GET /slots` (slot count, per-slot `n_ctx`, is_processing), `GET /health`, `GET /props`. The app's sidecar port is in `app_settings` key `chat.local_gguf.base_url`.
