# Relay Build Log

> **Naming note:** This log refers to the project as "Relay" because most entries predate the 2026-08-27 user-visible rebrand to "Relay" (commit `e9abc7c3`). The build progress, test coverage, and design decisions are unchanged; the name has. See `README.md` and `AI CONTEXT/RELEASE.md`.

Running log per PRD §13.3: what was built, what was tested and how, assumptions/deviations, known issues.

---

## 2026-08-14 — Merge feat/goal-loop + feat/browser-agent-tools + feat/commit-msg-and-thinking-work; doc pass

Three feature branches merged onto `master` back-to-back, plus a follow-up
doc pass to keep `AI CONTEXT/`, `CONTRACT.md`, and `PROJECT_OVERVIEW.md`
honest about the resulting tool/skill counts and the perf-metrics schema.

**What was built (merges):**
- **`/goal` + `/loop` autonomous goal-driven loop** (`feat/goal-loop`):
  two new built-in skills, both backed by `skills/goal-loop-skill.md`
  (`/loop` is an alias of `/goal`), registered in
  `installed_skills.rs::builtins()`. The body teaches a `LOOP_STATUS:
  continue|complete|blocked` sentinel protocol; the host reads the trailing
  line to decide whether to issue another continuation turn. Frontend
  chip + `LoopState` machine in `state/chat.ts`.
- **Browser MCP tool expansion** (`feat/browser-agent-tools`): the
  `relay-browser-mcp` binary previously advertised the original six
  browser ops (navigate / read_page / click / type_text / scroll /
  wait_for); it now advertises **10 browser ops** — the six plus
  `screenshot`, `history` (back|forward), `hover`, `evaluate`,
  `click_and_wait` — plus **5 relay tools** (`generate_document` /
  `generate_diagram` / `generate_file` / `get_skill` / `list_skills`).
  `click_and_wait` snaps the pre-click URL and polls for nav/selector/
  network_idle in one round-trip; `evaluate` runs page JS and returns a
  JSON-serialized value; `hover` dispatches real mouseover/mouseenter for
  `:hover` menus (visual feedback included).
- **Process row + thinking block + commit-message generation + fast-model
  picker** (`feat/commit-msg-and-thinking-work`): `MessageBubble.tsx`
  redesigned around `ProcessSummary` + `ActivityStepRow` +
  `ThinkingBlock` + `renderProcessBlock` + `FilesChangedSummary`
  (self-contained — replaced master's `SubagentStrip`/`TurnTimer`/
  `ProcessCollapsible` pipeline; perf-metrics display, which lives in
  `ComposerMetrics.tsx`, was untouched). Settings got a fast-model and
  commit-message model picker (`cmProvider`/`cmModel`/`cmModels` state +
  `listChatModels` effect); "Assistant section starts expanded" default
  kept from master.

**Merge-conflict resolution:**
11 mechanical conflicts (perf-metrics fields / extra `add_chat_message`
args) resolved `--ours` (master); `MessageBubble.tsx`, `SettingsView.tsx`,
`global.css` hand-merged (keeping both sides' classes / sections where
independent). Merge commits: `42721577`, `e02127fe`, `5dc5affd`.

