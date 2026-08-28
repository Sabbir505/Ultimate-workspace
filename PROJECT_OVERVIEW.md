# Relay — Project Understanding & Improvement Plan

> A codebase-wide tour of **Relay v0.4.1** (a local-first, multi-pane desktop shell for AI coding agents), written from a direct read of the source tree on **2026-08-27**. It ends with a concrete list of bugs, improvements, and new-feature ideas ranked by value.

> **Note on naming.** "Relay" is the user-visible product name (window title, `package.json` name, `tauri.conf.json` `productName`, `<title>`, sidebar/banner/HTML strings). The Rust crate name, the bundle identifier, the NSIS installer filename, the mobile app name, and the Windows scheduled-task name are still "Conduit" / `conduit` — the rebrand (`e9abc7c3`) was deliberately limited to user-facing surfaces to avoid orphaning existing Task Scheduler registrations, breaking the bundle id on installed systems, or invalidating the updater signing key. See `AI CONTEXT/RELEASE.md` for the rationale. Where this doc refers to **the product**, it means Relay. Where it refers to the crate, the bundle id, the installer, the mobile app, or the task scheduler entry, it means **Conduit**.

---

## 1. What Relay is

Relay is a **desktop orchestration shell** — *not* a code editor and *not* an agent framework. It wraps existing AI coding agent CLIs (**Claude Code**, **Kimi Code**, **OpenCode**) so a developer can:

- open any local project folder,
- run up to **6 agent sessions at once** in tiled, resizable **PTY panes** (`MAX_PANES = 6` in `src/state/panes.ts:20`),
- resume any session later by its harness session id,
- talk to LLMs directly through a built-in **Chat tab** (streaming HTTP/SSE, tool calling, artifact generation),
- see live git state, diffs, commits, branches, and AI-proposed plans in a dedicated git sidebar,
- browse what the agent built in **native webview browser panes**,
- manage local **GGUF models** via a Hugging Face "market",
- schedule **automated cron runs** that fire even while the app is closed,
- control it all from a **React Native mobile companion** over a localhost WebSocket relay (the phone never holds API keys).

Everything is **local-first** — SQLite on disk, OS-keychain secrets, child processes on the same machine, no cloud backend. (The one online dependency is the optional Hugging Face catalog and the GitHub Releases auto-updater.)

---

## 2. Tech stack

| Layer | Technology |
|---|---|
| Shell | **Tauri v2** (Rust backend + system webview), window vibrancy (acrylic on Windows, frosted on macOS) |
| Frontend | **React 18 + TypeScript**, **Zustand** stores, Tailwind + a hand-written `global.css` theme system (split into feature files + 23-line aggregator) |
| Terminal | **xterm.js** + `portable-pty` (ConPTY on Windows) |
| Persistence | **SQLite** (rusqlite, WAL mode — `PRAGMA journal_mode=WAL` at `src-tauri/src/db/mod.rs:117`) — projects, sessions, chat messages, cost events, skills, settings, artifacts, automations, doc corpora |
| Secrets | **OS keychain** via `keyring` (Windows Credential Manager / macOS Keychain / Linux Secret Service), with an XOR-obfuscated SQLite fallback when the Secret Service is unavailable |
| LLM chat | reqwest → Anthropic / OpenAI / OpenRouter / OpenAI-compatible endpoints; local **llama-server** (GGUF) sidecar |
| Git | shells out to the `git` binary + a Rust **filesystem watcher** (`notify`) for event-driven status |
| Connectors | **OAuth 2.0 + remote MCP** (Notion, GitHub, Google family, Gmail, Kiwi) — vendor-hosted MCP servers, plus REST fallbacks |
| Docs/artifacts | Bundled **Python** (python-docx/pptx, openpyxl, reportlab) + bundled **LibreOffice** (pptx→pdf preview) |
| Mobile | **React Native / Expo** companion app (Expo SDK 57, RN 0.86, React 19) |
| Distribution | NSIS installer (Windows-only) + **signed auto-updates** from GitHub Releases (`latest.json`) |

---

## 3. High-level architecture

The app registers **235 IPC commands** in `tauri::generate_handler!` at `src-tauri/src/lib.rs:239-494` (236 total `#[tauri::command]` attributes across the backend, one of which is the deprecated `pty_subscribe` retained for compatibility). The handlers are organized into:

