# Agent findings: mobile relay + secrets (13 files)
# Status: COMPLETE — verified result captured 2026-10-02 19:53

FILES COVERED: src-tauri/src/mobile/{relay,session_chat,protocol,relay_requests,relay_owner,relay_crypto,tailscale,push,commands,relay_ws,dispatch,mod}.rs + secrets.rs (cross-checked chat/mod.rs cancel/client, db/projects.rs, chat/permission.rs, chat/providers.rs, installed_skills.rs, pty/mod.rs).

Overall: the crypto core is SOUND (per-connection HKDF salt, strictly-increasing per-direction counter nonces, constant-time proof compares, fail-closed on empty token, AEAD tag enforced, nonce echoed in frame and checked) — the 2026-09-21 C1 nonce-reuse finding is remediated. No P0.

## P0

none

## P1

**1. `CancelChatTurn` is a no-op for `ChatTurn` streams — cancel is acknowledged, generation and billing continue — relay_requests.rs:350-356, relay.rs:2531-2538, 2732 (90%).**
`chat_turn_arm` runs `handle_chat_turn` as a bare spawned task; mid-turn cancel routes to `chat_mgr.cancel(sid)`, but `handle_chat_turn` never registers anything with ChatManager (it builds `provider.build_request(...)` and pumps `response.bytes_stream()` manually), and `ChatManager::cancel` (chat/mod.rs:1647-1651) only aborts handles in `self.streams`. `handle_mid_turn_frame` sends ChatDone — the phone believes the turn stopped — while the SSE loop (`'chunks: while let Some(chunk_result) = stream.next().await`, relay.rs:2732) has no cancellation check, so tokens keep arriving and the provider request runs to completion (cost continues). The B-26 comment intends cancel to work mid-turn; it works only for SendChatMessage streams. Fix: capture `turn.abort_handle()` before the select loop and abort it in `on_cancel` (or a CancellationToken checked in the chunk loop).

**2. Replayed legacy static proof yields a permanently "paired" zombie connection that suppresses the push-notification fallback — relay_requests.rs:236-260, push.rs:94-98, relay.rs:423-446, 893-905 (85%).**
The legacy fallback still accepts the static, connection-independent proof (`legacy_ok = !nonce_bound && !require_challenge && !v2_client && verify_pair_proof(...)`). Per-connection salt prevents command execution by a replayer (AEAD tag fails), and the relay replies "undecryptable frame" and `continue`s instead of evicting — but the connection stays paired and registered in `conns`, and push fallback is gated exactly on that map (`phones_disconnected` = `conns.lock().is_empty()`). A replayer keeping the zombie alive with one junk frame per <75s permanently suppresses approval/turn-done/automation/budget pushes to the real phone — a parked approval never reaches anyone. Window is unbounded because the pairing token is deliberately reused across launches and `require_challenge` defaults off. Fix: drop the connection after N consecutive AEAD failures; default `require_challenge` on; and/or make `phones_disconnected` require a connection that decrypted at least one valid frame.

## P2

**3. Unauthenticated pairing lockout is a trivial repeatable DoS, and the failure counter misses several rejection paths — relay_requests.rs:71-77, 90-92 (85%).**
Any tailnet peer can send 5 garbage-proof Pair frames and trip the process-global 60s lockout for everyone; repeat every 60s to keep the legitimate phone from ever pairing. Meanwhile the counter skips "not a Pair message"/"malformed"/"no E2E proof"/require_challenge refusals. Fix: count every pairing-stage rejection except transport errors; per-peer-IP lockout.

**4. `stop_relay` during `start_relay`'s bind-retry window resurrects "running" state — relay.rs:274-294, 412-414, 455-456 (82%).**
Bind retries up to 20s without consulting abort_rx; a stop during that window clears state, then the thread binds and start_relay re-publishes port/pairing-token state — a stopped relay reported running with a dead listener. Fix: after `port_rx.await`, verify this start's abort sender still stands before publishing; select on abort_rx in the retry loop.

**5. `RenameProject` arm uses `?` inside the match — a DB error tears down the whole phone connection — relay.rs:1883-1885 (85%).**
Every other branch replies ChatError and keeps the socket; this `?` propagates out of handle_connection on any SQLite error. Fix: fold into `result` like siblings.

**6. `filter_diff_to_path` never matches git's quoted-path form — per-file diff peeks return empty for paths git quotes — relay.rs:2364-2370 (85%).**
Git emits `diff --git "a/x" "b/x"` for paths with spaces/unicode (common on Windows); the `b/{target}"` pattern requires a space before `b`. `GitDiff { path }` returns "" for such files. Fix: match `"b/{target}"` (quoted) too.

**7. Default WebSocket message cap allows ~4 GiB pre-authentication memory amplification — relay.rs:767 (80%).**
`accept_async` uses tungstenite 0.24 defaults (16 MiB frame / 64 MiB message); the pairing frame is fully buffered before parse; 64 permits × 64 MiB junk ≈ 4 GiB. Fix: `accept_async_with_config` with explicit `max_message_size` (~16-32 MiB for base64 voice notes).

**8. `ResolvePlanProposal` skips the session-ownership check its two sibling handlers enforce — session_chat.rs:430-435 (85%).**
`ResolveSessionApproval` (:303-331) and `ResolveSessionQuestion` (:373-391) reject a pending id owned by a different chat ("a phone that knows another chat's pending_id must not be able to answer it"); the plan-proposal path discards the session id entirely — any paired client can approve/revise any pending plan by id. Fix: mirror the approval check via PlanState + `require_chat_id`.

**9. Mid-turn loop has no idle timeout; `ChatTurn` SSE stream unbounded — a stalled provider + half-open phone parks the handler and its permit indefinitely — relay_requests.rs:326-369, chat/mod.rs:201-207 (80%).**
Main loop wraps read.next() in IDLE_TIMEOUT (relay.rs:863) but chat_turn_arm's select polls only `&mut turn` and read.next(); reads deliberately unbounded; B-9 watchdog guards chat_mgr.send streams, not this manual one. Fix: wrap read.next() in IDLE_TIMEOUT here too and/or stall-bound the chunk loop.

**10. Artifact reads block the relay runtime worker via `rx.recv()` on the WS dispatch path — session_chat.rs:1147-1153, relay.rs:681 (80%).**
`dispatch_mobile` runs inline on the connection task of the dedicated 4-worker runtime; `blocking_read` ends in sync `rx.recv()` — ReadArtifact is up to 8 MB fs::read + base64. Four concurrent artifact opens freeze every connection's frame processing. Fix: make handle_read_artifact async + spawn_blocking, or bound the recv.

**11. Stale security documentation claims per-launch token rotation the code deliberately no longer does — relay.rs:8, protocol.rs:27-28, commands.rs:105-107 (90%).**
relay.rs:416-446 loads/reuses the keychain token across launches, rotating only via Settings. Docs overstating rotation invite wrong threat-model decisions on a security-critical surface. Fix: update all three to the reuse-from-keychain design + point at regen_mobile_pairing_token.

**12. DRY: duplicated tailscale status parsing and hand-rolled error sends — tailscale.rs:104-121 vs 296-313; relay.rs ~10 match arms (1710-2039) hand-build ChatError where `domain_error(&write, domain, e)` (relay.rs:2404) does exactly that (85%).**
Fix: extract `from_parsed(TailscaleStatusJson)`; use domain_error in AddProject, SetBudget, RemoveBudget, Hide/UnhideCostProject, Create/Delete/SetEnabled/RunAutomationNow arms.
