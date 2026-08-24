# Conduit — Project Understanding & Improvement Plan

> A codebase-wide tour of **Conduit v0.4.1** (a local-first, multi-pane desktop shell for AI coding agents), written from a direct read of the source tree on **2026-08-23**. It ends with a concrete list of bugs, improvements, and new-feature ideas ranked by value.

---

## 1. What Conduit is

Conduit is a **desktop orchestration shell** — *not* a code editor and *not* an agent framework. It wraps existing AI coding agent CLIs (**Claude Code**, **Kimi Code**, **OpenCode**) so a developer can:

- open any local project folder,
- run up to **6 agent sessions at once** in tiled, resizable **PTY panes**,
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
| Frontend | **React 18 + TypeScript**, **Zustand** stores, Tailwind + a 180+ KB hand-written `global.css` theme system |
| Terminal | **xterm.js** + `portable-pty` (ConPTY on Windows) |
| Persistence | **SQLite** (rusqlite, WAL mode) — projects, sessions, chat messages, cost events, skills, settings, artifacts, automations, doc corpora |
| Secrets | **OS keychain** via `keyring` (Windows Credential Manager / macOS Keychain / Linux Secret Service) |
| LLM chat | reqwest → Anthropic / OpenAI / OpenRouter / OpenAI-compatible endpoints; local **llama-server** (GGUF) sidecar |
| Git | shells out to the `git` binary + a Rust **filesystem watcher** (`notify`) for event-driven status |
| Connectors | **OAuth 2.0 + remote MCP** (Notion, GitHub, Google family, Gmail, Kiwi) — vendor-hosted MCP servers, plus REST fallbacks |
| Docs/artifacts | Bundled **Python** (python-docx/pptx, openpyxl, reportlab) + bundled **LibreOffice** (pptx→pdf preview) |
| Mobile | **React Native / Expo** companion app |
| Distribution | NSIS installer + **signed auto-updates** from GitHub Releases (`latest.json`) |

---

## 3. High-level architecture

The app has **226 IPC commands** registered in `src-tauri/src/lib.rs`, organized into:
- **Project/Session commands** (11): CRUD for projects and sessions
- **PTY/Harness commands** (11): spawn, write, resize, kill, memory, install harness, login, subscribe
- **Browser commands** (26): create, navigate, push state, actions, close, panes, devtools, register/unregister
- **Git commands** (16): status, diff, log, branch, commit, push, worktree, diff, file diff
- **Chat/Automation commands** (155+): token handling, tools, prompts, providers, dispatch, streaming, compaction
- **Data commands** (40): settings, skills, quick actions, secrets, cost, budgets, exports, workspaces
- **Infrastructure commands** (35+): connectors, local models, market, updater, mobile relay, docs index, GitHub PRs, MCP gallery

**Database:** 21 tables in `src-tauri/src/db/mod.rs` (13 migration modules). Key tables:
- `projects`, `sessions`, `chat_sessions`, `chat_messages` (with `superseded_by` for compaction)
- `artifacts` (30-day expiry), `cost_events`, `skills`, `quick_actions`, `workspaces`
- `automations`, `automation_runs`, `chat_checkpoints`
- `connector_credentials`, `chat_session_connectors`
- `doc_corpora`, `doc_files`, `doc_chunks`, `chat_documents` (RAG support)

---

## 4. Backend map (`src-tauri/src/`)

