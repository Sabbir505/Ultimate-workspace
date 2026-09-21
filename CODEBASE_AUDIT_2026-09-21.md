# Codebase Audit — Wave 5 (2026-09-21)

> **Method:** three parallel auditors (Rust chat engine + hooks; Rust platform layer; frontend + mobile)
> over the post-0.5.0 tree, plus manual verification of every Critical/High finding against the code and a
> baseline gates run. Prior waves (2026-09-06/13/14/17) are fully remediated; findings below are new as of
> this tree (hooks system + vault feature + wallpaper + get_automation, all landed after 2026-09-17).
> Items already documented as open in `docs/audits/*` or `docs/research/*` are marked **[KNOWN]**.

## Baseline gates at audit time

| Gate | Result |
|---|---|
| `cargo test --lib` | 1,255 passed, 0 failed, 16 ignored |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean (0 errors) |
| `npx tsc --noEmit` | clean |
| `vitest` | 173 files passed (1,265 tests) |

---

## Critical

**C1. [crypto] `mobile/src/hooks/useRelay.ts:315` + `mobile/src/lib/relayCrypto.ts:44-48` — E2E nonce reuse across reconnects under the same key.**
The session key is `HKDF(pairing_token)` and the token rotates only per desktop *launch*; every reconnect resets `_outCounter = 0; _inCounter = 0` and re-derives the same key, and the nonce is `16 zero bytes || counter`. A phone that drops and reconnects (sleep/wake, tailnet blip) re-sends frames with identical (key, nonce) pairs and different plaintexts — XChaCha20-Poly1305 nonce reuse leaks `p1 ⊕ p2` (frame JSON is highly predictable) and enables forgery. **Fix:** derive a per-connection key (desktop sends a fresh salt in its first authenticated reply; both sides run `HKDF(token, salt_conn)`) or use a random 96-bit nonce prefix per frame. *Verified: reset line quoted at useRelay.ts:315.*

## High

**H1. [bug] `src-tauri/src/chat/dispatch.rs:2326-2328, 2353-2355` — plan-mode refusal of connector/MCP Write tools returns an EMPTY string to the model.**
`gate_denial(true, name).unwrap_or_default()` — `gate_denial` returns `None` unless `is_mutating_tool(name)`, and vendor names (`gmail_send_message`, `notion_create_page`, `mcp_<server>_<tool>`) are not in those lists. The call IS blocked, but the model receives a success-shaped empty result: it cannot tell it was refused or that it should call `present_plan`, and typically retries or fabricates an outcome (the code comment promises "the same guidance"). **Fix:** build the denial text inline instead of re-filtering through `gate_denial`. *Verified.*

**H2. [bug] `src-tauri/src/agent_sessions/claude.rs:836-838`, `handlers.rs:172-174, 769`, `opencode.rs:1147, 1177` — harness post-hook observations receive the UI display card, not the tool arguments.**
The observation calls pass `values.first()` from `tool_meta_*` builders, which produce the display marker `{"kind":…,"title":"Editing file …"}` — the raw input is discarded (only the pi path passes the real input, `handlers.rs:590`). A format-on-write hook using `${tool_input.path}` silently no-ops or acts on the wrong file in Claude/Kimi/CommandCode/OpenCode panes. **Fix:** pass the raw block input (`b.get("input")` / `&args` / `&inp`) to `harness_observation`. (Affects the hooks feature shipped 2026-09-19.)

**H3. [race/data-loss] `src/state/vault.ts:825-828` — `restoreSnapshot` lands note content with no staleness guard (its comment claims one).**
The `set({ content, savedContent, … })` after `vaultReadNote` is unconditional — no generation counter (unlike `openNote`, vault.ts:254/442). Back-button restore of note A resolving after note B opened overwrites B's buffer with A's text while `activePath === B`; `content === savedContent` reads "clean" and the next autosave writes A's text into `B.md`. **Fix:** capture a generation before the read and bail before the `set`. *Verified.*