- **Project/Session commands** (10): CRUD for projects and sessions
- **PTY/Harness commands** (11): spawn, write, resize, kill, memory, install harness, login, subscribe
- **Browser commands** (15): create, navigate, push state, actions, close, panes, devtools, register/unregister
- **Git commands** (16): status, diff, log, branch, commit, push, worktree, diff, file diff
- **Chat/Automation commands** (≈70): token handling, tools, prompts, providers, dispatch, streaming, compaction
- **Data commands** (≈40): settings, skills, quick actions, secrets, cost, budgets, exports, workspaces
- **Infrastructure commands** (≈40): connectors, local models, market, updater, mobile relay, docs index, GitHub PRs, MCP gallery, speech

**Database:** 21 tables declared in `src-tauri/src/db/mod.rs` (22 `CREATE TABLE` lines, one of which is a duplicate inside a test). Migrations are **inline `migrate_*` functions** in the same file — 12 top-level entries (`migrate_unc_paths`, `migrate_chat_fts`, `migrate_chat_session_flags`, `migrate_chat_session_watch_mode`, `migrate_chat_session_permission_mode`, `migrate_chat_session_policies`, `migrate_chat_session_worktree`, `migrate_chat_session_agent`, `migrate_chat_session_project_id`, `migrate_artifacts_message_id`, `migrate_chat_messages_superseded`, …) plus several follow-up `_v2`/rename migrations in the same module. They are **not** separate migration modules.

Key tables:
- `projects`, `sessions`, `chat_sessions`, `chat_messages` (with `superseded_by` for compaction)
- `artifacts` (30-day expiry), `cost_events`, `skills`, `quick_actions`, `workspaces`
- `automations`, `automation_runs`, `chat_checkpoints`
- `connector_credentials`, `chat_session_connectors`
- `doc_corpora`, `doc_files`, `doc_chunks`, `chat_documents` (RAG support)

---

## 4. Backend map (`src-tauri/src/`)

| Module | Role | Notes |
|---|---|---|
| `lib.rs` | Entry point; manages shared state, registers **235 commands** (handler macro at lines 239-494), boot sequence, exit cleanup | Kills every child PTY/browser/stream/sidecar on quit |
| `commands/` | Thin Tauri command wrappers | Verifies project-path allowlists before git/file ops |
| `pty/` | Pane lifecycle, writer+reader+waiter threads, URL detection | Panes only die on explicit close or quit |
| `browser.rs` | Native child-webview panes + tabs; bounds synced from frontend | Windows/macOS: `add_child`; Linux: iframe fallback |
| `browser_mcp.rs` | Loopback MCP server for agent-driven browser control | 10 browser ops + conduit tools; 4 unit tests |
| `chat/` | Large command module, streaming, dispatch, permission, providers, tools (split across `commands.rs`, `dispatch.rs`, `prompts.rs`, `proto.rs`, `streaming.rs`, `tasks.rs`, `python_runtime.rs`, `pygen.rs`, `local_models.rs`, `tools/`) | 4+ providers; 30+ tools; context compaction |
| `agent_sessions.rs` | Headless CLI chat, one-shot runs for automations | Normalizes to `chat:*` events |
| `git.rs` + `git_watcher.rs` | Git wrapper + filesystem watcher | 90 s timeout, event-driven `project:fs-changed` |
| `connectors/` | OAuth flows, credential storage, remote MCP client | Per-conversation opt-in |
| `automations.rs` + `bin/conduit_automation.rs` | Cron scheduler (30 s tick) + run ledger; standalone sidecar for Task Scheduler | Sidecar is intentionally still named `conduit-automation` to match the existing `ConduitAutomations` task-scheduler registration |
| `db/mod.rs` | SQLite schema + 12+ inline `migrate_*` functions | WAL + NORMAL sync; additive migrations; 30-day artifact sweep |
| `mobile/` | WS relay, session-chat mirroring, pairing auth, E2E encryption (HKDF + XChaCha20-Poly1305) | Phone never holds keys |
| `secrets.rs` | Keychain wrapper with XOR-fallback | |
| `docs_index.rs` | RAG document embedding and search | gptq, sentence-transformers |
| `github.rs` | GitHub REST API helper | PR CRUD, branches, checks |
| `mcp_gallery.rs` | Bundled MCP server registry | Install/connect/disconnect |
| `speech.rs` | Speech-to-text transcribe | |

