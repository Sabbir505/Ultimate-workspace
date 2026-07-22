# Conduit Build Log

Running log per PRD §13.3: what was built, what was tested and how, assumptions/deviations, known issues.

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