**H4. [bug/state-corruption] `src-tauri/src/vault/index.rs:278-284` — a failed `COMMIT` leaves the shared connection inside an open transaction.**
The `Ok(()) => conn.execute_batch("COMMIT")?` arm propagates without the ROLLBACK the `Err` arm performs. On disk-full/IO error at commit, every later vault statement fails with "cannot start a transaction within a transaction" — indexing, note writes, renames all bricked until app restart (the connection is the process-wide `DbState`). **Fix:** `let _ = conn.execute_batch("ROLLBACK");` before returning. *Verified.*

## Medium

**M1. [crypto-contract] `mobile/src/hooks/useRelay.ts:333-336` — the pairing proof `HMAC(token, "E2E")` is static and replayable; an observer who captures it once can occupy the pairing slot for the desktop run.** Loopback + tailnet TLS constrains exposure. **[KNOWN]** (documented deferred in `docs/audits/FIXES.md` / `Action_list.md`) — resurface as a challenge (`HMAC(token, server_challenge)`) when the phone protocol next ships a release.

**M2. [security/path-traversal] `src-tauri/src/vault/mod.rs:1095-1104` — `vault_note_meta` is the only vault read that skips `safe_join`.** `normalize_rel` never rejects `..`; `vault_note_meta("../../x")` returns an arbitrary file's timestamps. **Fix:** route through `safe_join`.

**M3. [contract] `src-tauri/src/agent_sessions/claude.rs:380-397` vs `hooks.rs:545-548` — a hook `ask` in full_auto is silently discarded.** The code implements the documented degrade-to-proceed (correct for the no-cards contract, and deny hooks still fire), but `HarnessGateVerdict::Ask`'s doc comment and the research doc still promise "force the card", and nothing logs the dropped ask. **Fix:** align the hooks.rs doc; emit a `chat:hook-run` warning verdict when an ask is dropped.

**M4. [bug] `src-tauri/src/hooks.rs:641-646` — imported Claude hook IDs collide across imports** (`claude-<event>-<n>` resets per batch); a later import mints duplicate ids and HooksPanel remove/toggle (keyed by id) then hits multiple rows. **Fix:** random suffix or content hash.

**M5. [compat] `src-tauri/src/hooks.rs:925-926` — post hooks ignore Claude Code's `{"decision":"block"}` output** (treated as "ok"); imported Claude hooks using the documented contract annotate nothing. **Fix:** treat `block` like `deny` in `run_post_tool`.

**M6. [bug] `src-tauri/src/chat/plan.rs:475-477` — the too-long-plan error echoes the ENTIRE oversized plan back** into the tool result, re-inflating context and inviting a longer retry. **Fix:** report `plan.chars().count()`, not `{plan}`.

**M7. [perf/hot-path] `src-tauri/src/hooks.rs` (`load_config` at 761/873/514) — two global-DB-mutex settings reads per tool call** (pre + post) in every session, plus a synchronous read on harness reader threads — even with zero hooks configured. **Fix:** cache the parsed list (generation counter bumped by `save_config`/import).

**M8. [hang] `src-tauri/src/chat/dispatch.rs:3320-3373` (`run_totp_tool`) — `bw get totp` / `op read` have no timeout**; a wedged password-manager CLI parks the tool call (auto-run under full_access) with no watchdog. **Fix:** `tokio::time::timeout` envelope.

**M9. [robustness] `src-tauri/src/hooks.rs:140` — one malformed `hooks` entry silently disables the whole hooks system** (`from_str::<Vec<HookDef>>…unwrap_or_default()`), and neither the panel nor logs surface it. **Fix:** parse per-entry over a `Value` array, skip invalid items.

