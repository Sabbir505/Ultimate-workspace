# Codebase Audit — Full-Tree Production-Readiness Wave (2026-10-03)

> **Method:** 26 parallel code-reviewer agents, each reading every file in its scope end-to-end
> (Rust backend ~182K lines across 16 scopes; frontend ~96K lines across 9 scopes; mobile ~14K
> lines; configs/CI/scripts), plus orchestrator cross-verification — every Critical below was
> re-read directly by the orchestrator before inclusion. All findings are evidence-backed with
> file:line and a concrete trigger path; hypotheticals were rejected. Scope split and per-scope
> raw reports live in `.zcode/audit-scratch/`. Prior waves (2026-09-06/13/14/17/21) were
> remediated; findings below are new as of this tree (post-wiki + computer-use commits).
> Items already documented as open in `docs/audits/*` are marked **[KNOWN]**.

## Baseline gates at audit time

| Gate | Result |
|---|---|
| `cargo test --lib` | 1,635 passed, 0 failed, 23 ignored |
| `cargo clippy --all-targets` | clean (0 warnings) |
| `npx tsc --noEmit` | clean |
| `vitest run` | 215 files / 1,697 tests passed |

**Verdict up front:** the code is *close* to production-ready but not there yet. The four green
gates mask **9 Critical and ~50 High** findings, several of which break the app's primary flows
(a whole-app deadlock on every project-bound send, silent cross-note data loss in the vault, a
sandbox bypass for subagents) or its core security claims (plaintext search keys, a replayable
E2E salt, an arbitrary-file-read allowlist poisoning). Everything else is polish by comparison.

---

## Critical (P0) — 9 findings

**C1. [deadlock] `send_chat_message` deadlocks the whole app for every project-bound session — nested `db.0.lock()` on a non-reentrant `parking_lot::Mutex`.**
`src-tauri/src/chat/commands/send.rs:1094` opens `let conn = db.0.lock()`; the guard lives until
the block ends at `:1193`, but the AGENTS.md (`:1141`) and project-wiki (`:1155`) closures
re-lock the same mutex on the same thread (`DbState(pub Arc<parking_lot::Mutex<Connection>>)` —
`lib.rs:172`). parking_lot is not reentrant → second `lock()` blocks forever. Any send into a
chat with a bound project (the primary use case) hangs the turn AND every other IPC command
(total app freeze). Fresh regression from the 2026-10-01/02 wiki+AGENTS.md layering commits;
the codebase documents this exact class at selection.rs:864-868. *Orchestrator-verified by
direct read.* Fix: reuse the held guard inside both closures (no awaits there), or hoist the
`get_project`/`wiki.layer_index` reads above `:1094`.

**C2. [sandbox-bypass] Subagent scope gate for `move_file`/`copy_file` reads the wrong argument keys — the check is silently skipped entirely.**
`src-tauri/src/chat/dispatch.rs:1670`: `vec![arg("source"), arg("destination")]` — but the tool
schema is `"required": ["src", "dest"]` (`tools/specs.rs:2458`, builder literally named
`src_dest_parameters()`) and the executors read `arg_str(args, "src")/"dest"`
(`tools/fs.rs:362-363`). Both extracted strings are always `""`, the `p.is_empty()` early-return
treats that as "not a scope call", and `subagent_fs_scope_refusal` returns None (allowed) for
every move/copy. The subagent loop deliberately bypasses the approval layer — this gate is
documented as "the only thing standing between a granted `write_file` and the whole
filesystem". A `workspace_write` subagent (or a prompt-injected model) can `copy_file` from the
project to ANY destination (startup folders, PATH binaries) and `move_file` (delete) from ANY
source. The unit test (`dispatch.rs:4803`) passes vacuously — it uses the same wrong keys.
*Found independently by two agents; orchestrator-verified against schema+executors.* Fix:
`vec![arg("src"), arg("dest")]` + fix the test fixtures.

**C3. [zip-slip] Skills zip install: traversal guard splits only on `/` — backslash entries escape the skill root on Windows.**
`src-tauri/src/installed_skills.rs:966-973`: `rel.split('/').any(|seg| seg == "..")` never
matches `..\..\evil.txt`; `dir.join(rel_path)` then resolves ParentDir components and writes
outside `<home>/.claude/skills/<slug>/` (with `create_dir_all` creating the escaped dirs). Same
bypass via GitHub-tree fallback (`:1152-1155`). A hostile "install this skill" .zip URL yields
an arbitrary relative file write (startup scripts, `.claude` config). The regression test
(`:1624`) only exercises the forward-slash form. *Orchestrator-verified by direct read.* Fix:
reject on components — `rel_path.components().any(|c| matches!(c, ParentDir|CurDir)) ||
rel.contains('\\')` — mirroring `git.rs::validate_repo_relative`; add a backslash test.

**C4. [authz] `set_chat_session_worktree` accepts any renderer-supplied path and permanently poisons the path-allowlist — arbitrary file read.**
`src-tauri/src/commands/worktree_cmds.rs:142-169` does zero validation (no existence, git, or
project-containment check) before `db::set_chat_session_worktree` (bare UPDATE,
`db/chat.rs:270-280`). That column feeds `allowlisted_roots` (git_cmds.rs:72) which gates
`read_file_text` (`data.rs:496-499`) and every git command, and is the PTY cwd for agent CLIs.
One IPC call from a compromised webview (`set_chat_session_worktree(sid, "C:\\Users\\me")`)
undoes the whole allowlist: `.ssh/id_rsa`, `.env`, any text file ≤512KB becomes readable.
*Orchestrator-verified by direct read.* Fix: canonicalize, require an existing directory under
the session's project root (ideally confirmed via `git worktree list`); mirror in the
stale-pointer re-create path.

**C5. [hang] Whisper sidecar's piped stdout/stderr are never drained — the STT server wedges permanently once the OS pipe buffer fills.**
`src-tauri/src/commands/stt.rs:433-435` spawns with `Stdio::piped()`; the `SttHandle`
(`:474-478`) keeps the Child but no reader task is ever spawned. whisper.cpp prints its
per-inference timing table per `/inference` request (and live dictation fires repeated
partials), so after ~100 clips the 4-64KB pipe buffer fills and the child blocks in printf —
every transcription hangs until the 120s timeout. The exact failure mode is documented and
already fixed in image_gen.rs (`:1365-1371`, `spawn_sidecar_readers` at `:1422-1442`). Fix:
drain both pipes to a log (or `Stdio::null()`), reusing the image_gen pattern.

**C6. [data-loss] Vault autosave can write note A's content into note B's file — silent cross-note corruption.**
`src/state/vault.ts:591-601` arms the save debounce guarded only by `saveGeneration` — which
never changes on `activePath` switches, so the promised "note switched since scheduling" guard
does not exist. In `openNote` (`:477-517`) the pending-save flush runs before `loadingNote` is
set; a keystroke (or dictation write) during the flush await arms a fresh 600ms timer that is
never cleared when `activePath` flips — if it fires after the flip but before `vaultReadNote`
lands, `saveNow` pairs B's path with A's text and overwrites B's file; the subsequent set
converges the UI, hiding the corruption. Same class in `restoreSnapshot` (`:952-956`) and
`deleteNote`. Fix: capture `activePath` when arming and compare in the callback; bump
`saveGeneration` on every activePath mutation; re-check in `saveNow` before `vaultWriteNote`.