| Module | Role | Notes |
|---|---|---|
| `lib.rs` | Entry point; manages shared state, registers **226 commands**, boot sequence, exit cleanup | Kills every child PTY/browser/stream/sidecar on quit |
| `commands/` | Thin Tauri command wrappers | Verifies project-path allowlists before git/file ops |
| `pty/` | Pane lifecycle, writer+reader+waiter threads, URL detection | Panes only die on explicit close or quit |
| `browser.rs` | Native child-webview panes + tabs; bounds synced from frontend | Windows/macOS: `add_child`; Linux: iframe fallback |
| `browser_mcp.rs` | Loopback MCP server for agent-driven browser control | 10 browser ops + conduit tools |
| `chat/` | Large command module (650+ lines), streaming, dispatch, permission, providers, tools | 4 providers; 32+ tools; context compaction |
| `agent_sessions.rs` | Headless CLI chat, one-shot runs for automations | Normalizes to `chat:*` events |
| `git.rs` + `git_watcher.rs` | Git wrapper + filesystem watcher | 90 s timeout, event-driven `project:fs-changed` |
| `connectors/` | OAuth flows, credential storage, remote MCP client | Per-conversation opt-in |
| `automations.rs` | Cron scheduler (30 s tick) + run ledger | `bin/conduit_automation.rs` for Task Scheduler |
| `db/` | SQLite schema + migrations (13 modules) | WAL; additive migrations; 30-day artifact sweep |
| `mobile/` | WS relay, session-chat mirroring, pairing auth | Phone never holds keys |
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
| `state/` | Zustand stores — `chat.ts` (1400+ lines), `panes.ts`, `projects.ts`, `ui.ts`, `settings.ts`, `artifacts.ts`, `updater.ts`, `connector.ts`, `localModel.ts`, `automations.ts`, `skills.ts`, `workspace.ts` |
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

## 7. Testing & quality status

- **Frontend:** 59 vitest test files in `src/test/` → **407 tests passing**
- **Backend:** Rust lib tests 502 + browser-mcp 4 + smoke 1 → **507 tests passing**
- **TypeScript:** `tsc --noEmit` clean
- **Build:** `vite build` passes, entry chunk 336 KB raw / 108 KB gzip

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
| 7 | **Mobile relay binds 0.0.0.0** | `mobile/relay.rs` | Default to 127.0.0.1 with opt-in |
| 8 | **`Modal` accessibility** — no focus trap / ESC | `Modal.tsx` | Add a11y handling |
| 9 | **Hardcoded 250 ms submit delay** | `lib/ipc.ts` | Make configurable or event-driven |

---

## 9. Bugs worth fixing (ranked)

1. **Add CI job for tests** — `build.yml` never runs tests; a regression can slip into a signed release.
2. **Fix CSS encoding** (`global.css` mojibake) — cheap, improves AI passes.
3. **Make mobile relay localhost-only by default** with explicit LAN toggle.
4. **Sandbox `run_code` on Windows** with Job Object + drop privileges.
5. **Reuse MCP sessions** across turns (token lifetime caching).
6. **Add per-turn chat timeout** (configurable).
7. **Modal accessibility** — focus trap, ESC close, `aria-modal`.
8. **Live model catalog** — finish the "refresh from CLI" path or move pricing to config.

---

## 10. Improvements (engineering & UX polish)

1. **Root `README.md`** — port essentials from `AI CONTEXT/README.md`.
2. **Global error surfacing** — failures should toast, not `console.warn`.
3. **Prune dead CSS rules** — the monolith has accumulated unused selectors.
4. **Message-list virtualization** — cap DOM at 500 messages with "load earlier".
5. **Full-text search** — SQLite FTS5 over all chats/projects.
6. **Budget alerts** — threshold notification for spend caps.
7. **Create PR from git sidebar** — drive `gh` or GitHub connector.
8. **More connectors** — Slack, Linear, Jira, Airtable, etc.
9. **Pop-out chats & panes** — Tauri multi-window support.
10. **Research-mode citation export** — BibTeX/markdown bibliography.

---

## 11. Getting started

```bash
npm install                 # frontend deps
npm run tauri dev           # dev (first Rust compile takes 10-20 min)
npm test                    # frontend tests (vitest)
cd src-tauri && cargo test  # backend unit tests
npm run tauri build         # release bundle (Windows NSIS)
```

Docs live in **`AI CONTEXT/`** (`PRD.md` = product spec, `CONTRACT.md` = IPC contract, `AI_CONTEXT.md` = canonical code map, `BUG_LIST.md` = audit trail, `RELEASE.md` = release/update flow).

---

*Written from a source-tree read on 2026-08-23. All metrics (226 commands, 21 tables, 59 test files, 407 tests) verified against current codebase.*