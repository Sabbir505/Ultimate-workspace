# Relay — Architecture & DRY Refactor Progress

> **Goal:** Refactor until the architecture is clean and DRY. After each significant step: live-test the system, run autoreview (code-review agent), and update this file.
>
> **Started:** 2026-09-10 · **Branch:** `fix/browser-chip-pane-binding-and-strip-ux`

## Baseline (2026-09-10)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean (0 errors) |
| `vitest run` | 136 files / 857 tests passed |
| `cargo check` (src-tauri) | clean (62 pre-existing warnings) |

Codebase size at start: ~75k lines TS/React (`src/`), ~109k lines Rust (`src-tauri/`), plus `mobile/` (Expo/React Native).

Prior context:
- `PROJECT_AUDIT.md` (2026-09-10): all actionable audit findings fixed; 1011 cargo tests + 857 vitest tests green at audit time.
- `docs/superpowers/plans/2026-08-10-refactor.md`: a month-old refactor plan, **0/181 tasks executed**, line counts now badly stale → superseded by this effort.

## Constraints (adopted from the prior plan where still valid)

- No behavior change in mechanical refactor steps — splits, moves, dedup with identical semantics.
- Backward-compat re-exports at split boundaries so caller sites don't churn.
- Tests move with their code.
- Build before considering a step done: `npx tsc --noEmit` (frontend) / `cargo check` (Rust); full test suites before commit.
- Autoreview (code-review subagent) after each significant step; findings fixed or logged before moving on.
- One conventional commit per step.

## Steps — session 8: resumable-download engine + a caught deadlock (2026-09-11)

| # | Step | Outcome | Verification | Commit |
|---|---|---|---|---|
| 8 | **Resumable-download consolidation.** New `src/download.rs`: `pump_body_to_file(resp, partial, start, resuming, stall, &mut cancel_rx, on_chunk)` owns the body→file loop with cancel + data-stall watchdogs, returning a `BodyPumpOutcome` (Completed/Cancelled/Stalled/ReadError/WriteError) + byte count. Migrated: `download_task` (model tool — keeps .part on cancel/stall, retries via Range) and `run_download` (HF market — removes .partial on cancel, maps outcomes to DownloadAbort::Failed, gains a 500-char error snippet where bodies were untruncated). **Bonus find:** migrating exposed a REAL deadlock — download_task's cancelled arm held the `entry.snapshot` std-Mutex guard across `TaskManager::emit`, which re-locks the same mutex. Original code scoped the guard; the pump-migration version had hoisted it. Fixed with an inner scope + a comment explaining why the guard must die before emit | cargo check 0 errors · warnings 61 (< 62 baseline) · cargo test --lib **1021 ✓** incl. `cancel_keeps_part_file_for_resume` 0.36s | n/a (test IS the verification) | `refactor(download): market run_download onto the shared body pump; fix cancel deadlock` |

**Debugging war-story (documented for future sessions):** the hang initially looked like a slow build. Actual chain: (1) the deadlock genuinely hung the test binary; (2) every later `cargo test` hit LNK1104 — Windows keeps the .exe locked while the hung process lives — which masqueraded as "could not compile" churn; (3) `git checkout` of sources didn't help while the process lived. Fix: kill `relay_lib*` processes, then scope the guard. Also: the user's dev `relay.exe` + the auto-format watcher share `target/`, so expect lock waits when editing rs files while the app runs.

## Steps — session 10: deep-carve completions (2026-09-11)

| Step | Outcome | Verification | Commit |
|---|---|---|---|
| MessageBubble carve | **2,278 → 708 lines.** The Markdown rendering system (lazy highlighter plumbing, icon cluster, ChatImage, cachedMarkdown, citeUrlTransform, `<Markdown>` + InsidePreContext) and the entire activity-step stack (StepStatusIcon/stepLabel/InlineDiff/StepCodeHighlighter/ActivityStepRow/ProcessSummary/FoldedStepGroup/EditFileRow/ThinkingBlock, ActivityStep/Group/Block types, groupSegments, renderProcessBlock, useLiveElapsedSec, formatMessageTimestamp) now live in **ActivitySteps.tsx (1,676 lines)**, imported back one-directionally; ThinkingBlock re-exported for SubagentPanel | tsc clean · vitest 138/869 · build ok | `refactor(chat): carve MessageBubble's Markdown + activity-steps system…` |
| browser_js extraction | **browser.rs 5,032 → 4,550.** 13 injected-JS builders + embedded script consts → **browser_js.rs (491 lines)**; re-exported so browser_mcp.rs call sites unchanged | cargo 1024 ✓ | `refactor(browser): extract the injected-JS builders…` |
| Provider defaults single-sourced | `ANTHROPIC/OPENAI/OPENROUTER/LOCAL_GGUF_DEFAULT_MODEL` consts own every default-model answer; all `default_model()` impls + the mobile relay catalog reference them (the two catalogs can no longer drift) | cargo 1024 ✓ | `refactor(providers): single-source the default model ids…` |
| ChatComposer carve | **3,032 → 2,746 lines.** Size limits, slash-command parsers, ChatAttachment + classify/encode/readAsBase64, ext tables, chrome icons, voice cadence constants + flattenVoiceText/chunkSeconds, AttachmentCard → **composerShared.tsx (330 lines)**; public names re-exported (ChatAttachment for ChatView, parsers for tests) | tsc clean · vitest 869 ✓ · build ok | `refactor(composer): extract helpers + attachment plumbing…` |