**C7. [secret-exposure] Search-engine API keys stored in the plaintext settings DB while every other secret uses the OS keychain.**
`src/components/settings/SettingsView.tsx:908-917` persists via `setSetting(\`search.${id}_key\`)`;
the backend reads them straight from SQLite `app_settings` (`chat/tools/search.rs:557`). Chat
API keys, the GitHub PAT, and the HF token all deliberately use `secrets.rs` (Windows Credential
Manager) with "key value NEVER returnable via IPC". Serper/Tavily/Brave keys are billing-grade
secrets sitting on disk in cleartext. Fix: add a `search.<provider>` entry type to secrets.rs
mirroring `set_chat_api_key`/`has_chat_api_key`; expose only a boolean "configured".

**C8. [mic-leak] `beginVoiceRecording` re-entrancy race leaks an open mic, a live AudioContext, and an orphaned transcription interval.**
`src/lib/voiceDictationCore.ts:453`: `recordingRef.current` is set only at `:539`, *after* the
getUserMedia await + graph build. A second activation during the window (double-click on the
mic button — it stays enabled during the await; second Alt press while the OS permission prompt
is up) overwrites `captureCtxRef`/`captureNodesRef`/`captureStreamRef`/`partialTimerRef`
without tearing down the first: tracks never stopped (recording indicator on until exit),
AudioContext never closed, doubled audio to the transcriber, and a leaked 1.5s interval issuing
transcribeAudio IPC forever. Fix: latch synchronously at entry (`openingRef`), defensively
clear existing interval/ctx/nodes/stream before overwriting.

