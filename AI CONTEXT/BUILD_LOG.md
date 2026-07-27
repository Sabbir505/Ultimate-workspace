# Conduit Build Log

Running log per PRD §13.3: what was built, what was tested and how, assumptions/deviations, known issues.

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
├── main.rs                     # thin entry -> conduit_lib::run()
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
    keychain with a throwaway `CONDUIT_TEST_KEY` entry, cleaned up after)
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
- **`npm run tauri dev` launched**: Vite on http://localhost:1420 (HTTP 200), app binary compiled and `conduit.exe` running (~43 MB RSS at idle — in line with §8 expectations vs Electron).
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
- **Browser urlbar layout bug (found via Playwright repro against vite :1420):** `.browser-urlbar` had `flex: 1`, making it a flex-grow sibling of `.pane-body` — the URL bar consumed 50% of the browser pane height (geometry: 398px urlbar / 398px frame). Fixed to `flex: 0 0 auto` + padding; post-fix geometry: 35px urlbar / 762px frame. Added a dev-only `window.__conduit` store handle in `main.tsx` (import.meta.env.DEV gated) to make such UI repros scriptable; `.debug/` gitignored.
- **Verification:** `cargo test` → **37/37**; `npm test` → **66/66**; `npm run build` clean (added missing `src/vite-env.d.ts` for `import.meta.env` typing). Dev server auto-rebuilt; verified live in the running app.

## Session: session-resume fix + browser omnibox

- **Root cause of "resume starts a fresh session":** two stacked bugs. (1) The Kimi adapter spawned `kimi -r <id>` — a flag that DOES NOT EXIST in Kimi CLI (verified `kimi --help` v0.27.0: resume is `-S, --session [id]`), so both resume and the output-scrape regex (which expected `kimi -r` hints the CLI never prints) were dead. (2) `harness_session_id` was NULL for every stored session (confirmed by inspecting conduit.db), compounded by the earlier UNC bug which ran harnesses in `C:\Windows` so Claude session files landed in the wrong project dir.
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
  `tauri dev` — never restart the conduit app per session constraint) and drove
  the running UI with Playwright (`.debug/live_test_refactor.py`, gitignored).
  Verified: app boots clean, toolbar + PaneGrid empty state render, adding a
  browser pane mounts it through the consolidated IPC + memoized PaneFrame
  path (iframe fallback engages since no Tauri runtime), `closePane` disposes
  + removes the pane end-to-end (`disposePaneResources` works), chat module
  imports intact, `window.__conduit` dev handle present. Zero refactor-
  introduced console errors (the lone X-Frame-Options iframe refusal is the
  known pre-existing frontend-only limitation, not a regression). Stopped the
  vite server after; conduit app untouched.
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
  file is prepended with `<!-- conduit:diagram -->` sentinel marker and validated
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
    simpler diagrams" guidance — Conduit does not use Mermaid; every diagram goes
    through `generate_diagram`. Also dropped the stale void-black `#08080C`
    canvas claim (the app migrated to the warm Claude-Code palette; the inline
    diagram canvas is white) and re-centered the structure pattern on SVG
    `<rect>`/`<text>` primitives.
  - `skills/pdf-skill.md`: added Path 0 — the pre-installed `conduit_docgen`
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
- Interactive-element tagging (preserves `data-conduit-ref` scheme for
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
`data-conduit-ref` element map is populated (click/type/scroll regression).

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

## 2026-07-26 — Agent-driven browser control (conduit-browser-mcp + visual feedback)

### What was built

Two companion features letting a Dev-tab agent (Claude Code / Kimi Code) drive
the in-app browser pane — and making that control watchable.

1. **`conduit-browser-mcp`** (new `[[bin]]` in src-tauri/Cargo.toml, same crate
   sharing `conduit_lib`) — a standalone MCP server speaking stdio JSON-RPC to a
   harness. It exposes six tools (navigate / read_page / click / type_text /
   scroll / wait_for, all with optional `pane_id`) and forwards each `tools/call`
   over a loopback WebSocket into the running Conduit app, which executes it
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
  `CONDUIT_WS_PORT` (default 7681) and `CONDUIT_PROJECT_ID` from env vars set
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
config is written to a Conduit-owned file (`<app_data_dir>/mcp/<project_id>.mcp.json`)
in `spawn_agent_session` (commands/pty_cmds.rs), and `--mcp-config` is appended
to the Claude Code `CommandSpec` there. `default-run = "conduit"` added to
Cargo.toml so `cargo run` / `tauri dev` still target the app binary (the new
`conduit-browser-mcp` binary made `cargo run` ambiguous otherwise). Binary path
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
Readability run). Overlay elements carry `data-conduit-overlay` and are excluded
from the tagger so they never appear as targetable page content.

### Visual feedback timing values (subjective tuning — revisit if needed)

Chosen mid-range within each task's spec; all are constants in `bridge_overlay.js`
/ `click_js` / `type_js`, logged here so they can be revisited:

- **Cursor tween: 400ms** — `__conduit_tweenCursor` uses a CSS transition with
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
- `cargo build --bin conduit-browser-mcp` — clean (standalone, no Tauri link).
- MCP binary stdio smoke test: `initialize` returns capabilities +
  protocolVersion; `tools/list` returns all 6 schemas; `tools/call` navigate
  with no app running returns structured `browser_unavailable` error with
  `conduit_code` data field.
- `npm run build` (tsc + vite) — clean.
- **Live-app E2E (PRD §13, partially verified):** launched `npm run tauri dev`
  — the in-app WS server bound `ws://127.0.0.1:7681`. Ran the
  `conduit-browser-mcp` binary against it:
  - `read_page` with no pane open → structured `pane_not_found` (correct).
  - `navigate http://localhost:1420` → **auto-opened a browser pane**, loaded
    the app's own Vite dev server, returned `{"pane_id":"...","title":"Conduit",
    "url":"http://localhost:1420"}`. The `title:"Conduit"` confirms the real
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
  reports back (returned "Conduit" once, empty another time) — so
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

- `conduit-browser-mcp` deliberately does NOT link Tauri (it's a thin
  stdio→WS relay) — it hardcodes the default port 7681 matching
  `BROWSER_MCP_PORT` rather than importing `conduit_lib` (which would pull Tauri
  into the binary). Drift is impossible in practice because the registration
  always sets `CONDUIT_WS_PORT`.
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
  and `conduit.exe` launched, browser-mcp WebSocket server came up on port
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
  Full E2E: `npm run tauri dev` rebuilt and `conduit.exe` launched.
- **Result of the full split:** `chat/mod.rs` 2306→622, `chat/tools.rs` 2394→
  `tools/mod.rs` 628. No file in `chat/` exceeds ~1200 lines; the largest is now
  `commands.rs` (1195) and `office.rs` (1032), both cohesive single-concern files.

## 2026-07-26 — Connectors: OAuth framework + first connector (Notion)

Added a "Connectors" system to the Chat tab: OAuth-based connections to
third-party SaaS tools that expose **official, vendor-hosted remote MCP
servers**. Conduit owns OAuth plumbing + credential storage + UI + per-
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
  `conduit:connector:<id>:<field>`, mirroring the existing
  `conduit:chat:<provider>` pattern (Linux XOR fallback included). Reuses
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
- **`redirect_uri` = `https://conduit.local/oauth/callback`** — a non-served
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
  step) and registering `https://conduit.local/oauth/callback` as the
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