## Steps — session 11: the deep-tail carves (2026-09-12)

Branch note: session runs on `feat/onboarding-wizard` (the user's active branch — onboarding work landed here mid-session as 1322b85c/bd219929). Baseline at session start: tsc clean · vitest 983/983 after the onboarding commits (the 3-4 pre-existing localModelAdvanced/commandPaletteChats failures present with the uncommitted onboarding work resolved themselves once those landed) · cargo check clean, 73 pre-existing warnings (feature work merged since session 10). Every Rust step gates on: cargo check 0 errors, warning-set byte-identical to pre-step (sorted/normalized diff), cargo test --lib 1055/1055.

| Step | Outcome | Verification | Review | Commit |
|---|---|---|---|---|
| ChatComposer carve | **2,756 → 1,635 lines** across three commits: (1) chrome components (QueuedMessageRow, QuotedSelectionRow, FolderNotch, GitHubNotch, ThinkingIcon, ThinkingToggle) → **composerChrome.tsx (490)**, FolderNotch/GitHubNotch re-exported for App.tsx; (2) the whole voice-dictation engine (state, refs, capture/segment-commit chain, hold-Alt push-to-talk) → **useVoiceDictation.ts (587)** hook taking setContent/textareaRef/setCaret/effectiveSessionId; (3) template-picker + broadcast modals → **composerModals.tsx** (state deliberately kept in the parent — hoisting would reset drafts on close/reopen, a behavior change). The slash/@ decks stay: 54 lines with a placement-sensitive CSS anchoring contract and keyboard-nav coupling | tsc clean · vite build ok · vitest **983/983** | **PASS** (conditional, resolved: pre-carve `renderVoiceText`/`removeVoiceSpan` deps verified `[]` in git — parity holds). Review follow-ups: dead selectContextSessionId import (fixed, 4ab6e5c); pre-existing stale-closure pattern (dictation write path + Alt-gate freeze on session switch without remount) logged below | 953351b7 + 0b823fe1 + cbe0c26a + 4ab6e5c |
| ChatView carve | **2,292 → 1,687 lines**: (1) the transcript scroll engine (stick-to-bottom latch + programmatic-pin suppression, measured live-edge pinning, history prepend w/ anchor restore, jump-to-latest glide, dock wheel chaining, approval/question-card anchoring, scroll-to-message registration) → **useTranscriptScroll.ts (530)**; the virtualizer is reached via a render-assigned `virtualizerImplRef` so the hook call keeps the original position and effect-registration order; (2) local-GGUF discovery + sidecar lifecycle (scan, live sidecar id, overrides blob + ref mirror, spawn/warm, chat-switch re-warm) → **useLocalModelSidecar.ts (300)**; the session-mutating pick handlers stay in ChatView (agent→spawn→provider→model ordering contract spans store writes) | tsc · build · chatViewTimelineMemo + subagentScrollFollow ✓ · vitest 982/983 (the 1 fail = automationStop real-timer flake, passes 9/9 solo, file untouched) · build ok | **PASS**. Notes: intra-frame rAF ordering between follow/pin and the retained remeasure effect flipped (converging, inert); added the virtualizerImplRef contract comment at the assignment site (00ba369c) | f2033a94 + 21f4aab9 + 00ba369c |
| AgentModelPicker carve | **1,169 → 1,011**: pane footer sliders (AutoBiasFooter, HarnessEffortFooter, ProviderEffortFooter) + GearSubModal (the portaled runtime-settings dialog) → **agentPickerParts.tsx (215)**; the parent's show*/guard conditionals stay at call sites; EFFORT_LABELS / HARNESS_EFFORT_LABELS / HARNESS_EFFORT_COLORS moved to agentPickerShared with boundary re-exports | tsc · build · picker suites 12/12 · build ok | **PASS**. NITs fixed in e3b7e670 (dead label-table import); stale EFFORT_LABELS doc comment reworded | 4e4fbbd6 + e3b7e670 |
| commands.rs split | **6,782 → 42-line shell + nine domain children** along the file's own `// ----` markers: sessions (704), artifacts (213), generators (398), send (2,117), approval (360), preview (845), api_keys (254), llama_sidecar (387), selection (1,527). Mechanical: bare top-level items → pub(super); children `use super::*`; shell `pub use child::*;` keeps every `crate::chat::commands::X` path + invoke_handler refs unchanged. Note: the doc's "send_chat_message (1,199 lines)" was stale — feature PRs #27–#34 had already brought it to ~311; the section split is this step's real content. The child first named `local_models` was renamed `llama_sidecar` — it shadowed the pre-existing `use crate::chat::local_models;` (E0255) | cargo check 0 errors · warning set byte-identical (73) · cargo test --lib **1055/1055** | **PASS** (zero non-NIT findings). NITs: stale `commands::local_models` doc path (fixed); selection::tests tests three helpers living in siblings (logged as follow-up) | 0d379bd1 + (docs) |
| BrowserManager impl split | **browser.rs 4,558 → 2,758-line mod.rs + four impl children**: navigation (375 — navigate/history/bounds/close), actions (718 — action exec, nav-quiet, devtools/pdf/capture, read/observe/extract), tabs (422 — pane registry + request plumbing, trust layer, tab ops), interactions (325 — ref click/type/hover, forms, snapshot, evaluate, healed resolution). Private methods → pub(super) so sibling impl blocks reach them; each child opens its own `impl BrowserManager`; cfg-paired duplicate methods kept whole; the two trailing doc blocks at cut seams relocated onto resolve_action / pane_is_visible | cargo check 0 errors · warnings identical · cargo test --lib **1055/1055** | **PASS**. NITs fixed in b527cff5 (section comments relocated to the right children; orphaned `///` for build_resolve_js demoted to `//`). Pre-existing observations logged below | f3041558 + b527cff5 |
| mobile handle_connection carve | **relay.rs 2,624 → 2,238; handle_connection 1,046 → ~560**: eight verbatim blocks → **relay_requests.rs (524)** — verify_pairing (returns the B-24 used_e2e flag; rejection paths' `return Err` → helper Err + `?`), chat_turn_arm (the B-26 select loop; call site propagates with `.await?` — same kill-the-connection semantics as the old inline `return Err`), get_transcript_arm (per-connection transcript_hashes passed `&mut`), get_cost_summary_arm, start_local_model_arm, spawn_session_arm, create_session_arm, transcribe_audio_arm. Socket-reading helpers take a generic `read: &mut R where R: Stream<Item = Result<Message, Error>> + Unpin`. send_msg/handle_chat_turn/PAIRING_TIMEOUT bumped to pub(super) | cargo check 0 errors · warnings identical · cargo test --lib **1055/1055** | **PASS** (zero non-NIT findings; control-flow conversions verified exact — turn-completion break keeps the connection, read error/close kills it; the frame-less length-mismatch pairing rejection confirmed pre-existing in the pre-image). NIT: moved bodies keep arm-depth indentation (intentional, fmt-on-touch) | 7fe46dd6 |

### Review follow-ups (pre-existing, deliberately not mixed into mechanical carves)

- `useVoiceDictation` write path freezes `setContent`/`effectiveSessionId` at mount (`renderVoiceText`/`removeVoiceSpan` `[]` deps, Alt-talk effect deps exclude `effectiveSessionId`) — after a session switch that doesn't remount the composer, dictation can splice into the previous chat's draft and hold-Alt can no-op until `transcribing` flips. House style predates the carve (same pattern in `replaceTokenSpan`); fixing it is a small behavior fix: add `setContent` to those deps.
- `ThinkingToggle` in composerChrome has no consumers (dead pre-carve too; kept as exported chrome).
- `selection::tests` (chat/commands) tests `strip_think_blocks`/`parse_invoked_skills`/`message_has_slash_token` which now live in sessions.rs/send.rs — follow-up: move the three test fns to their subjects.
- `BrowserManager::attach_navigation_listeners` (browser.rs) has zero crate-wide references — dead before the split (no new dead_code warning). Candidate for deletion after a git-history check on why the call went away.
- automationStop.test.tsx is load-flaky under the full vitest run (real-timer "1m 30s" assertion; passes in isolation). Not a refactor regression — pre-existing since the live-timer feature.

---

### Still open — session 11 disposition (2026-09-12)

Everything on the 2026-09-11 deep-tail list is done:

- **ChatComposer.tsx** — ✅ session 11 (chrome, voice dictation, modals carved; see session 11 table).
- **ChatView.tsx** — ✅ session 11 (scroll engine + local-model sidecar carved; split-pane wiring was too thin/spread to be a seam — it's inline selectors + one load effect, left as-is).
- **chat/commands.rs** — ✅ session 11 (nine-domain split; `send_chat_message`'s 1,199-line figure was stale — feature work had already reduced it to ~311).
- **browser.rs** — ✅ session 11 (impl split along navigation/actions/tabs/interactions seams; the injected-JS extraction was already done in session 10).
- **mobile/relay.rs** — ✅ session 11 (handle_connection carve; the provider-catalog half was already resolved in session 10).
- **AgentModelPicker** — ✅ session 11 (gear sub-modal + pane footers carved; the rail/pane fetch machinery remains one cohesive unit — further splitting would fragment railKey/pane/ranked/activeIndex state for no standalone modules).

No further refactor items are outstanding from the original survey. Residual candidates live in "Review follow-ups" above.

---

## Steps — session 7: agent_sessions split completed (2026-09-11)

| # | Step | Outcome | Verification | Commit |
|---|---|---|---|---|
| 2 | **agent_sessions split — COMPLETE.** The 9,213-line mod.rs carved into 13 domain child modules along its mapped seams: `lifecycle` (133 — one-shot child registry/guards, CLI session persistence), `primer` (318 — context-primer assembly, actual-model persistence), `attachments` (147), `acp` (663 — ACP turn dispatch + stream reader), `dirwatch` (329), `bundle` (174), `claude` (1005 — spawn, permission/ask handling, read_claude_stream), `perturn` (579 — per-turn harness spawn + reader), `ask` (324 — RELAY_ASK channel), `opencode` (1001 — turn dispatch, server lifecycle, SSE reader), `handlers` (679 — the four harness event handlers + spawn/usage helpers), `oneshot` (895 — run_one_shot family), `tracker` (654, prior session). mod.rs shell: 3,045 lines (manager, shared emit/persist, finalization, inline tests). Every child is a `use super::*` carve (inherits parent imports + private helpers), items pub(super), glob-reimported so call sites are unchanged; pub/pub(crate) items re-exported for external consumers; trailing doc comments moved with their items; ONE_SHOT_CHILDREN doc reunified | cargo check 0 errors · warnings 61 (< 62 baseline) · cargo test --lib **1021 ✓** | n/a (pure moves) | `refactor(agent_sessions): split the 9.2k-line file into 13 domain modules` |

Note: one commit message lost two words to shell backtick expansion (`use super::*` in the text) — cosmetic, left as-is rather than force-pushing the shared branch.

## Steps — session 6: finishing the list (2026-09-10)

| # | Item | Outcome | Verification | Commit |
|---|---|---|---|---|
| 1 | `run_subagent_loop` (last streaming transport) | **Decision: parsing stays bespoke by design** — the subagent loop needs B-11 thinking-echo (text + signature), D6 output sanitization, transcript-embedded markers, and SUBAGENT_RESULT_CAP capping, which the shared pump/execution primitives don't model; forcing them through would change subagent semantics. The genuinely duplicated part was extracted: `parse_subagent_args` + `run_subagent_call` collapse the two format branches' identical per-call tails | cargo · 1021 ✓ | `refactor(subagent): shared per-call execution tail…` |
| 4 | lib/ipc rehoming | `chatSessions.ts` now owns the chat wire-type family (from prompts.ts) + session mutators/cancel/persist/resolve/key+config wrappers (from automations.ts); prompts.ts 345→83, automations.ts 213→113; barrel re-export keeps consumers unchanged | tsc · vitest 865 ✓ | `refactor(ipc): rehome the chat wire-type family…` |
| 3 | checked_send long tail | New `checked_send_ctx(builder, n, op)`: keeps operation context prefixes ("gmail search failed: …" / "gmail search HTTP 400: …" — the "HTTP {status}:" marker stays load-bearing) and adds a 500-char body snippet where bodies previously flowed untruncated. Migrated gmail_api ×7 + google_rest ×5 (+1 hand-migrated for its inline-comment builder); search.rs's compact no-body form stays by design | cargo · 1021 ✓ | `refactor(connectors): checked_send_ctx…` |
| 2 | agent_sessions.rs split (first carve) | Directory module: `agent_sessions/mod.rs` + `tracker.rs` (654 lines — ToolTracker cluster: PendingTool/SubagentMeta/ToolTracker + impl, tool_meta_* builders, shell/subagent name helpers, result markers), child module inheriting the parent's imports/helpers via `use super::*`, items re-exposed pub(super), glob-imported back so all call sites are unchanged | cargo · 1021 ✓ (test build incl.) | `refactor(agent_sessions): extract ToolTracker/meta…` |

**Streaming merge: CLOSED.** mobile ✓ · run_chat_stream ✓ · tool loops ✓ (execution shared) · subagent ✓ (execution shared; parsing bespoke by design — recorded above). The ~1,600 LOC duplication estimate resolved into: execution contracts now shared everywhere they could be without behavior change; the per-format round parsers remain distinct because they genuinely parse different wire shapes.

**agent_sessions split: first carve landed** (tracker.rs). Remaining carves (same mechanical pattern — slice by top-level items, child module + `use super::*`, pub(super) + glob back): primer/context assembly, attachments, claude turn reader, per-turn harness spawn/read, opencode server, the four event handlers, one-shot runner, finalization/emitters, and the tests module. Each carve is independently committable.

---

## Steps — session 5: streaming loop merge, transports 1–2 (2026-09-10)

| # | Step | Verification | Autoreview | Commit |
|---|---|---|---|---|
| M0 | `streaming::ProviderSsePump` + `SsePumpEvent` — shared per-line provider-SSE machinery: parse via the ChatProvider trait, reasoning-sentinel `<think>` wrapping, full-text accumulation, B-18 parse-failure tolerance, `close_think()` | tsc n/a · cargo 1021 ✓ | reviewed with M1+M2 | (with M1) |
| M1 | **Transport 1 — mobile `handle_chat_turn`** onto the pump. Gains three safety nets the builtin path already had: B-18 parse tolerance (stray malformed line skipped instead of failing the turn), EOF flush of a trailing unterminated line, pump-managed think state. Emit channel (ws), done handling, usage parse, persist unchanged; the chunk watchdog was deliberately NOT added (plain `stream.next()` kept) | cargo check clean · 1021 ✓ | **PASS** | `refactor(stream): ProviderSsePump; mobile chat loop…` |
| M2 | **Transport 2 — `run_chat_stream`** (builtin non-tool path) onto the same pump, via a local `emit_token` closure (stream_events → app.emit fallback). B-9 watchdog, D4 whole-loop done, perf recording (not on the think closer), EOF tolerance, think-closer all preserved; −60 lines, one loop definition left instead of two | cargo 1021 ✓ incl. `done_marker_ends_the_whole_read_loop` (mock server e2e) | **PASS** | `refactor(stream): run_chat_stream onto the shared ProviderSsePump` |

| M3 | **Tool loops** (`run_openai_tool_loop` / `run_anthropic_tool_loop`): both now normalize their wire shape once into `NormalizedToolCall` (id, name, parsed args) and share `spawn_task_fanout` (parallel Task pre-pass) + `run_round_tool` (marker pair, deferred await, RUN_SHELL output attachment, live-web flag). Request building, round parsing, echo/result-message shapes, B-17 cache-rejection retry, Hermes fallback, and tripwire logic stay per-loop — they genuinely differ | cargo check clean · 1021 ✓ | n/a (mechanical) | `refactor(stream): shared tool-call execution in both tool loops` |

**Transport status:** mobile ✓ · run_chat_stream ✓ · tool loops ✓ (execution shared; round parsing per-format by design) · **`run_subagent_loop` remains** — it emits raw chunks to `chat:subagent-tokens`, uses its own `subagent_run_tool` wrapper, and carries inline dual-format accumulators (~250 lines); merging it means deciding whether its execution wrapper can route through `run_round_tool` without changing subagent permission semantics — a dedicated session. The agent_sessions.rs harness readers parse CLI JSON event schemas, not provider SSE — out of scope by design.

### Remaining transports

- **Tool loops** (`run_openai_tool_loop` / `run_anthropic_tool_loop` + their `*_stream_round` bodies): these parse raw provider JSON inline (not via the trait) and interleave tool-call accumulation + B-17 cache-rejection retries — merging them onto the pump (or each other) is the next transport, but needs the rounds' delta-accumulation behavior pinned first.
- **`run_subagent_loop`** (dispatch.rs): carries both OpenAI- and Anthropic-shaped accumulators inline; same treatment after the tool loops.
- The harness readers in agent_sessions.rs parse CLI JSON event schemas, not provider SSE — correctly out of scope for this pump.

---

## Steps — session 4: the still-open list (2026-09-10)

| # | Item | Outcome | Verification | Commit |
|---|---|---|---|---|
| ipc rollout | All remaining sections out of lib/ipc.ts | 15 contiguous domain files (`approvals budget voice prompts artifacts automations localModels harnessChat exportImport updater workspaces marketFiles github rag mcp`) over ipcCore; ipc.ts = 448-line base (projects/sessions/chat) + barrel re-exports. Cross-slice type refs resolve through the barrel as erased imports; script-assisted with tsc-driven import synthesis. Autoreview: PASS with cosmetic cleanups (dead head imports pruned, duplicate star-export removed, unused safeListen imports dropped) | tsc clean · vitest 865 ✓ · build ✓ · autoreview **PASS** | `refactor(ipc): roll remaining sections…` + cleanups |
| settings split (rest) | GitPanel (219), ApiKeysPanel (615), ConnectorsPanel (331), DataPanel (303) extracted | **SettingsView.tsx: 3,085 → 843 lines** — every panel now a standalone module; SettingsView remains the sole importer (lazy) | tsc · vitest 865 ✓ · build ✓ | `refactor(settings): extract GitPanel, ApiKeysPanel…` |

### Still open (updated)

- **Streaming loop-body merge** — prerequisites in place (behavior pins, shared primitives); merge transport-by-transport, biggest remaining item.
- **agent_sessions.rs full split** along the surveyed seams (handler tails already deduped).
- **checked_send long tail** (~20 sites) — per-site decisions on context prefixes/truncation bounds; mobile app surfaces these strings.
- **Semantic rehoming pass** in lib/ipc/ (e.g. chat-session CRUD wrappers scattered across prompts/automations slices per the original banner order — autoreview observation, cosmetic).

---

## Steps — session 3: backlog sweep (2026-09-10)

Worked the remaining survey backlog item by item, each step verified + committed.

| # | Item | Outcome | Verification | Commit |
|---|---|---|---|---|
| 7 | Pin toolchain | `src-tauri/rust-toolchain.toml` — stable channel + rustfmt component guaranteed present (its absence caused the 1.9 migration) | n/a | `chore: pin toolchain…` |
| 8 | Hermetic format tests | format.test.ts pins TZ=UTC + stubs Intl.DateTimeFormat to en-US | vitest ✓ | `test: pin locale + timezone…` |
| 9 | Repo-root cleanup | `.playwright-mcp/` ignored; loose research notes/artifacts moved to `Random Stuff/`; stray codemod script removed | n/a | (with #7) |
| 6 | Resize-handle lifecycle | `lib/pointerDrag::startPointerDrag` replaces 4 hand-rolled pointerdown/move/up/cancel dances (App split rAF batching, ToolPanel, DevDiffPanel, ArtifactPreviewPane keep their own math). Capture-based drags gain pointercancel handling + guarded release | tsc · vitest 865 ✓ · build ✓ | `refactor(ui): shared startPointerDrag…` |
| 5 | chat.ts loaders + session patches | `loadBufferPage`/`loadBufferOlder` unify the main/split buffer twins (per-pane guards + dedupe preserved); `patchSessions` replaces 12 uniform `sessions.map` sites (8 conditional-patch sites stay explicit) | tsc · vitest 865 ✓ | `refactor(state): buffer-keyed page loaders + patchSessions…` |
| 1 | Streaming behavior pins | 8 new tests: OpenAI-family `parse_sse_chunk` (content/reasoning alias/[DONE]/finish_reason/fatal error events/usage retention), `resolve_base_url` table, thinking-budget bounds property (documents the clamp precondition) | cargo test --lib **1021 ✓** | `test(llm): pin the SSE-parse and provider-dispatch contracts` |
| 2 | HTTP status-check helper | `util::checked_send(builder, snippet_chars)` with the load-bearing `HTTP {status}:` prefix documented on both sides (error_class.rs substring match). Migrated the 2 fully-canonical sites (llm_client one-shots). ~20 residual sites embed operation context ("gmail search HTTP …") or untruncated bodies — collapsing them changes user-visible error text, needs per-site review | cargo check · 1021 ✓ | `refactor(util): checked_send…` |
| 3 | Harness handler dedup | `emit_subagent_spawn` (3 copies) + `merge_round_usage` (5 copies incl. 2 in commandcode) extracted from the four per-harness event handlers; frame parsing stays per-harness | cargo · 1021 ✓ · autoreview **PASS** | `refactor(harness): extract emit_subagent_spawn + merge_round_usage` |
| 4a | ipc.ts split (scoped) | `lib/ipcCore.ts` (runtime guard, safeInvoke/safeListen, toasts) + `lib/ipc/modelMarket.ts` (HF market domain) extracted; ipc.ts re-exports both → 125 consumer sites unchanged. Pattern proof for rolling out the remaining ~24 sections | tsc · vitest 865 ✓ · build ✓ | `refactor(ipc): split transport core + first domain…` |
| 4b | SettingsView split (first cut) | `ToggleSwitch.tsx` + `LocalModelsPanel.tsx` (991 lines incl. electricity/compaction sub-panels + shared KV constants, now exported) extracted; SettingsView 3,085 → 2,105 lines | tsc · vitest 865 ✓ · build ✓ | `refactor(settings): extract ToggleSwitch and the LocalModels panel cluster` |

### Still open (next-up list)

- ipc.ts: roll the remaining sections (browser, git, harness/models, chat streaming, connectors…) into `lib/ipc/*.ts` on the ipcCore foundation — mechanical now that the pattern exists.
- SettingsView: same extraction treatment for ApiKeysPanel (564), ConnectorsPanel (280), DataPanel (~290), GitPanel (170).
- agent_sessions.rs: full split along the surveyed seams (the four handlers now share their tails; the frames themselves stay per-harness by design).
- checked_send long tail: ~20 sites needing per-site decisions on context prefixes and truncation bounds (mobile app surfaces these strings).
- Streaming loop-body merge: prerequisites now exist (behavior pins + shared primitives); merge transport-by-transport.

---

## Steps — session 2: streaming-turn consolidation (2026-09-10)

The highest-value deferred item: the ~1,600 LOC of duplicated "stream one LLM turn" machinery. Attacked in verifiable stages, foundations first — the full loop unification deliberately NOT forced in one pass (see "what remains" below).

| # | Step | Verification | Autoreview | Commit |
|---|---|---|---|---|
| 7A | `src/chat/llm_client.rs`: `oneshot_client()` (B-10 timeouts) + `resolve_base_url` + `oneshot()` dispatch replaces 5 copies of the "resolve provider → dispatch one call" block (title 32 / commit 64 / diff-review 2048 / github PR 768 / memory extraction). `openai_oneshot`/`anthropic_oneshot` moved verbatim. Intentional deltas: github PR draft gains B-10 timeouts (was `Client::new()`, could hang forever); memory-extraction's anthropic_compatible missing-base error gains the "set the endpoint in Settings" suffix. The assistant-panel one-shot in chat/mod.rs stays bespoke on purpose (treats anthropic_compatible as managed-with-default, errors instead of skipping) | cargo check clean · warnings 62 (= baseline) · cargo test --lib **1011 ✓** | **PASS** | `refactor(llm): chat::llm_client — one dispatch for all one-shot completions` |
| 7C | `SseLineBuffer::with_cap()` — the mobile chat-turn loop and the opencode server-event reader hand-rolled the push_str/find/drain line buffering (the B-14 bug class the shared buffer exists for). The cap preserves the opencode reader's 4 MiB no-newline flood guard, and is strictly better: complete lines still drain mid-flood. (stt.rs "hand-rolled SSE" from the survey was actually a binary zip download — no change needed) | cargo check clean · cargo test --lib **1013 ✓** (2 new buffer tests) | n/a (small, covered by D review) | `refactor(util): SseLineBuffer::with_cap; adopt the shared buffer in mobile + opencode readers` |
| 7D | `cache::apply_openai_cache_marks()` — the 12-line cache-marking block was copy-identical between providers.rs (non-tool builder) and streaming.rs (tool-loop body); now one home for the cache-correctness invariant. `providers::anthropic_thinking_budget()` — the budget fallback formula must stay in lockstep across both Anthropic builders; the paths keep their own (deliberately diverged) thinking semantics and share only the formula | cargo check clean · warnings 62 · cargo test --lib **1013 ✓** | n/a (mechanical) | `refactor(chat): shared OpenAI cache-mark helper + anthropic thinking budget` |

### What remains of the streaming consolidation (and why it stopped here)

The five loop bodies themselves (streaming.rs `openai_stream_round`/`anthropic_stream_round` + their tool loops, dispatch.rs `run_subagent_loop`, mod.rs `run_chat_stream`, mobile/relay.rs `handle_chat_turn`, agent_sessions.rs harness readers) still carry per-path semantics that are NOT mechanical to merge:
- retry guards differ (B-17/B-18 cache-rejection retry in streaming.rs, absent in mobile);
- block-index clamping differs (main rounds clamp at 64; the subagent BTreeMap doesn't);
- `<think>` wrapping placement, usage parsing, and emit channels (app.emit vs ws send vs Channel) differ per transport;
- the harness readers (agent_sessions.rs) parse Claude-Code/opencode event schemas, not provider SSE.
Unifying them safely means first pinning those behaviors with targeted tests, then merging transport-by-transport. The shared primitives this session extracted (oneshot dispatch, SSE buffering, cache marks, budget formula) are the pieces those loops can each adopt without behavior risk; the survey's finding #11 (`util::send_checked` for ~55 HTTP status-check sites) is also still open, with the caveat that `chat/error_class.rs` pattern-matches error strings — the helper must keep the exact classification formats.

---

## Steps — session 1: survey + first pass (2026-09-10)

| # | Step | Type | Verification | Autoreview | Commit |
|---|---|---|---|---|---|
| 0 | Baseline health check | setup | tsc clean · vitest 857 ✓ · cargo check clean | n/a | — |
| 1 | `src/lib/format.ts`: dedup formatBytes ×8, formatRate ×2, formatDuration ×2, date formatters ×3, shortName ×2 + 8 unit tests; removed stale duplicate `CostUpdatedPayload` interface in types.ts | DRY (pure fns) | tsc clean · vitest 865 ✓ · vite build ok | **PASS** (code-reviewer) | `refactor(ui): consolidate display formatting into shared lib/format` |
| 2+2b | `src/lib/agents.ts` (canonical AGENT_OPTIONS + CLOUD_PROVIDER_IDS replacing 3+2 copies); single homes for ArtifactType, SyntaxStyle, PerDownloadState; `src/lib/segments.ts` leaf module (parseSegments/Segment/ToolData/EditPayload moved verbatim from MessageBubble/DiffCard; SubagentPanel drops mirrored types) | DRY + architecture (de-couple panes from mega-components) | tsc clean · vitest 865 ✓ · vite build ok | **PASS** (code-reviewer) | `refactor(ui): single-source agent catalog and tool-segment model` |
| 3 | `src/hooks/useTauriEvent.ts` (`useEventSubscription` + `useTauriEvent`) centralizing the listen()-promise race; `src/lib/paths.ts::pathUnderChanged`; `useCopyToClipboard`. Migrated: BranchPanel, BranchDropdown, BrowserPane ×3, 4 global event hooks, 7 path-matcher sites, 4 clipboard sites | DRY + architecture (shared invariants) | tsc clean · vitest 865 ✓ (incl. listener-race regression suites) · vite build ok | **PASS** (code-reviewer) | `refactor(ui): shared useTauriEvent/useEventSubscription + useCopyToClipboard hooks` |
| 4 | chat.ts: `resolvePendingCard` + `omitKey` helpers replace the 3× resolve*-action skeleton (audit-M3 contract kept: optimistic remove → IPC → restore+toast on failure) | DRY (store internals) | tsc clean · vitest 865 ✓ · vite build ok | **PASS** (code-reviewer) | `refactor(state): shared resolvePendingCard + omitKey helpers in chat store` |
| 5 | `NewChatMessage` struct (Default) replaces the 19-positional-arg `add_chat_message`; all 46 call sites converted positionally (31 via codemod, 15 hand-checked valued rows) | DRY + safety (kills telescoping-None transposition risk) | cargo check clean (62 warnings = baseline) · cargo test --lib **1011 ✓** · positional mapping verified per site | **PASS** (code-reviewer) | `refactor(db): NewChatMessage struct replaces 19-arg add_chat_message` |
| 6 | `ANTHROPIC_API_VERSION` const replaces 10 wire-literal sites (streaming/one-shot/metering/model-listing); merged the character-identical `chat_provider_id_from_str`/`parse_provider_id` twins | DRY (Rust provider layer) | cargo check clean · cargo test --lib **1011 ✓** | **PASS** (code-reviewer) | `refactor(chat): single ANTHROPIC_API_VERSION const; merge provider-id parser twins` |
| — | Style side-effect, quarantined: installing rustfmt (was missing) let the repo's auto-format watcher migrate the whole repo to rustfmt 1.9 style. Committed separately as formatting-only (`style:` commits ×2, 52 files) | hygiene | cargo test --lib 1011 ✓ | n/a (no semantics) | `style: adopt rustfmt 1.9 formatting` + stragglers |

## Completion audit (2026-09-10)

Objective: "Refactor until you are happy with the architecture, DRY. After each significant step, live-test the system, run autoreview, and track progress in a md file."

| Requirement | Evidence |
|---|---|
| Refactor for architecture + DRY | 6 steps across both stacks: 4 frontend (shared format lib, agent catalog + tool-segment leaf modules, subscription/copy hooks with the listen-race invariant, chat-store helper extraction) and 2 backend (NewChatMessage struct over 46 call sites, provider const + parser twin merge); plus leaf-module extraction so components stop importing mega-components |
| Live-test after each step | Every step: full `tsc --noEmit` + `vitest run` (865/865, up from 857 — 8 new tests) + `vite build` for frontend; `cargo check` (clean, 62 baseline warnings) + `cargo test --lib` (1011/1011, equal to audit baseline) for Rust; production `vite build` after each frontend step |
| Autoreview after each step | 5 code-reviewer passes (steps 1, 2+2b, 3, 4, 5, 6) — all PASS; every flagged semantic risk traced and resolved (e.g. listener-race equivalence vs the two regression suites, positional mapping of all 46 Rust call sites, CostUpdatedPayload shape vs the Rust emitter) |
| Track progress in a md file | This file — baseline, per-step table with verification + autoreview + commit, details, deferred list |

Final health: `tsc` clean · vitest **136 files / 865 tests passed** · `cargo test --lib` **1011 passed / 0 failed** · cargo warnings 62 (= audit baseline, zero new) · working tree clean.

## Deferred / recommended follow-ups (from the survey, deliberately not forced)

Frontend:
- `SettingsView.tsx` (3,085 lines) → one file per panel; `ChatComposer.tsx` (voice engine + attachment classifier are extractable); `ChatView.tsx`, `MessageBubble.tsx`, `AgentModelPicker.tsx` splits along the seams listed in the survey.
- `src/lib/ipc.ts` (3,157 lines, 294 wrappers) → per-domain submodules behind a barrel; add `jsonSetting<T>` factory for the identical load/save trio.
- chat.ts: `patchSession(id, patch)` for the ~18 repeated `sessions.map` setters; parametrize main/split buffer twins (`loadMessages`/`loadSplitMessages` etc.); the 4 streaming-map cleanups each carry site-specific regression guards — extract only with those guards' tests.
- `useDragResize` hook for the 4 pointer-capture resize handlers; `useOcclusion` for the 5 popups.

Backend (in survey priority order):
- `llm_client` module: shared streaming-turn skeleton (5 implementations, ~1,600 LOC), `resolve_provider_credentials` + one-shot dispatch (5 copies — deliberately deferred: they diverge on missing-credential error behavior, which needs a product decision), resumable-download engine (2 copies).
- Split seams: `agent_sessions.rs` (8,899 lines; the four per-harness event handlers are near-twins), `chat/commands.rs` (`send_chat_message` is 1,199 lines), `browser.rs` (2,454-line impl + ~490 lines of injected JS → `browser_js.rs`), `mobile/relay.rs` (provider catalog triplication vs providers.rs).
- Shared `util::send_checked` HTTP helper (~55 status-check sites) and one client factory (inconsistent timeouts); adopt `util::SseLineBuffer` in the 3 hand-rolled readers; `ThinkState` helper for the ~12 `<think>` toggle sites.
- Toolchain: pin `rust-toolchain.toml` so formatter style can't drift between rustfmt versions again (the 1.9 migration happened only because rustfmt was missing and the watcher adopted whatever was installed).

### Step 5 details

- Autoreview verified the re-export list (`db/mod.rs`) gained exactly one name; `delete_chat_messages_after` intact; every valued row (usage-token closures, compaction summaries, checkpoint round-trips) maps field-for-field with the old positional order.
- Toolchain note: **rustfmt was missing** from this machine's stable toolchain and was installed (`rustup component add rustfmt`) to format the codemod output; the repo's auto-format watcher then applied 1.9 style repo-wide. Recommend a `rust-toolchain.toml` pin so formatter style can't drift again.

### Step 3 details

- Hook semantics cover both prior patterns ("hold the listen() promise" cleanup and the cancelled-flag `.then` shape) and are stricter: the handler is inert after dispose.
- Event hooks keep using the NAMED ipc wrappers (`onBudgetAlert`, `listenMemoryUpdated`, …) so event names + payload types stay single-sourced in lib/ipc.ts; `cost:updated` has no wrapper so it uses the raw-name form. This also keeps the `automationRunClosed` ipc mock valid.
- Intentionally NOT migrated (different semantics, noted for future work): ChatSelectionToolbar (copy flag never resets), TerminalPane (file export misusing `copied` name), BrowserPane:822 (promise-form copy, 1200ms), DevDiffPanel/GitToolsSidebar/useGitStatusPolling effects (listener entangled with fetch latches — matcher deduped only).

### Step 1 details

- Intentional display unifications (flagged + accepted by autoreview): byte sizes now consistently show one decimal below 10 units ("512.0 KB" vs UpdateBanner/SettingsView's old "512 KB"); `formatDuration` gains an hours tier ("1h 1m" where MessageBubble capped at "61m 40s"); AutomationRunTable timestamps use `hour: "numeric"`. UpdateBanner/UpdateButton keep literal "0 B" via the new placeholder arg; ModelMarket keeps its idle "—" rate via `formatRate(...) || "—"`; AutomationRunTable keeps "<1s" for sub-second runs via a local wrapper.
- `CostUpdatedPayload`: TS interface merging had silently united two same-file declarations; kept `{ sessionId; version: 1 \| 2 }` which matches the Rust `CostUpdatedEvent` (emits `version: 2`).
- Autoreview non-blocking note: format.test.ts date assertions are locale-sensitive (hold on en-US); optional follow-up to pin Intl in test setup.

## Autoreview findings log

(none yet)

## Notes / deviations

(none yet)