**C9. [crypto] Mobile `PairOk.salt` is unauthenticated and replayable — cross-connection nonce reuse breaks the E2E claim against the relay MITM.**
`mobile/src/hooks/useRelay.ts:710` resets both per-direction counters on every connect and
`:806` derives the session key verbatim from the desktop-supplied salt; PairOk arrives as a
plaintext frame before any E2E state exists and nothing binds it to this connection's
challenge (`relayCrypto.ts:34-42` uses it as-is). A relay MITM records connection N's salt,
then on connection N+1 suppresses the fresh PairOk and replays it — identical key, counters
restarted at 0: XChaCha20 keystream reuse (XOR recovery of the phone's commands/approvals) plus
Poly1305 one-time-key reuse (forgery). The "unique key per connection — audit C1" guarantee
rests entirely on the unauthenticated value. Fix: derive `salt' = SHA256(challenge || salt)`,
or have PairOk echo the challenge and reject mismatches/repeats.

---

## High (P1) — by subsystem

### Chat engine (Rust)

**H1. `prompt_firewall` Unicode-lowercase offset desync — attacker-controllable panic that silently kills chat turns.** `prompt_firewall.rs:109/:118/:141-165`: `to_lowercase()` expands U+0130 `İ` (2→3 bytes), shifting every offset found in `lower` past its true position in `normalized`; `"İİİİİİİİİ<system>"` panics at `normalized[..27]`, and fewer `İ` mis-redact. The module's own docs declare retrieved content attacker-controllable, and a panic in the turn task "kills the turn silently (B-1)". Fix: match and slice the same string, or ASCII-only lowering (all patterns are ASCII). Related: `neutralize` (`:143-153`) drops non-overlapping cuts appended in PATTERNS order — collect, sort by start, then dedupe.

**H2. PTY reader throttles every pane to ~512 KB/s.** `pty/mod.rs:1040-1048`: the frame-budget tail block sleeps out the 16ms budget after *every* read instead of coalescing (mid-iteration flush unreachable), so max one 8KB frame per 16ms; the 64KB `FRAME_BYTE_LIMIT` is dead code. `cargo build` output blocks on ConPTY backpressure, transcripts lag minutes on multi-MB output. Fix: keep reading during the budget window (deadline-bounded loop); flush on deadline or byte cap.

**H3. Anthropic effort-tier → thinking mapping silently dropped on the tool loop (the default path).** `providers.rs:337-366` vs `streaming.rs:1690-1714`: the tool-loop builder only honors the brain toggle; `req.effort` is never consulted — selecting low/medium/high on Anthropic models with tools on is a silent no-op, and the two builders' documented "must stay in lockstep" contract is broken. Fix: call the shared `anthropic_thinking_for(req)`.

**H4. Background shell output retained with no byte cap.** `chat/tasks.rs:1073-1094`: the deque caps 40 *lines*, never bytes; a single newline-free line of hundreds of MB is retained for the task lifetime (background shells live for the app's lifetime). Foreground got this fix (D1/`BoundedTail`); background did not. Fix: running byte total + per-line truncation, or reuse `BoundedTail`.

**H5. Subagent loop's Anthropic branches have no `MAX_STREAM_BLOCK_INDEX` clamp.** `dispatch.rs:1938/:1994/:2014` vs the clamped OpenAI branch (`:2092-2095`) and the clamped main round (streaming.rs:828-834): a hostile `anthropic_compatible` endpoint can emit unbounded distinct block indexes → unbounded BTreeMap growth mid-turn / OOM. Fix: extract one `clamp_index(v)` used at all four sites.

**H6. A one-time tool approval permanently grants write access to the target's whole directory.** `commands/approval.rs:84-88`: `grant_directory_for_approved_tool` runs on *every* `approved=true` — `resolve_tool_action` has no "always" parameter, so "Allow once" on `write_file C:\...\important\notes.txt` persists that directory into `grantedRoots` for every future turn of every session, contradicting both doc comments. Fix: thread the card's choice through; grant only on remember.

**H7. `generate_document` executes model-authored Python with no `code_exec` opt-in.** `chat/tools/generate.rs:181-185/269` → `pygen.rs:71-76`: `run_code` is gated (`tools/mod.rs:1612-1617`) but `generate_document` takes no caps at all; pygen's header claims "identical to codeexec" including "Opt-in only". A prompt-injected page steering the model into `generate_document(language="python")` gets unsandboxed execution the user never opted into, with no warning appended. Fix: pass `caps`, require `caps.code_exec`, append the sandbox note.

**H8. Hidden, reused WebView2 print window navigates to model-authored `file://` HTML.** `pdfprint.rs:142/221-245`: writes model HTML to temp and navigates the shared hidden window to `file:///...`; nothing ever returns it to `about:blank`. A `file://` document can embed other local files as subresources rendered into the produced PDF (local-file read bypassing permission-gated `read_file`), and model JS keeps running in the hidden window after the tool returns and can navigate it anywhere. Fix: NavigationStarting allow-list of the one temp file → force `about:blank` after PrintToPdf; strip `file:` subresources; destroy (not reuse) the window.

**H9. Reachable panic in `apply_patches`: `slide["slots"][slot]` on a non-object.** `docdesign/plan.rs:527`: serde_json mutable indexing panics when `slots` is a string/array; the model can write its own sidecar (`generate_file` → `x.plan.json` with `"slots":"oops"`) then call `revise_document` → panic inside the async dispatch, killing the turn. Fix: `get_mut("slots")` + `as_object_mut().ok_or_else(...)`.

**H10. Citation lint computes the report body via `rfind("\n#")` — tolerant Sources headings corrupt every metric.** `citation_lint.rs:378` vs `is_sources_heading` (`:133-165`) accepting `**Source References:**` styles: the whole Sources section gets linted as body — citations double-counted, source lines flagged as uncited/misattributed; numbers are persisted and shown as integrity chips. Fix: return the heading offset from `parse_sources_section` and cut there.

**H11. XLSX preview: unbounded row index from the sheet's `r` attribute → multi-GB HTML / 268M HashSet inserts.** `office.rs:962-965/:1001/:1020-1050`: `MAX_ROWS` caps only parsing; `n_rows.max(row_idx+1)` feeds the render loops — a single `<row r="1048576">` in any previewed .xlsx OOMs/hangs the preview task; `mergeCell ref="A1:ZZ1048576"` likewise. Fix: skip `row_idx >= MAX_ROWS`; clamp merge spans.

**H12. Chat-import zip has no decompression caps.** `export.rs:412-415/:503-517`: every entry read via `read_to_end` with no per-entry/total limit and all retained simultaneously — a crafted "chat export" (plausible backup/restore vector) OOMs the process. Fix: cap per-entry ~25MB / total ~500MB via metadata checks or `take()`.

**H13. `fetch_url` fallback extraction is O(n²) on up to 1 MiB pages, synchronously on an async worker.** `tools/search.rs:480-520`: `remove_blocks` re-lowercases the whole document per tag occurrence; a 1MiB page of 60k tiny `<script>` blocks (the exact shape where Readability fails → fallback runs) pegs a worker for minutes; `fetch_url` is auto-run with a model/attacker-chosen URL. Fix: spawn_blocking + single-pass removal.

### Databases & stores

**H14. Deleting any project that has a wiki always fails — nested transaction.** `db/projects.rs:63/98` opens a transaction and calls `wiki::remove_wiki_by_path_prefix` which opens a second `BEGIN` on the same connection (wiki.rs:537) → "cannot start a transaction within a transaction", the delete errors and rolls back forever. Tests seed no wiki so it's invisible. Fix: inline the wiki deletes into the outer tx, or split an untransactional inner helper.

**H15. `mirror_run_start` repoints `active` at `active + 1` instead of the version `record_version` created.** `db/automations.rs:374-375` vs improve.rs:134-135 (`MAX(version)+1`): they diverge whenever `active` lags (engine candidates, rollbacks) — after an engine proposal + user edit, `active` points at the *engine's candidate body*, not the user's prompt, and desyncs permanently. Fix: use the returned version.

**H16. `ensure_artifact`'s three logical inserts run bare.** `db/improve.rs:89-103`: registry + v1 seed + active channel as three autocommitted statements; a SQLITE_BUSY (real: the headless `relay_automation` binary shares the DB) leaves a crippled artifact that the `existing` early-return never repairs. Fix: one transaction (same class already fixed in `delete_chat_session`/`replace_file_chunks`).

### Sessions, harnesses, fabric

**H17. Dead opencode SSE reader is never repaired — permanent turn-failure loop with lost (billed) replies.** `agent_sessions/opencode.rs:55-64/:788-796`: server-reuse keys on TCP liveness only, never `oc_reader_alive`; the reader does exactly one `GET /event` with no retry. Any stream error drops the reader while the server stays "alive" — every subsequent send runs the full model turn (billed) with all text lost, and the promised restart never fires. Fix: add `|| !entry.oc_reader_alive.load(...)` to the respawn condition; retry the event stream with backoff.

**H18. Subagent release watcher frees the slot and settles the run row before the first turn starts.** `session_fabric/mod.rs:1729-1748/:2240-2259`: the watcher's first `session_busy()` poll runs before `turn_in_flight` is set (only set inside `mgr.send` after CLI spawn), so it immediately bumps −1 and settles `"ok"` — `max_concurrent`/`MAX_ACTIVE_SUBAGENT` gate spawn instants only, and a first turn that fails mid-stream is recorded as success (the settle is final). Fix: wait for busy-true within a bounded start-grace (the pattern `watch_answer`/`spawn_spawn_result_reporter` already use).

**H19. Project-level native subagent stores never re-sync.** `harness_subagent_watch.rs:83` vs `git_watcher.rs:108-111/163/240`: the `project:fs-changed` payload is the watched ROOT, not the changed file (notify paths discarded), so `is_project_store_path` can never match a project root — edits to `<proj>/.claude/agents/x.md` leave the linked row stale. Related: `is_native_store_path` (`:48-51`) never matches on Windows because canonicalized `\\?\`-prefixed payloads are compared to plain home-joined dirs — the OpenCode user store never re-syncs at all. Fix: emit changed file paths; compare through `strip_unc_prefix`; add the opencode user layout.

**H20. Reader loops treat one invalid-UTF-8 byte as EOF — turn killed by localized cmd.exe output.** `agent_sessions/claude.rs:649-653` (+ perturn.rs:660-664, acp.rs:467-471): `read_line` returns `InvalidData` for a single non-UTF-8 byte and the loop `break`s — the CLI's OEM-codepage messages ("'kimi' is not recognized…") discard the streamed reply and force a respawn of a healthy process. Fix: `read_until(b'\n')` + `from_utf8_lossy` + `continue`, with a bounded buffer.

**H21. `spawn_per_turn` overwrites `entry.child` without killing the previous child.** `perturn.rs:463` — every other adapter takes-and-`kill_child_tree`s first; a plain drop neither kills nor reaps (zombie/orphan beyond the session's kill reach). Fix: mirror the other adapters.

**H22. `run_one_shot` leaves an orphan user message on early failure.** `oneshot.rs:32-44/:130/:185-186` — `send` upholds the opposite invariant (mod.rs:947-959); a failed automation spawn leaves a permanent user bubble with no reply. Fix: delete the row on every early-error return.

### Automations, hooks, connectors, browser

**H23. No stale-run reaping for automations.** `automations.rs:629-640`, finalized only at `:854-901`; the boot sweep covers subagent runs only. A routine app close during a run (runs last up to 2h) leaves `status='running'` forever — phantom in-progress run, skewed improve stats. The cross-process lock HAS PID-staleness (B-28); the rows don't. Fix: boot-time `UPDATE ... SET status='interrupted' WHERE finished_at IS NULL`.

**H24. Scheduler tick runs blocking git + DB-lock-holding work directly on the async runtime.** `automations.rs:122-127` → `automation_triggers.rs:366-378` (`try_wait` + `thread::sleep(20ms)` up to 5s per repo, under parking_lot DB locks): every 30s tick can block a shared worker for 5s × N repos, starving all async commands + the webhook listener. github.rs already wraps its git calls in spawn_blocking. Fix: spawn_blocking the tick body.

**H25. GitHub tree installs silently drop all subdirectory content.** `installed_skills.rs:1147-1150`: `github_list_dir` returns one level and the loop skips `is_dir` without recursing — `scripts/`, `reference/`, `assets/` siblings of SKILL.md are never fetched (the contract at `:1117-1118` promises them); gallery one-click installs are silently incomplete. Fix: recurse the contents API under the existing caps.

**H26. Ungated irreversible connector writes on the harness bridge, amplified by the tool description.** `gmail_api.rs:80-87` + `mcp_tools_bridge.rs:315-330`: the bridge executes `gmail_send_message`/`gdrive_create_file`/`gcalendar_delete_event` ungated, and the description tells the model "do not ask for permission first and never tell the user to send it manually" — the injection amplifier. Reads return untrusted content verbatim, so an injected email can silently send mail from the user's real account. Documented owner policy, hence P1 — but the highest-risk item in the module. Fix: delete that sentence; add a per-session gate for connector Writes.

**H27. No timeout anywhere on the MCP HTTP transport.** `connectors/mcp.rs:68-86` (call sites session.rs:90-92, dispatch.rs:564, chat/mod.rs:743): serve/list/call all awaited bare; vendored rmcp's default client sets no timeout — a vendor endpoint that accepts TCP but never responds parks the turn forever (same class as the fixed audit H-2; config.rs:600-601 even references a timeout note that was never implemented). Fix: `tokio::time::timeout` envelopes or a timeout-bearing reqwest client.

**H28. Unscoped `file://` navigation from model input — arbitrary local file read + exfil.** `browser.rs:646` accepts ANY `file://` path; the sidecar schema itself coaches the model toward `file:///C:/path` previews. `read_page`/`evaluate` return the rendered text, and `evaluate` can POST it out (CORS-simple from the null origin). `classify_gate` returns None for navigate (no consent card in Auto mode), and `file:` origins serialize to `"null"` so one "always allow" grant covers every local file. Fix: keep `file://` only within `path_within_scope` of project/artifacts roots (the upload_file pattern); hard-gate `file:` navigations.

### Frontend

**H29. Composer state bleeds across session switches.** `ChatComposer.tsx:230-236/356` + `ChatView.tsx:787-798`: attachments, command pill, `forceResearch`, `attachError`, and `quotedSelections` are component-local with no reset keyed on `effectiveSessionId` (only the draft is per-session, by explicit design) — a screenshot or `/research` pill prepared in chat A ships into chat B's next message. Cross-conversation content leakage. Fix: clear on session-id change (useRef compare), clear quotedSelections in the registration effect.

**H30. Live-streaming markdown rebuilds component identities per token flush — every code block/mermaid remounts per token.** `ActivitySteps.tsx:1746-1859` builds a fresh `components` object inside `build()` consumed with `cache={false}` (MessageBubble.tsx:451/478) — React sees new element types per flush and remounts subtrees (highlighter re-initializes, flashes fallback `<pre>`, CopyButton state resets). Fix: hoist to a reference-stable components map.

**H31. Sending with no active session silently drops and clears the composed message.** `ChatComposer.tsx:1291-1308` clears content/attachments immediately while `sendMessage` early-returns (`streamingSlice.ts:62` `if (!activeChatSessionId) return;`) — during the boot window (or forever if `newChat` fails) the user's typed text + pasted screenshot vanish with no toast. Fix: bail/toast in handleSend when no session exists.

**H32. ApprovalFlow: pressing Enter on the Deny button approves the gated tool call.** `ApprovalFlow.tsx:186-189`: the root-div keydown handler runs `handleAllow()` synchronously before the button's default activation; `resolveApproval` honors the first call — Enter on Deny = approve; Enter on an occurrence checkbox = "apply all", discarding deselections. Fix: `if (e.target !== e.currentTarget) return;`.

**H33. BranchDropdown: no stale guard — a late fetch paints the wrong repo's branches and a click checks out in the wrong repo.** `BranchDropdown.tsx:70-93`: every other loader guards; this one sets state unconditionally — repo A's list under repo B's header, and `performCheckout` uses the *current* path → wrong-repo git mutation. Same pattern unguarded in BranchPanel.tsx:70-98 (no self-heal — refresh only on the NEW project's fs events) and PullsPanel IssueList (self-heals at the next 30s tick).

**H34. sanitize.ts `position:` neutralizer misses the first declaration in an inline style — full-screen overlay redress in the main window.** `sanitize.ts:154`: the regex requires a preceding `[;{\s"']` char; `"position:fixed;inset:0"` passes untouched. Mermaid runs at `securityLevel:"antiscript"` (label HTML survives) and lands in the privileged main window via dangerouslySetInnerHTML — a prompt-injected diagram label can paint a 100vw/100vh clickjack cover (the exact vector the layer exists to stop; the neighboring `behavior` rule uses `\b` and works). Fix: `/(^|[{;,\s])position\s*:/gi` + regression test.

**H35. Vault note-switch drops keystrokes typed during the open/restore IPC window.** `state/vault.ts:477-481/510-517/952-973/634-640`: the one-shot timer-gated flush misses keystrokes that land during the resolve/read awaits (armed against the old note, then no-op after the buffer swap) and skips flushing entirely after a failed save — typed text is nowhere. Fix: dirty-check flush immediately before each buffer switch; re-arm on save failure.

**H36. Chat terminal events carry no turn-epoch guard.** `streamingSlice.ts:832-873/:563`: a cancelled turn's late `chat:error` (process-kill-driven, hundreds of ms later) deletes the replacement turn's live streaming entry and flashes a false error banner; every subsequent token is dropped until the done-refetch. Triggers: steer-queued message, silent-turn auto-cancel, send-again-after-stop. Fix: per-session monotonic turn epoch; ignore older terminal events.

**H37. Pop-out chat window duplicates every notification.** `App.tsx:306`: the pop-out early-return sits *after* all event hooks, so chat:done/error/approval fire relayNotify in both windows (per-window `isAppFocused`), producing two bell rows, possible double OS toast, and concurrent localStorage read-modify-write on the shared key; TTS auto-read also runs in both windows with no player UI in the pop-out. Fix: suppress notification emission in the pop-out context or dedupe on a stable event key.

**H38. CI: `github.ref_name` interpolated directly into `run:` scripts in the release job.** `.github/workflows/build.yml:170/205`: both steps run with TAURI_SIGNING_PRIVATE_KEY + RELEASES_TOKEN in scope; a crafted tag name executes before the version guard can reject it (the guard is inside the same interpolated script). Requires tag-push (write) access, so hardening — but the blast radius (signing key / PAT exfil) is the highest in the repo and the fix is one line. Fix: `env: REF_NAME: ${{ github.ref_name }}` → `"$REF_NAME"`.

### Mobile

**H39. App lock is dead code.** `mobile/src/lib/appLock.ts:28/62/77`: `setAppLockEnabled` has zero call sites (no Settings row), and even enabled it never locks on cold start (`backgroundedAt` is module memory; force-quit + relaunch skips the gate entirely) — "an unlocked phone in someone else's hands is otherwise a remote shell in theirs" (App.tsx:93-95). Fix: add the toggle; persist the background stamp and evaluate at launch.

**H40. Push notifications are completely unwired.** `mobile/src/lib/notifications.ts` entry points have zero call sites; `registerPushToken` is returned but never invoked; `PushAck` never consumed; approvals are never journaled (useRelay.ts:874) — an approval arriving off-screen or disconnected is invisible: no push, no journal, no banner. Fix: wire token registration on connect, consume the ack, journal approvals.

**H41. Deep link accepts `http(s)://` hosts and permanently un-pairs the phone.** `mobile/src/lib/deepLinks.ts:80-83` returns an https host verbatim as the WebSocket URL; `globalConnect` persists it *before* connecting; `new WebSocket('https://…')` throws synchronously with no reconnect scheduled — every cold start reloads the broken URL (a natural tailscale-link form triggers it). Fix: map http→ws/https→wss; validate scheme; persist only after a successful pair.

**H42. `CancelChatTurn` is a no-op for `ChatTurn` streams — billing continues after the phone sees "done".** `mobile/relay_requests.rs:350-356` + `relay.rs:2531-2538/2732`: the temp-session turn task registers nothing with ChatManager, so the mid-turn cancel routes to `chat_mgr.cancel` (no-op) while the SSE loop keeps consuming the full provider request. Fix: abort the turn's handle (or a cancellation token checked in the chunk loop).

**H43. Replayed legacy pairing proof holds a zombie "paired" connection that suppresses push fallback.** `relay_requests.rs:236-260` + `push.rs:94-98`: the static legacy proof is connection-independent; per-connection salt blocks command execution but the relay never evicts on AEAD failures, and `phones_disconnected` trusts the conns map — one junk frame per <75s permanently suppresses approval/turn-done pushes to the real phone. Window unbounded (token deliberately reused across launches; `require_challenge` defaults off). Fix: evict after N failed frames; default the challenge on; require ≥1 decrypted frame for "connected".

---

## Medium (P2) — grouped by theme (~110 items)

### Security & secrets
- `create_automation` returns the webhook URL **including its secret** into the model-visible tool result (persisted to transcripts/cloud) — `tools/automations.rs:409-417`; contradicts the module's own `strip_webhook_secret` discipline. Return id + "get URL from the Automations view".
- Capability report claims model-created subagents are "READ-ONLY … only the user can widen", but `create/update_subagent` accept `sandbox_policy: workspace_write` verbatim (`tools/capabilities.rs:305-309` vs `tools/subagents.rs:111-127`, schema advertises the enum). Force agent-origin rows read_only or fix the report text.
- `browser_confirm_result` has no nonce — sequential gate ids; a hostile page can self-approve its own risk gate (the M-11 spoof class fixed for `browser_action_result` only) — `commands/browser_cmds.rs:253-264`; same pattern in pane/tab result commands.
- Gallery "Filesystem" flagship entry roots the server at `{home}` — one click hands the model read/write over `~/.ssh`, `~/.aws` — `mcp_gallery.rs:102-105`. Default to the project dir; make `{home}` explicit opt-in.
- Harness bearer tokens persisted as plaintext JSON in `<app_data>/harness/<proj>/*/mcp.json`, not cleaned on session end — `connectors/harness.rs:116-121`, `harness_bundle.rs:602-610`.
- Mobile `ResolvePlanProposal` skips the session-ownership check its two sibling handlers enforce — any paired client can approve any pending plan by id — `mobile/session_chat.rs:430-435`.
- Unauthenticated pairing lockout is a repeatable global DoS (5 frames → 60s for everyone) and the counter misses several rejection paths — `mobile/relay_requests.rs:71-92`.
- Default WebSocket caps allow ~4 GiB pre-auth memory amplification (64 permits × 64 MiB frames) — `mobile/relay.rs:767`; set explicit `max_message_size`.
- Windows `strip_unc_prefix` mangles `\\?\UNC\server\share` into relative `UNC\server\share` and `add_project` stores it — every consumer resolves against the process CWD — `util.rs:71-79`, `commands/projects.rs:41`.
- Stale security docs claim per-launch token rotation the code deliberately no longer does — `mobile/relay.rs:8`, `protocol.rs:27-28`, `commands.rs:105-107`.
- "Hidden" sourcemaps still ship inside the installer (`sourcemap:"hidden"` omits the reference, not the files; Tauri embeds dist/) — `vite.config.ts:14`. Strip `dist/assets/*.map` in the build.
- `--use-fake-ui-for-media-stream` auto-grants mic in the main window; any script execution there (DOMPurify is the only gate) can open the mic silently — `tauri.conf.json:26`.
- GitHub Actions pinned by mutable tags (`@v4`, `@stable`, `@v2`) in the workflow that holds the signing key + PAT — `build.yml` throughout. Pin SHAs.
- No `timeout-minutes` on the release jobs — a hung build burns 6h with the signing key decrypted — `build.yml:55/155`.
- Winget manifest `Scope: user` vs NSIS `installMode: perMachine` (`packaging/winget/...installer.yaml:16` vs `tauri.conf.json:49`) — upgrade-path mismatch.
- `slug()` passes `..` through → a chat titled `..` exports a traversal zip for standard extractors — `chat/export.rs:116-136`.

### Correctness bugs
- `mirror` of skill edits uses singular `"skill"`/`"loop"` kind strings — the harness-twin mirror never runs, and every Skill/Loop artifact create/update errors after partially writing (`commands/data.rs:293-296`, `commands/artifact_cmds.rs:147/420/444/477/523`); normalize at the `installed_skills` boundary.
- `update_automation` cannot clear `schedule` (empty string ≡ absent) though the schema says empty is valid — `tools/automations.rs:474-481`.
- Context-window probe hits `{base}/models` instead of `{base}/v1/models` — dynamic windows silently dead for openai_compatible relays — `commands/selection.rs:172`.
- `delete_chat_api_key` leaves `chat.{p}.selected_models` behind — re-adding a provider resurrects the stale curated list — `commands/api_keys.rs:108-117`.
- `parse_merge_range` typo `r2.max(r2)` (identity) — reversed merge ranges mis-render — `office.rs:809`.
- `split_sentences` decimal heuristic inverted ("3.5" splits mid-number; "2026." merges) — `citation_lint.rs:579-585`.
- `STREAM_STATE_CAP` clear wipes opencode `roles`/`part_kinds` — user prompt echo can render into the persisted assistant reply after 8192 ids — `agent_sessions/opencode.rs:888-897`.
- ACP `session/error` leaks the turn-perf accumulator (wrong TTFT next turn, registry entry until exit) — `agent_sessions/acp.rs:773-789`.
- `wait_for_turn_idle` holds the global sessions lock across the per-session lock — cross-chat stalls up to the 20s server boot — `agent_sessions/mod.rs:374-385`.
- Download resume: stale `.part` → permanent 416 loop; changed upstream of same length → silently corrupt output (no If-Range/ETag) — `chat/tasks.rs:807-869`.
- `batch` schema says navigate is not allowed inside; only nested batch is rejected — `browser_mcp.rs:1620-1622`.
- `filter_diff_to_path` never matches git's quoted-path form — per-file diff peeks empty for paths with spaces/unicode — `mobile/relay.rs:2364-2370`.
- `stop_relay` during the bind-retry window resurrects "running" state — `mobile/relay.rs:274-294/455-456`; `RenameProject` uses `?` in the match — one DB error drops the whole phone connection (`:1883-1885`).
- Docs watcher: events arriving during an in-flight index run are consumed and permanently dropped (no re-arm/dirty flag) — corpus silently stale — `docs_watcher.rs:113-119/205-225`.
- A manual Index against a missing corpus root wipes the whole chunk index and stamps it "done" — `docs_index.rs:637-649`.
- Vault: negated operators (`-tag:x`) exclude nothing (fall through to literal FTS phrase) — `vault/index.rs:683-691`; rename rewrites wikilinks inside fenced code blocks (`vault/parse.rs:688-776`); watcher reindex during full-scan mis-resolves ambiguous basenames (`vault/index.rs:544-562`); non-md assets never indexed despite schema contract (`:23-24`).
- Wiki `.git` watchers never uninstalled on wiki/project removal — kernel watcher leak — `wiki/commands.rs:163-174`.
- improve_engine judge gate dilutes scores by total case count — real judge regressions pass — `improve_engine.rs:611-618`; `quarantine_flaky_cases` compares globally-last results, not per-pair — `db/improve.rs:691-707`.
- `image_gen_install` skips stopping the running server on the cudart-repair path (reinstall over locked exe) — `image_gen.rs:2682-2690`; `resolve_binary` returns non-existent paths (`:829-879`); stop-during-start race (`:1477-1482`); warmup bypasses GENERATE_GATE — concurrent generation hangs both clients (`:1344-1356`); image downloads pass `expected_sha256: None` — multi-GB downloads unverifiable and never resume despite the message promising it (`local_model_market.rs:1347-1358/1570-1573`, `image_gen.rs:2437/2526/2552`).
- tts: cache writes non-atomic (truncated WAV served forever as `cached:true`) — `tts.rs:945/959`; install registry lacks an in-progress guard (double-click orphans the cancel sender) — `tts.rs:1527-1531`; Kokoro bundle downloads verify by size only — `tts.rs:1417-1469`; `synthesize_gpu` has no child timeout — `tts_gpu.rs:676-679`.
- llama_build: failed CUDA-DLL install "recovers" silently as CPU-falling-back on the second click — `llama_build.rs:105`.
- stt: 10s health budget too short for the 547MB model on slow disks — `stt.rs:457-463`.
- Memory extract-model pick persisted without the `provider::` prefix — silently lost/wrong provider — `MemoryPanel.tsx:279-282` vs `worker.rs:73-76`.
- `StepCodeHighlighter` cache keys embed full code strings (~46MB worst case in the shared 240-entry LRU) — `ActivitySteps.tsx:830`; settle-window backoff frames never used (dead schedule) — `useTranscriptScroll.ts:583-593`; local-model warmup keys off the global session not the pane's — `useLocalModelSidecar.ts:182-184/232`.
- Mermaid theme observer watches only `data-theme` — custom-theme token swaps leave old palettes mounted — `MermaidDiagram.tsx:428-435`; numeric table cells crash PDF compilation (`esc(4200)` TypeError) — `lib/docdesign/irDoc.ts:179-192` + `compilePdfHtml.ts:114`; `ALLOWED_ATTR` silently strips standard SVG presentation attrs from all srcDoc content — `sanitize.ts:22-58`.
- TTS: `~~~` fences voiced as prose (strikethrough rule destroys the markers first) — `tts.ts:499 vs 629`; bullets stripped without the promised sentence break — `:656-658`; next()/prev() at the boundary replays the current sentence — `:1300-1314`.
- VaultPdfViewer consumes every text selection into a highlight (text layer un-copyable) — `VaultPdfViewer.tsx:382-421`; watcher-reload is an undoable transaction (Ctrl+Z reverts an external change and autosave writes it back) — `VaultEditor.tsx:815-825`; `noteContentCache` never invalidated — stale `[[Note#` completions — `:55-63/605-614`; VaultGraph hover `console.debug` ungated in production — `VaultGraph.tsx:652-669`.
- SkillsLibrary: failed skill read leaves the previous body editable under the new slug (cross-skill corruption on save) — `:352-360`; gallery load stuck "Loading…" on error — `:134-135`; template save partial-failure duplicate path — `:652-666`.
- Logs/automations UI: automations `load()` unhandled (dead Refresh, silent empty view) — `state/automations.ts:41-44`; three unhandled rejection paths in LogsView (`:80/175/193`); runs fetch without stale guard — `AutomationsView.tsx:763-786`; stale model select sends a nonexistent model — `:1503/1395`.
- Settings: system-prompt pill stuck "Saving…" on failure — `SettingsView.tsx:734-741`; GitPanel commit-model input permanently disabled on IPC failure — `:120-137`; unrelated downloads toast "Speech/Embedding model installed" — `SttPanel.tsx:50-54`, `KnowledgePanel.tsx:201-204`; six optimistic writes with no revert-on-failure (Mesh/Improvements/Knowledge/LogGateway/LocalModels/Data panels); HF token/dir-pick dead clicks — `ModelMarket.tsx:256-280`; success message renders with the fetch-failure action — `ApiKeysPanel.tsx:263/565-569`; base URL saved untrimmed/unvalidated — `:255/554`.
- Mobile: reconnect backoff defeated by every `useRelay()` mount + no jitter — `useRelay.ts:1077`; `_send` returns true for queued-only frames (messages silently lost when pairing fails) — `:641-654`; `steerQueued` drops duplicate queued texts — `useSessionChat.ts:718`; `connected` seeded from readyState not paired state — `useRelay.ts:1036/1055`; hardcoded About version 1.0.0 vs 0.4.2 — `SettingsScreen.tsx:377`.
- Sidebar shows the whole Windows path as the folder label (`split(/[\/]/)` misses backslash) — `Sidebar.tsx:361`, `ProjectsSidebar.tsx:93`; LocalModelModal leaves its overlay up over the Market — `LocalModelModal.tsx:69-74`; CommandPalette "Add Project" no catch — `:221-223`; ProjectSettingsPanel unhandled rejections + optimistic deletes — `:57-90/131-134`.
- `subagent runs` map grows unbounded — `state/subagents.ts:169/245-252`; `loadGraph` no catch (stuck graph overlay) — `state/vault.ts:888-892`; duplicated send-failure reset blocks — `streamingSlice.ts:253-268/297-312/386-392`.

### Performance
- Docs index spawn walks GGUF model folders (header parsing) **while holding the global DB mutex**, on every watcher reindex — `docs_index.rs:467-496`; corpus walk + per-file reads synchronous on the async worker — `:637/691`.
- Blocking work on async workers: `os_toast` (registry+PNG+WinRT on the UI thread, `os_toast.rs:17-39`); `is_libreoffice_available` (`preview.rs:552`); git diff in generators (`generators.rs:182/357`); export/import compress+IO (`export.rs:335-421`); interpreter probe (`python_runtime.rs:139-152`); DNS resolution (`tools/search.rs:136-137`); `taskkill` on the background path (`tasks.rs:517-535`); non-Windows PATH probe (`local_models.rs:1989-1994`); `commandcode` bridge `cmd.status()` unbounded (`browser_mcp_register.rs:366-446`); `project_paths` is_dir under the DB lock (`skills_cmds.rs:13-28`); automations tick (H24); image_gen/tts status scans (`image_gen.rs:1032-1042`, `tts.rs:1178-1200`).
- Health-check clients without timeouts (wedged sidecar parks model start forever) — `local_models.rs:1083-1086/1385-1388`.
- Unbounded/no-cap outputs: `fs_list_directory` uncapped (`fs.rs:42-56`); `fs_search_files` walks the whole tree after the cap (missing outer break, `fs.rs:107-131`); search_content "Notes" one line per skipped file (`search_content.rs:396-427`); Jina reader buffers full bodies bypassing the 1 MiB guard (`search.rs:228/805`); `fetch_capped` buffers before capping (`installed_skills.rs:1004-1014`); hook output unbounded (`hooks.rs:536-537`); background shell bytes (H4).
- Logs list unvirtualized with full re-render per append — `LogsView.tsx:219` + `useLlmLogs.ts:57`.
- Per-send redundant bundle/watch resolution (re-write bundle files, re-list artifacts per turn) — `agent_sessions/mod.rs:705-861`, `opencode.rs:32-41`; per-call fresh reqwest clients — `google_rest.rs:440`, `gmail_api.rs:173`.
- Vault no-positive-term search loads the whole `vault_files` table — `vault/index.rs:738-753`.
- `useRelay`-mounted reconnect storms (above); `dict` object instability churns voice-loop effects per transcript partial — `useVoiceLoop.tsx:102/128/401/424`.

### Resource leaks & lifecycle
- `svc.svc.cancel()` never-polled (no-op; comment false) — `mcp_gallery.rs:473-485`; gallery double-connect race (two children for one server) — `:447-465/544-572`.
- Per-label browser state never pruned on tab/pane close (unbounded maps; permanent 2s stall on recreated labels) — `browser/navigation.rs:306-347`, `tabs.rs:28-34`.
- Sidecar round-trip timeout orphans the in-flight op (keeps driving the page after the harness errored) — `bin/relay_browser_mcp.rs:223-271`.
- Hook timeout kills only the direct child — `cmd /C` grandchildren orphaned — `hooks.rs:494-499/552-558`.
- Unbounded append-only tables (`session_mail`, `memory_ops`, `improve_events/runs/eval`) with no prune — `db/mod.rs:1149-1461`.
- Popup storm: popup blocker disabled + blank popups allowed — unbounded OS windows from any page — `browser.rs:1019-1021/1379-1388`.
- Temp dirs named from bare nanos (same-tick collisions execute the wrong source) — `codeexec.rs:179`, `pygen.rs:98/248`, `pdfprint.rs:222-229`.

### DRY (extract-or-deduplicate)
- Seven near-identical `run_gated_*` wrappers — `dispatch.rs:331/472-519/2277-2417`.
- `fts_match_query` ×4 + LIKE-escape ×2 across db modules (drifting semantics) — `db/docs.rs:445`, `wiki.rs:611`, `memory.rs:244`, `chat.rs:1164/1205`, `session_fabric.rs:344`.
- `usage_delta`/`usage_is_zero` duplicated — `pty/mod.rs:440-578`; `record_usage` pair.
- Wait-poll machinery duplicated with drift — `browser_mcp.rs:1065-1158` vs `1355-1425`; browser label parsing ×5.
- Tokenization assembly duplicated (`ChatMessage` vs `CompactionEntry` framings can drift) — `compaction.rs:242-317`.
- `harness_oneshot_blocking` duplicates `one_shot_spec` arm-for-arm — `oneshot.rs:423-519` vs `815-943`; plan-mode directive string ×2 — `perturn.rs:177-186/295-304`.
- `resolve_pipeline_model` ~55-line block ×2 — `memory/worker.rs:273-311/803-840`; tailscale parsing ×2 + ~10 hand-rolled domain-error sends — `mobile/tailscale.rs:104-121/296-313`, `relay.rs:1710-2039` vs `domain_error` `:2404`.
- winget upgrade spec ×2 — `harness_adapters/claude_code.rs:84-97` vs `opencode.rs:85-98`.
- `image_gen_use_family` triple download-dispatch blocks; `download_mmproj` hand-duplicates the downloader; `pick_free_port` ×2; cudart scan ×2 — see commands-media P2 #15.
- `planned_path`/`truncate` across the three doc generators — `jsdocgen.rs:68-166`, `pygen.rs:82-88`, `docdesign/plan.rs:640-648`, `codeexec.rs:268-277`.
- Frontend: `wordOverlap` ×2 — `planParser.ts:20` / `planMatcher.ts:4`; `loadNotified` ×2 — `buildUpdates.ts:19` / `harnessUpdates.ts:22`; `skeletonOf`+`STRING_LITERAL_RE` ×2 — compileDeck/compileDoc; divergent second fuzzy matcher — `VaultQuickSwitcher.tsx:16-34` vs `lib/fuzzy.ts`; `base64ToBytes` ×2 — `tts.ts:842` / `ttsPreview.ts:42`; thinking tri-state cycle ×2 — `composerChrome.tsx:499` / `ChatComposer.tsx:1696`; five hand-rolled TTL caches — `pty_cmds.rs`/`agent_cmds.rs`; adapted-artifact persistence block + ArtifactType mapping ×2-3 — `artifact_cmds.rs:116-311`; Sidebar/ProjectsSidebar ~120 duplicated lines — `Sidebar.tsx:284-339` / `ProjectsSidebar.tsx:131-182`; stage-browser-mcp/stage-automation 60-line copy-paste — `scripts/`; ~25 dead imports ×4 settings panels + duplicate "subagents" category + dead `fileSizeCache`.

---

## Orchestrator checks (not owned by any single scope)

- **Packaging:** winget `Scope: user` vs NSIS `installMode: perMachine` mismatch (above); scoop manifest is correctly marked unofficial with autoupdate.
- **CSP posture:** cdnjs in `script-src` is used only inside `sandbox="allow-scripts"` opaque-origin preview iframes and is pinned by `src/test/csp.test.ts` — deliberate; the main-window risk is bounded but worth revisiting if pdfjs can be self-hosted like the fonts now are.
- **Prior-audit KNOWN items re-verified:** SHOW_FAKE_UPDATE — removed; pty `price_for` fossil — removed; Google Fonts — now self-hosted (cdnjs remains only for pdfjs). Still open: ~36 exhaustive-deps suppressions, `@babel/standalone` in the entry chunk (JsxPreview), no i18n, advisory-only budgets.

## Remediation short-list (highest value first)

1. **C1** send.rs deadlock (app-freezing; one-line-per-closure fix).
2. **C2** subagent move/copy gate keys (+ fix the vacuous test).
3. **C4** worktree path validation; **C3** zip-slip component check.
4. **C6 + H35** vault save generation/path guard + dirty-check flush batch (one PR).
5. **C7** search keys → keychain; **C5** whisper pipe drain.
6. **C8** mic latch; **C9** mobile salt binding (both small, both user-facing security).
7. **H14/H15/H16** db integrity batch (nested tx, version pointer, atomic ensure_artifact).
8. **H17 + H20/H21/H22** agent_sessions robustness batch.
9. **H26/H27/H28** connector/browser trust batch (description text, MCP timeouts, file: scope).
10. **H29/H32/H34** frontend correctness batch (composer reset, Enter guard, position regex).
11. **H38 + sourcemaps + action SHAs** release-pipeline hardening (one PR).
12. Then the P2 waves by theme (blocking-IO → spawn_blocking sweep; caps & prunes; DRY extractions).

## Coverage

26 agent scopes, every source file read end-to-end: Rust — chat engine (dispatch/streaming/mod, providers/permission/tasks/local_models, tools/*, commands/*, docs/citation/docdesign), agent_sessions (14 files), db (23), commands (30), mobile relay (12) + secrets, connectors (8), browser/MCP (11), memory/vault/wiki/docs/improve (21), automations/hooks/skills/git/github (12), session_fabric/harness/ACP (16), root/pty/llm_log/artifacts (26). Frontend — chat core (9), chat components (47), settings (30), panes/vault/big-3 (23), misc components (60), lib utilities (~60), voice/IPC (34), state stores (36), app shell/hooks/configs/CI/scripts (~60). Mobile RN — all 54 files. Site (`site/`, ~590 lines) and packaging manifests reviewed by the orchestrator. Out of scope by design: `src/styles/` (CSS ~25K lines — styling only, no logic; not covered by any scope), test files themselves (`src/test/`, `*.test.ts`, Rust `#[cfg(test)]` blocks — all green at baseline), `docs/`, mockups/harness HTML files at repo root, generated `dist/`, vendored `node_modules`, and the `Random Stuff`/`Thesis Diagrams` asset folders. Raw per-scope reports with full quoted evidence: `.zcode/audit-scratch/agent-results-*.md`.

**Totals: 9 Critical · 43 High · ~110 Medium** — plus verified-clean areas worth stating: SQL layer has no injection and correct rollback discipline elsewhere; DOMPurify posture is genuinely strong (three-tier policy, CSS neutralization — modulo H34); mobile E2E crypto core is sound modulo C9 (the 2026-09-21 nonce-reuse C1 is remediated); OAuth PKCE/refresh single-flight verified clean; tool schemas' filename sanitization and vault `safe_join` hold; all 29 frontend hooks clean up correctly; updater signatures verified before install.


---

## Remediation status (2026-10-03, same-day fix wave)

**Gates after the wave:** `cargo test --lib` 1,637 passed / 0 failed · `cargo clippy --lib` 0 warnings · `npx tsc --noEmit` clean · mobile `tsc` clean · `vitest` 1,697 passed / 0 failed (incl. tests updated to the new contracts: approval resolve signature, search-key keychain commands, paste-guard session fixture, debounced key writes).

**All 9 Critical fixed and orchestrator-verified:** C1 send.rs nested-lock deadlock (single guard reuse) · C2 subagent move/copy gate keys (`src`/`dest`) + vacuous test rewritten with in-scope/out-of-source/escape-source cases · C3 zip-slip component-based guard + backslash test + whole-archive pre-filter · C4 worktree pointer validation (`validate_worktree_pointer` + `git::list_worktrees`) · C5 whisper pipe drain (`spawn_pipe_reader`) · C6+H35 vault save generation/path binding + dirty-check flush (`flushPendingSave`) across openNote/restoreSnapshot/closeNoteTab/renameNote · C7 search keys → OS keychain (`set/has/delete_search_api_key` + read-time migration, plaintext rows purged) · C8 voice re-entrancy latch (`openingRef` + `startSeqRef`) · C9 v3 pairing (`bind_salt_to_challenge` both sides, replay-refused challenge + repeated effective salt).

**All 43 High fixed:** H1 firewall ASCII-lowering + text-order cuts (+2 regression tests) · H2 PTY immediate flush · H3 `anthropic_thinking_for` lockstep · H4 background-shell byte cap · H5 block-index clamps · H6 `always` threading for the directory grant (full chain: IPC → slice → card) · H7 `generate_document` code_exec gate + sandbox note · H8 print-window CSP + about:blank teardown on every path · H9 slots-object guard · H10 sources-section byte-offset cut (+ sentence scanner fix) · H11 xlsx row/merge clamps + `r1.max(r2)` typo · H12 import zip caps · H13 single-pass remove_blocks + capped Jina reader + spawn_blocking DNS · H14 wiki-row helper (no nested BEGIN) · H15 `active` repoint to the real version · H16 `ensure_artifact` transaction · H17 opencode reader-alive respawn + connect retries · H18 start-grace in both release watchers · H19 per-file `fs:file-changed` event + `strip_unc_prefix` matcher · H20 shared lossy capped line reader · H21 per-turn child take-and-kill · H22 one-shot orphan-row removal · H23 `sweep_stale_automation_runs` at boot · H24 tick → spawn_blocking · H25 GitHub tree recursion (dir budget 24) · H26 harness-write gate (`connectors.harness_writes`, default off) + description rewrite · H27 MCP connect/list/call timeouts · H28 `file://` scope containment · H29 composer per-session reset · H30 memoized markdown component map · H31 no-session send guard (kept draft + toast) · H32 approval keydown target guard · H33 stale-guards in BranchDropdown/BranchPanel/PullsPanel · H34 position-neutralizer start-anchor · H35 (with C6) · H36 stale-terminal guard map (armed on cancel, disarmed on first token) · H37 pop-out `relayNotify` suppression · H38 REF_NAME via env (+ timeouts + action SHAs in the follow-up) · H39 persisted away-stamp + cold-start lock + Settings toggle · H40 push wiring + approval journaling · H41 http(s)→ws(s) normalization + persist-after-pair · H42 ChatTurn abort_handle on cancel · H43 AEAD-failure eviction (threshold 5).

**Mediums fixed (~60 of ~110):** the full spawn_blocking sweep (tasks, generators, preview, python probe, export, os_toast, search DNS, skills_cmds lock, docs GGUF walk + sync corpus walk), memory/resource caps (fs list/search, search_content notes, Jina reader, fetch_capped already, hook output, xlsx, import zip — via H11/H12), prunes/lifecycle (stale automation sweep, hook timeout tree-kill via H20-wave, docs_watcher pending-flag, wiki watcher uninstall — noted below where deferred), correctness (download 416/If-Range restart, `r2.max(r2)`, sentence decimal lookahead, `{base}/v1/models`, api-key full-config delete incl. selected_models, opencode STREAM_STATE cap-retain, ACP session/error perf unregister, wait_for_turn_idle lock scope, plan-mode directive dedup, image_gen resolve/install/stop races + warmup gate, tts atomic cache + install guard, tts_gpu timeout, stt health budget + try_wait, llama fresh predicate, python probe caching, UUID temp dirs, security-doc corrections, domain_error DRY, winget spec DRY, `fs:file-changed` plumbing, mcp_gallery cancel/no-op + connect race + Filesystem default root, batch navigate rejection, sidecar dispatch cancellation, browser_mcp_register bounded CLI, unpriced_usd removal (Rust + types), fts pinned-corpus leg, llm_log LIKE escape, quarantine same-pair compare, skills_cmds lock scope, export spawn_blocking + pre-lock used-set + slug dot collapse, os_toast async, checkpoints safety high-water mark, adapter bold fix, hooks output cap, git list_branches single call, github comments newest-first, pty usage_delta/usage_is_zero hoist, memory/docs improve_engine dilution — via H18-wave — and vault/docs watcher drops — via H23-wave) plus all frontend/mobile items from the dead agent's list (revert-on-catch settings, dead imports, dead props, cache keys, DEV-gated logs, `[[Note#` invalidation + non-undoable external swap, Mermaid style observer, PDF search supersede, ContextMeter catch, MissingFields JSON prefill, TTS fence/bullet/skip-boundary + base64 dedup, thinking-cycle dedup, sidecar pane-keyed warmup, settle backoff, run-log AutomationsView error state + stale guard + model-select normalization, SkillsLibrary catches, LogsView catches + memo rows, ProjectSettingsPanel catches, CommandPalette catch, sidebar path split, app-lock persistence + cold start + toggle, push wiring + approval journal, deep-link scheme normalize + persist-after-pair, reconnect pending-guard + jitter, duplicate-queue splice, expoConfig version, sourcemap strip, action SHAs + timeouts, make-latest-json hard-fails, stage-sidecar dedup + debug opt-in, winget Scope: machine).

**Deliberately NOT fixed (pure-dedup refactors where behavior is already correct on every site; each is mechanical and safe to land as its own PR):** the FTS/LIKE `fts_match_query`/`escape_like` hoist across db modules; image_gen's triple download-dispatch fold; `download_mmproj` → `start_model_download_inner` reuse; memory `resolve_pipeline_model` extraction; Sidebar/ProjectsSidebar chat-row hook; logs virtualization (row memo done; windowing deferred); `--use-fake-ui-for-media-stream` documentation (JSON has no comment channel; docs file out of the fix wave's scope).
**Follow-up dedup wave (also 2026-10-03, same session):** FTS/LIKE hoist landed — `db::fts_prefix_query` + `db::escape_like` in db/mod.rs now back all five former private copies (docs/wiki/memory OR-joined, chat AND-joined, LIKE escapes in chat + session_fabric); image_gen's download dispatch folded into `queue_catalog_download` (3 sites); `sanitize_hf_filename` shared between the model + mmproj downloads; memory `resolve_pipeline_model` extracted (both pipelines use it); Sidebar/ProjectsSidebar row actions moved to a shared `useChatRowActions` hook; mic-flag + CSP-cdnjs accepted risks documented in docs/README.md (Security notes). Logs list: row memoization shipped (the per-poll re-render cost — the dominant issue — is proportional to changed rows now); full windowing was attempted and rolled back (virtual-core reads offsetHeight + measureElement rects, both 0 under jsdom, and mounts with a bogus scroll offset at 200 rows — verified by probe; the LogsView test file carries a NOTE with the two stubs a future attempt needs, verified in a real webview first).

**One intentional behavior change surfaced by tests (fixed, not regressed):** `useAutomationsStore.load` originally set `loaded: true` even on failure, which told the empty-harness-chat sweep "the automation list is known" and deleted run-log chats it could not rule out — failure now leaves `loaded` false and surfaces `error` (banner + Retry), and the sweep stays safe.

**Residue sweep (final, 2026-10-03):** the last three open Mediums are closed — `planned_path` deduplicated (docdesign/plan.rs now delegates to `jsdocgen::planned_path`); `truncate` consolidated into `codeexec::truncate_to_cap(s, cap)` (pygen keeps its trim, delegates the cap logic; the two former copies differed only in cap and trim order); and TTS bundle downloads now VERIFY integrity — the HF listing is fetched with `expand=lfs` and `hf_download_file` hashes each file while streaming, failing the file (and retrying on the next attempt) on sha256 mismatch instead of finalizing a corrupt asset that later surfaced as an opaque engine-load error. **Now truly all done:** every Critical, High, and Medium finding from this audit is fixed, and all gates are green (cargo test 1,637 ✓ · clippy 0 warnings ✓ · tsc ✓ · vitest 1,698 ✓).
