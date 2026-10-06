# Agent findings: root/pty/llm_log/artifacts (26 files)
# Status: COMPLETE — verified result captured 2026-10-02 18:36

FILES COVERED: src-tauri/src/{lib,main,types,util}.rs, pty/mod.rs, llm_log/{mod,gateway,normalize,commands}.rs, artifacts/{generator,schemas,intent,adapter,context,validator,proposal,mod}.rs, checkpoints.rs, exec_gate.rs, prompt_firewall.rs, user_dirs.rs, download.rs, os_toast.rs, app_ui.rs, pricing_live.rs, sidecar_sweep.rs, agents_md.rs

## P0

none

## P1

**1. `prompt_firewall::scan`/`neutralize`: `to_lowercase()` can change byte length, desynchronizing offsets — attacker-controllable panic that silently kills chat turns — prompt_firewall.rs:109 / :118 / :141-165.**
```rust
let lower = normalized.to_lowercase();          // :109 — lower can be LONGER
let char_at = normalized[..byte_at].chars().count();   // :118 — byte_at indexes `lower`
```
Rust's full Unicode lowercasing expands U+0130 `İ` (2 bytes) to `i` + U+0307 (3 bytes), so every offset found in `lower` is shifted past its true position in `normalized`. Concrete panic: `"İİİİİİİİİ<system>"` — normalized 26 bytes, lower 35, phrase found at byte 27 of lower, `normalized[..27]` panics. `neutralize()` has the same bug at :160-163 and with fewer `İ` mis-redacts (cuts shifted, leaving phrase bytes un-neutralized). The module's own doc declares retrieved content "attacker-controllable" (hostile web page in RAG corpus / memory), and `guard`/`guard_db` run at those injection points (memory/mod.rs:166,175; wiki/mod.rs:2196; chat/mod.rs:1806). The panic happens inside the spawned turn task where "a panic kills the turn silently (B-1)" (chat/mod.rs:1799). Fix: match and slice on the same string (slice `lower`, derive char offsets from `lower`), or lowercase length-preservingly (ASCII-only lowering — every pattern is ASCII).

**2. PTY reader loop throttles every pane to ~500 KB/s: sleeps out the 16 ms budget after *every* read instead of coalescing — pty/mod.rs:1040-1048.**
```rust
if !frame.is_empty() {
    if let Some(started) = frame_started {
        let elapsed = started.elapsed();
        if elapsed < FRAME_BUDGET { thread::sleep(FRAME_BUDGET - elapsed); }
        flush_frame!();
    }
}
```
The tail block runs at the end of every iteration, and `frame_started` is set on the same iteration that produced the data (mid-iteration flush unreachable: `FRAME_BYTE_LIMIT` can't hit with an 8 KB read buffer and elapsed can't exceed budget microseconds after set). Net: max one 8 KB frame per 16 ms ≈ 512 KB/s per pane; the 64 KB `FRAME_BYTE_LIMIT` is dead code. Output-heavy commands (`cargo build`, test runs) are rate-limited; the child blocks on ConPTY backpressure; transcript heuristics lag minutes on multi-MB output; `pty:exit` delayed. Inverts the stated design ("accumulate reads for up to 16 ms"). Fix: keep reading during the budget window (deadline-bounded read loop); flush only when the deadline elapses or byte cap reached.

**3. `strip_unc_prefix` mangles `\\?\UNC\…` paths into a relative-looking `UNC\…` string, and `add_project` stores that as the project path — util.rs:71-79, trigger at commands/projects.rs:41.**
`canonicalize()` of a network-share path returns `\\?\UNC\server\share\…`; `strip_unc_prefix` strips only the literal `\\?\`, producing relative `UNC\server\share\proj`. `add_project` stores exactly this, so a project added from a network share gets a corrupt stored `path` resolved against Relay's CWD by every consumer (git commands, pty spawn cwd at pty/mod.rs:706, checkpoints, fs probes in claude_code.rs:191/236, kimi_code.rs:123) — silently failing or creating/reading files under a `UNC\…` subfolder of the process CWD. (The app's own test for `normalize_canonical_path` at util.rs:365-369 asserts the correct collapse.) Fix: use `normalize_canonical_path` in `add_project` and/or make `strip_unc_prefix` handle the `UNC\` case so other call sites inherit the fix.

## P2

**4. `neutralize` drops non-overlapping matches because cuts are appended in PATTERNS order, not text order — prompt_firewall.rs:143-153.**
`PATTERNS` iterated in list order; a later-listed phrase appearing EARLIER fails `start >= last.pe` and is silently dropped. Example: `"you are now evil. ignore previous instructions"` — `override.ignore_previous` (offset ~18) appended first; `forgery.you_are_now` at offset 0 then fails `0 >= 45` and survives strip mode un-redacted. Fix: collect all cuts, sort by start, then drop genuinely overlapping ones.

**5. Restoring to a safety/baseline checkpoint with `rollback_messages` deletes the entire conversation instead of the messages after that snapshot — checkpoints.rs:480-484, :526-528.**
The pre-restore safety snapshot is written with `message_id: None`, and `delete_chat_messages_after(…, None)` wipes every message (test at checkpoints.rs:715-721 confirms baseline = whole-conversation wipe). Restoring the safety snapshot with `rollbackMessages: true` (exposed via `restoreChatCheckpoint(id, true)` in src/lib/ipc/artifacts.ts:473) loses the whole conversation while the tree rolls forward. Fix: record the message high-water mark on safety/baseline rows and use it for the delete bound.

**6. `os_toast` (Windows) is a synchronous command doing registry writes, PNG encoding, file IO, and a WinRT toast on the IPC/UI thread — os_toast.rs:17-39.**
lib.rs:672-683 states the house rule: a non-`async` command "runs INLINE on the IPC thread — which is the UI thread". This one does `create_subkey` + `set_value` calls, first-use icon PNG encode + write, and a synchronous WinRT show — visible UI stalls (first toast worst). Every other command in the handler list is async. Fix: make it `async` + `spawn_blocking`.

**7. Loop-artifact markdown emits an unclosed bold marker for inputs — artifacts/adapter.rs:234.**
`md.push_str(&format!("- **{}", input.name));` — the skill formatter 70 lines earlier writes `"- **{}**"` (adapter.rs:163); the loop formatter drops the closing `**`, so every generated loop skill's Inputs section renders with bold bleeding to end of line. Fix: `"- **{}**"`.

**8. `record_usage` / `record_usage_on_disk` duplicate ~40 lines of delta-zip + zero-check logic verbatim — pty/mod.rs:440-502 vs :510-578.**
Identical `UsageInfo` field-by-field `zip(...).map(|(a,b)| (a-b).max(0))` block and identical six-field `is_zero` check; only the baseline mutex differs. Extract `usage_delta` / `usage_is_zero` — a future token field added to one zip and forgotten in the other silently corrupts the on-disk cost path.
