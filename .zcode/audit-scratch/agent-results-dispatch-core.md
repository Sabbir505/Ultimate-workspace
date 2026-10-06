# Agent findings: chat dispatch core (5 files)
# Status: COMPLETE — verified result captured 2026-10-02 18:56 (retry succeeded)

FILES COVERED: src-tauri/src/chat/{dispatch,streaming,mod,stream_events,partial_buf}.rs (dispatch.rs 5173 lines read in 4 passes) + verification reads in chat/tools/fs.rs.

## P0

**1. Subagent sandbox gate for `move_file`/`copy_file` reads the wrong argument keys — the scope check is silently skipped entirely.**
- dispatch.rs:1670 (and the test at dispatch.rs:4803):
```rust
let paths: Vec<&str> = match name {
    tools::MOVE_FILE | tools::COPY_FILE => vec![arg("source"), arg("destination")],
    tools::WRITE_FILE | tools::EDIT_FILE | tools::DELETE_FILE => vec![arg("path")],
```
The actual tool schema/implementation use `src`/`dest` (tools/fs.rs:362-363; also dispatch.rs:158-162 and :3102 use the right keys). For a move/copy from a `workspace_write` subagent, `arg("source")`/`arg("destination")` both return `""`, and the very next statement short-circuits: `if p.is_empty() { return None; }` ("The tool itself reports the missing argument; not a scope call"). `subagent_fs_scope_refusal` returns None (allowed) for every move/copy, and the subagent loop "deliberately bypasses the main loop's approval layer" (dispatch.rs:1313-1319) — this function is documented as "the only thing standing between a granted `write_file` and the whole filesystem." Consequence: a `workspace_write` subagent (or a prompt-injected model driving one) can `copy_file` from the project to ANY destination on disk (startup folders, PATH binaries — the scenario the `download_file` gate at dispatch.rs:3038-3055 exists to prevent), and `move_file` can delete (move) files from ANY source into the project. The unit test `subagent_write_scope_is_the_project` (dispatch.rs:4803) passes only because it also uses the wrong keys (`{"source": ..., "destination": ...}`). Fix: change the arm to `vec![arg("src"), arg("dest")]`, update the test fixtures to the real schema keys, and consider an assertion tying the keys to `fs_target_path`'s extraction.

## P1

**2. Subagent loop's Anthropic branch has no `MAX_STREAM_BLOCK_INDEX` clamp — unbounded map growth from network-controlled indexes.**
- dispatch.rs:1938, 1994, 2014. The clamp is applied in `run_subagent_loop` only to the OpenAI `tool_calls` branch (dispatch.rs:2092-2095); the Anthropic branches (`content_block_delta` :1938 → `ant_think.entry(idx)`; `input_json_delta` :1994 → `ant_calls.entry(idx)`; `content_block_start` :2014 → `ant_calls.insert(idx, …)`) are unclamped, while the main `anthropic_stream_round` clamps its equivalent (streaming.rs:828-834). A user-configured `anthropic_compatible` base URL (untrusted per the codebase's own threat model) can emit one block per distinct index — each inserting into a BTreeMap that lives for the round — driving unbounded heap growth mid-turn / OOM. Fix: apply the same guard at the three sites, or extract one `clamp_index(v) -> Option<usize>` used in all four places.

## P2

**3. Stream-registry insert can overwrite a superseding send's handle (narrow TOCTOU) — chat/mod.rs:1579-1594.**
`send` cancels at entry, spawns the turn, then inserts — if preempted between `tokio::spawn` (703) and the insert, a second `send` for the same session can insert during the window; the first send's insert then replaces task 2's handle: two turns run concurrently for one session (interleaved `chat:token` streams, double persistence), and `cancel` thereafter kills the superseded turn. Fix: key the insert on a monotonic per-session generation or re-check under the lock.

**4. DRY: seven near-identical `run_gated_*` approval wrappers — dispatch.rs:472-519, 2277-2293, 2325-2340, 2362-2377, 2383-2398, 2403-2417 (+ `run_gated_fs_tool` at 331).**
`run_gated_{connector,mcp,system,automation,subagent,mesh,vault}_tool` duplicate the identical gate→deny-text→execute dance; only summary builder and execute call differ; the deny copy already drifted (MCP variant at 512-515). Fix: one generic `run_gated<F, Fut>(..., exec: F)`.

**5. `build_edit_preview` does blocking full-file I/O and two full scans on the async runtime — dispatch.rs:414, 445.**
`std::fs::read_to_string` + `content.match_indices(find).count()` rescans everything (the 50-item loop breaks early but the count doesn't). A multi-hundred-MB file pins the worker. Fix: `spawn_blocking` + count from the single iterator.

**6. `browser_batch` failure detection is a substring heuristic page content can trip — dispatch.rs:3780.**
`if out.starts_with("Error:") || out.contains(" failed:")` — a successful `browser_read` whose page text contains " failed:" (error pages, changelogs) marks the step FAILED and skips every later step. Fix: structured `(ok, text)` from the inner arms instead of re-deriving from the rendered string.

**7. `partial_buf` cap comment says chars, enforcement uses bytes — partial_buf.rs:23, 37.**
`MAX_PARTIAL_CHARS = 400_000` but `entry.len()` is `str::len()` (bytes) — CJK/emoji-heavy streams trim at ~130-200k actual chars. Bounded (no bug) but the documented invariant is wrong. Fix: rename to `MAX_PARTIAL_BYTES` or use `chars().count()` if char semantics are load-bearing.

Cleared (checked, sound): openai `<tool` suppression offset math (carry maps contiguely, char-boundary safe); DbState/late_attach/PARTIALS locks correctly scoped, never held across awaits; SSE index clamps in both main stream rounds; sanitize_stream_text/neutralize_markers/truncate_chars (no byte-slicing panics in model-facing paths); emit/partial_buf::record hot path O(1) amortized; cancellation paths (child-task registry, pending-approval drops, reconnect ladder's `is_current_stream` gate); `cancel_all` drain semantics.