---

## 5. Frontend map (`src/`)

| Area | Purpose |
|---|---|
| `App.tsx` | Shell layout; lazy overlay views (Settings, Skills, Cost, Automations); bootstrap hooks |
| `state/` | Zustand stores — `chat.ts`, `panes.ts`, `projects.ts`, `ui.ts`, `settings.ts`, `artifacts.ts`, `updater.ts`, `connector.ts`, `localModel.ts`, `automations.ts`, `skills.ts`, `workspace.ts` |
| `hooks/` | Event wiring, plan tracking, syntax theme, model download, cost rollups |
| `components/` | ChatView, MessageBubble, ChatComposer, Git sidebar, panes, sidebar, cost dashboard, settings, automations, command palette, peek |
| `lib/` | `ipc.ts` (1500+ lines), session launcher, diff parser, plan parser/matcher, sanitize, syntax highlighting, model labels, keybindings, fuzzy search |
| `styles/` | Split CSS modular files + `global.css` aggregator (23 lines) |

---

## 6. IPC Contract

- **Location:** `src/lib/ipc.ts` (1500+ lines), `AI CONTEXT/CONTRACT.md`
- **Patterns:** `safeInvoke` / `safeListen` wrappers, TypeScript interfaces for all commands/events
- **Events:** `pty:output`, `chat:token`, `chat:done`, `chat:artifact`, `project:fs-changed`, `browser:url_detected`, `browser:navigated`, `cost:updated`, `automation:run-finished`, etc.

---

## 7. Testing & quality status (as of 2026-08-27)

| Gate | Result |
|---|---|
| `npm test` (vitest) | **68 test files / 460 tests passing** in 16.08s |
| `cargo test --lib` | **539 passed, 1 FAILED, 11 ignored** — `chat::commands::preview_tests::basename_walk_prefers_newest_match_and_skips_vendor_dirs` fails (assertion `older-shallow == newer-deep` at `src-tauri/src/chat/commands.rs:2759`) |
| `cargo test` (all targets) | Includes the lib failure above; smoke test passes |
| Browser-MCP tests | 4 passing (`src-tauri/src/browser_mcp.rs`) |
| Smoke test | 1 passing (`src-tauri/tests/smoke.rs`) |
| `npx tsc --noEmit` | **34 errors** — concentrated in `src/components/chat/GitToolsSidebar.tsx` (TS18046 on `step` / `t` / `sub` of type `unknown`) and `src/components/panes/ProgressPanel.tsx` (TS18046 on `t` of type `unknown`). The build emits a non-fatal `>500 kB` warning on multiple chunks. |
| `npm run build` | Passes in 36.08s; entry chunk `dist/assets/index-C98R2Vls.js` is **458.96 KB raw / 141.47 KB gzip**; several async chunks >500 KB (syntax 1.59 MB, babel 2.98 MB, flowchart-elk 1.45 MB, ArtifactPreviewPane 1.24 MB, mindmap 544 KB) |

**This is not a green build.** The `tsc` errors and the failing cargo test should be treated as Sev M and are tracked in `BUG_AUDIT.md`.

---

## 8. Known issues & acknowledged debt