**M10. [coverage] `src-tauri/src/agent_sessions/handlers.rs:380-429`, `opencode.rs:1153-1179` — opencode tool calls mostly never fire post-hook observations**: the per-turn fallback arm has no call at all, and the server path skips parts that arrive already `status:"completed"` (opencode's common inline shape). Post-hook audit logs silently under-report. **Fix:** observe on first sight regardless of `done`; add the per-turn call.

**M11. [perf/N+1] `src-tauri/src/vault/index.rs:756-770` (`search`) — up to 500 per-hit point queries after the FTS query**, all under the global DB mutex. **Fix:** join `vault_files` in the main query.

**M12. [perf] `src-tauri/src/vault/index.rs:1071-1077` (`graph`) — degree recomputation is O(edges × nodes)** (≈500M string compares at 10k notes/50k links) per `vault_graph` call. **Fix:** one-pass `HashMap` degree count.

**M13. [race/data-loss] `src/state/vault.ts:692-701 + 522-526` — deleting a note with a pending autosave resurrects the deleted file**: `closeNoteTab` flushes `saveNow()` to the just-deleted path. **Fix:** clear `activePath`/timer before the delete, or skip the flush on delete.

**M14. [bug] `src/state/vault.ts:364-371` — `bind()` leaves the previous vault's `openNotes`/`pinnedPaths`/`recentPaths`**: stale rail entries resolve against the new vault, silently creating phantom notes via the create-branch. **Fix:** reset those fields in `bind`/`unbind`.

**M15. [persistence] `src/state/vault.ts:77-92 vs 312-320` — persisted `openNotes`/`pinnedPaths`/`recentPaths` are never restored** (`loadLayout` reads only four layout scalars; the arrays reset every launch despite "persisted, capped" doc comments). **Fix:** restore with per-item validation.

**M16. [race] `src/state/vault.ts:724-741` — vault search fires per keystroke with no out-of-order guard**: a slow older query overwrites newer results and clears `searchLoading`. **Fix:** capture-and-bail on query change + debounce.

**M17. [security/DRY] `src/components/chat/DocDesignRunner.tsx:96-101` — the docgen postMessage handler checks `source`/`requestId` but not `event.source === frame.contentWindow`** (InlineDiagram.tsx:129-141 shows the intended bar). **Fix:** verify `event.source` + per-run token.

**M18. [perf] `src/components/vault/VaultEditor.tsx:222-252, 351-357` — `mathBlockRanges` scans the whole document twice per keystroke** (state-field update + decoration build). **Fix:** compute once per update; incremental rescan.

**M19. [mobile/security] `mobile/src/lib/deepLinks.ts:62-90` — a `relay://connect?host=…` deep link silently repoints the phone at an arbitrary relay host** (persisted + connected, no confirm); a malicious link can serve fake sessions/approval prompts and harvest push tokens. **Fix:** confirm dialog before connecting from a deep link.

## Low

**L1. [bug] `src-tauri/src/hooks.rs:985-994`** — the Test button always sends a `pre_tool_use` payload; lifecycle hooks are tested under the wrong event and a passing Test can mask a script that no-ops live. Fix: synthesize the payload per `def.event`.
**L2. [perf] `src/chat/tools/mod.rs:1242-1253`** — `LIST_DIRECTORY`/`WRITE_FILE`/`DELETE_FILE`/`MOVE_FILE`/`COPY_FILE` still run inline on the async runtime (only read/edit/search got the D2 `run_blocking_tool` treatment). Wrap the remaining five.
**L3. [perf] `src/chat/python_runtime.rs:93-105` + `codeexec.rs:179-187`** — blocking `py --version` probe + FS work inline per `run_code`. Resolve once into a `OnceLock`; run the body on the blocking pool.
**L4. [robustness] `src/mcp_tools_bridge.rs:364`** — `INFLIGHT.lock().unwrap()` on a std mutex poisons all future `generate_image` bridge calls after one panic mid-lock. Use `parking_lot` or `into_inner()`.
**L5. [observability] `src/hooks.rs:719, 783-792`** — `chat:hook-run` has no frontend consumer, and pre-hook verdicts always emit `"checked"` (never deny/ask), so untrusted/denied hooks are invisible outside the Test button. Wire the panel; pass the real verdict.
**L6. [DRY] hooks ask-refusal ladder** implemented three times with drifting prose (`dispatch.rs:1195, 2103`, `mcp_tools_bridge.rs:179`). Extract `hooks::refuse_ask`.
**L7. [edge] `src/hooks.rs:153-174`** — a dotted tool name (`fs.read`) flips the matcher into regex mode where `.` is a wildcard: a typo *widens* matching for such names. Try exact equality before regex.
**L8. [info] `src/chat/commands/send.rs:675-697`** — `session_start` first-turn detection is serialized by the DB mutex (no double-fire path today); fires with status "start" even if the turn then errors — observe-only, acceptable. Recorded for awareness.
**L9. [race] `src/vault/mod.rs:774-786`** — two concurrent `install_watcher` calls can leak a watcher + debounce thread (non-atomic take/compare/restore). Hold the state lock across install.
**L10. [race] `src/vault/mod.rs:841-875`** — `reindex_changed` checks the watched root once before the loop; an unbind racing the batch writes orphan rows (bounded: next bind full-scans). Re-check per file.
**L11. [leak] `src/agent_sessions/opencode.rs:449-463`** — if the SSE reader thread fails to spawn, the healthy `opencode serve` child is returned as `Err` un-killed, holding its port and bearer-tokened MCP config. `kill_child_tree` in that arm.
**L12. [secret-at-rest] `src/harness_bundle.rs:35-36, 91-92, 552+`** — connector OAuth tokens are written plaintext into the app-data harness `mcp.json`/`opencode.json` and persist after the CLI exits (adjacent-**[KNOWN]**: the 2026-09-13 audit documented the project-level variant). Delete/zero the bundle configs on session teardown.
**L13. [UX] `claude.rs:359-371`** — a hook deny's `reason` is discarded on the harness path (the CLI's canned deny message is sent instead), so the model can't adjust to what the hook flagged. Fold the reason into the deny `message`.
**L14. [portability] `src/hooks.rs:653-656`** — imported Claude hooks hard-wrap as `cmd /C`; non-Windows builds silently never run them. `#[cfg(windows)]` → `sh -c` branch for parity.
**L15. [DRY] `vault/mod.rs:341-357, 378-401`** — identical never-clobber `stem - N.ext` loops; extract `next_free_path`. Also the stderr-drain thread is copy-pasted four times (`claude.rs:165`, `opencode.rs:406`, `perturn.rs:398`, `oneshot.rs:229`).
**L16. [stale-comment] `opencode.rs:121-124`** — the "nested block_on panics" rationale no longer holds (`send()` now runs in `spawn_blocking`); misleading to a future simplifier. Update.
**L17. [mobile] `useSessionChat.ts:217, 365`** — optimistic message ids from `Date.now()` collide within the same millisecond (duplicate RN list keys; echo-replacement keys off ids). Use a decrementing counter like the desktop's `moduleState.ts`.
**L18. [bug] `src/state/vault.ts:416-424`** — clicking a wikilink to an existing-but-unindexed note errors instead of opening (create-branch throws "already exists" and returns). Fall through to `openNote`.
**L19. [leak] `src/App.tsx:141-157`** — `onResized` unlisten race on early unmount (the exact race `safeListenUnmountRace.test.tsx` guards elsewhere). Add a disposed flag.
**L20. [leak] `src/components/vault/VaultAssetView.tsx:25-39`** — blob URL created after the unmount check leaks it. Assign via ref, revoke in cleanup.
**L21. [DRY] `VaultView.tsx:585-598`** — re-implements `vaultQuickSwitcher` (Mod+P) outside the keybinding registry; a custom rebinding won't apply. Move Mod+S into the registry, delete the local handler.
**L22. [perf] `VaultGraph.tsx:462-469`** — `dataSignature` JSON.stringifies the full graph per store reload (every autosave while the overlay is open). Incremental fingerprint.
**L23. [edge] `src/state/vault.ts:259-266, 52-56`** — subpath scroll relies on fixed 350/900ms timers (slow renders never scroll); the module-level `noteContentCache` never invalidates across `bind()` (stale cross-vault completions). rAF-bounded retry; clear cache on change.
**L24. [perf] `src/chat/python_runtime`/`tools` note** — see L2/L3. *(merged)*