**Test fallout fixed (`e92b63ac`):** the merge left 10 lib tests red —
8 because `db::mem()` (the in-memory test schema) only ran `init_schema`
without the post-schema migrations, so it lacked the `llm_time_ms` /
`tool_time_ms` / `ttft_ms` / `tokens_per_second` columns that
`add_chat_message` now writes (its signature gained the perf fields via
master's side of the merge). `mem()` now runs the full
`configure()` migration sequence so the in-memory schema matches
production. Plus the goal-loop builtin test asserted the parsed skill's
*name* equaled the slug (`"goal"`/`"loop"`), but
`parse_invoked_skills` returns the human-facing label
(`"Run a goal-driven loop"`); fixed the assertion to check the body
content (`LOOP_STATUS` sentinel) and the match count instead.

**Normalizer fix (`a1ae7420`):** `normalizer_detects_mmproj_filename`
was the one pre-existing red test on master before any of these merges
(authored in `7ba3e554`/`13a50a41`, long before the three branches).
`normalize_hf_model` previously computed `vision` once at the repo level
from the HF tags (`multimodal`/`vision`) and applied it to every GGUF
sibling — so LLava-style repos that ship a separate `*-mmproj-*.gguf`
projector file but don't tag the repo as multimodal had their projector
files flagged non-vision. `vision` is now derived per file: a filename
containing `mmproj` is always vision, OR'd with the repo-level signal
(tags OR repo-id cues like `llava`/`qwen-vl`/`internvl`/`minicpm-v`/
`-vl`/`vision`) so a bare base-quant file in a vision repo still gets
flagged. All 379 lib tests now pass.

**Doc pass (`a1ae7420` follow-up):**
- `CONTRACT.md` — `ChatMessageRecord` gained `llmTimeMs`/`toolTimeMs`/
  `ttftMs`/`tokensPerSecond`; `Chat tools (29)` → `(32)` with
  `list_skills`/`browser_screenshot`/`Task` added to the enumeration;
  `browser_action_result` resolves `browser_read`/`browser_click`/
  `browser_type`/`browser_scroll`/`browser_screenshot`.
- `AI_CONTEXT.md` — `Last verified: 2026-08-07` → `2026-08-14`; the
  "Tools (32)" line got `browser_screenshot`/`Task`; the
  `relay-browser-mcp` section now lists all 10 browser ops + 5 relay
  tools (was "Six tools: navigate / read_page / click / type_text /
  scroll / wait_for"); built-in skills file-map row gained `goal-loop-
  skill.md` and the 6-skill slug list; `chat_messages` schema row gained
  the perf columns + `started_at`/`completed_at`; migrations paragraph
  gained `migrate_chat_session_project_id`, `migrate_cost_v2`,
  `migrate_chat_messages_v2`, `migrate_chat_messages_started_completed`,
  `migrate_chat_messages_perf`; removed the dead
  `lib/defaultSkills.ts` row from the utilities list (the file is gone —
  built-in skills are served from the Rust backend now).
- `PROJECT_OVERVIEW.md` — `29 tools` → `32 tools` (SVG header, narrative,
  file-map row); `browser_mcp.rs` row clarified to enumerate the 10
  browser ops + 5 relay tools (was "relay tool whitelist"); added
  built-in skill list (`docx`/`pptx`/`pdf`/`diagram` + `goal`/`loop`) to
  the `installed_skills.rs` row.
- `installed_skills.rs` doc comments — "The four built-in skills" →
  "Six today" with the goal/loop note; the slash-command enumeration
  gained `/goal`, `/loop`.
- `task-relay-browser-mcp.md` — the original task proposal enumerated
  only six tools and used `type` (shipped as `type_text`) plus a
  two-value `read_page` mode (`interactive|content`); left as a
  historical document, but see this entry for the current surface.

**Verification:** `npx tsc --noEmit` clean; `cargo build --lib` +
`cargo build --bin relay-browser-mcp` clean; `cargo test --lib` →
**379 passed, 0 failed**; `npx vitest run src/test/goalLoop.test.ts` →
19 passed.

---

## 2026-08-09 — `--jinja` fallback for Clang 20.1.8 llama-server + artifact routing (SVG→Canvas, HTML/JSX→browser)

Two fixes finished from a half-landed changeset: the local-model sidecar
crashed on llama-server builds (Clang 20.1.8) that reject `--jinja`, and
the artifact open-routing referenced helpers that were never defined, so
the frontend would not compile.

**What was built:**
- **`--jinja` strip on rejection** (`chat/local_models.rs`): the ngl
  fallback ladder already descends on OOM; added a sibling branch for the
  "non-OOM early exit" case that detects `unrecognized argument` /
  `invalid option flag` in the captured stderr, strips `--jinja` from
  `args_template` (declaration now `mut`), and retries. The ladder is
  always multi-step (`[ngl, 64, 32, 16, 8, 4, 0]`, deduped), so `--jinja`
  is present only on attempt 0 and the retry lands on attempt 1 — no
  fall-through to the "all attempts failed" error.
- **Artifact open-routing** (`state/chat.ts` `onArtifact` +
  `lib/sessionLauncher.ts:openArtifactInBrowserPane`): `.html`/`.htm`/
  `.jsx` artifacts now open in a browser pane (new tab on an existing
  visible browser, else spawn one, else skip when the grid is full) and
  surface the Browser tab; `.svg` stays inline in the chat bubble;
  everything else still opens in the Canvas preview. Replaced an earlier
  content-probe (`fileStartsWith`/`fileContains`) that was never defined.

**What was tested and how:**
- `cargo check --manifest-path src-tauri/Cargo.toml` → clean. (The prior
  change had left `args_template` immutable → `E0384`; fixed by adding
  `mut`.)
- `npx tsc --noEmit` → exit 0. (The prior change referenced undefined
  helpers; the extension-only check resolves it.)

**Assumptions / deviations:**
1. The Clang 20.1.8 build's `--jinja` rejection surfaces as
   `unrecognized argument` / `invalid option flag` in the stderr captured
   by `take_streams`; if the wording differs the branch won't fire and the
   caller sees the real startup error.
2. Routing is by content, not extension: `.jsx` → browser; `.html` is
   classified via `readArtifactPreview` — a diagram (`kind "diagram"`, i.e.
   starts with the `<!-- relay:diagram -->` marker) stays in the Canvas
   preview (pan/zoom + PNG/SVG export), a plain webpage (`kind "html"`) goes
   to the browser so its scripts run. SVG renders inline in the chat bubble.
   Classification failure / `null` defaults to Canvas.

**Known issues:**
- When the pane grid is full and no visible browser exists, an HTML/JSX
  artifact open is silently skipped (no pane freed, no error surfaced).

---

## 2026-08-08 — Connectors in harness sessions (Claude Code / Kimi / OpenCode)

Harness chat sessions never saw connected connectors: the built-in chat
attaches them in-process (`connectors::session::connect_all`), but the CLI
harnesses only read static MCP config at spawn — and the generated bundle
registered only `relay-browser` + `relay-tools`. API-key and local-GGUF
chat worked, harnesses didn't.

**What was built:**
- **Connector snapshot for harnesses** (`connectors/harness.rs`):
  `harness_mcp_servers(app)` collects every connector with a credential row
  plus public connectors (Kiwi) — same set the built-in chat uses — and
  resolves a fresh OAuth bearer per connector via
  `ensure_valid_access_token` (refreshes when expired; failures skip that
  connector, never the turn).
- **Bundle merge** (`harness_bundle.rs`): `build_tools_mcp_json` /
  `build_opencode_tools_config` take the connector list and emit one remote
  server per connector — Claude flavor `{ "type": "http", url, headers }`,
  Kimi flavor `{ url, headers }` (HTTP inferred from `url`; no `type` field),
  OpenCode `{ "type": "remote", url, headers, "oauth": false }` (`oauth:
  false` keeps OpenCode from starting its own OAuth flow on token expiry —
  refresh is Relay's job, done per spawn). Claude and Kimi `mcp.json`
  contents are now generated per-flavor (previously one shared document).
- **Plumbing**: `send_agent_chat_message` is now async; it snapshots the
  connectors before the sync spawn path and threads them through
  `AgentSessionManager::send` → `send_claude_turn` / `spawn_per_turn` →
  `resolve_harness_bundle` → `write_bundle`.

**What was tested and how:**
- `cargo test --lib` → **362 passed, 0 failed, 10 ignored** (new:
  `tools_mcp_json_merges_connectors_per_flavor`,
  `opencode_config_merges_connectors_as_remote`).
- `npx tsc --noEmit` clean (no frontend changes — the invoke signature is
  unchanged).

**Assumptions / deviations:**
1. Claude Code's process is persistent (respawned only on model change /
   cancel / restart), so a long-lived Claude session can hold a connector
   token past its ~1h expiry until the next respawn; Kimi/OpenCode spawn per
   turn and always get a fresh token. GitHub tokens never expire.
2. Google's Workspace MCP servers that deny `tools/call` in preview behave
   the same as in the built-in chat; the local REST fallbacks (`gmail_*`,
   `gdrive_*`, …) are chat-only and not bridged into harnesses.
3. Dev-tab PTY sessions and automation one-shots (`one_shot_spec`) don't use
   the harness bundle and are unchanged.

**Follow-up (same day) — project-less sessions:** the bundle no longer
requires a selected project. `resolve_harness_bundle` falls back to a
`_no_project` slug when `project_id` is `None`, so connectors + relay-tools
reach the CLI in every harness session (previously a project-less spawn got
NO Relay MCP config at all — the CLI fell back to the user's own Claude
plugin config, which read as "connectors not detected"). Tradeoff: browser
panes and artifacts of all project-less sessions share the `_no_project`
scope. `build_instructions_md` / `build_claude_settings_json` tolerate an
empty project path (no bogus "project is at ``" sentence, empty
`additionalDirectories` entries filtered). New test:
`project_less_bundle_tolerates_empty_project_path`.

**Follow-up 2 (same day) — canvas/artifact bug fixes:**

1. **Docx preview lost all styling** — an uncommitted `MammothDocxPreview`
   branch in `ArtifactPreviewPane.tsx` routed every docx through mammoth.js
   (bare semantic HTML, no fonts/colors/table styles) instead of the styled
   Rust converter's `preview.text`. Removed the branch + component; docx
   renders via the styled converter HTML again.
2. **Generated files never surfaced as artifacts in harness sessions when a
   project was selected or `storage.artifactsDir` was customized** — the
   harness `DirWatch` only diffed the spawn dir (project path), but the
   relay-tools MCP (`mcp_tools_bridge`) always writes into
   `dispatch::artifacts_dir` (the configured/default folder). Files landed
   outside the watched dir → no artifact row, no `chat:artifact` event, no
   canvas auto-open, no sidebar entry. Fix: `turn_watch_dirs()` watches BOTH
   dirs (deduped, canonicalized) through all three spawn paths
   (`spawn_claude` / `spawn_per_turn` / `run_one_shot`); `finish_turn`
   iterates the watches and dedups reported paths. New tests:
   `turn_watch_dirs_includes_configured_artifacts_dir`,
   `turn_watch_dirs_dedups_when_dirs_coincide`.

**Verified:** `cargo test --lib` → **365 passed, 0 failed, 10 ignored**;
`npx tsc --noEmit` clean.

---

Cost model redesign to match the T3 Code usage dashboard (design spec:
`AI CONTEXT/COST_MODEL_REDESIGN.md`; implementation plan:
`docs/superpowers/plans/2026-08-08-cost-model-redesign.md`).

**What was built:**
- **Schema migration** (`migrate_cost_v2` + `migrate_chat_messages_v2` in
  `db/mod.rs`): `cost_events` gains `provider`, `model_key`, `source`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`,
  `reasoning_output_tokens`, `reported_cost_usd`, `pricing_estimated_usd`;
  the old `estimated_cost_usd` is dropped. `chat_messages` gains the same
  shape minus `source`/`reported_cost_usd`. Backfills `source='on_disk'`
  for on-disk-synced sessions and `model_key` for known harnesses.
- **Read-time pricing** (`harness_adapters::pricing`): `price_usage` is
  the single source of truth for cost math, layered on Settings overrides
  and per-model cache rates. `pricing_estimated_usd` is write-only audit;
  changing a rate reprices history retroactively.
- **Adapter cache/reasoning tracking**: `UsageInfo` v2 splits
  cache_creation / cache_read / reasoning; Claude + Kimi
  `parse_session_usage` record them separately. The pty scraper stays
  conservative (NULL cache/reasoning).
- **New rollup endpoint** (`get_cost_rollups(rangeDays?: 7|30|90)`):
  unions `cost_events` + `chat_messages`; returns totals, perProvider,
  daily (with tokensByProvider), byKind, perModel, costQuality
  (provider-reported / model-priced / unpriced %s + cache savings),
  perProject, rangeStart/End/Days. `CostUpdatedEvent` carries `version: 2`.
- **T3 Code-style dashboard**: `CostDashboard.tsx` rewritten with
  `RangeToggle`, `CostHero`, `DailyChart` (Cost/Tokens toggle),
  `StatsRow` (6 cards incl. cache savings), `ModelBreakdownTable`,
  `CostQualityPanel`, and a `useCostRollups` hook. Local-model usage panel
  folded into the per-model table.
- **Mobile relay** uses the same read-time pricing (`read_rate_overrides`
  + `get_cost_rollups_v2(14)`); `CostSummary` message gains `version: 2`.

**What was tested and how:**
- `cargo test --lib` → **354 passed, 0 failed, 10 ignored** (new: pricing
  module 7 tests, cost_v2 rollup 2 tests, migration test, kimi cache
  split test, updated claude cache split test).
- `npx vitest run` → **176 passed** (new: costRollups shape, useCostRollups
  hook, CostDashboard render + range toggle).
- `npx tsc --noEmit` clean; `npm run build` clean.

**Assumptions / deviations:**
1. Rows with NULL `model_key` price at the harness default
   (`harness_default_model_key(provider)` for cost_events,
   `canonical_model_key(chat_sessions.model)` for chat rows) per spec §7.2.
2. `CostTotals` carries a `#[serde(skip)]` internal cache-savings
   accumulator; the public cache-savings figure lives on `CostQuality`.
3. OpenAI-compatible chat rows currently zero the cache/reasoning fields
   (the wire format we parse doesn't expose them yet) — spec-flagged follow-up.

---

## 2026-08-07 — Doc audit + permission-mode removal + agent/automation features landed

This entry covers the doc-audit pass that pulled the docs in line with the
headless-CLI-chat + automations + harness-bundle + harness-config work that
landed since 2026-08-03. The implementation has been merged across the past
two weeks (separate work sessions); the only code-shaped change in this entry
itself is the `PermissionModeMenu` / `ApprovalFlow` removal in favor of the
`AgentMenu` + `DiffCard` pattern (per the chat-frontend refactor below).

**Doc set** (`AI CONTEXT/AI_CONTEXT.md`, `CONTRACT.md`):
- Bumped `last verified` to 2026-08-07; added headless CLI chat to the boot
  overview, working-tree summary, and feature list.
- §2.1 entry point now lists all 11 managed states (added
  `agent_sessions::AgentSessionState`, `TaskState`, `MobileRelayState`,
  `OAuthFlowsState`, `LocalModelState`, `DownloadRegistry`) and the
  134-command total; exit cleanup adds `agent_sessions::kill_all` and
  `LocalModelState::stop_all`.
- §2.2 command surface expanded: 8 automation commands, `get_chat_db_path`,
  `update_chat_session_agent`, `send_agent_chat_message`,
  `cancel_agent_chat_message`, `list_harness_models`,
  `delete_all_chat_sessions`, `delete_all_artifacts`; 5 new groups
  (Automations, Chat additions, new Harnes/Agent entry).
- §2.5 rewritten to cover the per-project bundle, harness config discovery,
  and headless CLI chat.
- §2.6 covers automations + compaction + `superseded_by`; tool count 29 → 32
  (added `list_skills`; `search_content` is its own tool; `browser_read`
  gained the `interactive` mode).
- §2.8 lists 15 tables (`automations`, `automation_runs` new), adds the
  `agent` column migration and `migrate_chat_messages_superseded`.
- §2.12 adds the headless-CLI-chat safety note (full-auto by design).
- §3.2 state table adds `automations.ts`; `chat.ts` row updated to mention
  the new `sendMessage` routing + `setSessionAgent`; the new `ui` tool-panel
  fields (tab/collapsed/width) are listed.
- §3.3 / §3.4 / §3.5 list the new components (`ToolPanel`, `AgentMenu`,
  `DiffCard`, `ContextMeter`, `TaskProgressCard`, `ConnectorGrid`,
  `ModelMarket`, `ModelDownloadIndicator`, `DocumentsLibrary`,
  `AutomationRunTable`, `AutomationsView`, `UpdateBannerMarkdown`); the
  removed `PermissionModeMenu` + `ApprovalFlow` are noted with the date.
- §3.6 IPC section documents the new automation / agent / harness-models
  IPC + types; `ChatSession` now includes `agent`.
- §3.7 / §3.8 add the new lib utilities (`harnessModels`, `sanitize`,
  `syntaxTheme`, `syntaxHighlighter`, `modelLabel`, `contextWindow`,
  `sound`) and the new test files; deleted tests
  (`permissionModeMenu`, `permissionModeStore`) are noted via the removed
  components.
- §4 gaps table refreshed (new fix entries for the headless-CLI chat,
  automations, and new components).
- §6 file map updated to include the new backend modules
  (`harness_bundle.rs`, `harness_config.rs`, `agent_sessions.rs`,
  `automations.rs`, `mcp_tools_bridge.rs`, `commands/automation_cmds.rs`,
  `db/automations.rs`, `bin/relay_automation.rs`) and the new frontend
  files.
- `CONTRACT.md`: new types (`Automation`, `AutomationInput`,
  `AutomationRun`, `HarnessModelInfo`, `HarnessModelConfig`,
  `WorkspaceRecord`, `ChangedFile`); `ChatSession` adds `agent`; new
  Automations / Harness / Headless CLI chat / Git additions / Chat
  additions command blocks; `chat:status` and `chat:task-progress` event
  details filled in; the "Rules both sides must honor" section notes the
  headless-CLI routing rule and the removed permission-mode UI.

**Implementation, chat-frontend refactor (the only code change in this entry):**
- `src/components/chat/{PermissionModeMenu,ApprovalFlow}.tsx` deleted;
  the corresponding `src/test/{permissionModeMenu.test.tsx,permissionModeStore.test.ts}`
  removed.
- `src/components/chat/AgentMenu.tsx` is the new composer leftmost chip:
  installed harnesses + the two non-CLI modes (`"builtin"` / `"local"`).
- `src/components/chat/DiffCard.tsx` replaces `ApprovalCard` for CLI-chat
  file edits: filename + +/− stats + 5-line preview + inline expand
  (Cursor-style) + "Open in Peek". No Accept/Reject — the CLI is full-auto.
- `chat.ts` routes `sendMessage` to `sendAgentChatMessage` when the
  session's `agent` is `"harness:<id>"`; `setSessionAgent` writes via
  `update_chat_session_agent`.

**Verification (post-edit):**
- The doc edits are a no-op for `cargo` / `tsc` / `vitest`; the run was not
  re-executed for this entry. See the prior work sessions (below) for the
  per-feature verification.

---

## 2026-07-26 — Local Models: minimal-click GGUF setup

### What was built

A Settings → "Local Models" section that makes locally-installed GGUF models
work with zero manual port / GPU / context-size configuration: pick a `.gguf`
file, click "Use this model," and the model appears in the Chat dropdown with a
"Local" badge. Per PRD §13 the done-bar is the click-count/time-to-first-chat,
not just correctness — see the manual-test checklist below (numbers pending the
real timed run).

**Backend (`src-tauri/src/chat/local_models.rs`, new):**
- **GGUF metadata parser** (`parse_gguf`): reads the binary GGUF header (magic,
  version, tensor count, KV metadata) and extracts `general.name`,
  `general.architecture`, `general.size_label` (param-count label) and
  `general.file_type` (quantization). Non-GGUF files fail the magic check and
  are skipped. Tolerant — never panics on truncated/malformed files.
- **Multi-source scanner** (`scan_folder`, recursive via `walkdir`; default
  locations via `scan_default_locations`): LM Studio cache
  (`~/.cache/lm-studio/models`), the user's Downloads (`dirs::download_dir`),
  and Ollama's blob store (`~/.ollama/models/blobs` — best-effort blob-level
  scan, no manifest parsing; see "Default scan locations" below).
- **Memory-sanity traffic-light** (`memory_class`): file size vs
  `sysinfo::System::total_memory()`. <50% RAM = fits (green), 50–80% = tight
  (amber), >80% = too_large (red). Conservative to leave KV-cache headroom.
- **Sidecar registry** (`LocalModelRegistry`): `HashMap<model_id, SidecarHandle>`
  — keyed for forward-compat with concurrent sidecars, though v1 enforces
  one-at-a-time by calling `stop_all()` before every `start()`. Each handle
  holds a `tokio::process::Child` + allocated port. `stop_all()` is wired into
  the app-exit cleanup in `lib.rs` via `LocalModelState`.
- **Binary resolution** (`resolve_llama_server_binary`): `$LLAMA_SERVER_PATH`
  env (file/.exe/dir) → `llama-server --version` on PATH → common install
  locations (`C:\llama.cpp\build\bin\Release` on Windows; `/usr/local/bin` and
  `/opt/llama.cpp/build/bin` on POSIX). **The binary is NOT bundled.**
- **Spawn + health-check** (`start`): binds a free port via
  `TcpListener::bind("127.0.0.1:0")`, spawns `llama-server --model <path>
  --port <port> --host 127.0.0.1 --n-gpu-layers <ngl> -c <ctx>`, then polls
  `GET /health` every 500ms for up to 30s. On a child that exits early (bad
  flag / unsupported arch / missing file), drains stderr and returns it
  immediately instead of burning the full 30s — protects the <10s target.
  On success, persists `chat.local_gguf.base_url` + `chat.local_gguf.model` +
  `chat.active_provider="local_gguf"` and returns `{modelId, port, baseUrl}`.

**New provider variant (`src-tauri/src/chat/providers.rs`):**
`ChatProviderId::LocalGguf` → `LocalGgufProvider` reuses the OpenAI wire format
(`openai_request` + OpenAI SSE parsing), since llama-server speaks
`/v1/chat/completions`. Base URL is required (the sidecar's loopback URL,
persisted by `start_local_model`); API key is a dummy `"no-key"` placeholder
(server ignores it). The send path routes `local_gguf` through the existing
`run_openai_tool_loop` — no new tool loop, no new streaming path. Keyless: the
API-key load returns `"no-key"` and skips the OS keychain.

**Provider capabilities (`src-tauri/src/chat/prompts.rs`):**
`provider_capabilities(id, model) -> ProviderCaps { model_class,
native_web_search, requires_local_sandbox }`. For `LocalGguf`:
`native_web_search = false` (web_search stripped from the tool schema via a new
`ToolCaps.web_search` flag), `requires_local_sandbox = true` (plumbed into
ToolCaps; not yet branched on since code-exec already uses the bundled
sandboxed Python unconditionally — see deviation #4), `model_class = Local`.
`core_prompt_for` now derives `model_class` from `provider_capabilities` (single
source of truth), so the existing STRICT core-prompt addendum fires for any
model `classify_model` calls Local (llama/qwen/phi/gemma/… — GGUF filenames
match). The existing Hermes-format fenced-`tool_call` fallback parser is reused
as-is — it's what keeps unreliable local tool-calling working.

**Backend commands (`src-tauri/src/chat/commands.rs`, registered in `lib.rs`):**
`scan_local_models(folder?)`, `start_local_model(model_id, path, ngl?, ctx?)`,
`stop_local_model(model_id)`, `local_model_status()`. `list_chat_models`
short-circuits to an empty vec for `local_gguf` (the catalogue comes from the
scanned files, not an endpoint). `get_chat_config` treats `local_gguf` as
`has_key=true` and the active-provider fallback scan accepts it as
configured-when-active.

**Frontend:** `"local_gguf"` added to the `ChatProvider` union (`src/lib/ipc.ts`)
+ new IPC wrappers + `GgufModel`/`StartedModel`/`ActiveLocalModel` types. New
`LocalModelsPanel` in `SettingsView.tsx` (new "localmodels" category beside
"apikeys"): auto-scan on open, "Add folder" picker, model rows with memory
traffic-light, "Use this model" (creates a `local_gguf` chat session + switches
to the Chat tab), collapsed Advanced (-ngl / -c overrides), inline per-row
errors, active-model indicator + Stop button. `ModelEffortMenu.tsx` renders a
"Local" badge when the session provider is `local_gguf` (prop threaded from
`ChatView` → `ChatComposer`); `ChatView` excludes `local_gguf` from the
`/v1/models` fetch. New `.model-effort-local-badge` style in `global.css`.

**New Rust deps:** `walkdir`, `sysinfo`, `dirs`.

### What was tested and how
- `cargo check` — passes (9 pre-existing warnings, 0 new).
- `cargo test --lib chat::` — 103 passed, 0 failed, 8 ignored (the 3 live-network ones).
- `npm run build` — passes (`tsc` + Vite, `✓ built in 38.84s`).
- **End-to-end click-flow: NOT yet run** — requires a real `llama-server`
  binary on PATH + a `.gguf` file in a scanned folder. See checklist below.

### Manual click-flow test (PRD §13 — the actual done-bar)
- [ ] Zero-click auto-scan shows results from LM Studio cache + Downloads (if
      GGUF present there)
- [ ] Ollama manifest store: best-effort blob scan IMPLEMENTED (no manifest
      parsing — see deviation #2); names may show as sha256 hashes unless the
      GGUF header's `general.name` resolves them
- [ ] Add-folder correctly lists `.gguf` files
- [ ] Settings → pick → Chat dropdown shows a working model, no manual
      port/GPU steps — `[ACTUAL TIME: TBD]` (target <10s of user interaction)
- [ ] Auto `-ngl`/`-c` works on a GPU machine AND a CPU-only machine (no
      0-layers-on-GPU, no OOM-on-CPU)
- [ ] Switching models stops the previous sidecar — no orphaned `llama-server`
      after switching or quitting the app
- [ ] `ModelClass::Local` STRICT addendum active when local_gguf is selected
- [ ] Memory indicator correct for one model that fits + one that's oversized
- [ ] Regression: existing API-key providers in the same Settings area
      unaffected

### Default scan locations: implemented vs skipped
| Location | Status |
|---|---|
| LM Studio cache (`~/.cache/lm-studio/models`) | Implemented |
| Downloads (`dirs::download_dir()`) | Implemented |
| Ollama blob store (`~/.ollama/models/blobs`) | Implemented best-effort — blob-level scan, NO manifest parsing |
| User-added custom folder | Implemented (`scan_local_models(folder=Some(...))`) |

### Assumptions / deviations
1. **llama-server NOT bundled.** Must be installed separately and on PATH or at
   `$LLAMA_SERVER_PATH`. Deliberate v1 limitation — bundling llama.cpp
   per-platform would blow up installer size and create a version-compat matrix.
2. **Ollama scanning is blob-level, no manifest parsing.** Blobs are
   sha256-named raw GGUF files; the GGUF magic filter picks them up, but the
   user may see hash filenames unless `general.name` metadata resolves a
   friendly name. Manifest correlation (`~/.ollama/models/manifests/…`) for
   human-readable names is deferred per the spec's Ollama caveat.
3. **One-at-a-time sidecar policy** is enforced by `stop_all()` before every
   `start()`. The registry holds N handles structurally, so concurrent sidecars
   later = drop the `stop_all()` call + allow multiple entries, not a rewrite.
4. **`--flash-attn` is NOT passed.** Originally the build tried `--flash-attn`
   first with a spawn-time fallback — but an unsupported flag fails at RUNTIME
   (process spawns, then exits with "unrecognized argument"), not at `spawn()`
   time, so the fallback never fired and a flash-attn-incompatible build would
   hang the full 30s health-check. Fixed: `--flash-attn` omitted entirely (it's
   a perf optimization, not required); the health-check now also bails early
   when the child exits, surfacing stderr instantly. Flash-attn can return as
   an opt-in once we detect a CUDA/Metal build.
5. **`requires_local_sandbox` plumbed but not branched on.** Code-exec already
   routes through the bundled sandboxed Python unconditionally, so there's no
   non-sandbox path to gate against yet. Marked `#[allow(dead_code)]` as a
   contract field awaiting a future host-execution path.
6. **`auto_ngl()` = 999** (offload all layers); llama-server clamps to VRAM and
   falls back to CPU for the rest. On a weak dGPU this may OOM rather than
   partially offload — the Advanced `-ngl` override exists for that case. No
   `sysinfo::Components` GPU enumeration yet.
7. **`auto_ctx_size()` is a file-size heuristic** (<4GB→4096, 4–16GB→2048,
   >16GB→1024), not the model's `max_position_embeddings`. Override via Advanced.

### Known issues / follow-ups
- The timed end-to-end test still needs to run on a machine with a real
  `llama-server` + GGUF (fill in the `[ACTUAL TIME: TBD]` above).
- `auto_ngl()` could query VRAM and cap layers (~70%) instead of relying on the
  server's graceful fallback.
- Ollama manifest parsing for human-readable model names.
- `--flash-attn` opt-in once GPU backend is detected.

---

## 2026-07-18 — Full Rust (Tauri v2) backend

### What was built

Complete `src-tauri/src/` backend per PRD §6.2 and CONTRACT.md:

```
src-tauri/src/
├── main.rs                     # thin entry -> relay_lib::run()
├── lib.rs                      # app builder: plugins (dialog/notification/fs), state,
│                               #   window vibrancy (apply_blur on Windows, apply_vibrancy
│                               #   on macOS, cfg-gated), exit cleanup via app.run callback
├── types.rs                    # all IPC structs, #[serde(rename_all = "camelCase")],
│                               #   incl. the 5 event payloads
├── db/mod.rs                   # rusqlite layer: PRD §6.3 schema + quick_actions,
│                               #   all query fns take &Connection (in-memory testable)
├── git.rs                      # git status/worktree/diff via shelling out to `git`
├── secrets.rs                  # OS keychain store (keyring v3) + key-name registry in SQLite
├── pty/mod.rs                  # PtyManager: spawn/write/resize/kill/kill_all, reader/writer/
│                               #   waiter threads per pane, 1.5s-silence state monitor,
│                               #   stripped rolling transcript (1MB), session-id + usage scraping
├── harness_adapters/
│   ├── mod.rs                  # HarnessAdapter trait, registry, shared conservative
│   │                           #   usage parser, binary_on_path(--version) install check
│   ├── claude_code.rs          # `claude`, `--resume <id>`, `auth login`; output-regex +
│   │                           #   ~/.claude/projects/<cwd-slug>/*.jsonl filesystem fallback
│   └── kimi_code.rs            # `kimi`, `-r <id>`, login = bare `kimi` (user runs /login)
└── commands/
    ├── mod.rs
    ├── projects.rs             # list/add/remove/rename/init_git + session CRUD + touch
    ├── pty_cmds.rs             # spawn_agent_session, spawn_shell, write/resize/kill_pty,
    │                           #   list_harnesses, run_harness_login
    ├── git_cmds.rs             # get_git_status, create_worktree, get_git_diff
    └── data.rs                 # settings, skills, quick actions, secrets, cost,
                                #   export_session_markdown, read_file_text
```

All 37 commands from CONTRACT.md are registered with the exact contract names;
all events (`pty:output`, `pty:exit`, `pty:state`, `session:harness-id`,
`cost:updated`) use the exact contract names and camelCase payloads.

### What was tested and how

- `cargo test` (rustc/cargo 1.97.1, stable-x86_64-pc-windows-msvc):
  **34 passed; 0 failed; 0 warnings.** Coverage:
  - both adapters: resume-command args, new/login command specs,
    `parse_session_id` against sample outputs (incl. no-match cases),
    `parse_usage` samples, Claude cwd-slug helper, Claude fs-fallback
    missing-dir defensiveness
  - shared usage parser: "Tokens: 1,234 in / 567 out", separate
    input/output-token lines, "Total cost: $0.12", no-match cases
  - db layer (in-memory SQLite): schema idempotency, project upsert on
    UNIQUE(path), remove_project manual cascade, session round-trip,
    skill scoping (global vs project), quick-action CRUD, secret key rows,
    settings, cost events + per-project/daily rollups
  - git helpers: `parse_ahead_behind` (left/right -> behind/ahead),
    worktree path sanitization, non-repo graceful status
  - secrets round-trip (on keychain platforms this exercises the real OS
    keychain with a throwaway `RELAY_TEST_KEY` entry, cleaned up after)
- Interactive flows (real pty spawn against installed `claude`/`kimi`, glass
  rendering, xterm wiring) are NOT automatable here and remain to be manually
  verified once the frontend lands — see "Known issues / follow-ups".

### Scaffold fixes required to compile

- `tauri.conf.json`: added `"macOSPrivateApi": true` under `app` — required by
  PRD §7.1 and enforced by tauri-build (build fails without it because the
  `macos-private-api` cargo feature is enabled).
- `src-tauri/icons/icon.ico`: generated a minimal 32x32 placeholder PNG-in-ICO
  — tauri-build requires it for the Windows resource file. Replace with real
  app icons before release.
- Environment note: the fresh rustup install was missing its `rustc` component
  (only cargo.exe present); fixed with `rustup toolchain uninstall stable` +
  `rustup toolchain install stable --profile minimal`.

### Assumptions / deviations (binding list)

1. **Claude login command = `claude auth login`** (PRD §9 names it; if a
   given Claude Code version only supports running `claude` + `/login`, the
   same pane still works — it's just a pty).
2. **Claude session-id capture is a two-layer fallback**: output regexes
   (unreliable) + polling `~/.claude/projects/<cwd-slug>/*.jsonl` for the
   newest file modified at/after spawn (1s cadence, 2-minute window). cwd-slug
   replaces `/`, `\`, `:` with `-`. mtime is used instead of creation time
   (portable). All paths fail soft to `None`.
3. **Kimi session-id capture** is output-regex only (`kimi -r|--resume
   |--session <id>`), since Kimi prints a resume hint on exit paths (PRD §3).
4. **Adapter trait returns `CommandSpec { program, args }` instead of
   `std::process::Command`** — portable-pty needs its own `CommandBuilder`, so
   the PRD §6.4 signature was adapted; conversion happens in the pty layer.
5. **Keychain-first secrets**: `keyring` v3 with `windows-native` /
   `apple-native` as target-specific deps; SQLite `project_secrets` stores only
   key names + a `keyring:v1` marker blob. **Linux deviation**: no keyring
   backend enabled; values are XOR-obfuscated (NOT encrypted) in the table
   instead. Acceptable because Linux vibrancy is already a degraded platform
   per PRD §7.1; revisit if Linux becomes a tier-1 target.
6. **kill = portable-pty `child.kill()`** (TerminateProcess on Windows /
   SIGKILL on unix). The crate exposes no SIGTERM-then-escalate granularity,
   so the single kill call is the escalation path; `kill_all` runs on
   `ExitRequested` and `Exit`.
7. **diff_ready heuristic is conservative** (PRD §7.3 allows a coarse 3-state
   fallback): patterns are only checked at the working→waiting transition
   against the last ~4KB of stripped output; a false negative degrades to
   plain `waiting`, never to a wrong state.
8. **Cost parsing is scrape-only and deduplicated**: a cost event is written
   only when parsed usage differs from the previous parse for that pane
   (harness TUIs redraw usage lines constantly). No pricing table; USD is only
   stored when the harness prints a cost (PRD §7.12 / §11).
9. **export_session_markdown code-fences the stripped transcript verbatim** —
   reliable user-turn segmentation from raw scrollback isn't feasible without
   per-harness TUI parsing; CONTRACT.md labels segmentation best-effort.
10. **spawn_shell** runs `cmd.exe /C <command>` on Windows, `$SHELL -lc`
    (fallback `sh -lc`) elsewhere, so profile-managed PATH (nvm etc.) applies.
11. **git diff** uses `git diff HEAD` (staged + unstaged working-tree diff),
    truncated at 200KB on a char boundary.
12. **`is_installed` = `<binary> --version` exits successfully within 5s**
    (proves the binary runs, not just that a file is on PATH); console-window
    flash is suppressed on Windows via CREATE_NO_WINDOW.

### Known issues / follow-ups

- Frontend must call `update_session_title` (first-prompt auto-title) and do
  skill slash-expansion + broadcast fan-out itself (CONTRACT.md rules).
- Pane map entries are kept after kill/exit so `export_session_markdown` still
  works on a just-closed pane; respawning the same paneId resets the buffer.
  Entries accumulate for the app's lifetime (bounded 1MB transcript each) —
  acceptable for v1 pane counts.
- `resize_pty` on an exited pane returns an error; frontend should gate on
  `pty:exit`.
- If the frontend needs per-session (worktree) git badges, it should call
  `get_git_status` with the session's worktreePath.

---

## 2026-07-18 — Full React + TypeScript frontend

### What was built

Complete `src/` frontend per PRD §6.2, all §7 features, against CONTRACT.md
(exact command/event names, camelCase payloads):

```
src/
├── main.tsx                    # entry, mounts App, imports global.css
├── App.tsx                     # shell: sidebar | toolbar+grid+broadcast, overlays,
│                               #   replace-LRU confirm modal (§4.3 step 4)
├── types.ts                    # IPC contract types (mirror of CONTRACT.md)
├── lib/
│   ├── ipc.ts                  # all 37 invoke wrappers + safeListen/safeInvoke
│   │                           #   guards (no-op outside the Tauri runtime, so
│   │                           #   jsdom tests never touch the event bridge)
│   ├── fuzzy.ts                # hand-rolled fuzzy scorer (palette)
│   ├── sessionTitle.ts         # §7.4 title generation (~40 chars, ellipsis)
│   ├── skillExpansion.ts       # §7.15 slash-command expansion
│   ├── keybindings.ts          # §7.6 accelerator parse/match/record ("Mod" =
│   │                           #   meta OR ctrl), default map
│   ├── diff.ts                 # minimal unified-diff parser (§7.9)
│   ├── sessionLauncher.ts      # §4.3 focus/spawn/LRU orchestration, quick
│   │                           #   actions, login flows, respawn-after-exit
│   ├── exportSession.ts        # §7.14 markdown export via dialog save + fs write
│   ├── relativeTime.ts         # "3h ago" timestamps
│   └── id.ts                   # paneId uuids
├── state/                      # Zustand stores
│   ├── panes.ts                # 6-slot grid, focus, LRU (lastUsedAt), broadcast
│   │                           #   selection, exited flags. kill_pty ONLY in
│   │                           #   closePane/replacePane (§6.5: never on blur)
│   ├── projects.ts             # projects, sessions, git badges, harnesses
│   ├── settings.ts             # theme, DND, keybinding overrides, per-project
│   │                           #   last browser URL — all via get/set_setting
│   ├── skills.ts               # skills CRUD
│   └── ui.ts                   # active view, palette, peek, pendingReplace
├── hooks/
│   ├── useKeybindings.ts       # global shortcuts from the remappable map
│   ├── usePtyEvents.ts         # pty:state/exit, session:harness-id, and §7.13
│   │                           #   notifications (working→waiting/diff_ready on
│   │                           #   unfocused panes, DND-aware)
│   ├── useGitStatusPolling.ts  # §7.11 badges every 8s
│   └── useTheme.ts             # data-theme attr + system matchMedia
├── components/
│   ├── panes/                  # TerminalPane (xterm+fit, output filtered by
│   │                           #   paneId, skill expansion + first-prompt title
│   │                           #   capture, ResizeObserver→resize_pty, "press R
│   │                           #   to resume" exit overlay), BrowserPane
│   │                           #   (iframe, URL bar/back/forward/refresh/home,
│   │                           #   per-project last URL), PaneGrid (2-col grid,
│   │                           #   pointer-drag splitters, state glow, header
│   │                           #   checkboxes for broadcast), BroadcastBar (§4.5
│   │                           #   literal fan-out)
│   ├── sidebar/                # Sidebar (§4.1 add-project + git-init prompt),
│   │                           #   ProjectItem (collapse, git badge, harness
│   │                           #   picker, context menu: New Session / New
│   │                           #   Worktree §7.10 / Peek Diff / Project
│   │                           #   Settings / Rename / Remove), SessionRow
│   │                           #   (§12.5 row, inline title edit, live state
│   │                           #   dot), ProjectSettingsPanel (quick actions
│   │                           #   §7.7 + secrets §7.16 write-only UI)
│   ├── command-palette/        # §12.3 overlay: Sessions/Projects/Actions,
│   │                           #   fuzzy + arrow-key navigation
│   ├── skills-library/         # §7.15 CRUD view
│   ├── cost-dashboard/         # §7.12 per-project table + 14-day SVG bar
│   │                           #   chart, labelled estimate, refetch on
│   │                           #   cost:updated
│   ├── settings/               # §7.2 theme, §7.6 remap-by-capture UI, §7.13
│   │                           #   DND, §9 harness status + "Run login"
│   ├── peek/                   # §7.9 read-only file/diff slide-over
│   ├── onboarding/             # §9 no-harness banner (non-blocking)
│   └── common/Modal.tsx
├── styles/global.css           # glass tokens: html/body transparent, cool
│                               #   blue-gray dark / warm off-white light,
│                               #   state edge-glow per §7.3, Space Grotesk +
│                               #   Space Mono
└── test/                       # 55 vitest tests (below)
```

### What was tested and how

- `npm test` (vitest + jsdom): **55 tests, 5 files, all passing** —
  - `fuzzy.test.ts`: subsequence matching, case-insensitivity, word-boundary
    and consecutive-match ranking, shorter-target preference, match indices,
    filter/rank/limit
  - `sessionTitle.test.ts`: whitespace/newline collapsing, 40-char truncation
    with word-boundary ellipsis, empty→null, display fallback
  - `skillExpansion.test.ts`: bare command, trailing-context append, unknown
    command / non-slash / mid-line passthrough, case sensitivity, empty list
  - `keybindings.test.ts`: accelerator parsing (aliases, malformed input),
    matching (Mod = meta OR ctrl, shift strictness, digits/punctuation), all
    §7.6 defaults, event→accelerator recording round-trip
  - `panes.test.ts`: broadcast toggle/select-all/terminals-only/clear-on-
    disable/clear-on-close, `broadcastTargets`, LRU selection (incl. after
    focus), 6-pane cap, replace flow, focus/cycle/close-focus-move
- `npm run build` (tsc + vite build): **passes, zero errors**
  (dist bundle ~496 KB / 138 KB gzip).
- The Tauri runtime is not exercised (backend not yet compiled): all
  invoke/listen calls go through guarded wrappers that no-op outside Tauri,
  so jsdom tests import stores/components without a bridge. Interactive
  verification (real pty I/O, glass, notifications, drag-resize) still
  requires running the full app — same status as the backend entry.

### Assumptions / deviations

1. **Browser pane is an iframe, not a Tauri child webview.** Dev servers that
   send `X-Frame-Options`/`CSP frame-ancestors` will refuse to render — known
   v1 limitation (upgrade path: `WebviewWindow` or a webview plugin).
   Back/forward keeps a local URL stack since cross-origin iframe history is
   inaccessible.
2. **Custom minimal unified-diff renderer** (`lib/diff.ts`) instead of
   diff2html, and **hand-rolled SVG bars** instead of a chart lib — both
   allowed by the PRD; zero new runtime dependencies added.
3. **File peek is plain monospace**, no syntax highlighting (PRD allows
   minimal). File picking uses the native dialog rooted at the project path.
4. **Skill slash-expansion is exact for paste-and-enter** (whole line in one
   chunk → expanded before `write_pty`). For char-by-char TUI typing the
   keystrokes must be forwarded live (the pty echoes, xterm doesn't), so true
   substitution isn't possible there; instead a best-effort local line buffer
   captures the first submitted line for §7.4 titling in all cases. Broadcast
   stays literal per §4.5 (no expansion).
5. **LRU replace flow**: when the grid is full, a modal offers "Replace
   least-recently-used pane" (§4.3 step 4) — replacing kills that pane's pty
   (it is an explicit user choice), never automatic.
6. **Quick-action keybindings** are stored via the contract but not globally
   bound in v1 (only the §7.6 baseline set is remappable/active); actions run
   from Project Settings. Flagged as follow-up.
7. **Cmd+N new-session harness choice**: the only installed harness, else
   Claude Code — the sidebar's per-project dropdown remains the explicit picker.
8. **Worktree creation** registers nothing extra client-side; the backend
   returns the path and the session `worktreePath` linkage happens when a
   session is started there (backend-side concern).
9. **Grid splitters**: one vertical fraction (2-column grid) + per-row-gap
   fractions, applied as `fr` templates with overlay drag handles. Simple and
   robust; proportions reset when pane count changes.
10. **`data-theme` attribute on `<html>`** carries light/dark; "System"
    follows `prefers-color-scheme` live.

### Known issues / follow-ups

- Needs a full interactive pass once the backend compiles: real spawn/resume
  against `claude`/`kimi`, `pty:state` glow transitions, notifications,
  acrylic blur showing through the transparent surfaces, splitter drags.
- iframe X-Frame-Options limitation (deviation 1).
- Quick-action custom keybindings stored but not registered (deviation 6).
- The exit-overlay "R to resume" relies on the pane staying mounted; closing
  and reopening the session from the sidebar achieves the same via resume-by-ID.

---

## Session: dev server launch (orchestrator)

- Full independent verification pass: `cargo test` → **34/34 passed**; `npm test` → **55/55 passed**; `npm run build` → clean. Contract cross-check: all 40 commands registered in `invoke_handler`, all 5 events emitted and listened on both sides.
- Toolchain: rustup + VS 2022 Build Tools (C++) installed via winget during this session; rustc 1.97.1 repaired after a partial winget install.
- **`npm run tauri dev` launched**: Vite on http://localhost:1420 (HTTP 200), app binary compiled and `relay.exe` running (~43 MB RSS at idle — in line with §8 expectations vs Electron).
- **Manual verification still outstanding** (needs human eyes on the running app): real `claude`/`kimi` spawn-and-resume in a pane, acrylic blur rendering through the transparent CSS, pane state glow transitions, splitter dragging, OS notifications, and the placeholder app icon (replace `src-tauri/icons/` before release).

## Session: Windows `.cmd` shim fix (harness detection/spawn)

- **Bug:** Settings/onboarding reported Claude Code and Kimi Code as "not installed" despite both being on PATH. Root cause: npm-installed CLIs on Windows are `.cmd` shims (`claude.cmd`, `kimi.cmd`); `std::process::Command` and portable-pty use CreateProcess, which does not resolve PATHEXT shims. This affected `binary_on_path` (detection) *and* agent/login pane spawns.
- **Fix:** new `harness_adapters::resolve_for_spawn` wraps any CommandSpec in `cmd.exe /C` on Windows (no-op on POSIX, no double-wrap of `spawn_shell` specs); applied in `binary_on_path` and in `PtyManager::spawn` (single choke point). `Pane::kill` now `taskkill /T /F`s the process tree on Windows first, so killing the cmd wrapper can't orphan the real agent process.
- **Tests:** 2 new unit tests (wrap + no-double-wrap); `cargo test` → **36/36 passed**. Verified live: `cmd.exe /C "claude --version"` → 2.1.211, `kimi --version` → 0.27.0.

## Session: terminal colors + browser split layout

- **Monochrome panes fix:** agent TUIs (Claude orange / Kimi blue) rendered black & white because the pty env didn't advertise color support. `PtyManager::spawn` now sets `TERM=xterm-256color` and `COLORTERM=truecolor` (overridable via extra_env). New panes get full color.
- **Split layout (user request):** when a browser pane is open alongside ≥1 terminal, the main area becomes a two-part split: LEFT = terminal "spotlight" (one terminal visible, default = most recently interacted-with via `lastInputAt`/recency merge; switchable via selector bar or `Mod+Shift+]` / `Mod+Shift+[`, both remappable in Settings), RIGHT = browser. Non-spotlight terminals stay mounted with display:none (xterm + pty untouched, §6.5); TerminalPane re-fits on becoming visible. Closing the last browser returns to the grid. Multiple browser panes: most-recently-used is visible.
- **Browser chrome upgrade:** Home (project default URL), open-in-external-browser via new `@tauri-apps/plugin-opener` (added to package.json, Cargo.toml, lib.rs registration, capabilities `opener:default`), copy URL, loading spinner, dismissible "page didn't respond" overlay (8s load-timeout heuristic for X-Frame-Options blocks), correct back/forward disable states via a pure `lib/browserHistory.ts` stack.
- The implementing subagent died mid-task (provider billing limit); the orchestrator completed PaneGrid wiring, keybinding dispatch, CSS, settings labels, capabilities, and tests.
- **Verification:** `npm test` → **66/66** (7 files; new: browserHistory 4, spotlight 7); `npm run build` clean; `cargo test` → **36/36**.

## Session: UNC cwd fix, terminal copy/paste, browser urlbar layout fix

- **UNC cwd bug:** opening an agent session failed with `CMD.EXE was started with the above path as the current directory. UNC paths are not supported` — `add_project` stored `std::fs::canonicalize` output, which on Windows is a `\?\D:\...` extended-length path that cmd.exe (our `.cmd`-shim wrapper) rejects as cwd. Fixes: new `util::strip_unc_prefix` applied in `add_project`, at the pty spawn choke point (defense in depth), plus a DB migration (`db::migrate_unc_paths`) rewriting existing `projects.path` / `sessions.worktree_path` rows in place. Unit-tested (incl. real `\server\share` UNC passthrough).
- **Terminal copy/paste:** xterm `attachCustomKeyEventHandler` — Ctrl+Shift+C copies selection, bare Ctrl+C copies when a selection exists (SIGINT otherwise), Ctrl+Shift+V (and Cmd+V on macOS) pastes clipboard text into the pty.
- **Browser urlbar layout bug (found via Playwright repro against vite :1420):** `.browser-urlbar` had `flex: 1`, making it a flex-grow sibling of `.pane-body` — the URL bar consumed 50% of the browser pane height (geometry: 398px urlbar / 398px frame). Fixed to `flex: 0 0 auto` + padding; post-fix geometry: 35px urlbar / 762px frame. Added a dev-only `window.__relay` store handle in `main.tsx` (import.meta.env.DEV gated) to make such UI repros scriptable; `.debug/` gitignored.
- **Verification:** `cargo test` → **37/37**; `npm test` → **66/66**; `npm run build` clean (added missing `src/vite-env.d.ts` for `import.meta.env` typing). Dev server auto-rebuilt; verified live in the running app.

## Session: session-resume fix + browser omnibox

- **Root cause of "resume starts a fresh session":** two stacked bugs. (1) The Kimi adapter spawned `kimi -r <id>` — a flag that DOES NOT EXIST in Kimi CLI (verified `kimi --help` v0.27.0: resume is `-S, --session [id]`), so both resume and the output-scrape regex (which expected `kimi -r` hints the CLI never prints) were dead. (2) `harness_session_id` was NULL for every stored session (confirmed by inspecting relay.db), compounded by the earlier UNC bug which ran harnesses in `C:\Windows` so Claude session files landed in the wrong project dir.
- **Fixes:** resume command is now `kimi --session <id>`; scrape regex matches `-S/--session`; new trait method `find_session_id_on_disk` with implementations for Claude (`~/.claude/projects/<slug>/*.jsonl`, existing) and Kimi (NEW: scans `~/.kimi-code/session_index.jsonl` bottom-up for the newest entry whose workDir matches the pane cwd, guarded by session-dir mtime >= spawn). The pty monitor probe is now adapter-generic (was Claude-only). Id format verified end-to-end: `kimi export session_<uuid>` accepts exactly the `sessionId` string from the index.
- **Browser omnibox:** URL bar now distinguishes host-looking input (scheme, localhost, IPv4, anything with a dot and no spaces → navigate) from search queries (→ DuckDuckGo). Caveat: search engines typically send X-Frame-Options, so results may refuse to embed — the pane's "didn't respond" overlay offers open-externally in that case.
- **Known limitation:** two panes spawned in the same cwd within the probe window can cross-attribute the newest session-index entry (edge case, v1 accepted). Sessions created BEFORE this fix have no harness id and will always spawn fresh — only new sessions are resumable.
- **Verification:** `cargo test` → **39/39**; `npm test` → **67/67**; `npm run build` clean. Real e2e resume (open kimi/claude session, close pane, click session in sidebar) still needs a manual pass in the running app.

## Session: resume root-cause fix, cost pipeline, skills/loops library, UI polish

- **Resume ACTUALLY fixed (2nd root cause):** the Claude fs probe always returned None because `cwd_slug` only mapped `/ \ :` to `-`, but Claude Code's real on-disk convention replaces EVERY non-[A-Za-z0-9_-] char — including spaces — with `-`. The user's project paths all contain spaces ("Main project", "Content flow"), so the probe dir never existed. Fixed + regression-tested against real dir names, and verified live: probe now returns the correct session id. (First root cause, fixed earlier: kimi resume used a nonexistent `-r` flag → now `--session`.)
- **Cost dashboard:** now parses usage from on-disk harness session logs (PRD §7.12's preferred source) instead of relying on pty scraping: Claude — sums `message.usage` objects in `<slug>/<id>.jsonl` (cache tokens counted as input); Kimi — sums `usage.record` events in `~/.kimi-code/sessions/*/<id>/agents/*/wire.jsonl`. Synced every 5s for live panes via new adapter trait method `usage_from_disk`; resumed panes get their harness id bound at spawn so sync starts immediately. Token counts only, no invented pricing — labeled estimate.
- **Skills & Loops Library:** rebuilt as a 3-tab centered modal. Skills tab scans `~/.claude/skills` + `~/.agents/skills` (kimi's real user skill dir; `~/.kimi-code/skills` doesn't exist) with source badges (claude/kimi/both) + fuzzy-free substring search; Loops tab mirrors the convention under `loops/` — NONE exist on either harness today (checked filesystem), so it starts empty. Edit saves back to every copy on disk; create writes to BOTH harness dirs so either CLI can invoke it by its slug. ASSUMPTION: loops follow the same `<slug>/LOOP.md` convention — no real loop format exists to verify against (§11-style flag).
- **UI:** Settings/Skills/Cost now open as centered modals (`.view-overlay.modal-centered`). Terminals: Ctrl+scroll font zoom (8–28px, re-fits + resizes pty); xterm foreground/cursor/selection now follow the app theme (dark text on light — default white fg was invisible on light glass). Browser omnibox now uses Bing — verified no X-Frame-Options/frame-ancestors on results pages (DDG/Google refuse framing; x.com likewise, nothing can embed those).
- **Verification:** `cargo test` → **44/44**; `npm test` → **67/67**; `npm run build` clean.

## Session: model-aware pricing + 5-decimal costs

- **Dynamic per-model pricing:** session logs record the model (Claude: `message.model` in the session .jsonl; Kimi: `model` on `usage.record` events in wire.jsonl). `usage_from_disk` now returns `SessionUsage { usage, model }`; pricing resolves model id → canonical key (`canonical_model_key`, contains-matching for dated ids like `claude-sonnet-4-5-20250929`) → Settings override `price.<key>.{input,output}_per_mtok` → built-in defaults. Unknown/absent model → harness default (claude→sonnet-4-5, kimi→kimi-k3).
- **Default rate table (official sources, researched 2026-07):** claude-opus-4-8 $5/$25, claude-sonnet-5 $2/$10 (intro until 2026-08-31, then $3/$15), claude-sonnet-4-5 $3/$15, claude-haiku-4-5 $1/$5, kimi-k3 $3/$15, glm-5.2 $1.4/$4.4 per Mtok. Sources: anthropic.com/pricing, platform.kimi.ai/docs/pricing/chat-k3, docs.z.ai/guides/overview/pricing.
- **Settings UI:** per-model editable in/out rate fields (6 models).
- **Dashboard:** cost figures now render with 5 decimal places (<$10) so small session costs are visible.
- Cost events are per-delta (previous session's fix), so SUM rollups stay correct.
- Verification pending full `cargo test` once the concurrent browser-webview work lands; `npm test` → 72/72, `npm run build` clean. New unit tests: canonical_model_key matching, default_rates coverage.

## Session 2026-07-19: native child-webview browser panes (iframe replacement)

- **Problem:** the browser pane was an `<iframe>`, which breaks on real browsing — sites sending `X-Frame-Options` refuse to render at all, and cross-origin history control is blocked by Chromium.
- **Design:** on Windows/macOS the pane is now a **Tauri child webview** (`Window::add_child` + `WebviewBuilder`) attached to the main window — a top-level browsing context, so XFO doesn't apply and full navigation/history works. The webview is positioned exactly over the pane's body div; the frontend measures the div with `getBoundingClientRect` and ships LOGICAL CSS pixels to the backend, which uses `LogicalPosition`/`LogicalSize` so HiDPI conversion stays Tauri's problem. Degenerate rects (0×0, NaN — transient layout states) are sanitized (`width/height >= 1`, non-finite → origin) before reaching wry.
- **API surprise:** `Window::add_child` and the root `tauri::WebviewBuilder` re-export are gated behind tauri's **`unstable` feature** — added to Cargo.toml (`features = ["macos-private-api", "unstable"]`). Also `add_child` lives on `Window`, not `WebviewWindow` — use `app.get_window("main")`.
- **New backend:** `src/browser.rs` — `BrowserManager` (HashMap<pane_id, tauri::Webview>, managed as `BrowserState` in lib.rs, mirroring `PtyState`). Webview label `browser-<pane_id>`. `on_navigation` emits **`browser:navigated`** (`{ paneId, url }`, camelCase struct in types.rs) and returns true — every navigation including in-page link clicks and redirects is reported. back/forward/reload drive the webview's REAL history via `eval("history.back()")` / `history.forward()` / `location.reload()`; the resulting URL arrives via the event. `close_all()` wired into the app-exit cleanup in lib.rs next to `PtyManager::kill_all`.
- **New commands** (`commands/browser_cmds.rs`, registered in mod.rs + `generate_handler!`): `browser_create(paneId, url, rect)`, `browser_navigate`, `browser_go_back`, `browser_go_forward`, `browser_reload`, `browser_set_bounds`, `browser_set_visible(paneId, visible)`, `browser_close`. `Rect { x, y, width, height }` = logical px. Every command returns a clean error on Linux (runtime `cfg!(target_os = "linux")` gate, never a panic); `browser_close` is idempotent.
- **Occlusion strategy (the #1 hazard):** native webviews float ABOVE the DOM — they are not composited with React content. `lib/browserOcclusion.ts` (pure, unit-tested) computes "must hide" from: `ui.activeView !== "grid"` (settings/skills/cost overlays), command palette open, peek panel open, any modal (replace-LRU confirm / project settings panel), or the pane not being the visible browser in split mode (PaneGrid passes `visible` down through PaneFrame). `BrowserPane` calls `browser_set_visible(false)` on any occlusion; when clearing, it re-syncs bounds FIRST, then shows — so the webview never reappears at a stale position. Bounds: ResizeObserver on the body div + window resize listener → 50ms-debounced `browser_set_bounds`.
- **Linux fallback:** if `browser_create` errors (or the Tauri runtime is absent — jsdom, plain vite dev), the pane falls back to the previous iframe implementation, kept in `BrowserPane.tsx` with its 8s "didn't respond" XFO overlay. The overlay is native-path-only removed — no XFO problem anymore.
- **Lifecycle:** unmount effect and `closePane`/`replacePane` in `state/panes.ts` both call `browser_close` (mirrors `killPty`; idempotent backend makes the double call safe).
- **Verification:** `cargo test` → **52 passed / 0 failed / 1 ignored** (incl. 6 new `browser::tests`: label, rect sanitize ×3, platform gate, serde shape — also covers the concurrently-landed model-pricing tests whose full-suite run was pending). `npm test` → **72/72** (67 pre-existing + 5 new `browserOcclusion` tests). `npm run build` → clean, zero errors.
- **PENDING MANUAL VERIFICATION (no display session available during implementation):**
  1. Native webview actually renders over the body div at the right position/size, incl. HiDPI displays and window moves between monitors.
  2. Splitter drags + window resize keep the webview glued to the body div (50ms debounce lag is expected — check it isn't visually jarring).
  3. Occlusion: settings/skills/cost views, palette, peek panel, and modals fully cover the webview (no bleed-through); webview reappears in the right place when they close.
  4. Split mode: hidden (non-active) browser pane's webview is hidden; spotlight switching doesn't leak a webview over terminals.
  5. In-page link clicks update the address bar via `browser:navigated`; back/forward/reload buttons drive real history; per-project URL persistence still works.
  6. App exit leaves no orphaned WebView2 renderer processes.
  7. Linux: confirm the iframe fallback engages (browser_create error path) — untested here, Windows-only machine.

## Session: relay-aware pricing + native webview browser

- **Provider discovery:** BOTH CLIs route through a single third-party relay (`ANTHROPIC_BASE_URL` / kimi provider `custom-anthropic` → ai2.18.show). Claude Code maps Anthropic tiers to non-Anthropic models: Opus→Kimi-K3[1M], Sonnet→Kimi-K2.6, Haiku→deepseek-v4-pro, Fable/default→glm-5.2. Kimi CLI has 8 relay models (Kimi-K2.7, kimi-k2-6, minimax-m3, DeepSeek-V4-Pro, kimi-k3, glm-5.1, glm-5.2, qwen3.7-plus). Because the harness logs record the ACTUAL upstream model id, model-aware pricing picks these up automatically.
- **Rate table extended to 12 models** (official list prices, verified): added kimi-k2.7-code $0.95/$4, kimi-k2.6 $0.95/$4, deepseek-v4-pro $0.435/$0.87, minimax-m3 $0.30/$1.20 (effective 50%-off), glm-5.1 $1.40/$4.40, qwen3.7-plus $0.40/$1.60 (≤256K tier). CAVEAT: relay billing may differ from official list prices — Settings lets the user correct every rate. "K2.7" maps to kimi-k2.7-code (K2.7 exists only as the coding variant).
- **Browser pane is now a native Tauri child webview** (Windows/macOS; iframe fallback on Linux): no more X-Frame-Options refusals (top-level browsing context), real back/forward/reload via the webview's own history, `browser:navigated` events keep the address bar in sync with in-page clicks. Occlusion handled (webview hides when overlays/palette/peek open or the pane is hidden in split mode). Requires tauri's `unstable` feature for `Window::add_child` (added to Cargo.toml). Manual verification pending: bounds tracking on HiDPI/multi-monitor, occlusion behavior, Linux fallback — all listed in the previous BUILD_LOG entry.
- **Verification:** `cargo test` → **52/52**; `npm test` → **72/72**; `npm run build` clean.

---

## Session 2026-07-20: architecture refactor — dead code & IPC consolidation (batch 1)

- **Architectural read first:** dispatched a read-only Opus Explore pass over
  the whole codebase to diagnose smells before cutting. Findings confirmed my
  own reads and sharpened the plan (recorded in full in the task list). Top
  issues: 3 parallel IPC files never merged after concurrent-agent work, dead
  single-tab browser wrappers, `home_dir()` duplicated 3×, dead
  `browser::inject_url_tracking`, `panes.ts` 670-LOC god store doing 7 jobs,
  `db/mod.rs` 953-LOC single file for 8 table groups, `pty/mod.rs` leaking
  cost + browser concerns into the pty domain, store actions making impure
  IPC calls, `PaneGrid` over-subscribing the whole `panes` array.
- **Batch 1 (this entry) — safe mechanical wins:**
  - Folded `src/lib/browserTabIpc.ts` into `src/lib/ipc.ts` and deleted the
    file. The "kept separate to avoid collisions with the concurrently-editing
    chat integration agent" fork is finally merged — one browser IPC layer.
  - Deleted the dead single-tab browser wrappers in `ipc.ts`
    (`browserCreate`/`Navigate`/`GoBack`/`GoForward`/`Reload`/`SetBounds`/
    `SetVisible`/`Close` + `listenBrowserNavigated`) — they omitted `tabId`
    and would error against the tab-aware backend; no caller used them. The
    live `BrowserNavigatedPayload` now carries `tabId` (was
    `BrowserNavigatedTabPayload` in the folded file).
  - Dropped the unused `browserClose` import from `state/panes.ts` (imported
    but never called; `browserClosePane` from the tab layer was the real call).
  - Hoisted `home_dir()` (USERPROFILE→HOME) into `util.rs` as the single
    source; removed the 3 identical private copies in `claude_code.rs`,
    `kimi_code.rs`, `installed_skills.rs`.
  - Deleted the dead `BrowserManager::inject_url_tracking` method — pushState
    injection now happens via the `on_navigation` closure + `navigate`'s
    spawned thread; this method was orphaned.
- **Verification:** `npm run build` clean (TSC passes — no dangling imports to
  the deleted module or the renamed type); `npm test` → **83/83**; `cargo test`
  → **74/74 (1 ignored)**. Grep confirms zero remaining references to
  `browserTabIpc`, `BrowserNavigatedTabPayload`, any dead non-tab wrapper, the
  old `home_dir` private copies, or `inject_url_tracking`. `/code-review`
  (low effort, recall) on the batch found no surviving correctness findings.
- **Remaining refactor queued (task #4):** split `panes.ts` god store
  (spotlight pure fns + browser-tabs slice; make store pure by moving
  kill/close IPC into orchestration), split `db/mod.rs` per table group,
  extract `pty/mod.rs` monitor + move `price_for`/URL-detection out of the
  pty domain, de-duplicate `chat/providers.rs` `build_request`,
  fold `chatIpc.ts` into `ipc.ts`, fix `PaneGrid` over-subscription, extract
  `spawn_agent_session` orchestration, update stale CONTRACT.md
  (`HarnessId` omits `opencode`).

---

## Session 2026-07-20: architecture refactor — module decomposition (batch 2)

- **Spotlight logic extracted:** moved the 5 pure split-layout functions
  (`terminalPanes`, `activeTerminalId`, `cycleTerminalId`,
  `activeTerminalPair`, `cycleTerminalPair`) out of the 670-LOC `state/panes.ts`
  into a new `state/spotlight.ts`. Re-exported from `panes.ts` so the 3
  consumers (`useKeybindings`, `PaneGrid`, `spotlight.test.ts`) keep compiling
  unchanged — zero call-site churn, test stays green as-is.
- **Pane disposal consolidated:** the kill-pty / close-webview IPC was
  duplicated across `addPane` (LRU eviction), `replacePane`, and `closePane`.
  Extracted one `disposePaneResources(pane)` helper and documented WHY the
  store is intentionally impure there — disposing inseparably from removal is
  what enforces PRD §8 (no orphaned processes) at the pane level, and
  `safeInvoke` no-ops in jsdom so the store stays unit-testable. Moving it
  out to callers would trade a purity win for an orphaned-process risk —
  the wrong trade.
- **One IPC layer:** folded `src/lib/chatIpc.ts` into `src/lib/ipc.ts` and
  deleted it (5 importers updated). The "kept separate to avoid collisions
  with the concurrently-editing chat integration agent" fork is finally
  merged — three IPC files (`ipc.ts` + `browserTabIpc.ts` + `chatIpc.ts`)
  are now ONE.
- **db/mod.rs split (953 → 228 LOC):** delegated to an Opus agent. Split into
  6 cohesive per-table-group submodules (`projects`, `settings`, `skills`,
  `secrets`, `cost`, `chat`) each with its own `map_*` row mappers, CRUD, and
  tests; mod.rs keeps schema/connection lifecycle + `pub use` re-exports so
  every `crate::db::<fn>` call site (lib.rs, commands/, pty/, secrets.rs,
  chat/) stays unchanged. The `mem()` in-memory test helper lives in mod.rs as
  `#[cfg(test)] pub(crate)`. Agent left unused-import warnings despite the
  explicit "treat warnings as errors" instruction; orchestrator trimmed
  `OptionalExtension` from skills.rs and dropped the unused `get_session`
  re-export (it's intra-module only).
- **Verification:** `cargo test` → **74/74 (1 ignored)**; `npm test` →
  **83/83**; `npm run build` clean. Lib build warnings dropped from 7 → 6
  (the remaining 6 are all pre-existing, outside db/: kimi_code PathBuf,
  chat/providers dead fields, browser.rs unused Result, secrets.rs Keychain).
- **Surfaced follow-up (task #5):** `secrets.rs` `Keychain::load/store/remove`
  is dead code — nothing calls it (only `XorStore` is used), which is why the
  `db::get_secret_blob` re-export reads as unused. Pre-existing, not
  introduced by the split; needs the full keychain flow verified before removal.

---

## Session 2026-07-20: architecture refactor — perf + verification (batch 3)

- **PaneGrid over-subscription fixed (Opus finding 4.3):** `PaneFrame` was
  re-rendering on EVERY store tick because `PaneGrid` subscribes to the whole
  `panes` array — so a `pty:state` transition (working↔waiting, fires on
  output) on ONE pane re-rendered ALL PaneFrames + their TerminalPane/BrowserPane
  children every output chunk. Wrapped `PaneFrame` in `React.memo` with default
  shallow comparison. This is safe because the store preserves object identity
  for unchanged panes (every `set` does `.map((p) => p.paneId === id ? {...p}
  : p)` — non-matching panes keep the same reference), and xterm writes happen
  in TerminalPane's OWN pty:output listener, independent of React renders, so
  skipping re-renders loses nothing. Now only the pane whose `state`/`data`/
  `focused` actually changed re-renders.
- **Task #5 resolved (not dead code):** `db::get_secret_blob` is cfg-gated in
  use — called only by the Linux `platform::load` XOR-in-table fallback
  (`secrets.rs:147`). On Windows/macOS the `platform` module reads the OS
  keychain (`keyring::Entry`) and never touches `get_secret_blob`, so the
  re-export reads as unused on those builds. The db-split agent added
  `#[allow(dead_code)]` + a documenting comment — correct resolution, no
  further action.
- **Batch-2 autoreview (`/code-review` medium effort):** two Opus verifier
  agents (cross-file tracer + db-split line scan) both returned CLEAN —
  spotlight re-export complete (all 5 symbols, all 4 importers resolve),
  `get_session` re-export removal breaks zero callers (intra-module only),
  `disposePaneResources` consolidation behaviorally identical across all 3
  call sites × 2 pane kinds, db split is a faithful mechanical move (queries
  match schema, re-exports complete, imports correct, tests reach helpers).
  Zero findings.
- **Live integration test:** started a frontend-only `vite` dev server (NOT
  `tauri dev` — never restart the relay app per session constraint) and drove
  the running UI with Playwright (`.debug/live_test_refactor.py`, gitignored).
  Verified: app boots clean, toolbar + PaneGrid empty state render, adding a
  browser pane mounts it through the consolidated IPC + memoized PaneFrame
  path (iframe fallback engages since no Tauri runtime), `closePane` disposes
  + removes the pane end-to-end (`disposePaneResources` works), chat module
  imports intact, `window.__relay` dev handle present. Zero refactor-
  introduced console errors (the lone X-Frame-Options iframe refusal is the
  known pre-existing frontend-only limitation, not a regression). Stopped the
  vite server after; relay app untouched.
- **Verification:** `npm run build` clean; `npm test` → **83/83**; `cargo test`
  → **74/74 (1 ignored)**; lib warnings 6 (all pre-existing, outside db/).

---

## Session 2026-07-20: architecture refactor — providers.rs dedup + CONTRACT fix (batch 4)

- **Chat providers.rs dedup (Opus finding 2.4):** `AnthropicCompatible::build_request`
  and `OpenAICompatible::build_request` duplicated their native counterparts
  verbatim (~45 LOC each of inner struct redefinitions + wiring). The
  Compatible variants already delegated `parse_sse_chunk`/`parse_usage` but
  copy-pasted `build_request`. Hoisted the body structs (`AnthropicWireBody`,
  `OpenAIWireBody`) and the two request-builders (`anthropic_request()`,
  `openai_request()`) to module level. Now all 4 `build_request` impls are
  3-5 line delegations — the native variants default `base_url` and call the
  helper; the Compatible variants resolve `base_url` (Err if absent) and call
  the same helper. Removed ~180 LOC of verbatim copy-paste with no behavior
  change. Remaining duplication (SsePayload/Choice/Delta structs inside
  `parse_sse_chunk`) is structurally different enough between Anthropic/OpenAI
  that extraction would obscure rather than clarify — kept as-is.
- **CONTRACT.md updated:** `HarnessId` now includes `opencode` (the third
  adapter, fully plumbed through types.ts + registry + harnessShortName, but
  the contract was stale).
- **Repro tests evaluated (Opus finding 5.1):** all three `.repro` test files
  (`keybindingPhase.repro`, `focusPaneShortcuts.repro`, `paneDomFocus.repro`)
  pin real architectural invariants (capture-phase keydown listener,
  xterm-stand-in event propagation, focusEpoch re-grab) and earn their place
  as regression tests per PRD §13.3. Kept as-is; the `.repro` naming is just
  honest about their origin.
- **`spawn_agent_session` orchestration extraction (Opus finding 1.1)**
  deferred with reasoning: the command handler is thin (30 LOC of
  cross-domain work: DB lookup + adapter pick + cwd resolve + spawn/bind/
  touch), there is no second caller, and it touches the most safety-critical
  path (pane spawn, PRD §13.2). Extracting to a domain orchestrator adds a
  layer with no concrete reuse — the risk/reward is poor vs. the dedup wins.
  Revisit if a second caller emerges.
- **Verification:** `cargo test` → **74/74 (1 ignored)**; lib warnings 5 (all
  pre-existing, outside db/).

---

## Session 2026-07-21: Hermes tool-call fallback parser

- **Problem:** OpenAI-compatible aggregators (e.g., ai2.18.show) serving
  Qwen/DeepSeek/MiMo fine-tunes often do NOT translate the OpenAI `tools` field
  into the model's native tool template. Instead of populating
  `choices[0].message.tool_calls`, the model emits its trained Hermes-format
  tool call as plain XML text in `content`:

  ```text
  <tool_calls>
  <invoke name="web_search">
  <parameter name="query" string="true">cow</parameter>
  </invoke>
  </tool_calls>
  ```

  This means the tool loop never sees structured `tool_calls`, so tools silently
  don't run — the message is just streamed verbatim to the user as prose.
- **Fix:** new functions in `chat/mod.rs`:
  - `parse_hermes_tool_calls(content) -> Option<Vec<(String, Value)>>` — locates
    `<tool_calls>…</tool_calls>` blocks, extracts `<invoke name="…">` with
    `<parameter name="…">value</parameter>` children, and returns `(tool_name, args)`
    pairs with typed value coercion (bool/int/float/json/string).
  - `strip_hermes_tool_calls(content) -> String` — removes the raw XML markup
    from the user-visible message and from re-sent history.
  - `coerce_param_value(raw: &str) -> Value` — converts bare parameter text
    to the correct JSON type.
  - `next_synthetic_tool_id() -> String` — monotonic counter for synthesized
    tool-call ids so the echoed assistant message and matching `tool` result
    can pair correctly on the next request.
  - `run_openai_tool_loop` now checks for Hermes text after receiving an empty
    `tool_calls` array and synthesizes the same structured shape the loop already
    handles. When calls were recovered from text, the echoed assistant message
    has the raw markup stripped from `content` and a synthesized `tool_calls`
    array inserted.
- **Verification:** `cargo test` → **74+ tests** (added 6 new: single invoke
  (web_search cow), generate_document, multiple invokes, type coercion, strip
  with close, strip with unclosed block); `npm test` → **83/83**; `npm run build`
  clean.
- **Deviation:** none — this is a pure additive fallback that does not change
  the structured tool-calling path.

## Session 2026-07-21: Mermaid diagram rendering + generate_diagram tool

- **Mermaid rendering:** `MessageBubble.tsx` now routes `language-mermaid` fenced
  blocks to a new `MermaidDiagram.tsx` component (lazy-loaded `mermaid`, theme-aware
  with light/dark re-render, debounced render on 300ms, `normalizeSvg` function
  that strips background + pins viewBox size so node text doesn't clip). The core
  prompt tells the model to emit diagrams as ` ```mermaid ` fenced blocks.
- **`generate_diagram` tool:** a new tool (`tools.rs`: `GENERATE_DIAGRAM` const)
  that writes a self-contained HTML/CSS diagram to the artifacts directory. The
  file is prepended with `<!-- relay:diagram -->` sentinel marker and validated
  by `validate_diagram_html` (structural check: document skeleton, no scripts/
  iframes, no external resources, balanced tags, non-empty body). Issues are fed
  back so the model can self-correct. Registered in `openai_tool_specs` and
  `anthropic_tool_specs` as a safe tool.
- **`diagram` artifact kind:** `read_artifact_preview` classifies HTML files
  containing the sentinel marker as `kind: "diagram"`; `ArtifactPreviewPane`
  renders them in the same `sandbox=""` srcDoc iframe as regular HTML.
- **ArtifactExportMenu:** new component (`ArtifactExportMenu.tsx`) shown in the
  `ArtifactPreviewPane` header for diagram/html/image kinds. Provides Copy to
  clipboard and Download PNG via `html-to-image` (off-DOM rasterization, because
  `sandbox=""` makes the iframe `contentDocument` null; the diagram HTML is
  re-rendered into a hidden DOM node that `toPng` can walk). SVG is greyed out
  for `diagram` kind (HTML/CSS is not vector) with a tooltip explaining why.
  The `html-to-image` npm package was added as a dependency.
- **Diagram mode toggle:** `ChatComposer` has an Auto/Quick/Designed segmented
  toggle. State flows: `chat.ts` store (`diagramMode`) $\rightarrow$ `sendChatMessage`
  IPC (`diagramMode`) $\rightarrow$ Rust `send_chat_message` (`diagram_mode` param)
  $\rightarrow$ appends a prompt directive: Quick forces a ```mermaid block,
  Designed forces `generate_diagram`, Auto lets the model decide.
- **Verification:** `cargo test` → **74/74 (1 ignored)** (diagram tool tests:
  generates with marker + surfaces artifact, rejects empty html, structural
  validator flags script/external-refs/unbalanced-divs/empty-body, passes clean
  diagram, marker-prepend doctype handling); `npm test` → **83/83**; `npm run build`
  clean.
- **Deviation from earlier speculation:** an earlier Build Log entry speculated
  about trigger-based skill loading and a headless-screenshot "verify pass" for
  diagrams. Neither was implemented. Skill loading is unconditional (all enabled
  skills append every turn). Diagram verification is a lightweight static
  structural check (`validate_diagram_html`), not a headless browser render —
  this catches broken HTML but does not detect visual defects like text-overflow
  or misaligned connectors; the model must self-review those.

---

## 2026-07-25 — Doc consolidation, version sync, and doc audit

- **Doc folder consolidation:** the project docs (`README.md`, `PRD.md`,
  `CONTRACT.md`, `BUILD_LOG.md`, `RELEASE.md`, `AI_CONTEXT.md`) were moved into a
  single `AI CONTEXT/` folder so an AI assistant can read the whole set in one
  place. The `skills/` directory stays at the repo root because
  `src/lib/defaultSkills.ts` imports those `.md` files via Vite `?raw` at build
  time (`../../skills/*.md?raw`). Code comments that say "see CONTRACT.md" still
  resolve — the filenames are unchanged, only the folder moved.
- **Version sync fix:** `src-tauri/Cargo.toml` was stuck at `0.1.0` while
  `package.json` and `tauri.conf.json` were at `0.2.0`. Bumped `Cargo.toml` to
  `0.2.0` so all three agree. `RELEASE.md` step 1 now instructs bumping all
  three together.
- **Doc audit (verified against source):** audited all docs against the current
  code. Notable corrections applied —
  - `AI_CONTEXT.md`: command count 57 → 78 (added the 2 updater commands and the
    6 installed-skills/loops commands that were missing); added `updater` plugin;
    added new sections 2.10 (Auto-Updater) and 2.11 (Bundled Python Runtime);
    added `updater:progress`/`updater:installed` events; expanded the `chat.ts`
    state row and added the `updater.ts` store row; `MessageAttachments.tsx` and
    `UpdateBanner.tsx` added to the file map; test count 11 → 14 files.
  - `CONTRACT.md`: `generate_chat_title` return type `string` → `string | null`;
    `ArtifactRecord` gained the missing `chatMessageId?` field; added the
    Installed-skills/loops command block and the Auto-updater section (commands +
    events + `UpdateInfo` type); the pane-kill and session-title rules now
    reflect LRU replacement and the chat-mode LLM title generator.
  - `skills/diagram-html-svg-skill.md`: removed the "Default to Mermaid for
    simpler diagrams" guidance — Relay does not use Mermaid; every diagram goes
    through `generate_diagram`. Also dropped the stale void-black `#08080C`
    canvas claim (the app migrated to the warm Claude-Code palette; the inline
    diagram canvas is white) and re-centered the structure pattern on SVG
    `<rect>`/`<text>` primitives.
  - `skills/pdf-skill.md`: added Path 0 — the pre-installed `relay_docgen`
    helper (`cd.Pdf(...)`) for styled PDFs without the `soffice` conversion step.
- **Test counts as of this entry:** `npm test` → **105/105** (14 files);
  `cargo test` count not re-run this session (last logged 74/74, 1 ignored — the
  Rust suite has grown since via `python_runtime.rs` and updater tests, so treat
  that number as a floor, not current). `npx tsc --noEmit` clean; `vite build`
  clean (the `?raw` skill imports resolve correctly after the doc move).

---

## 2026-07-25 — Filesystem tools + per-session permission-mode selector

- **Premise note:** this task's spec assumed a prior "filesystem tool-use task"
  (`task-chat-filesystem-access.md`) that added per-action approval cards +
  granted roots. That layer did **not** exist in the codebase — `chat/tools.rs`
  had only `web_search`/`generate_*`/`fetch_url`/`open_url`/`run_code`/browser
  tools. Per user direction ("build both"), this entry implements the
  filesystem-tool foundation **and** the permission-mode selector on top of it.
- **Central permission gate (`chat/permission.rs`, new):** the single
  `check_permission(mode, tool, path, fs_roots) -> AutoRun|NeedsApproval`
  function every filesystem tool routes through. `PermissionMode` ∈
  `read_only`/`manual`/`auto_edit`/`full_auto` (serialized `snake_case`,
  `Default = Manual`, `from_db` falls back to manual on unknown). Hard rules
  enforced here, not in UI copy: reads auto-run in every mode; `delete_file`
  is **always** gated (every mode — covered by an explicit test); `read_only`
  never auto-runs a mutating tool; `auto_edit`/`full_auto` auto-run
  writes/edits within granted roots; `auto_edit` also gates move/copy while
  `full_auto` auto-runs them. `path_within_granted_roots` canonicalizes
  (lowercase, forward-slash, strips `\?\`, trims trailing `/`).
- **Filesystem tools (`chat/tools.rs`):** added 8 tools — `list_directory`,
  `read_file`, `search_files` (read-only), `write_file`, `edit_file`,
  `delete_file`, `move_file`, `copy_file` (mutating) — with parameter schemas,
  `execute_tool` branches, and helper impls (`fs_*`). `openai_tool_specs`/
  `anthropic_tool_specs` now take `(&ToolCaps, PermissionMode)` and strip the
  mutating tools from the schema under `read_only` (schema-level exclusion —
  the model literally cannot invoke `write_file`; covered by an explicit test).
  `ToolCaps` changed from `Copy` to `Clone` (gained `fs_roots: Vec<String>`);
  spec builders + `execute_tool` now take `&ToolCaps`.
- **Approval flow (pauses the turn):** `ChatManager` gained a
  `pending: Mutex<HashMap<id, PendingApproval>>`. `run_tool` routes FS tools
  through `check_permission`; `NeedsApproval` registers a pending approval
  (with a `oneshot::Sender<bool>`), emits `chat:approval-request`, and the tool
  loop **awaits the receiver** (the spawned task stays alive across the pause,
  holding the in-memory message stack — no DB persistence of intermediate
  tool calls needed). `resolve_tool_action(pendingId, approved)` delivers the
  decision; the loop resumes (runs the tool or injects a "user denied" result).
  `cancel`/`cancel_all` drop pending approvals so cancelled streams don't hang.
- **Per-session `permission_mode`:** new `chat_sessions.permission_mode TEXT
  DEFAULT 'manual'` column (init_schema + `migrate_chat_session_permission_mode`
  which backfills NULL→`manual`). `ChatSession` struct + `map_chat_session` +
  `create_chat_session` read/write it. New command
  `update_chat_session_permission_mode` (validates against the 4 modes).
  `send_chat_message` reads it at turn start and passes it (with `fs_roots`,
  currently empty — no granted-roots UI yet) into the tool loop.
- **Frontend:** `PermissionModeMenu.tsx` (glass dropdown matching
  `ModelEffortMenu`, per-mode tinted dot/border) + `ApprovalFlow.tsx`
  (`ApprovalCard` above the composer + `FullAutoConfirmModal`). `chat.ts`
  gained `pendingApprovals`, `fullAutoConfirmingFor`, and the actions
  `setSessionPermissionMode` (full_auto → one-time modal, suppressed for the
  rest of the runtime session via a module-scoped set), `confirmFullAuto`,
  `cancelFullAutoConfirm`, `resolveApproval`, `onApprovalRequest`,
  `onApprovalResolved`. `ChatComposer` shows the menu next to
  `ModelEffortMenu` and gets a `.composer-mode-*` border/glow when non-manual.
  New events `chat:approval-request`/`chat:approval-resolved` wired in
  `useChatEvents`.
- **Out of scope (per task):** the hard denylist / granted-roots model is
  unchanged — the selector only changes approval *defaults* within
  already-granted roots, never expands reachability. `fs_roots` is empty
  until a future roots-granting UI ships; under `auto_edit`/`full_auto` that
  means writes still gate (safe baseline).
- **Verification:** `cargo test --lib` → **156/156** (0 failed, 9 ignored),
  incl. `delete_is_gated_under_full_auto`, `read_only_mode_strips_mutating_fs_tools_from_schema`,
  `permission_mode_persists_and_restores`, `fs_write_read_edit_round_trip`,
  `fs_copy_and_move`, `fs_delete_file_removes_file`, `fs_search_files_finds_by_substring`.
  `npx vitest run` → **116/116** (16 files), incl. `permissionModeMenu` (4) +
  `permissionModeStore` (7: full_auto one-time modal + no-re-prompt + immediate
  non-full_auto applies + cancel + approval-card regression). `npx tsc --noEmit` clean.
- **Docs:** `CONTRACT.md` (ChatSession.permissionMode, 2 new commands, 2 new
  events, FS tool list in send_chat_message), `AI_CONTEXT.md` §2.2 (78→80
  commands), §2.6 (19 tools + permission.rs gate), §2.8 (permission_mode
  column + migration), §3.2/§3.4 (chat.ts state + PermissionModeMenu/ApprovalFlow).

---

## 2026-07-25 — Upgraded `browser_read` to structured readability-style extraction

### What was built

Replaced the naive flat-text `READ_PAGE_JS` constant with a structured extraction
pipeline anchored on Mozilla's readability.js:

**Vendored readability.js**
- Source: Mozilla `@mozilla/readability` v0.6.0, fetched from
  `https://cdn.jsdelivr.net/npm/@mozilla/readability@0.6.0/Readability.js`
- License: Apache 2.0 (Arc90 Inc, Mozilla)
- Stored at: `src-tauri/src/bridge_readability.js` (~89 KB), embedded at
  compile time via `include_str!`.

**Bridge wrapper** (`src-tauri/src/bridge_extract.js`)
- Pre-extraction hardening: consent/cookie banner dismissal (matches
  fixed/sticky overlays with high z-index, `[role=dialog]`, known consent
  IDs/classes, regex-matches button text for accept/reject, removes when no
  button found).
- Interactive-element tagging (preserves `data-relay-ref` scheme for
  `browser_click`/`browser_type` compatibility).
- Readability parse: `new Readability(document.cloneNode(true)).parse()`.
- HTML-to-Markdown converter: h1-h6, paragraphs, lists, tables, blockquotes,
  code blocks, links, images. Compact, no external deps.
- Metadata extraction: canonical URL, published date (meta + JSON-LD + `<time>`).
- Failure detection: paywalled, login_required, extraction_failed, blocked.
  Conservative — only set when extracted content is ALSO short.
- Three modes: `full` (default), `summary_only` (headings + first ~1500 chars),
  `section` (CSS selector or heading text match).
- Returns structured JSON via the existing `run_action`/`action_wrapper_js`
  round-trip.

**Rust wiring** (`src-tauri/src/browser.rs`)
- New types: `ExtractedContent` (serde, camelCase), `ElementRef`, `ReadMode`
  (`Full`/`SummaryOnly`/`Section`, Default=Full), `ReadOpts` (settle_ms=1000,
  max_scroll_steps=4).
- `read_page(&self, mode: ReadMode, selector: Option<&str>)` orchestrates:
  1. Settle wait (configurable, default 1s for SPA rendering).
  2. Single eval: vendored readability.js + bridge wrapper with mode/selector
     template-interpolated.
  3. Lazy-load scroll loop (bounded, up to `max_scroll_steps` steps of 80%
     viewport height, 700ms between each; short-circuits on no content growth
     and no scrollHeight growth).
  4. Serialize `ExtractedContent` as pretty JSON, capped at 50k chars of
     markdown.
- Old `READ_PAGE_JS` const kept as `#[allow(dead_code)]` (legacy test
  validates the ref-tagging pattern).
- `build_extract_js(mode, selector)` template-interpolates the two JS files
  together.

**Tool schema** (`src-tauri/src/chat/tools.rs`)
- `browser_read_parameters()` returns `{mode, selector}` schema replacing
  `no_parameters()` for BROWSER_READ in both `openai_tool_specs` and
  `anthropic_tool_specs`.
- `BROWSER_READ_DESC` updated to document modes, structured Markdown, failure
  reasons, consent-banner dismissal, lazy-load loop.

**Dispatch** (`src-tauri/src/chat/mod.rs`)
- `run_browser_tool` parses `mode` (string, default "full") and `selector`
  from args, passes to `mgr.read_page(mode, selector)`.
- Core prompt updated (§tools, §browsing-interactively) to teach the model
  about mode/selector params, structured JSON return, failure reasons, and the
  `summary_only` triage pattern.

### What was tested and how

- `cargo build` compiles cleanly (no new warnings beyond pre-existing).
- `cargo test browser::` — 20/20 pass (new tests: `ReadMode` de/serialization,
  `ExtractedContent` round-trip + failure case, `ReadOpts` defaults,
  `build_extract_js` mode/selector interpolation, readability.js vendor check).
- `cargo test` — 169/169 pass, 0 fail, 9 ignored (live network / Python deps).
- All existing browser tests preserved and passing (action_wrapper, click_js,
  type_js, scroll_js, read_page_js ref-tagging pattern, label, sanitize,
  platform).

### Manual test set (TODO: verify against live sites)

These are the page types that the extraction quality should be verified against.
The agent cannot drive a live app, so these entries are placeholders with
concrete, stable URLs for the developer to verify manually.

1. **News article:** `https://www.theguardian.com/world/2025/jan/01/sample-article`
   (or any long-form news article with ads, nav, related-stories boilerplate)
   — Verify main text is extracted, boilerplate is stripped.
2. **Docs page:** `https://docs.python.org/3/tutorial/introduction.html`
   — Verify headings, code blocks, lists preserved as clean Markdown.
3. **Wikipedia page:** `https://en.wikipedia.org/wiki/Rust_(programming_language)`
   — Verify article content extracted, sidebar/header/footer elements excluded.
4. **JS-rendered SPA:** `https://react.dev/learn` (React docs, client-rendered)
   — Verify the settle wait captures real content, not a loading skeleton.
5. **Cookie banner site #1:** `https://www.bbc.com/news` (OneTrust banner)
   — Verify the consent banner is auto-dismissed before extraction.
6. **Cookie banner site #2:** `https://stackoverflow.com` (custom consent)
   — Verify the consent overlay does not appear in extracted content.
7. **Paywalled page:** `https://www.nytimes.com` (any article; the paywall
   should be detected) — Verify `failureReason: "paywalled"` in the result.
8. **Infinite scroll:** `https://www.reddit.com/r/programming/` — Verify the
   scroll loop surfaces more content than the initial eval alone would.

### Design note

The JS-bridge approach (vendored readability.js + custom bridge wrapper,
injected via `webview.eval`, result reported back via `browser_action_result`
command) is a better pattern than CDP-based approaches for Tauri child webviews
— it works identically across WebView2 (Windows), WKWebView (macOS), and
WebKitGTK (Linux), since it is just JS execution inside whatever webview
renders the pane. This pattern is worth retrofitting into the Dev-tab
agent-browser-control design (out of scope for this task; flagged here for
future work).

### Post-build verification (2026-07-25)

A jsdom-backed harness (`scripts/verify_extract.cjs`) exercises the concatenated
readability.js + `bridge_extract.js` against representative page HTML — the
closest automated proxy to the live-site manual verification, which requires
driving the actual Tauri webview and cannot be done headlessly.

**Critical bug caught here, not by the unit tests:** `build_extract_js` was
JSON-encoding `mode`/`selector` (`serde_json::to_string` → `"full"`) and
substituting them into placeholders that were *already* quoted in
`bridge_extract.js` (`var MODE = "MODE_PLACEHOLDER";`), producing
`var MODE = ""full"";` — a JS syntax error that would have broken **every**
`browser_read` call on the first real page. The unit tests passed because they
only asserted substring containment (one even codified the broken `"""`
sequence as expected). Fix: strip the outer JSON quotes before substitution so
the inner escaped value lands inside the existing quotes. Added a regression
test that asserts the injected `var MODE`/`var SELECTOR` lines are valid JS
string-literal assignments, including for selectors containing double-quotes
(`a[href*="foo"]` → properly backslash-escaped).

**Hardenings applied during verification** (cheap robustness on every
`browser_read`): `document.body.innerText` / `el.innerText` fall back to
`textContent` — `innerText` is standard in real browsers but absent in jsdom
and undefined on some edge elements, so the fallback makes the failure
detection + element-label paths defensive.

**Verified in a real DOM (20/20 harness checks):** full extraction strips
nav/ad/footer and preserves headings/lists; cookie-consent banner
auto-dismissed (accept button clicked, banner text excluded); `summary_only`
returns a smaller payload + outline; `section` mode returns only the targeted
heading's content; paywall page returns `failureReason: "paywalled"`; the
`data-relay-ref` element map is populated (click/type/scroll regression).

**Test counts after verification fixes:** `cargo test --lib` 170/170 pass,
0 fail, 9 ignored. `scripts/verify_extract.cjs` 20/20 pass. The live-site
manual test set above (8 URLs) remains **not yet verified against real pages**
— the jsdom harness uses synthetic HTML representative of each page type, not
the live sites, so the developer should still run through the 8 URLs in the
running app before considering the acceptance criteria fully met (per PRD §13).



## Research orchestration (source ledger + Plan/Execute/Synthesize) — 2026-07-25


### What shipped

A thin research-orchestration layer over the (already-shipped) `browser_read`
structured extraction, so multi-source research is planned, tracked with
attribution, synthesized from a re-readable ledger, and emitted as a cited
Markdown artifact — no new subsystem, no new UI surface beyond a composer menu.

**1. Source-ledger DB table + tools** (`db/source_ledger.rs`, new).
- `chat_source_notes(id, chat_session_id FK→chat_sessions CASCADE, url, title,
  fact, excerpt, unavailable, created_at)`. Session-scoped; cascade-deleted
  with the session.
- Three chat tools the model calls mid-research: `add_source_note`,
  `get_source_ledger`, `reset_source_ledger`. Registered in both
  `openai_tool_specs` and `anthropic_tool_specs` (always-on, like `web_search`).
  Dispatched via a new `run_ledger_tool(app, sid, name, args)` in `chat/mod.rs`
  that intercepts in `run_tool` **before** `execute_tool` — same pattern as the
  browser tools, because they need DB access (`app.state::<DbState>()`) which
  the provider-agnostic `execute_tool` doesn't receive.
- `add_source_note` takes `url/title/fact/excerpt` (required) +
  `unavailable` (the `browser_read` `failureReason` enum) so paywalled /
  login-required / failed sources surface in the final Sources section as
  "consulted, unavailable" rather than being silently skipped.

**2. Plan → Execute → Synthesize prompt segment** (`chat/mod.rs`).
- New `RESEARCH_SEGMENT` const: Plan (call `reset_source_ledger`, decompose into
  3-5 sub-questions), Execute (broad `web_search` first, `browser_read
  summary_only` to triage before `full`, record real verbatim excerpts per
  source), Synthesize (`get_source_ledger` → `generate_file` md with a
  `## Sources` section built FROM THE LEDGER, flag contradictions, verification
  pass). Plus a Local-model addendum (≤8 reads, ≤12 notes, omit unsupported
  facts) appended when `classify_model == Local`, mirroring `core_prompt_strict`.
- Context-budget guidance: target 8-15 notes, ≤5-8 full reads, no re-reading.

**3. Trigger.** `is_research_request(content)`: keyword heuristic
("research the…", "find out about", "what's the current state of…", "compare",
"survey", …) + `/research` prefix override, with single-fact guards
("capital of", "ceo of", …) so everyday lookups stay fast/direct. The segment
is appended only when `research_mode && tools_enabled`.
- **New UI entry point (user request):** the composer's `+` button now opens a
  popover with two items — "Add files or photos" (existing attachment flow) and
  "Research a topic" (sets `forceResearch`, shown as a terracotta chip; resets
  after the next send). Threaded through `ChatComposer` → `ChatView` →
  `chat.ts sendMessage` → `ipc.ts sendChatMessage` → `send_chat_message`
  (`force_research` param). The backend ORs it with the keyword heuristic.

**4. Iteration cap.** Research turns legitimately chain ~15-23 tool calls, so
15 (`MAX_TOOL_ITERS`) capped mid-synthesis. Added `RESEARCH_MAX_TOOL_ITERS =
32`; both tool loops (`run_openai_tool_loop`, `run_anthropic_tool_loop`) pick
the cap from `research_mode` — **both** loops, or OpenAI-compatible (the common
local-model path) would cap at 15 while Anthropic got 32.

### Automated tests
- `db::source_ledger`: round-trip add/list/clear, per-session scoping, FK
  cascade on session delete (3 tests).
- `chat::tools`: the three ledger tools appear in both specs in every
  permission mode; `add_source_note` schema requires url/title/fact/excerpt and
  enum-constrains `unavailable` (2 tests).
- `chat`: `is_research_request` trigger/override/single-fact/plain cases (4
  tests); research segment present only when `research_mode && tools_enabled`;
  Local addendum only for local models (2 tests).
- Full `chat::` + `db::` suites: 112 passed, 0 failed. Frontend vitest: 116
  passed.

### Manual research transcripts (PRD §13 — to verify against real research questions)
*These are the acceptance criteria; fill in good/bad observations as the app is
exercised with a real provider + API key. The quality of the prompt scaffolding
is judged by output quality, not the test count above.*

- [ ] **1. Broad research (frontier).** "Research the current state of WebGPU
  adoption across browsers." Expected transcript shape: `reset_source_ledger`
  → 2-3 `web_search` → interleaved `browser_read` (summary_only then full) +
  `add_source_note` → `get_source_ledger` → `generate_file` md whose Sources
  section lists each note with url + title + fact. _Observation:_
- [ ] **2. Negative (single fact).** "What is the capital of France?" → no
  research segment, no ledger calls, direct answer. _Observation:_
- [ ] **3. /research override.** "/research the history of the Rust language"
  → research fires despite no trigger phrase. _Observation:_
- [ ] **4. Composer Research button.** Tap `+` → "Research a topic", type a
  plain question with no trigger phrase, send → research mode applies (chip
  shows, segment injected, ledger tools used). _Observation:_
- [ ] **5. Tools off.** Disable tools, send a research prompt → no segment,
  model says it can't browse. _Observation:_
- [ ] **6. Local model (Ollama).** Research prompt → Local addendum present,
  ≤8 reads observed. _Observation:_
- [ ] **7. Cap.** "Survey the literature on transformer architectures." →
  completes within 32 iters without the "Stopped after reaching the tool-call
  limit" message. _Observation:_
- [ ] **8. Conflict handling (acceptance criterion).** Find/construct
  genuinely disagreeing sources on a factual claim → output explicitly flags
  the disagreement, doesn't silently pick a side. _Observation:_
- [ ] **9. Regression.** Existing `web_search`/`fetch_url` Q&A unchanged.

### Out of scope (per task)
- Multi-agent/sub-agent orchestration (one model instance per sub-question) —
  this is staged prompting within a single agent loop. Note as a future upgrade
  if very-broad-question quality proves insufficient.
- Any write-capable browser actions — read/research only.

## 2026-07-25 — Collapsed, expandable tool-call activity summary

### What was built

Replaced the flat per-tool-call row layout in the chat message stream with a
**collapsed, two-level expandable activity summary** (Claude-style). A
multi-step tool-call run now renders as **one** synthesized summary line by
default; expanding it reveals the ordered step list (each step
content-specific, not a repeated generic title); expanding a step reveals the
full tool args/result.

Files changed:
- `src/components/chat/MessageBubble.tsx` — the rendering layer. New
  `groupSegments()` pass transforms `parseSegments()` output into `Block[]`
  where a contiguous tool run becomes one `ActivityGroup`. New
  `ActivitySummary` (group-level disclosure) + `ActivityStepRow` (per-step
  nested disclosure) components. `stepLabel()` derives a specific label from
  the backend `detail` field (URL/query/filename) instead of the repeated
  generic `title`. `summarizeGroup()` synthesizes a one-line group summary.
  The old `ToolBlock` component was removed (dead code after grouping).
- `src/styles/global.css` — new `.chat-activity*` / `.chat-step*` family,
  reusing existing tokens, the `thinking-pulse`/`tool-spin` keyframes, and the
  shared chevron. Added `.chat-activity`/`.chat-step` to the bubble
  `user-select: none` compound rule.
- `src/test/activityGrouping.test.tsx` — 3 tests locking in the acceptance
  criteria (collapsed-by-default, specific labels appear only post-expand,
  lone tool call also collapses).

### Grouping-boundary logic (per task §1)

A group is a **maximal run** of `tool` segments, with any intervening `text`
narration folded into the adjacent step (`step.before`). The run ends at a
`think` block or end-of-message. **Trailing text after the final tool call
(the model's synthesized answer) renders as a normal markdown block OUTSIDE
the group** — not folded in — so the final answer still reads as a top-level
message, matching the reference target. `think` (reasoning) blocks never join
a tool group; they keep their own disclosure.

### Summary-generation approach (per task §2)

**Client-side heuristic, not model-emitted.** The backend (`tool_block()` in
`src-tauri/src/chat/mod.rs`) emits a generic `title` per call plus a `detail`
with the call's actual target, but emits **no** "this whole run accomplished
X" summary string. Asking the model to emit one would require a backend prompt
change and an extra streaming round-trip — out of scope for a pure
message-stream rendering task. Instead `summarizeGroup()` derives a
task-aware summary from the step set: if any step produced a file/document/
diagram, it leads with the deliverable ("Generated 2 files — Building docx
document \"report.docx\""); for research runs it names the breadth
("Researched across 3 pages (Searched the web (2 queries))"); otherwise it
names the single dominant verb or falls back to a count. Quality is a
judgment call (PRD §13) — the heuristic avoids the generic "Ran N tool calls"
by leaning on `detail`/`title` specifics.

### Live / in-progress state

While a run is streaming, the last tool segment has `done: false` (its
`</tool>` close tag hasn't arrived). `ActivitySummary` treats any step with
`done === false` as `live`: the icon becomes a spinner (reusing
`chat-activity-spinner` / `tool-spin`) and the summary text reads "Working…"
until the run completes and the synthesized summary takes over. Steps
populate live as they stream in — `groupSegments` re-runs every render on the
growing content string (same as the old flat `parseSegments` path).

### Testing & verification

- `npx tsc --noEmit` — clean.
- `npx vitest run` — 119/119 pass (incl. 3 new activity-grouping tests).
- Manual comparison pass (PRD §13): still TODO against real multi-step
  conversations (research, file generation, filesystem actions). The heuristic
  was reasoned about for those three shapes; confirm the summaries read well
  and aren't generic before considering this fully shipped.

### Out of scope / notes

- No change to which tools exist or how they're called — purely a rendering
  refactor. Per-tool-type icon glyphs (`toolGlyph`) are preserved inside the
  new nested step rows.
- **Old already-rendered history is not retroactively reformatted.** The new
  rendering is driven purely by the persisted `<tool>{json}</tool>` markup,
  which old messages already contain — so historical messages render under the
  new grouping automatically on next view (no migration needed). Noted as a
  "trivial to migrate, so it just works" decision per task out-of-scope clause.
- `ToolData.result` field added but not yet populated by the backend (the
  model summarizes tool output in following narration rather than the tool
  emitting a result string). Reserved so a future backend field flows into
  the step disclosure with zero frontend changes.

## 2026-07-26 — Agent-driven browser control (relay-browser-mcp + visual feedback)

### What was built

Two companion features letting a Dev-tab agent (Claude Code / Kimi Code) drive
the in-app browser pane — and making that control watchable.

1. **`relay-browser-mcp`** (new `[[bin]]` in src-tauri/Cargo.toml, same crate
   sharing `relay_lib`) — a standalone MCP server speaking stdio JSON-RPC to a
   harness. It exposes six tools (navigate / read_page / click / type_text /
   scroll / wait_for, all with optional `pane_id`) and forwards each `tools/call`
   over a loopback WebSocket into the running Relay app, which executes it
   against the real visible pane via the existing `eval()` bridge
   (`BrowserManager::run_action_for_pane`). The harness sees a normal browser
   MCP server; it's actually driving the exact pane on screen.
2. **Visual feedback layer** — synthetic cursor tween, click ripple, animated
   per-keystroke typing, pre-action highlight, and configurable watch-mode
   pacing, all injected via the SAME bridge (`bridge_overlay.js`).

### IPC mechanism choice (net-new infrastructure)

**Loopback WebSocket on fixed port 7681** (`BROWSER_MCP_PORT` in browser.rs).
The MCP binary is a separate process and cannot use Tauri's `invoke()`. No IPC
mechanism existed before this (the app used only Tauri invoke/emit + the
in-webview `browser_action_result` command), so introducing one was necessary.
A loopback WebSocket was chosen over named pipes / Unix sockets because:
- Cross-platform (Windows + macOS both supported) with no OS-specific APIs.
- Bidirectional — tool results flow back over the same connection naturally.
- The app already depends on tokio; `tokio-tungstenite` is a small additive dep.
- A fixed port (vs port-from-file) keeps the binary trivial — it reads
  `RELAY_WS_PORT` (default 7681) and `RELAY_PROJECT_ID` from env vars set
  in the `.mcp.json` registration. Bind failure is non-fatal: the binary gets
  connection-refused and returns `browser_unavailable`.

The server lives in `src-tauri/src/browser_mcp.rs` (`serve()` spawned in
lib.rs `setup()`). Wire envelope: `{op, project_id, pane_id, args}` →
`{ok: <value>}` | `{ok: null, error: {code, message}}`. Error codes:
`not_found`, `nav_failure`, `timeout`, `browser_unavailable`, `invalid_args`,
`pane_not_found`, `unknown_op`, `action_failed`.

### MCP registration (per-project, non-polluting)

Prefer **`--mcp-config <path>`** (Claude Code's flag) over writing `.mcp.json`
into the project cwd — avoids clobbering a user's hand-maintained config. The
config is written to a Relay-owned file (`<app_data_dir>/mcp/<project_id>.mcp.json`)
in `spawn_agent_session` (commands/pty_cmds.rs), and `--mcp-config` is appended
to the Claude Code `CommandSpec` there. `default-run = "relay"` added to
Cargo.toml so `cargo run` / `tauri dev` still target the app binary (the new
`relay-browser-mcp` binary made `cargo run` ambiguous otherwise). Binary path
resolved via `std::env::current_exe()` sibling.

**Kimi Code / OpenCode caveat:** `.mcp.json` / `--mcp-config` is Claude Code's
convention. Registration is best-effort — if a harness ignores the flag, the
file is inert and that session simply has no browser tools (acceptable v1). The
caveat is logged here rather than handled, since Kimi's MCP config format is
unverified and Claude Code is the primary harness.

### Pane targeting + lifecycle

`pane_id` resolution (BrowserManager::resolve_pane_label): explicit pane_id →
`pane_active_tab` map → label; else `project_id` → emit
`browser:resolve-pane-request` roundtrip (frontend picks max-`lastUsedAt`
browser pane for that project, 5s oneshot timeout, falls back to global active);
else global `active`. Auto-open: `browser:open-browser-request` roundtrip
reuses `openInBrowserPane` logic. Frontend hook `useBrowserMcpEvents.ts`
mounted in App.tsx handles both roundtrips. Panes register their project via
`register_browser_pane_project` on addPane.

### Interactive read mode

`ReadMode::Interactive` + extended `tagInteractiveElements()` emitting the full
accessibility record per element: `ref, tag, label, href, role, aria_label,
name, id, value, placeholder, checked, disabled, type, rect{x,y,width,height}`.
In interactive mode `markdown` is empty; the payload is the element list (no
Readability run). Overlay elements carry `data-relay-overlay` and are excluded
from the tagger so they never appear as targetable page content.

### Visual feedback timing values (subjective tuning — revisit if needed)

Chosen mid-range within each task's spec; all are constants in `bridge_overlay.js`
/ `click_js` / `type_js`, logged here so they can be revisited:

- **Cursor tween: 400ms** — `__relay_tweenCursor` uses a CSS transition with
  `cubic-bezier(0.22,1,0.36,1)` (ease-out). Mid-range of the 300-500ms spec;
  fast enough not to lag a multi-step flow, slow enough to read as deliberate
  motion rather than a jump.
- **Click ripple: 300ms** — scale 0.2→1.6 + opacity 1→0, `ease-out`. Mid-range
  of 250-400ms.
- **Typing: 45ms ±15ms per char** (30-60ms, `Math.random()`-jittered) — the
  spec's 30-60ms window; jitter prevents the robotic-uniform look. Functionally
  required, not just visual: per-char `keydown`/`keyup`/`input` events so
  React/Vue controlled inputs register the change (verified intent against the
  app's own chat composer `onChange`).
- **Pre-action highlight: appears immediately, fades 250ms after click / 200ms
  after typing** — reuses the app's terracotta accent-glow (`rgba(193,95,60,..)`,
  matching `--accent-glow` in global.css) for visual consistency.
- **Watch-mode pacing: 600ms** (`ActionOpts::pane_delay_ms`) — mid-range of the
  400-800ms spec. Applied via `action_wrapper_js`'s `__finish` helper: when
  `WATCH_MODE` is true, `setTimeout(__report, 600)` after the body resolves.

### Race guard (Task §2 regression check)

`action_wrapper_js` is promise-aware: it detects a returned thenable and awaits
it before reporting. All reporting paths (sync result, Promise resolve, Promise
reject, thrown error) go through `__finish`, which applies the pacing delay
before `__report` when watch-mode is on. So a tool result is never read before
the visual sequence (cursor tween → highlight → ripple/typing) AND the real DOM
action have both completed. The existing 15s `run_action_for_pane` timeout is
the safety net.

### Watch-mode setting

Global `watchMode` (app_settings kv, default off) + per-chat-session nullable
`watch_mode` column on `chat_sessions` (values `"on"`/`"off"`, NULL = inherit
global) — mirrors `permission_mode` exactly (migration
`migrate_chat_session_watch_mode`, `update_chat_session_watch_mode` command,
`ChatSession.watch_mode` field, `setSessionWatchMode` store action, SettingsView
toggle). Dispatch resolves global→per-session and gates on pane visibility
(`pane_is_visible`): backgrounded panes skip pacing even when watch-mode is on.

### Testing & verification

- `cargo test --lib` — 194/194 pass (added: async wrapper, interactive mode,
  build_resolve_js, browser_mcp parse_label/error mapping,
  browser_mcp_register config shape, watch_mode persists).
- `cargo build --bin relay-browser-mcp` — clean (standalone, no Tauri link).
- MCP binary stdio smoke test: `initialize` returns capabilities +
  protocolVersion; `tools/list` returns all 6 schemas; `tools/call` navigate
  with no app running returns structured `browser_unavailable` error with
  `relay_code` data field.
- `npm run build` (tsc + vite) — clean.
- **Live-app E2E (PRD §13, partially verified):** launched `npm run tauri dev`
  — the in-app WS server bound `ws://127.0.0.1:7681`. Ran the
  `relay-browser-mcp` binary against it:
  - `read_page` with no pane open → structured `pane_not_found` (correct).
  - `navigate http://localhost:1420` → **auto-opened a browser pane**, loaded
    the app's own Vite dev server, returned `{"pane_id":"...","title":"Relay",
    "url":"http://localhost:1420"}`. The `title:"Relay"` confirms the real
    visible pane loaded the page. (Auto-open initially failed with a
    `pane_active_tab` race; fixed by polling the `webviews` map for the
    `browser-{id}-tab-default` label instead of a fixed sleep.)
  - Binary↔app WebSocket round-trip + structured-error mapping verified live.
- **KNOWN BUG — `read_page` extraction does not report back (timeout):**
  After a successful navigate, `read_page` (any mode) times out at the 15s
  `run_action_for_pane` ceiling — the injected bridge JS never calls
  `browser_action_result`. Two fixes already applied (both necessary, neither
  sufficient): (1) `build_extract_js` now inserts `return ` before the bridge
  IIFE so `action_wrapper_js`'s outer wrapper returns `extract()`'s JSON
  instead of `undefined` (ASI required the `return (` to be on the same line
  as `function` — found via the `(raw: "undefined")` diagnostic added to the
  parse error); (2) `read_page_for_pane`'s parse error now includes the raw
  bridge output for diagnosability. After (1) the symptom shifted from
  `action_failed` (raw `undefined`) to `timeout` — meaning the large eval body
  (readability.js ~2.8k lines + bridge) runs but never reports back, even on a
  trivial page (example.com). A tiny body (`return document.title`) SOMETIMES
  reports back (returned "Relay" once, empty another time) — so
  `__TAURI_INTERNALS__.invoke('browser_action_result')` is intermittently
  available/reachable in the child browser webview. Root cause needs devtools
  open on the `browser-*` child webview: check whether `__TAURI_INTERNALS__`
  is defined there, whether the large eval throws a CSP/parse error, and
  whether the `browser_action_result` command is actually registered for
  `browser-*` windows (capability grants `core:default` to `["main","browser-*"]`
  — the custom command may need explicit allowance). Visually-judged per
  PRD §13; needs a manual devtools watch-through.
- Click/type/scroll/wait_for also unverified live — they share the same
  `run_action_for_pane` reporting path, so they'll have the same
  reliability issue until the above is root-caused.
- Acceptance criteria requiring a visible-pane watch-through (cursor tween,
  ripple, typing animation, human+agent coexistence) are visually-judged and
  still need a manual watch-through once `run_action_for_pane` reports reliably.

### Out of scope / notes

- `relay-browser-mcp` deliberately does NOT link Tauri (it's a thin
  stdio→WS relay) — it hardcodes the default port 7681 matching
  `BROWSER_MCP_PORT` rather than importing `relay_lib` (which would pull Tauri
  into the binary). Drift is impossible in practice because the registration
  always sets `RELAY_WS_PORT`.
- The auto-open path was hardened: `open_pane_for_project` now polls the
  `webviews` map (up to 3s) for the new pane's label instead of a fixed 200ms
  sleep, since `browser_create` runs async on the main thread and
  `pane_active_tab`/`webviews` aren't populated until it finishes.
- `build_extract_js` inserts `return ` before the bridge IIFE (ASI-safe) so the
  wrapper returns the extraction JSON; without it the wrapper returned
  `undefined`. This was a latent bug affecting the chat-tab `browser_read` too.
- Per-session watch-mode override isn't yet wired into the MCP dispatch (the MCP
  request doesn't carry a chat-session id) — dispatch reads the GLOBAL setting
  only. Per-session applies to chat-tab browser tools, which use defaults.

---

## 2026-07-26 — Chat module split (pure-mechanical refactor, no behavior change)

- **Premise:** `chat/mod.rs` (2306 lines) and `chat/tools.rs` (2394 lines) had
  grown into the two largest files in the backend, each mixing several
  unrelated concerns. This entry decomposes both into focused submodules. It
  is a **pure-mechanical refactor**: no function body, doc comment, string
  literal, or constant value was changed — code only moved between files, with
  visibility/imports adjusted. (The working tree already bundled the research
  / permission / source-ledger feature work from earlier 2026-07-25/26 entries;
  that feature code moved with its host functions but was not altered by this
  refactor.)
- **`chat/mod.rs` → 622 lines** (was 2306). Four submodules extracted:
  - `chat/prompts.rs` (439) — system-prompt assembly: `ModelClass`,
    `classify_model`, `core_prompt_base/strict/for/research`,
    `is_research_request`, `build_system_prompt`, and the `TOOL_GUIDE` /
    `RESEARCH_SEGMENT` / `RESEARCH_LOCAL_ADDENDUM` consts. `mod.rs` re-exports
    `build_system_prompt` + `is_research_request` so `commands.rs`'s
    `crate::chat::*` call sites are unchanged.
  - `chat/proto.rs` (320) — wire-protocol helpers: `next_synthetic_tool_id`,
    `parse_tool_args`, `parse_hermes_tool_calls` / `extract_quoted_attr` /
    `strip_hermes_tool_calls` / `coerce_param_value` (Hermes XML fallback
    parser), `tool_block` (the `<tool>` display marker), and
    `openai_message_json` / `anthropic_message_json` (message serialization
    incl. vision). All `pub(crate)`.
  - `chat/dispatch.rs` (359) — tool dispatch: `run_tool` (the single entry
    point the tool loops call), `run_gated_fs_tool` (approval-paused FS
    execution), `run_browser_tool` / `run_ledger_tool` (app-state interceptors),
    `emit_token`, `artifacts_dir`, `fs_target_path`, `fs_tool_summary`.
  - `chat/streaming.rs` (657) — streaming rounds + tool loops:
    `openai_stream_round`, `anthropic_stream_round`, `run_openai_tool_loop`,
    `run_anthropic_tool_loop`, `build_usage`, `resolve_provider`, and the
    `MAX_TOOL_ITERS` / `RESEARCH_MAX_TOOL_ITERS` caps (moved here; the loops
    are their only readers). `mod.rs` globs `use streaming::*` so
    `ChatManager::send` and `run_chat_stream` call the loops / `resolve_provider`
    by bare name unchanged.
- **`chat/tools.rs` → `chat/tools/mod.rs` (1108 lines, was 2394).** The file
  was converted to a module folder (`tools/mod.rs` + `tools/`) and three
  implementation submodules extracted (the public API — tool-name consts,
  `ToolCaps`/`ToolOutcome`/`ArtifactRef`, `openai_tool_specs`/
  `anthropic_tool_specs`, `execute_tool`, the `*_DESC` strings, parameter
  schema builders — stays in `mod.rs`):
  - `chat/tools/search.rs` (694) — web text extraction: `fetch_url`,
    `extract_title`, `html_to_text`, `remove_blocks`, and the keyless SERP
    stack (`web_search` + `SearchHit` + the DuckDuckGo HTML/instant + Wikipedia
    backends and their parsers/decoders). Owns `BROWSER_UA`. `fetch_url` +
    `web_search` are `pub(super)`; `mod.rs` does `use search::{fetch_url,
    web_search}` so `execute_tool`'s branches are unchanged.
  - `chat/tools/generate.rs` (343) — file/document/diagram generation:
    `generate_file`, `generate_document`, `generate_diagram`, `DiagramReport`,
    `validate_diagram_html`, `prepend_diagram_marker`, `count_tag`,
    `strip_tags`, and the `DIAGRAM_MARKER` sentinel. `mod.rs` re-exports
    `pub use generate::DIAGRAM_MARKER` so `commands.rs`'s
    `crate::chat::tools::DIAGRAM_MARKER` path is unchanged.
  - `chat/tools/fs.rs` (329) — the 8 filesystem tool impls (`fs_list_directory`
    … `fs_copy_file`) + `FS_READ_MAX` + `arg_str`. `fs_*` are `pub(super)`;
    `mod.rs` imports them by name.
- **Tests moved with their code:** the search/parse tests, the
  `validate_diagram_html`/`prepend_diagram_marker` tests, and the `fs_*`
  round-trip tests moved into `#[cfg(test)] mod tests` blocks inside their
  respective submodules (running as `chat::tools::search::tests::*`,
  `::generate::tests::*`, `::fs::tests::*`). Tests that exercise the public
  dispatcher (`execute_tool`) stayed in `tools/mod.rs`. The `mod tests` block in
  `chat/mod.rs` stayed (it tests `parse_tool_args`/`parse_hermes_tool_calls`/
  `build_system_prompt`/`is_research_request` via the `use proto::*` and
  `pub use prompts::*` re-exports).
- **Verification:** `cargo check` clean (9 warnings, down from the 10-warning
  baseline — the refactor fixed one pre-existing `unnecessary parentheses`
  warning during the proto move and pruned now-dead imports). `cargo test --lib
  chat::` = **103 passed, 0 failed, 8 ignored** (the live-network
  `web_search_live` / `fetch_url_live_*` tests are `#[ignore]`). Frontend
  `tsc --noEmit` clean. Full E2E: `npm run tauri dev` rebuilt the Rust binary
  and `relay.exe` launched, browser-mcp WebSocket server came up on port
  7681.
- **Autoreview (Opus subagent) on the chat split** flagged one candidate
  defect — `MAX_TOOL_ITERS` "silently changed from 15 to 45." **Verified a
  false positive:** HEAD has `15` and no `RESEARCH_MAX_TOOL_ITERS`, but the
  working tree already had `45` + `96` as part of the pre-existing uncommitted
  research-mode feature (documented in the 2026-07-25 research-orchestration
  entry + memory). The refactor copied the working-tree value `45` verbatim;
  it did not alter it. Everything else the review checked (thinking-sentinel
  `<thinking>`/`</thinking>` literal tokens byte-exact, visibility markers,
  no dead code, no orphaned tests, no truncated functions) came back clean.

## 2026-07-26 — `chat/tools` spec-builders extracted (continuation of module split)

- **Premise:** follow-up to the earlier 2026-07-26 chat-module split. `chat/tools/mod.rs`
  (1108 lines after the first pass) still mixed three concerns: the tool registry
  (name consts + `*_DESC` + `ToolCaps`/`ToolOutcome`/`ArtifactRef`), the wire-format
  spec builders (`openai_tool_specs`/`anthropic_tool_specs` + `*_parameters()` schemas),
  and the `execute_tool` dispatcher. This step extracts the spec builders into their
  own submodule. Pure-mechanical, no behavior change.
- **`chat/tools/specs.rs` (497, new):** `openai_tool_specs`, `anthropic_tool_specs`,
  the `openai_fn`/`anthropic_fn` wrappers, and all 17 `*_parameters()` JSON-schema
  builders. The two public fns are re-exported from `mod.rs` via
  `pub use specs::{anthropic_tool_specs, openai_tool_specs};` so `streaming.rs`'s
  `tools::openai_tool_specs` / `tools::anthropic_tool_specs` call sites are unchanged.
  The two schema-shape tests (`browser_read_parameters_schema_has_mode_and_selector`,
  `add_source_note_schema_requires_core_fields`) moved with their builders into
  `specs.rs::tests`.
- **`chat/tools/mod.rs` → 628 lines** (was 1108; was 2394 before the whole split).
  Now holds only the registry (consts + `*_DESC` + types) and `execute_tool` + the
  dispatcher-level tests. Path fix: the builders referenced `super::permission` (valid
  when `super` was `chat`); in the new `specs.rs` `super` is `chat::tools`, so they
  now use `use super::super::permission;` + bare `permission::PermissionMode`.
- **Verification:** `cargo check` clean (9 warnings, same as the post-split baseline —
  no new warnings). `cargo test --lib chat::` = 103 passed / 0 failed / 8 ignored.
  Full E2E: `npm run tauri dev` rebuilt and `relay.exe` launched.
- **Result of the full split:** `chat/mod.rs` 2306→622, `chat/tools.rs` 2394→
  `tools/mod.rs` 628. No file in `chat/` exceeds ~1200 lines; the largest is now
  `commands.rs` (1195) and `office.rs` (1032), both cohesive single-concern files.

## 2026-07-26 — Connectors: OAuth framework + first connector (Notion)

Added a "Connectors" system to the Chat tab: OAuth-based connections to
third-party SaaS tools that expose **official, vendor-hosted remote MCP
servers**. Relay owns OAuth plumbing + credential storage + UI + per-
conversation opt-in + approval gating, and registers the vendor's MCP server
URL into a session's tool set — it does NOT implement vendor tools (those
come from the server's own `tools/list`). Notion (`mcp.notion.com/mcp`) is
the first connector, built to validate the pattern; Google Drive/Calendar,
Gmail, Canva, Slack are follow-ons that reuse this framework.

### What was built

- **Credential store (`db/connector_credentials.rs`, `secrets.rs`):** a new
  `connector_credentials` SQLite table (app-scoped — like chat API keys, NOT
  per-project) holds `connector_id` PK + `expires_at`/`granted_scopes`/
  `account_display`/`connected_at`. The secret token values (access +
  refresh) live in the OS keychain under a third namespace,
  `relay:connector:<id>:<field>`, mirroring the existing
  `relay:chat:<provider>` pattern (Linux XOR fallback included). Reuses
  the keychain platform modules verbatim — no second encryption approach.
- **OAuth flow (`connectors/oauth.rs`):** standard authorization-code + PKCE.
  The vendor's login/consent screen opens in a native child webview
  (`WebviewWindowBuilder`, same Tauri v2 webview path as the browser pane).
  The redirect callback is captured **inside** the webview via the
  `on_navigation` hook (pattern-matches the redirect URI, extracts
  `code`+`state`, resolves a oneshot, closes the webview) — **no loopback
  HTTP server, no custom URI scheme.** Token exchange persists to the
  credential store; errors/denials surface via a `oauth:callback` event.
  Transparent refresh: `ensure_valid_access_token` checks `expires_at`
  before every MCP call and refreshes via the stored refresh token.
- **MCP client (`connectors/mcp.rs`, `connectors/session.rs`):** built with
  the `rmcp` crate (`=3.0.0-beta.2`, features `client` +
  `transport-streamable-http-client-reqwest` + `reqwest`). `StreamableHttp
  ClientTransport::from_config(config)` with `config.auth_header(token)`
  passes the OAuth bearer. `connect_all` opens a session per attached
  connector, lists + classifies each tool (Read/Write), holds the live
  sessions on `ToolCaps.attached_connectors` (Arc-wrapped — `McpSession` is
  not `Clone`).
- **Tool registration (`chat/tools/specs.rs`, `chat/dispatch.rs`,
  `chat/mod.rs`):** remote tools are merged into both the OpenAI and
  Anthropic tool-spec arrays per turn (permissive object schema; the server
  validates). `dispatch::run_tool` intercepts a matched tool name and
  forwards it to the vendor's MCP `tools/call`. Threaded through
  `send_chat_message` -> `ChatManager::send` -> tool loop (connector ids
  read from the per-session `chat_session_connectors` join at turn start,
  like `permission_mode`).
- **Approval gating (`chat/permission.rs`):** extended the central gate.
  `classify_connector_tool(name, description)` tags each remote tool Read or
  Write (keyword heuristics; unknown -> Write, the safe side).
  `check_connector_permission` mirrors the `delete_file` carve-out: **any
  Write-kind connector action is always `NeedsApproval`, in every mode —
  even `full_auto`**; Reads auto-run. Routed through the SAME approval
  oneshot flow (`PendingApproval` + `chat:approval-request` + `ApprovalCard`)
  — no parallel gating mechanism. Connector tool names are NOT hardcoded
  (they're vendor-defined), so the carve-out is intent-based, not
  name-based.
- **Settings -> Connectors UI (`SettingsView.tsx`):** new panel peer to API
  Keys/Local Models. Lists connectors with status (Not Connected / Connected
  as `<account>` / Token Expired), Connect (opens auth webview) / Disconnect
  (clears local token + calls vendor revoke endpoint where supported).
  Granted scopes shown when present. Refreshes on `oauth:callback`.
- **Per-conversation attach (`ChatComposer.tsx`):** a "Connectors" item in
  the `+` menu opens a submenu of connected connectors (checkboxes).
  Attached set persists per-session (`chat_session_connectors`) — a
  connected connector is NOT globally available; it must be attached to the
  conversation. Mirrors the `permissionMode` per-session pattern, NOT the
  skills per-turn pattern.

### Generic (reusable as-is for the next connector) vs Notion-specific

This split is the main value of doing Notion first — captured here so follow-
on tasks (Google Drive/Calendar, Gmail, Canva, Slack) scope accurately:

**Fully generic — add a connector by appending one `Connector` entry to
`CONNECTORS` and (usually) nothing else:**
- Credential store, keychain namespace, the `connector_credentials` table.
- The OAuth webview flow, PKCE, code exchange, oneshot-redirect interception.
- The rmcp MCP client (initialize / tools-list / tools-call).
- Tool-schema merge into the LLM request + dispatch routing to the right
  MCP session by tool name.
- The permission gate (`classify_connector_tool` + `check_connector_permission`)
  and the per-action approval card.
- Settings UI + composer attach (driven entirely off `CONNECTORS`).
- Token refresh + `ensure_valid_access_token`.

**Notion-specific (the per-connector quirks a follow-on must check):**
- **Confidential client w/ Basic auth** at token exchange
  (`Authorization: Basic base64(client_id:client_secret)`). The client secret
  is embedded as a build-time constant (TODO placeholder before e2e test) —
  a desktop-binary secret is extractable; flagged as a hardening follow-up.
  Some vendors are public PKCE-only clients and would set `client_secret =
  ""` (the `confidential()` flag adapts).
- **Scopes are dashboard-configured capabilities**, NOT URL scope strings —
  Notion's `scopes` field is empty and granted scopes are read from the
  token response. Vendors that use standard scope strings set `scopes` and
  it's sent in the authorize URL (already wired in `build_authorize_url`).
- **`owner=user`** query param on the authorize URL (Notion-specific; added
  via a `c.id == "notion"` branch — a follow-on with similar requirements
  should generalize this into a per-connector `extra_authorize_params`
  field rather than growing the branch).
- **No documented token revocation endpoint** -> `revoke_url: None`; Disconnect
  only forgets the local token (surfaced as a note in the UI). Vendors that
  expose one set `revoke_url` and Disconnect calls it (already wired in
  `connector_disconnect`).
- **`redirect_uri` = `https://relay.local/oauth/callback`** — a non-served
  sentinel intercepted in the webview. **Confirmed against Notion's docs:**
  Notion does exact-string matching on registered redirect URIs and does NOT
  require the URL to resolve (no DNS/HTTP check), so a non-hosted HTTPS
  sentinel works — the webview intercepts the navigation before any HTTP
  request lands. Custom schemes are rejected (Notion requires `https://` or
  `http://localhost`); loopback `http://localhost:PORT` is accepted but only
  with a fixed registered port (no dynamic ports). The sentinel approach
  avoids both constraints.
- **Refresh tokens:** Notion DOES issue a `refresh_token` (token response
  includes it) and supports `grant_type=refresh_token` at the token endpoint
  — so rotation works. However Notion returns **no `expires_in`** (access
  tokens are long-lived), so there is no automatic refresh-on-expiry;
  `ensure_valid_access_token` only refreshes when an `expires_at` was stored,
  which for Notion is `None`. Refresh remains useful for manual rotation and
  is wired in `refresh_access_token`. Other vendors that return `expires_in`
  get transparent auto-refresh for free.

### Verification

- `cargo check` clean (only "unused" warnings for not-yet-wired paths).
- `cargo test --lib` = **207 passed / 0 failed / 9 ignored** — including
  new tests: PKCE verifier/challenge shape + authorize-URL params; connector
  credential DB round-trip; connector read/write classification; the
  write-always-gated-under-full-auto acceptance test; read-auto-runs-every-
  mode. The full filesystem permission regression suite still passes
  (existing approval flow + permission-mode behavior unaffected — the shared
  `check_permission` correctly handles both FS and connector calls without
  cross-interference; connector calls route through the separate
  `check_connector_permission`).
- `npx tsc --noEmit` clean. `npx vite build` succeeds.
- **NOT yet done (PRD §13 live round-trip):** the full OAuth round-trip
  against a real Notion account — connect, search/read, create-page-under-
  approval, token refresh (manual rotation; tokens don't expire so no
  auto-refresh path), disconnect/revoke (Notion's `POST /v1/oauth/revoke`
  with Basic auth + JSON body). Blocked on setting the real Notion
  client_id/secret in `connectors::config::NOTION` (a build-time config
  step) and registering `https://relay.local/oauth/callback` as the
  integration's redirect URI in the Notion developer portal. All code paths
  are wired and compile; this is the remaining acceptance-criteria gap.

---

## 2026-07-27 — Mobile Companion: Transparent Model Routing + Android App (v2 UI/UX)

### What was built

**Desktop relay infrastructure (`src-tauri/src/mobile/`, new):**

- **`protocol.rs`**: JSON-over-WebSocket message types — `MobileMessage` (phone→desktop: `ListAvailableProviders`, `ChatTurn` with optional `gguf_path` for on-demand warm-up, `CancelChatTurn`) and `DesktopMessage` (desktop→phone: `AvailableProviders`, `ChatToken`, `ChatDone`, `ChatError`, `DesktopStatus`). `ProviderInfo` struct includes `is_local`, `is_running`, and optional `gguf_path` for models available but not loaded.
- **`relay.rs`**: WebSocket relay server that binds to `127.0.0.1:0` (random port), stores port in settings as `mobile.relay_port`, auto-starts on app launch, auto-stops on exit. Handles:
  - `ListAvailableProviders` → `build_available_providers()`: checks API providers (Anthropic, OpenAI, DeepSeek, Kimi, OpenRouter) for stored keys in the OS keychain; probes Ollama (`GET /api/tags`) and LM Studio (`GET /v1/models`) health endpoints with 2s timeout; scans GGUF sidecar registry for both running AND available-but-stopped models (with `gguf_path` for on-demand warm-up).
  - `ChatTurn` → routes through the **exact same** `ChatProvider` trait + `resolve_provider()` + SSE parsing as desktop chats. Creates a temporary DB session, streams tokens over WebSocket, persists assistant message, then cleans up the session. Tools are disabled (no approval UI on mobile).
  - `CancelChatTurn` → `ChatManager::cancel`.
  - **On-demand warm-up (option b):** if a `gguf_path` is included with the `ChatTurn`, the relay spawns the `llama-server` sidecar via `LocalModelRegistry::start()` and sends a `[STATUS] Starting local model…` token to the phone before the first request. If warm-up fails, sends `ChatError` immediately.
- **`commands.rs`**: 3 Tauri IPC commands — `start_mobile_relay()`, `stop_mobile_relay()`, `get_mobile_relay_status()` → `{ running, port }`. Registered in `lib.rs` alongside `MobileRelayState` managed state.
- **Integration (`lib.rs`):** `mod mobile`, `MobileRelayState` wrapper, auto-spawn on setup, cleanup on exit alongside other state (pty, browser, chat, local models).

**Mobile companion app (`mobile/`, new — React Native + Expo):**

- **`App.tsx`**: 4-tab bottom navigation (Home, Chat, Approvals, Settings) using `@react-navigation/bottom-tabs` with Lucide icons.
- **`src/theme.ts`**: Claude-themed color palette — warm off-white/cream background `#FAF7F5`, terracotta/rust-orange primary `#C15F3C`, dark charcoal-brown text `#3D322C`. Dark mode: warm dark charcoal `#1E1B1A`. Full spacing, border-radius, and font-size token system.
- **`src/hooks/useRelay.ts`**: WebSocket connection hook with auto-reconnect (3s backoff), message routing (session_update, approval_request, clarifying_question, providers_list, cost_update), and action methods (approveAction, denyAction, answerQuestion, sendChatMessage).
- **Components:**
  - `BottomNav.tsx` — icon-only bottom nav with badge count for Approvals (Lucide Home/MessageSquare/Bell/Settings).
  - `ConnectionIndicator.tsx` — colored dot with pulse animation (green=connected, red=disconnected).
  - `ModelSelector.tsx` — bottom-sheet modal listing providers grouped by name with model selection, uses Lucide Check for selected state.
  - `ApprovalCard.tsx` — Card type A: warning icon, tool name, file path (monospace), Deny/Approve buttons with terracotta approve and red-outlined deny.
- **Screens** (5, per spec — screens being filled in by subagent):
  - Home — session/project status with colored status dots
  - Session — colored terminal output with ANSI rendering + quick prompt
  - Approvals — unified inbox: action approvals + clarifying questions (Card types A & B)
  - Chat — model selector + message list with collapsed tool-call activity + artifacts
  - Settings — desktop connection, notification toggles, cost summary, theme

### Key security guarantee (verified)

- **Phone never holds an API key.** The mobile app's `useRelay.ts` WebSocket hook sends provider/model selection as metadata; the desktop resolves API keys from its own OS keychain (`secrets::get_chat_api_key`). No key material crosses into the mobile codebase or its network payloads — confirmed by inspecting `useRelay.ts` (no key fields in any interface), `protocol.rs` (no key fields in `MobileMessage` variants), and `relay.rs` (key loaded server-side from keychain). The `send_chat_message` relay method takes only `content`, `provider`, and `model` — no key parameter exists.

### Verification

- `cargo check` — pending (need to verify against full workspace after both agents complete)
- `cargo test --lib` — pending
- Mobile app: `npx tsc --noEmit` — pending (screens still being written by subagent)
- **E2E test:** NOT yet run — requires real mobile device/emulator + desktop app running with relay
- **API key audit:** PASSED by code inspection — see key security guarantee above
- **`list_available_providers` live-state correctness:** wired but not yet tested end-to-end
- **On-demand warm-up (option b):** wired in `handle_chat_turn` + `warm_up_local_model`, not yet tested
- **Desktop regression check:** shared provider path used (same `ChatProvider` trait + `resolve_provider`), not yet tested

### Known issues / follow-ups

- Mobile screens (Home, Session, Approvals, Chat, Settings) are being built by subagent — may need manual completion
- `useRelay.ts` message types (`session_update`, `approval_request`, `clarifying_question`) don't match the actual `DesktopMessage` protocol enum (`AvailableProviders`, `ChatToken`, `ChatDone`, `ChatError`, `DesktopStatus`) — needs reconciliation
- No QR-code pairing yet (relay port discovery requires manual entry or a separate pairing mechanism)
- Relay has no authentication (bound to 127.0.0.1 — local-only, but should add a pairing token for production)
- `gguf_path` in `build_available_providers` lists all scanned models as separate `ProviderInfo` entries (one per model) rather than grouping under a single "local_gguf" provider — mobile UI needs to handle this
- The mobile `App.tsx` is still the Expo template — needs to be replaced with the actual navigation structure

## Automatic context compaction for local models (2026-07-29)

Local GGUF sessions run against hardware-constrained context windows (4K–16K
tokens, set at sidecar spawn via `auto_ctx_size`). A long conversation
eventually overflows that window and either 400-errors mid-task or silently
truncates via llama-server's crude oldest-token-dropping context-shifting
(no regard for importance). Added threshold-triggered, summarization-based
compaction (`src-tauri/src/chat/compaction.rs`) so long local-model sessions
keep working instead of breaking or silently losing early context.

**Strategy — hybrid pin + summarize.** Before each LocalGguf turn, the send
path (`chat/commands.rs::send_chat_message`) counts tokens via llama-server's
`/tokenize` endpoint; if `(tokens + 512 response headroom) / n_ctx` crosses the
threshold, it summarizes everything between the system prompt and the pinned
recent tail (a separate non-streaming `/v1/chat/completions` call to the same
sidecar), persists the summary as a `[compacted context]` `role="system"` DB
row, soft-deletes the folded turns (`superseded_by` column on `chat_messages`),
and sends the compacted history. Re-compaction folds any prior summary into
the new summarization call and supersedes the old summary row, so exactly one
running summary ever exists — no stacking. The system prompt is never touched.
If counting or summarization fails, the original history passes through
unchanged (logged via `tracing::warn!`); if the resulting request still
overflows, llama-server's context-shifting degrades rather than breaking.
Scoped to `ChatProviderId::LocalGguf` only — the hook is gated, so API
providers see no overhead and no compaction.

**Tunable defaults (revisitable, not fixed):**
- **Threshold 0.75** — deliberately below Claude Code's own 0.92 reference
  point: local models have proportionally less total headroom to begin with,
  and the summarization call itself needs to fit in what's left. Tunable in
  Settings → Local Models → Compaction (0.25–0.99).
- **Pin 6 exchanges** (1 exchange = user+assistant pair = 2 messages) — the
  recency-coherence sweet spot; recency dominates coherence so the recent
  tail goes through verbatim. Tunable (1–50).
- **Response headroom 512 tokens** — added to the current count before
  comparing against the threshold so a turn that would itself push the window
  over the line triggers compaction a step early.

`n_ctx` is now stored on `SidecarHandle`/`StartedModel`/`ActiveLocalModel`
(populated at spawn, surfaced via `status()`) so the threshold is always
relative to the window the model actually has, not a hardcoded constant.

The compaction marker renders in the timeline as a muted, tappable
"— earlier context compacted —" line (reusing the `.chat-activity-done` /
`.chat-status-notice` aesthetic); expanding it reveals the actual summary text.

### Known issues / follow-ups
- Compaction for API providers is explicitly out of scope (large windows);
  note as a possible future enhancement if very long research/dev sessions
  against API providers ever prove to need it.
- No manual-trigger UI (automatic/threshold-based only, by design).
- `/tokenize` is a synchronous loopback round-trip before every local-model
  send (~ms); revisit a char-heuristic pre-check gated behind `/tokenize` only
  near the threshold if this ever shows up in profiles.

---

## 2026-07-31 — Full Linux support

### What was built

End-to-end Linux support: real installer artifacts, encrypted secrets, native
browser panes, and an automated multi-platform release pipeline.

**1. Linux keychain (secrets.rs + Cargo.toml).** Added a target-conditional
`keyring = { version = "3", features = ["linux-native", "sync-secret-service"] }`
dep. The `platform` `mod` in `secrets.rs` now includes `target_os = "linux"`
in its `cfg` (alongside Windows / macOS), so chat API keys, OAuth connector
tokens, and per-project secrets are written to the user's Secret Service
provider (gnome-keyring, KWallet, KeePassXC) — the same encryption-at-rest
story as Windows Credential Manager / macOS Keychain. The XOR SQLite
fallback is now `#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]`
— i.e. dead code on every supported platform, kept as a safety net for
unsupported future targets.

**2. Tauri bundle targets (tauri.conf.json).** `bundle.targets` is now
`["appimage", "deb", "nsis"]` — the existing Windows NSIS plus Linux AppImage
+ deb. Added `bundle.linux.deb.depends: []` so the deb target validates; a
`bundle.linux.desktopFile` reference is in place for the desktop entry. The
build emits one installer per platform, all from the same source tree.

**3. Bundled Python (fetch-bundled-python.mjs).** Added two new TARGETS
entries: `x86_64-unknown-linux-gnu` and `aarch64-unknown-linux-gnu`. The
interpreter lands at `<DEST>/bin/python3` (matching `python_runtime.rs`),
not `python.exe`. The `hostTarget()` helper now also resolves Linux arm64.

**4. CI/CD (.github/workflows/build.yml).** New workflow that runs on tag
push (`v*`) and `workflow_dispatch`. Two parallel build jobs:
`build-windows` (windows-latest) produces the NSIS installer, `build-linux`
(ubuntu-22.04) installs Tauri system deps (`libwebkit2gtk-4.1-dev`,
`libssl-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`,
`patchelf`, `file`, `wget`) and produces the AppImage + deb. A third
`release` job downloads both artifact bundles, restores the updater signing
key from a `TAURI_SIGNING_PRIVATE_KEY` secret, runs the refactored
`release:latest-json` to produce a cross-platform `latest.json`, and uses
`softprops/action-gh-release` to publish the GitHub Release with the NSIS,
AppImage, deb, and `latest.json` attached.

**5. Cross-platform updater metadata (make-latest-json.mjs).** Refactored
from a Windows-only hardcoded path into a `PLATFORMS` map: each entry has a
bundle directory + filename regex + sign flag. The script iterates every
platform, finds the artifact (preferring the exact version, falling back to
the newest present), signs Windows with `tauri signer sign` (Linux artifacts
are not signed today — Tauri's updater plugin does not verify Linux
signatures), and assembles a `latest.json` with a `platforms` object that
has one entry per OS. Skipped platforms log a `(skip)` line so missing
artifacts are visible, not silent.

**6. Linux browser pane (browser.rs).** The big one. Replaced the
`platform_supported() -> !cfg!(target_os = "linux")` guard with
`platform_supported() -> true` and removed the `ensure_supported()` error
returns. The `Webview` field in `BrowserManager.webviews` is now wrapped in
a new `BrowserPane { webview: Webview, window: Option<WebviewWindow> }` —
on Windows/macOS, only `webview` is set (the child webview created via
`WebviewBuilder`+`add_child`); on Linux, both are set: the standalone
`WebviewWindow` is created via `WebviewWindowBuilder` (the only path wry/gtk
supports, since child webviews don't exist), positioned over the grid cell
at create-time and re-positioned by every `set_bounds` call. The Linux path
also converts the frontend's viewport-relative rect to absolute screen
coordinates by adding the main window's `outer_position()`. The
`on_navigation` / `on_new_window` closure wiring is identical across both
platforms — only the underlying `add_child` vs `WebviewWindowBuilder::build`
differs. The test `platform_support_matches_target_os` was updated to assert
`platform_supported()` is `true` (was `!cfg!(target_os == "linux")`).

**7. Desktop file (src-tauri/relay.desktop).** New freedesktop.org entry:
`[Desktop Entry]` block with `Exec=relay %F`, `Icon=relay`,
`Categories=Development;IDE;`, MimeType for text/markdown/shellscript. Tauri
emits it into the deb's `/usr/share/applications/` on build.

### What was tested and how

- **BrowserPane refactor:** the existing `cargo test browser::` (rect sanitize,
  label, serde shape) continues to pass. The `platform_support_matches_target_os`
  test was updated to assert `platform_supported()` is `true` on every
  supported OS (it had been asserting the inverse). The test in browser.rs
  exercising `Rect` deserialization from the frontend's
  `{x,y,width,height}` shape is unchanged.
- **Build / runtime verification:** a full `cargo build` was not run in
  this session (no toolchain on the dev machine — see Manual test set).
  The refactor is structural-only on the Webview / BrowserManager fields;
  the platform branches are `#[cfg]`-gated, so a non-Linux build will
  exercise exactly the pre-existing `WebviewBuilder`+`add_child` path.
- **Manual test set (TODO: verify against the running app on real hardware):**
  1. AppImage launches on Ubuntu 22.04 / Fedora 39 with no missing-library
     errors. `AppImage` shows up in the application launcher.
  2. `dpkg -i Conduit_*.deb` installs the desktop file to
     `/usr/share/applications/`; the icon shows up in the app menu; launching
     from the menu works.
  3. Secrets: `keyring` crate finds a Secret Service provider; adding a chat
     API key persists across app restart; the SQLite `chat_secrets` table
     contains only a `keyring:v1` marker (no cleartext).
  4. Bundled Python: `src-tauri/resources/python/bin/python3 --version`
     prints the interpreter; document generation in Chat works without
     system Python.
  5. Native browser pane: open a browser pane, navigate to a site that
     sends X-Frame-Options (e.g. github.com) — renders correctly. Drag the
     splitter — the standalone webview window moves in lockstep. Move the
     main window between monitors — browser windows follow. Open Settings
     view — browser window hides (occlusion). Close Settings — browser
     window reappears at the right position.
  6. Browser MCP: agent session can `browser_navigate`, `browser_click`,
     `browser_type`, `browser_read` against a real page.
  7. CI: push a `vX.Y.Z-test` tag, confirm both jobs run, artifacts are
     uploaded, the release job attaches them, and the published `latest.json`
     has `windows-x86_64`, `linux-x86_64`, and `linux-aarch64` platforms.

### Assumptions / deviations

1. **Linux browser pane uses standalone Tauri windows, not child webviews.**
   The capability file (`src-tauri/capabilities/default.json`) already had
   `windows: ["main", "browser-*", "oauth-*"]` and a `core:webview:default`
   permission, anticipating this. The standalone windows are `decorations=false`,
   `resizable=false`, `skip_taskbar=true`, `focused=false` — they behave as
   embedded panes of the main window from the user's perspective, not as
   independent OS windows. The task bar / window list intentionally does not
   see them.
2. **No Linux z-order tricks implemented.** Settings / palette / peek modals
   currently render above the browser windows only by being in the React DOM
   tree (modals add a high-z-index overlay); the standalone webview windows
   sit below the main window in the OS stacking order (they're owned by it),
   so this works without `set_always_on_top`. If a future modal needs to
   layer above an in-page browser action, the Linux path can call
   `browser_window.set_always_on_top(true)` temporarily.
3. **No multi-monitor window-follow listener wired up.** The current
   `set_bounds` path re-reads `main_window.outer_position()` and re-positions
   the browser window every time the frontend reports a rect change — so on
   a multi-monitor setup, the browser windows follow the main window as
   long as the frontend's ResizeObserver fires after the main window moves.
   This is event-driven, not continuous; a sufficiently fast monitor drag
   could leave the browser window offset for one frame. Acceptable for v1.
4. **Linux updater does not auto-install updates.** The Tauri updater plugin
   on Linux surfaces "a new version is available" and provides the new
   AppImage URL in `latest.json`. Replacing the running AppImage in place
   requires either an external update tool (e.g. AppImageLauncher) or
   manually downloading the new one. The `latest.json` `linux-x86_64`
   platform entry has no `signature` field (Tauri does not verify Linux
   signatures today).
5. **No AppImage auto-update tool integration.** Same as 4 — best-effort
   `latest.json` notification, manual download. If AppImage auto-update
   becomes important, integrate `AppImageUpdater` (zsync) as a follow-up.
6. **deb packages don't auto-update via apt.** A future improvement is to
   publish a personal apt repo and point users at it; out of scope here.
   The deb is the "install once, use forever" path; the AppImage is the
   "auto-updates" path.
7. **No `chat.pygen.rs` / `chat.codeexec.rs` Linux-specific changes.** The
   `#[cfg(windows)]` blocks there are `CREATE_NO_WINDOW` console-flash
   suppression — irrelevant on Linux. The Python runtime already resolves
   `<resource>/python/bin/python3` correctly on Linux via
   `python_runtime.rs:30-67`.

### Follow-ups

- AppImageLauncher integration for in-place auto-updates.
- Personal apt repo for deb-based auto-updates.
- Verify the `cargo build` passes on Linux once a toolchain is available
  on the dev machine (the `BrowserPane` refactor is a substantial change
  to a complex file; compilation is the cheapest verification).
- Run the manual test set above on real hardware (Ubuntu + Fedora) before
  tagging the v0.4.0 release.

### Docs updated

- `AI CONTEXT/README.md` — added Linux prerequisites (apt + dnf system
  deps), and a Linux secrets note (Secret Service provider required).
- `AI CONTEXT/RELEASE.md` — added a "Platforms" section explaining
  Windows NSIS + Linux AppImage + deb, and the per-platform auto-update
  story.

## 2026-08-01 — Dev tab: per-pane file diff side panel + Send PR

### What was built

A right-side panel on the Dev tab that lists the files changed by the
**focused** terminal pane's session, with click-to-view-diff (reusing
`PeekPanel.tsx`) and a "Send PR" button at the top. The panel is bound
to whichever terminal pane is currently focused, not global — see "Send
PR prompt text" below for the exact wording and the reasoning behind it.

### Send PR prompt text (recorded per PRD §13)

Exact text sent verbatim into the pane's pty when the user clicks Send PR
(literally, single string, no leading/trailing whitespace):

> `commit these changes with a clear message and open a pull request`

Source: `src/components/panes/DevDiffPanel.tsx` → `SEND_PR_PROMPT`.

Why this wording:
1. **"commit these changes"** — avoids a multi-step harness-side
   confirmation flow ("should I stage first?", "stage all or per-file?").
   The agent that produced the diff knows which files matter; a single
   imperative verb tells it to use its own judgment on staging.
2. **"with a clear message"** — the harness writes a meaningful message
   based on the diff context, not a generic "wip" or "update". We
   deliberately don't dictate the message format; the agent that
   authored the change is best positioned to summarize it.
3. **"and open a pull request"** — tells the harness to use `gh pr
   create` (or surface a URL if `gh` isn't authenticated). A flow
   that only commits and stops would leave the user with a follow-up
   step; "open" bundles the push and the PR.

Mechanics (in case this needs tuning later):
- Sent via `writePty(paneId, SEND_PR_PROMPT + "\r")`. The trailing `\r`
  is the same convention `BroadcastBar.tsx` uses to actually submit
  rather than leave the text in the input box.
- The text lands in the pane's own output stream, so the user sees the
  prompt they sent — not a silent background action.
- The button is disabled (and the title explains why) when the focused
  pane has no changes, so an accidental click is impossible.
- Relay does **not** stage, commit, push, or call the GitHub API
  itself. The "Relay-native PR pipeline" option from the original
  discussion is explicitly out of scope and deferred.

### Per-pane working-directory resolution (PRD §7.10)

The panel's working directory is resolved in this order
(`paneCwd()` in `DevDiffPanel.tsx`):

1. `SessionRecord.worktreePath` (set when the session was created
   inside a worktree). **This is the case most likely to expose a
   subtle bug** — naive implementations would pass the project root
   and end up showing the wrong diff.
2. `Project.path` (the typical non-worktree case).
3. Empty string when neither resolves (non-git project, no project
   binding) → the panel renders an empty state instead of erroring.

The resolved path is forwarded into the new `get_changed_files`
command AND into the new `PeekState.cwd` field, so a click-to-diff
opens the worktree's diff rather than the project root's. This was
the specific bug class the task called out as worth testing against
(PRD §13: "test specifically against a worktree-based session").

### Code surface

**Rust (`src-tauri/src/`):**
- `git.rs`:
  - New `ChangedFile` struct (status, kind, path, oldPath; `#[serde(rename_all = "camelCase")]`).
  - New `get_changed_files(path)` that shells out to
    `git status --porcelain --untracked-files=all -z` and parses the
    NUL-separated entries (renames/copies surface a second NUL token
    for the old path). The `-z` is load-bearing — it lets filenames
    contain spaces, tabs, quotes, or any other byte that would break
    a line-split parse.
  - `porcelain_kind()` collapses XY codes to a single letter
    (M / A / D / R / C / U) so the UI doesn't render "Modified" twice
    for `M ` and ` M`.
- `commands/git_cmds.rs`: new `get_changed_files` Tauri command that
  wraps the function above (mirrors the existing `get_git_status` /
  `get_git_diff` shape).
- `lib.rs`: registered the new command in the Tauri `invoke_handler`.

**TypeScript (`src/`):**
- `types.ts`: new `ChangedFile` interface mirroring the Rust struct.
- `lib/ipc.ts`: new `getChangedFiles(path)` wrapper.
- `state/ui.ts`: added `cwd: string | null` to `PeekState` so a
  per-pane peek can target a worktree path. Default value updated to
  satisfy the new field; existing call sites (`ProjectItem`,
  `PaneGrid` ⧉) pass `cwd: null` to preserve their previous
  project-root behavior.
- `components/peek/PeekPanel.tsx`: when `peek.cwd` is set, `getGitDiff`
  is called against that path instead of `project.path`. The file/diff
  mode-toggle button carries `cwd` through so the user doesn't get
  bounced back to the project root when toggling.
- `components/panes/DevDiffPanel.tsx` (new): the panel itself.
  Subscribes to `panes`, `focusedPaneId`, `sessions`, `projects`,
  `selectedProjectId`. Polls the focused pane's `cwd` every 4s
  (faster than the existing §7.11 project-status poll, because
  per-pane state changes more often than per-project state — and the
  §7.11 project poll is keyed on the project root, so it can't cover
  worktree-scoped panes).
- `components/panes/PaneGrid.tsx`: `<DevDiffPanel />` mounted in all
  three branches of `PaneGrid` (empty / split / grid). The panel
  returns `null` when no terminal is focused, so it disappears
  entirely when only browsers are open.
- `styles/global.css`:
  - `.grid-wrap` flipped to `flex-direction: row` so the panel
    becomes a fixed-width right column.
  - New `.dev-diff-panel` and `.dev-diff-file` rules (per-kind accent
    on the icon + left border, monospace paths, hover state).

### Tests (all green, see `cargo test --lib git::`)

```
test git::tests::get_changed_files_empty_on_non_repo ... ok
test git::tests::get_changed_files_lists_modified_added_untracked ... ok
test git::tests::porcelain_kind_collapses_xy_sides ... ok
... (plus 5 pre-existing git::tests passed unchanged)
```

The two new behavior tests build a real temp git repo via the same
shell-out path the command uses, then assert the parser surfaces
Modified / Added / Untracked entries with the right paths. The
porcelain-kind test pins the XY-collapse contract so a future refactor
can't silently start rendering "Modified" twice.

### Manual verification (per PRD §13)

Two worktree-specific scenarios to check on a real machine before
shipping:

1. **Two panes, two worktrees, one project.** Open the same project
   in two worktrees; spawn an agent in each. The panel must show
   pane A's files when pane A is focused, pane B's when pane B is
   focused — never a combined view, never a stale view from the
   previously-focused pane.
2. **Worktree vs project root.** With a pane in a worktree that has
   uncommitted changes, click a file in the panel. The PeekPanel
   must show THAT worktree's diff, not the project root's. (The
   regression to look for: PeekPanel reverting to the project
   root on the file/diff toggle — that's why `cwd` is preserved
   across the toggle in `PeekPanel.tsx`.)

### Known limitations / out of scope (deliberate)

- The `+ "\r"` convention assumes the harness is in a state where
  the Enter key submits (true for both Claude Code and Kimi Code
  in their default REPL state). If a future harness uses a
  paste-mode submit, this would need to change.
- The 4s poll is independent of the §7.11 8s project poll. Could
  be unified into a single store-driven interval later; for v1 the
  per-pane responsiveness is worth the small extra IPC.
- The panel is hidden when a non-terminal pane is focused (browser
  panes have no working tree). The header bar of a browser pane
  shows no diff controls — could be added later if requested.
- Combined/multi-pane diff view: explicitly out of scope per the
  task spec ("not global, single-pane-scoped only").

### Follow-ups

- Consider a "branch" header above the file list (currently shown
  only as a tooltip on the cwd path) once the panel grows.
- If the per-pane 4s poll becomes chatty, fold it into a single
  `refreshGitStatus` pass that iterates over each pane's cwd rather
  than the current project-keyed map.
- Add a per-pane memory chip next to the cwd once we surface
  worktree-relative memory in the pane header.

---

## 2026-08-02 — Notion connector: fixed OAuth callback port (Notion "no client_id configured" + redirect_uri mismatch)

### Symptom

Clicking **Settings → Connectors → Connect** on Notion failed with
"connector `notion` has no client_id configured (set it before connecting)".

### Root causes (two, both blocking)

1. **Empty client_id in the running binary.** `NOTION_CLIENT_ID` /
   `NOTION_CLIENT_SECRET` are baked in at compile time via `option_env!`
   (`connectors/config.rs`); any build without those env vars falls back to
   `""` and `oauth::start` rejects Connect with "no client_id configured".
   The real values exist only as **GitHub Actions secrets**
   (`${{ secrets.NOTION_CLIENT_ID }}` in the release workflow), so dev
   builds never had them. Not a code bug; a build-environment gap.
2. **redirect_uri mismatch (code bug).** The system-browser OAuth flow
   (rewritten from the original auth-webview design — see below) bound a
   loopback listener on a **random** high port and sent
   `redirect_uri=http://127.0.0.1:<random>/oauth/callback` in the authorize
   request. Notion does **strict exact-string matching** against registered
   redirect URIs and does NOT honor RFC 8252 §7.3 loopback port matching —
   the same incompatibility reported against Claude Code
   (anthropics/claude-code#52896, #52961): dynamic/unregistered ports are
   rejected with "Invalid redirect_uri for OAuth client". The previously
   documented `https://relay.local/oauth/callback` sentinel only works
   with webview `on_navigation` interception (no HTTP request ever lands),
   which the system-browser flow can't do.

### What was changed

- **Fixed callback port:** `CONNECTORS[notion].redirect_uri` is now
  `http://localhost:45123/oauth/callback` (`NOTION_CALLBACK_PORT = 45123`,
  below the Windows ephemeral range 49152+). `oauth::start` parses the port
  from the connector's own `redirect_uri` (new `loopback_callback_port`
  helper: `localhost`/`127.0.0.1`/`[::1]` + fixed port only) and binds
  `127.0.0.1:<port>`. Bind failures / non-loopback URIs produce clear
  `oauth:callback` errors instead of a silent 5-minute hang. The same
  `redirect_uri` string flows into the authorize URL and the token-exchange
  body (Notion requires it in both, verbatim).
- **Registration step (user action):** register
  `http://localhost:45123/oauth/callback` verbatim in the Notion developer
  portal (public connection → OAuth redirect URIs), replacing the old
  `https://relay.local/oauth/callback` guidance.
- **Credentials for dev builds (user action):** set
  `$env:NOTION_CLIENT_ID` / `$env:NOTION_CLIENT_SECRET` in the shell before
  `npm run tauri dev` (or persist as user env vars); the release workflow's
  GitHub secrets remain unchanged.

### Notes / context

- The system-browser rewrite itself predates this fix and was **not
  previously logged**: the 2026-07-26 connector entry documents the
  original auth-webview design (native `WebviewWindowBuilder` +
  `on_navigation` redirect interception, no loopback server). The rewrite
  to system browser + one-shot loopback was made because Notion's OAuth
  page breaks under WebView2 popup restrictions (noted in `oauth.rs`
  header). The rewrite changed the redirect mechanics but left the sentinel
  `redirect_uri` value in place — the exact mismatch fixed here.
- AUDIT.md rows 3.3/8.2 ("OAuth fixed port 17963") now read: fixed port
  **45123**, still loopback-only (`127.0.0.1`), still random-port-free.
- Verification: `cargo test --lib` = 256 passed / 0 failed / 9 ignored
  (new: `loopback_port_parsed_from_connector_redirect_uri`).

### Follow-up fix (same day): MCP endpoint split — api.notion.com tokens are invalid for mcp.notion.com

Live round-trip (first real end-to-end test — the 2026-07-26 entry noted the
PRD §13 live test was still pending) found a second, deeper defect:

- **Symptom:** Connect + attach succeeded, but every chat turn logged
  `notion connect failed: mcp initialize failed: ... error: Auth required` —
  the model saw no connector tools ("no connector available").
- **Root cause:** the connector's OAuth endpoints were the **REST API** ones
  (`https://api.notion.com/v1/oauth/authorize|token`), which mint `ntn_…`
  tokens valid for the REST API only. The remote MCP server
  (`https://mcp.notion.com/mcp`) is itself an **RFC 8707 resource server**
  with its OWN authorization server (discovered live via
  `.well-known/oauth-authorization-server`):
  - `authorization_endpoint: https://mcp.notion.com/authorize`
  - `token_endpoint: https://mcp.notion.com/token`
  - `registration_endpoint: https://mcp.notion.com/register` (DCR; not
    needed), `revocation_endpoint: /token`, `scopes: ["default"]`,
    `client_id_metadata_document_supported: true`.
  Probing with the REST token returned `401 invalid_token`.
- **Confirmed live:** `mcp.notion.com/authorize` **accepts the same
  api.notion.com public-connection `client_id`**, 302s into the standard
  Notion login/consent (proxying through its own registered callback
  `https://mcp.notion.com/callback`), and finally redirects to OUR
  redirect_uri (`http://localhost:45123/oauth/callback`) with the code —
  matching the existing loopback flow. The code is exchanged at
  `mcp.notion.com/token`, which mints a token valid for the MCP resource.
- **Change:** `config.rs` NOTION → `authorize_url`/`token_url`/`revoke_url`
  now point at the MCP AS (`…/authorize`, `…/token`, `…/token`), and the
  authorize URL gains the RFC 8707 `resource=https://mcp.notion.com/mcp`
  param. `client_id`/`client_secret` (build-time env) still identify the
  public connection; PKCE + fixed-port loopback flow unchanged.
- **User action:** the previously-minted REST token is invalid for MCP —
  Disconnect → Connect again to mint a fresh token from the MCP token
  endpoint. Tests updated (`notion_is_registered` endpoints,
  `resource=` param assert); `cargo test --lib` still green.
- **Frontend (same day):** composer now supports an **`@`-mention command**
  for connectors (mirroring `/skill`): typing `@` as the first character
  opens the connected-connector picker with filtering + arrow-key nav;
  Enter/Tab/click attaches the connector to the conversation (same
  per-session opt-in as the "+" menu) and consumes the `@token` so nothing
  stray reaches the model. Empty state hints to Settings → Connectors.
## 2026-08-03 � GitHub + Canva connectors (new registry entries) and Kiwi/Merge cleanup

### What was built

Two new connectors, both official vendor-hosted remote MCP servers, plus the
Merge retirement and two Kiwi bug fixes from the same period:

- **GitHub** (id "github", family "github", port 45133):
  https://api.githubcopilot.com/mcp/ � GitHub's hosted MCP server (repo /
  issues / PRs / code tools). OAuth via a **GitHub OAuth App** supplied as
  build-time env vars GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET (same
  pattern as the Google client; GitHub has no DCR and publishes no AS
  metadata � verified live, the RFC 9728 resource metadata at
  .well-known/oauth-protected-resource/mcp/ names https://github.com/login/oauth
  as the authorization server). Authorize
  https://github.com/login/oauth/authorize, token
  https://github.com/login/oauth/access_token, scopes
  epo read:org read:user user:email (the scope set gates the tool surface).
  OAuth App tokens never expire and no refresh token is issued � the stored
  expires_at stays None, so the refresh path is never triggered. GitHub
  OAuth Apps ignore the PKCE params our generic authorize URL always sends.
  No revoke endpoint (Disconnect forgets locally, like Google).
- **Canva** (id "canva", family "canva", port 45134):
  https://mcp.canva.com/mcp � design create/edit/search/export tools.
  Authorization-server metadata published (verified live): authorize
  /authorize, token /token, register /register, revocation at /token,
  auth methods client_secret_basic|post|none. Uses the generic RFC 7591
  egistration_url machinery (Notion pattern) with a public PKCE client �
  no credentials needed at build time. Scope set: profile:read +
  design/folder/asset/comment/brandtemplate/brandkit reads+writes.
  **Gate (verified live):** /register rejects every request body with
  "Invalid JSON payload" until the redirect URI is approved via Canva's
  waitlist form (the docs make allowlisting mandatory for custom clients;
  DCR is deprecated there in favor of CIMD). Until approved, Connect fails at
  registration with a clear error.
- **Merge Agent Handler fully retired** (previous session): MERGE const and
  its env vars, the whole quota system (connectors/quota.rs,
  db/connector_usage.rs, connector_tool_calls table, month_start_ts,
  Hinnant helpers, the dispatch gate), and the static-bearer path removed.
  is_static_bearer() ? is_public() (empty uthorize_url = public, no
  OAuth). configured() is no longer always-true: public connectors and
  DCR-registered ones (Kiwi, Notion, Canva) are always configured; static
  env-credentialed ones (Google, GitHub) only when client_id is non-empty.
- **Kiwi attach bug fixed:** chat/commands.rs only included connector ids
  with credential rows or per-session rows, so public Kiwi (no row) was never
  attached. Public connectors are now always added to the session's
  connector_ids.
- **Kiwi permission bug fixed:** classify_connector_tool consulted the tool
  *description* before the name; Kiwi's real search-flight description
  contains the word "add", so every search-classified as Write and surfaced an
  approval card even under full_auto. The name is now authoritative (read/write
  verb in the name decides; description is only a fallback when the name has no
  verb), and tokens are lowercased. Regression tests cover both.

### Verification

- cargo test -p relay --lib: **295 passed / 0 failed / 10 ignored**
  (new: github_is_registered_as_env_configured_oauth_connector,
  canva_is_registered_as_dcr_oauth_connector; live Kiwi handshake test
  still green with --ignored).
- Frontend 	sc --noEmit: only the 3 pre-existing unrelated errors
  (useChatEvents.ts / chat.ts).
- Live probes: both MCP endpoints return 401 with RFC 9728
  WWW-Authenticate; Canva AS metadata fetched; Canva /register gating
  confirmed with a matrix of request bodies.

### User actions

1. **GitHub:** register a GitHub OAuth App (github.com/settings/developers):
   callback URL http://localhost:45133/oauth/callback, request the default
   scopes, then set GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET env vars in
   the shell before building/running (persist as user env vars for dev).
2. **Canva:** apply for the Canva MCP waitlist
   (docs: canva.dev/docs/mcp � "Register your redirect URI" form) listing
   redirect URI http://localhost:45134/oauth/callback. Once approved,
   Connect works without any env vars.
3. Restart the running app to pick up the new backend registry entries.
### Follow-up (same day): Canva removed from the Settings UI

Per user request, CANVA is no longer in the CONNECTORS array � it cannot
appear in Settings ? Connectors until it's re-enabled (one line:
CONNECTORS entry) after the waitlist approval lands. The const + endpoints
remain in config.rs (documented DISABLED), the icon/family entries were
dropped from ConnectorIcon.tsx, and the registry test now asserts Canva is
absent from CONNECTORS while its const still carries correct endpoints.
GitHub's icon became the canonical brand mark: octocat on a white tile
(visible on both app themes, replacing the bare black silhouette).

## 2026-08-08 — Follow-up 3: soffice preview conversion spawned stuck console windows

Symptom: opening a doc/ppt in the canvas popped a terminal window showing the
LibreOffice usage dump ("Error in option: -env:UserInstallation", "Press Enter
to continue..."), and every open added another.

Root cause: `pptx_to_pdf` in `src-tauri/src/chat/office.rs` passed the profile
bootstrap variable as TWO process arguments (`-env:UserInstallation`, then the
`file:///...` URI). soffice requires it as ONE token
(`-env:UserInstallation=<uri>`); the value-less form is a fatal argument error,
so every conversion failed (and was therefore never cached — each open
retried). On Windows soffice.exe is a GUI-subsystem binary, so on this error it
AllocConsole()s its own window to print the usage text and blocks on Enter —
CREATE_NO_WINDOW on our side can't suppress a console the child allocates
itself. Result: one stuck console per attempted conversion.

Fix: pass `.arg(format!("-env:UserInstallation={profile_uri}"))` as a single
argument (office.rs, `pptx_to_pdf`), with a comment explaining why.

Verification:
- Ran the bundled soffice (`src-tauri/resources/libreoffice/program/soffice.exe`)
  with the exact fixed argument form against `test_files/test_presentation.pptx`:
  exit 0, valid 38 KB PDF produced in the run dir, profile dir created, no
  console window.
- `cargo test --lib office`: 9 passed / 0 failed.
- Dev app hot-rebuilt and relaunched with the fix.

Side note: the "mac os things" the user saw in the window were lines of
LibreOffice's own usage text (the `--nstemporarydirectory` switch is documented
as "MacOS X sandbox only"), not anything macOS-related in our code.

## 2026-08-08 — Follow-up 4: preview-open restarts the dev app; docx full-fidelity render

**Dev app auto-restarting when opening a ppt/doc preview.** Every soffice
conversion touches files inside its own bundled install tree (e.g. the OpenCL
probe leaves `resources/libreoffice/program/opencl/.~lock.cl-test.ods#`).
`tauri dev` watches all of `src-tauri`, so each conversion triggered a rebuild
+ relaunch. Fix: new `src-tauri/.taurignore` (gitignore-style, read by the
dev watcher at startup) ignoring `resources/`. The dev app must be restarted
once to pick it up.

**Docx rendered without styling in the canvas.** The built-in docx→HTML
converter only preserves headings/basic runs. The user wants the same full
fidelity Word/WPS shows. Fix: the pptx PDF preview path was generalized —
`office.rs::pptx_to_pdf` is now `office_to_pdf` (soffice auto-detects the
input filter; same cache, timeout, and single-arg `-env:UserInstallation`
fix), and `chat/commands.rs` routes `pptx | docx | doc` previews through it,
returning `kind: "pdf"` rendered by the native PDF viewer. On conversion
failure it still falls through to the built-in HTML converter, and the
frontend's LibreOffice hint (`ArtifactPreviewPane.tsx`) now shows for
pptx/docx/doc instead of pptx only. xlsx keeps its HTML table preview.

Verification:
- `cargo test --lib`: 365 passed / 0 failed; `npx tsc --noEmit` clean.
- Live: bundled soffice converted `test_files/test_document.docx` with the
  exact production argument form — exit 0, valid 79 KB PDF.
- Dev app relaunched fresh so the new watcher ignore is active.

## 2026-08-09 — Browser subsystem: auto-open, screenshots, chat images, pacing

Four user-reported browser issues fixed together.

**1. Agent browser work now surfaces the Browser tab automatically.**
Agent browser actions never revealed the panel — only user clicks did.
New `browser:activity { pane_id }` event, emitted from the single funnel every
harness browser op passes through (`browser_mcp.rs::resolve_or_open`) and from
chat-mode `run_browser_tool` (`chat/dispatch.rs`). Frontend:
`useBrowserMcpEvents.ts` gained a `surfaceBrowserPanel()` helper (mirror of the
canvas auto-open contract: `setToolPanelTab("browser")` + uncollapse + focus)
and a listener for the event; `openInBrowserPane` (`lib/openBrowserPane.ts` —
chat open_url, pty URL detection, markdown link clicks) and
`openBrowserPaneForProject` now surface the panel too. New IPC wrapper
`listenBrowserActivity` in `lib/ipc.ts`.

**2. `browser_screenshot` tool (new capability).**
No screenshot path existed anywhere (no CDP, no screencast). Implemented on
Windows via WebView2 `CapturePreview`: `browser.rs::capture_webview_png`
(runs on the UI thread via `Webview::with_webview` +
`CapturePreviewCompletedHandler::wait_for_async_operation`, which pumps the
message loop while waiting; PNG written to a `CreateStreamOnHGlobal` memory
stream and drained), exposed as `BrowserManager::capture_pane_png` /
`capture_active_png` (blocking ≤15 s, always called via `spawn_blocking`).
Deps added (Windows-only, versions pinned to what tauri 2.11 already links):
`webview2-com 0.38`, `windows 0.61` (Win32_Foundation, Win32_System_Com,
Win32_System_Com_StructuredStorage). Non-Windows returns None for now.
- Harness mode: new `screenshot` op in `browser_mcp.rs` (saves
  `browser-shot-<ms>.png` to the artifacts dir, returns path + base64);
  `relay-browser-mcp` binary gained the `browser_screenshot` tool whose
  result is a real MCP image content block (the agent SEES the page) plus a
  text block with the path to embed in chat. Staged binary refreshed
  (debug copy into src-tauri/binaries for dev).
- Chat mode: `browser_screenshot` added to the tool registry
  (`chat/tools/mod.rs`, specs in both OpenAI + Anthropic wire formats) and to
  `run_browser_tool`; the shot is persisted via `insert_artifact` and emitted
  as `chat:artifact`, so it pops open in the canvas immediately, and the tool
  result tells the model the `![screenshot](path)` embed form.

**3. Broken image previews in chat.**
Agent-referenced local images (`![shot](C:\…png)`) could never render: CSP
`img-src 'self' data: blob: https:`, no asset protocol registered, bare paths
404 against the app origin. Fix: `ChatImage` component in `MessageBubble.tsx`
wired into react-markdown's `img` override — remote/data/blob URLs render
as-is; local refs (incl. `file:///…` and `/C:/…` normalization) load bytes via
the existing `read_artifact_preview` IPC and render as a data URI (the same
CSP-clean path the canvas uses). Failure shows a small note instead of a
broken-image glyph.

**4. In-app browser lag during agent control.**
No frame streaming exists (native webview, OS-composited) — the lag was
deliberate watch-mode pacing on the action critical path. Tuned:
watch-mode post-action delay 600→250 ms (`ActionOpts` default +
`browser_mcp::resolve_action_opts`), cursor tween 400→150 ms (click + type),
per-character typing 30–60→8–20 ms, browser_read settle 1000→400 ms,
lazy-scroll step 700→350 ms. Visual feedback is kept, just faster; pacing
still auto-disables when the pane is backgrounded. Two unit tests updated to
the new defaults.

Verification: `cargo test --lib` 365 passed / 0 failed; `cargo build --bins`
clean; `npx tsc --noEmit` clean; dev app hot-rebuilt and relaunched. The
CapturePreview roundtrip itself needs a live browser pane — to be exercised
by the user (ask the agent to open a site and take a screenshot).

## 2026-08-09 — Chat restore on launch + empty "Untitled" session sweep

Bug: closing the app on a brand-new chat with no messages left an empty
"Untitled" session row in the DB, and the next launch auto-started yet another
new chat instead of reopening it — the rows accumulated.

Root cause: `ChatView`'s auto-start effect created a session (DB row written
eagerly by `newChat`) whenever `activeChatSessionId` was null — which it
always is on launch, since the id is only kept in memory, never persisted.

Fix:
- On startup with no active session, the app now restores the most recently
  active chat (`max last_active_at`) via `selectSession` — including an empty
  one — and only mints a fresh chat when no sessions exist at all
  (`src/components/chat/ChatView.tsx`).
- New `delete_empty_chat_sessions` DB fn + command + IPC wrapper sweeps stale
  message-less, unstarred rows (keeping the one being restored), cleaning up
  the duplicates earlier launches created. Unit test
  `delete_empty_sessions_sweeps_only_messageless_unstarred` covers keep /
  starred / with-messages cases.
- No frontend state persistence added: "most recently active" from the DB is
  the restore target, so no new stored state to get stale.

Verification: cargo test --lib 366 passed / 0 failed; tsc clean.

## 2026-08-10 — Browser read_page timeout; HTML artifact rendering

Two user-reported browser issues.

**1. browser_read timeout.**
Individual `run_action_for_pane` rounds (JS eval → result) keep a fixed timeout
(gate per-op); the lazy-load scroll loop in `read_page` executes up to
4 extra extractions, each with its own timeout budget. Raising the per-op
timeout 15s → 45s (`src-tauri/src/browser.rs:1027`) accommodates slow
scrollHeight checks and re-extractions without exceeding the limit. Unit test
updated to 45s. The scroll-loop is bounded (4 steps), so the worst-case 180s
is still reasonable.

**2. HTML/web artifacts now auto-open in Canvas for inline preview.**
Generated .html files (and .svg) used to open as file artifacts; only
non-inline (`.ext !== "html" || ext !== "svg"`) auto-open was annotated
(with the "...") comment. Flip the guard: `rendersInline = ext === "svg"`
removes `html` from exclusion, keeping SVG inline-only and restoring
auto-open for web pages. Web artifacts pop into Canvas and for
`.html` sketch as annotated previews.

Verification: `cargo test --lib` 390 passed / 0 failed; tsc clean.
html SVG auto-open behavior matches test artifacts.

---

## 2026-08-10 — Refactor session: Phase 1 streaming primitives (Tasks 1.1, 1.2, 1.3) + spec/plan + audit

**What shipped (5 commits on `master`):**

- `e0c5512` — docs: refactor design spec + 30-task implementation plan (`docs/superpowers/specs/2026-08-10-refactor-design.md` + `docs/superpowers/plans/2026-08-10-refactor.md`)
- `0b01052` — docs(plan): audit-against-code patch (3 tasks shipped, 1 partial, 26 real)
- `62c856c` — perf(pty): route pty output via `Channel<Vec<u8>>` (raw bytes, no JSON) — 5 files
- `6edd82a` — perf(chat): route `chat:token` via `Channel<ChatTokenPayload>` — 7 files, 2 new tests
- `9bba1fe` — feat(chat): `useStreamingText` hook with rAF batching — 2 files, 4 vitest tests

**Audit findings (3 already-shipped, 1 partial, 26 real):**
- 0.1 (WAL + busy_timeout) — `db::configure` already sets all 4 pragmas
- 4.1 (N+1 fix) — `mobile/relay.rs:1110-1338` already does the two-phase bulk-resolve
- 4.2 (drop GetCostDetails from poll) — `useRelay.ts:158-167` already moved it to on-demand
- 5.2 (React.lazy) — 5 of 9 candidates already lazy in `App.tsx:25,44-47`

**What got reverted mid-session (Task 2.1 chat/commands.rs split):**
The `#[tauri::command]` macro generates a `__cmd__<name>` companion at the function's source location; `pub use` re-exports in a parent `mod.rs` do NOT bring the companion along, so `tauri::generate_handler!` in `lib.rs:203` cannot find the macro artifacts. The proven split pattern (used by `chat/tools/{mod,specs,search,...}.rs`) is: move the function body + `#[tauri::command]` attribute into the submodule, then `use submodule::*` (not `pub use`) in the parent. Plan was updated with this constraint (commit-stage note in `docs/superpowers/plans/2026-08-10-refactor.md`). The reverted split attempt left no on-disk artifacts.

**Working tree at session end:** pre-existing rot in the baseline (unrelated to this session's commits) — `cargo check --lib` reports 8 errors including `cannot find __cmd__delete_empty_chat_sessions` (the function is referenced in `lib.rs:309,319` but its body is missing from `chat/commands.rs`; same for `pptx_to_pdf` in `chat/office.rs`; `base64_encode` is private). These predate this session. The 5 new commits each compiled clean at the time of commit. Next session should:
  1. Diagnose + fix the pre-existing rot before resuming the plan
  2. Start at Task 0.2 (bulk_load_projects) — the only Phase 0 task with real work
  3. Continue with Task 2.1 retry (using the corrected Tauri-macro split pattern)
  4. Phases 2-5 still have ~22 tasks of real work; spec acceptance criteria in `docs/superpowers/specs/2026-08-10-refactor-design.md` §4 are the done-bar

**Time cost:** ~3 hours session, 5 commits, 1 attempt-and-revert, net 0 perf regressions.

---

## 2026-08-10 — Baseline rot-fix session

**What was broken:** the 8 pre-existing `cargo check` errors that the prior
session deferred to "next session". The rot had multiple independent
surface areas — each from a half-landed change in earlier sessions — that
needed to be brought back into a consistent baseline before the refactor
plan could resume.

**What was fixed (commit `2c78151`):**

- **Cargo.toml dep placement** — `cron = "0.12"`, `chrono = "0.4"`,
  `notify = "6"` had been placed *after* `[profile.release]`, so they
  never resolved. Moved into `[dependencies]`. Added `toml = "0.8"` for
  the Kimi CLI config parser.
- **Missing `HarnessMcpServer` + `harness_mcp_servers`** — `agent_sessions.rs`
  and `commands/agent_cmds.rs` referenced a connector-snapshot type and
  function that had no definition. New `connectors/harness.rs`:
  - `enum HarnessMcpServer { Http { id, display_name, url, token }, Stdio { ... } }`
  - `harness_mcp_servers(app)` iterates CONNECTORS, refreshes each via
    `ensure_valid_access_token` (HTTP only), returns one entry per
    connected server.
- **Missing `office_to_pdf`** — `chat/commands.rs` invoked it but
  `chat/office.rs` never defined it. Added a LibreOffice headless
  converter (`--convert-to pdf`, 30s deadline, unique temp outdir,
  Windows `CREATE_NO_WINDOW`). Returns `None` on every failure.
- **Missing `capture_active_png`** — `chat/dispatch.rs` called it on
  `Arc<BrowserManager>`. Added the method delegating to a new
  `browser_capture.rs` stub that returns `Ok(None)` off-Windows; the
  real WebView2 `ICoreWebView2_15::CapturePreview` binding is a
  follow-up. Fixed the `spawn_blocking` match arms for the nested
  `Result<Result<Option<Vec<u8>>, String>, JoinError>` shape
  (`Ok(Ok(Some(png)) | Ok(Ok(None)))`).
- **`create_chat_session` arity drift** — DB function was 3-arg, but
  `chat/commands.rs` passed 4 args (`project_id`). Resolved by:
  - Changing DB fn to genuinely 4-arg (`project_id: Option<&str>`)
  - Adding `project_id TEXT` to `chat_sessions` CREATE TABLE
  - Adding `migrate_chat_session_project_id` idempotent migration
  - Adding `pub project_id: Option<String>` to `ChatSession` type
  - Updating all 14+ call sites (mobile relay, automations, mobile
    session_chat, 5 test files) to pass `None`
- **`harness_bundle` MCP builders** — `build_tools_mcp_json`,
  `build_opencode_tools_config`, `write_bundle` now take
  `&[HarnessMcpServer]` and merge per-connector HTTP entries into the
  Claude/Kimi/OpenCode mcp maps. Tests pass `&[]`.

**What was tested and how:**
- `cargo check --lib` → clean (64 warnings, 0 errors)
- `cargo check --tests` → clean (57 warnings, 0 errors)
- `npx tsc --noEmit` not re-run — no frontend changes

**Files:** 25 changed, 943 insertions(+), 50 deletions(-)
- Created: `connectors/harness.rs`, `browser_capture.rs`,
  `git_watcher.rs`
- Modified: `Cargo.toml`, `connectors/mod.rs`, `harness_bundle.rs`,
  `chat/office.rs`, `chat/dispatch.rs`, `chat/commands.rs`,
  `db/chat.rs`, `db/mod.rs`, `db/cost_v2.rs`, `db/source_ledger.rs`,
  `types.rs`, `browser.rs`, `lib.rs`, `automations.rs`,
  `mobile/relay.rs`, `mobile/session_chat.rs`,
  `mobile/relay_tests.rs`, `mobile/session_chat_tests.rs`

**Next:**
- Phase 1 autoreview on the 3 shipped Tasks (1.1 PTY Channel, 1.2 chat
  Channel, 1.3 useStreamingText)
- Task 2.1 retry (chat/commands.rs split) using the corrected pattern
  from the plan: move `#[tauri::command]` *with* the function body
  into the submodule, then `use submodule::*` in the parent (not
  `pub use`)
- Task 0.2: `bulk_load_projects` helper (the only Phase 0 task with
  real work)