| # | Issue | Where | Status |
|---|---|---|---|
| 1 | ~~**Per-session permission modes are unwired**~~ **RESOLVED** — wired via `ff0b812f` (2026-08-15): permission menu, approval cards, Claude Code stdio relay | `src/state/`, `src/components/chat/`, `src-tauri/src/chat/` | ✅ Fixed |
| 2 | **CSS encoding mojibake** — UTF-8 comments decoded as `â€”` etc. | `src/styles/global.css` | Re-encode |
| 3 | **Stale docs** — `project:fs-changed` event not documented | `AI CONTEXT/` | Update all docs |
| 4 | **`run_code` not OS-sandboxed** — TODOs for Job Object/Landlock | `codeexec.rs` | Mitigation via permission gating |
| 5 | **MCP session reuse** — sessions open every turn | `connectors/session.rs` | Add caching |
| 6 | **No per-turn chat timeout** | `chat/*` | Add configurable timeout |
| 7 | **Mobile relay binds 0.0.0.0** (legacy default) | `mobile/relay.rs` | Default to 127.0.0.1 with opt-in |
| 8 | **`Modal` accessibility** — no focus trap / ESC | `Modal.tsx` | Add a11y handling |
| 9 | **Hardcoded 250 ms submit delay** | `lib/ipc.ts` | Make configurable or event-driven |
| 10 | **`tsc --noEmit` is red** — 34 errors in `GitToolsSidebar.tsx` and `ProgressPanel.tsx` | `src/components/chat/GitToolsSidebar.tsx`, `src/components/panes/ProgressPanel.tsx` | Fix unknown-typed destructures |
| 11 | **`cargo test --lib` has 1 failure** — `preview_tests::basename_walk_prefers_newest_match_and_skips_vendor_dirs` | `src-tauri/src/chat/commands.rs:2759` | Regressed recently; investigate ordering/walk logic |

---

## 9. Bugs worth fixing (ranked)

1. **Fix the 34 `tsc` errors in `GitToolsSidebar.tsx` and `ProgressPanel.tsx`** — these are the canonical "TS18046: x is of type 'unknown'" anti-pattern; the fix is typing the destructured slices. A 30-line patch.
2. **Fix the failing cargo test** `basename_walk_prefers_newest_match_and_skips_vendor_dirs` — the assertion compares `older-shallow == newer-deep`, so the test is checking the right behavior but the code is doing it wrong (or the test fixture is wrong). Either direction, it's a one-liner.
3. **Add CI job for tests** — `.github/workflows/build.yml` never runs tests; a regression can slip into a signed release.
4. **Fix CSS encoding** (`global.css` mojibake) — cheap, improves AI passes.
5. **Make mobile relay localhost-only by default** with explicit LAN toggle.
6. **Sandbox `run_code` on Windows** with Job Object + drop privileges.
7. **Reuse MCP sessions** across turns (token lifetime caching).
8. **Add per-turn chat timeout** (configurable).
9. **Modal accessibility** — focus trap, ESC close, `aria-modal`.
10. **Live model catalog** — finish the "refresh from CLI" path or move pricing to config.

---

## 10. Improvements (engineering & UX polish)

1. **Root `README.md`** — port essentials from `AI CONTEXT/README.md`. (Now in place; see `README.md`.)
2. **Global error surfacing** — failures should toast, not `console.warn`.
3. **Prune dead CSS rules** — the monolith has accumulated unused selectors.
4. **Message-list virtualization** — cap DOM at 500 messages with "load earlier".
5. **Full-text search** — SQLite FTS5 over all chats/projects.
6. **Budget alerts** — threshold notification for spend caps.
7. **Create PR from git sidebar** — drive `gh` or GitHub connector.
8. **More connectors** — Slack, Linear, Jira, Airtable, etc.
9. **Pop-out chats & panes** — Tauri multi-window support.
10. **Research-mode citation export** — BibTeX/markdown bibliography.
11. **Finish the rebrand** — rename the Rust crate, the bundle id, the NSIS filename, the updater key filename, and the mobile app to "Relay". Each requires a migration step (bundle id change → reinstall; updater key change → key-pair regen; scheduled-task name change → unregister/re-register); the rebrand commit's note calls this out as a deliberate deferral.

---

## 11. Getting started

```bash
npm install                 # frontend deps
npm run tauri dev           # dev (first Rust compile takes 10-20 min)
npm test                    # frontend tests (vitest)
cd src-tauri && cargo test  # backend unit tests (currently 1 failing)
npm run tauri build         # release bundle (Windows NSIS)
```

Docs live in **`AI CONTEXT/`** (`PRD.md` = product spec, `CONTRACT.md` = IPC contract, `AI_CONTEXT.md` = canonical code map, `BUG_LIST.md` = audit trail, `RELEASE.md` = release/update flow). See `README.md` for the high-level orientation.

---

*Written from a source-tree read on 2026-08-27. Metrics verified against current codebase: 235 commands, 21 tables, 68 test files / 460 vitest tests, 539 + 1-failed cargo-lib tests, 34 tsc errors, 458.96 KB / 141.47 KB entry chunk.*