---

## Already known (not re-counted)

`pty/mod.rs::price_for` fossil + write-only `pricing_estimated_usd` (research doc); `AutomationRunTable`/CSV not virtualized; entry-chunk bloat (react-markdown, babel-standalone, flowchart-elk); 24 recurring frontend timers; ~40 exhaustive-deps suppressions; no i18n; `SHOW_FAKE_UPDATE`; static harness model catalog fallback (research doc, Part C); unattended full-auto authority + advisory-only budgets; unsigned installer; Google Fonts external fetch.

## Remediation short-list (highest value first)

1. **C1** mobile nonce-per-connection (crypto correctness; small diff).
2. **H1** plan-mode empty denial → real refusal text (one-liner ×2 sites).
3. **H3 + H4 + M13/M14** vault data-integrity batch (generation guard, COMMIT rollback, delete-vs-autosave, bind reset).
4. **H2 + M10 + M5 + M4** hooks-harness correctness batch (raw inputs, opencode coverage, `block` contract, import ids).
5. **M2** `vault_note_meta` safe_join (one-liner).
6. **M7** hooks config caching (hot-path DB reads).
7. **M6** plan-too-long echo (one-liner).

## Coverage

- **Auditor 1** (chat engine + hooks): hooks.rs, hooks_cmds.rs, chat/** (dispatch, streaming, mod, send, commands, providers, tools, permission, plan, compaction, totp, codeexec, office, python_runtime, reconnect, error_class, cache, partial_buf, turn_perf, docs), mcp_tools_bridge, exec_gate, hooks frontend. Clean: streaming marker math, cancel/reconnect gates, permission posture matrix, bridge allowlist + automation gate, hooks core (matcher/substitution/timeout/envelope/gate), HooksPanel.
- **Auditor 2** (platform): agent_sessions (full for claude/handlers/opencode/tracker/lifecycle/dirwatch/ask/oneshot), automations + sidecar, vault/**, db/** (migrations, cost_v2, memory, automations, session_fabric), connectors (oauth full, rest scan), mobile (relay_ws/relay_crypto full), pty kill/spawn/monitor, browser_mcp auth, secrets/exec_gate/download/git_watcher, harness_bundle token paths. Clean: block_on placement (verified std-thread-only), kill_child_tree + RAII one-shot registry, automation overlap guards, mobile pairing/crypto gates, migration backfills, oauth callback.
- **Auditor 3** (frontend + mobile): vault feature (all components + store), hooks UI, chat streaming slices + ChatView/MessageBubble/Composer, BrowserPane/browserTrust, sanitize/interactiveHtml (exemplary), settings/appearance/wallpaper, ipcCore/sessionLauncher/workspaceRestore, mobile relay crypto/hooks/deepLinks, build config. Clean: pane-buffer contract, streaming slices, sanitize pipeline, no localStorage secrets.
- **Spot-checks by the orchestrator:** C1, H1, H3, H4 verified by direct read; M2/M11/M12 line-checked; baseline gates run.
- **Scan-only (no claims):** connectors REST bodies, db/chat.rs + db/docs.rs internals, browser/{actions,tabs}.rs, bin/relay_browser_mcp.rs, per-CLI harness adapters, memory/ + session_fabric/ task bodies, mobile screens beyond hooks/lib, docdesign compilers. These overlap prior remediated waves.

**Totals:** 1 Critical · 4 High · 19 Medium · ~20 Low + 1 informational, plus KNOWN markers.

---

## Remediation status (all findings fixed same day, 2026-09-21)

Every finding above is fixed. Gates after remediation: clippy `-D warnings` clean, `cargo test --lib`
**1,262 passed / 0 failed**, `tsc --noEmit` clean (desktop + mobile), vitest **173 files / 1,271 tests passed**.
Highlights per finding (full fixes in the working tree; not committed at audit time):

- **C1** — per-connection session key: desktop generates a 32-byte salt per pairing, sends it in a plaintext
  `PairOk` frame before any encrypted frame, and derives `HKDF(token, conn_salt)` (`relay_crypto.rs::derive_session_key_with_salt`,
  `relay_requests.rs`, `protocol.rs::PairOk`); mobile mirrors it (`relayCrypto.ts` salt param + `b64UrlToBytes`,
  `useRelay.ts` PairOk handler with send-queue until keyed). The salted design also closes M1's practical
  impact: a replayed static proof pairs but cannot derive the key, so every frame fails the tag check.
  Legacy derivation kept for the pinned cross-implementation vectors; new salted vectors added. Coordinated
  protocol change: an old-phone + new-desktop pairing will fail (both apps ship from this repo).
- **H1** plan-mode refusals now return real guidance text (`plan::plan_denial_message`, both dispatch sites).
- **H2** all harness observation sites pass the RAW tool input (claude `b.get("input")`, kimi/commandcode/
  opencode raw args; pi unchanged); **M10** opencode observes on first sight (start OR completed-inline) via
  the existing `seen` state machine + the per-turn arm got its missing call.
- **H3** `restoreSnapshot` participates in `openGeneration` and bails when superseded; **H4** both vault
  transaction sites ROLLBACK on COMMIT failure; **M13** delete neutralizes the pending autosave before the
  backend delete; **M14** `bind()` resets tabs/pins/recents/modes.
- **M2** `vault_note_meta` routed through `safe_join`; **M11** vault search JOIN (per-hit queries gone);
  **M12** O(E) degree map; **M17** DocDesignRunner verifies `event.source` + per-run token.
- **M4/M5/M6/M7/M8/M9** hooks: content-hash import ids, `decision:"block"` honored, plan-too-long reports the
  count not the text, 2s-TTL config cache with explicit invalidation (hot-path DB reads gone), 30s TOTP
  watchdog, per-entry config parsing that skips bad entries.
- **M15/M16/M19/L1-L24** all fixed as specified (layout restore with validation, debounced+guarded search,
  deep-link confirm dialog, lifecycle-aware test payloads, blocking-pool FS tools, interpreter OnceLock,
  parking_lot INFLIGHT, real hook verdicts + HooksPanel live `chat:hook-run` feed, unified `refuse_ask`,
  exact-equality before regex, watcher/reindex races, opencode child kill, deny-reason carried to the CLI,
  `sh -c` import branch, `next_free_path` + `drain_stderr` DRY helpers, stale comment, mobile optimistic-id
  counter, link-open fallthrough, onResized disposed flag, blob-URL ref revocation, registry-owned Mod+S,
  cheap graph fingerprint, rAF-ready subpath scroll + cache invalidation).
- **L8** (session_start double-fire) confirmed unreachable under the DB mutex — informational, no change.
- **L3 partial**: python interpreter resolution cached; the codeexec temp-dir FS ops were left inline
  (wrapping would restructure error-cleanup flow; the expensive blocking probe is gone). The vault feature (newest, least-audited surface) accounts for roughly half of all findings; the hooks system's remaining defects are concentrated in harness-path input fidelity (H2/M10) and config ergonomics (M4/M9), not in its security envelope.
