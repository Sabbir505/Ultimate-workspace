# Product Requirements Document
## Codename: Relay
### A local-first, multi-pane desktop shell for AI coding agents

> **Naming note:** This PRD was written under the codename "Relay". The product was rebranded to "Relay" in user-visible surfaces on 2026-08-27 (commit `e9abc7c3`); the crate, bundle id, and other internal identifiers are still "Relay" — see `README.md` and `AI CONTEXT/RELEASE.md`. The requirements themselves are unchanged.

**Document purpose:** This PRD is written to be handed to an AI coding agent (Kimi Code CLI / Kimi K3, or Claude Code) as the primary build specification. It should be read top to bottom before any code is written. Where a decision is ambiguous, this document states the default to take rather than leaving it open.

---

## 1. Product Summary

Relay is a desktop application that lets a developer open any local project folder and run one or more AI coding agent CLIs (Claude Code, Kimi Code CLI) against it inside resizable, tiled panes — up to 6 at once — with full session history, session resume, a built-in browser for previewing dev servers, and a native macOS "Liquid Glass" visual style with light/dark themes.

It is **not** a code editor and **not** a fork of VS Code. It does not implement its own AI agent loop, diffing engine, or model inference. It is an orchestration shell: it spawns existing, already-authenticated CLI agent binaries as child processes inside pseudo-terminals, and gives the user a fast, persistent, multi-project interface around them.

**Primary user:** a solo full-stack developer running multiple concurrent projects (this app is being built for that exact use case first), who wants to:
- Jump between projects instantly without re-opening terminal windows and re-navigating directories
- Keep a permanent, searchable history of every agent session per project
- Run 2-3 agents concurrently (e.g. Claude Code on one project, Kimi Code on another, or both on the same project for comparison)
- See a live preview of what the agent just built without alt-tabbing to a browser
- Have this feel like a considered, native macOS app rather than a developer utility bolted together

---

## 2. Non-Goals (explicitly out of scope for v1)

- Not a text editor. No syntax-highlighted file editing surface (a lightweight **read-only** file/diff peek viewer is in scope — see §7.9 — but this is not Monaco, not a full editor).
- Not a VS Code fork. No extension API compatible with VS Code extensions.
- Not implementing inline "Tab" style autocomplete.
- Not implementing our own agent loop, tool-calling, or diff-application engine — we rely entirely on the CLI harness (Claude Code / Kimi Code) for that.
- No cloud sync, no multi-device account system, no hosted backend in v1. Fully local-first, single-machine.
- No third-party code-execution plugin marketplace in v1 (explicitly deferred — see §12).

> **Implementation note (v0.3.0+):** A **mobile companion app** ships alongside the desktop build (React Native / Expo). It is a client-only UI over a localhost WebSocket relay; the phone never holds API keys, and all model calls originate from the desktop. The original PRD stated "no mobile app" because the v1 build was desktop-only; the companion was added in v0.3.0 without moving the data model off-device. See §14.4 and `CONTRACT.md` → Mobile Relay for the protocol.

---

## 3. Supported Agent Harnesses (v1)

The app must support at minimum:

1. **Claude Code** (Anthropic) — supports session resume via session ID.
2. **Kimi Code CLI** (Moonshot AI) — supports session resume via `kimi -r <session-id>` / `--session`, `kimi -c` / `--continue` for the most recent session. Single-binary distribution.
3. **OpenCode** — added as a third adapter; resume support follows the same trait.

> **Implementation note (Chat tab):** The app also includes a Chat tab (not described in this PRD) that offers direct LLM conversations via HTTP APIs — a separate feature from the CLI agent panes covered here. The Chat tab supports: streaming responses, tool calling (32 tools: web_search, generate_document, generate_file, generate_diagram, fetch_url, open_url, run_code, get_skill, list_skills, download_file, download_progress, run_shell, get_task_status, cancel_task, the agentic browser control set `browser_read`/`browser_click`/`browser_type`/`browser_scroll`/`browser_screenshot` plus `wait_for`, the focused-subagent `Task` tool, the filesystem set `list_directory`/`read_file`/`search_files`/`search_content`/`write_file`/`edit_file`/`delete_file`/`move_file`/`copy_file`, and the source ledger `add_source_note`/`get_source_ledger`/`reset_source_ledger`), Mermaid diagram rendering, HTML/CSS diagram generation with PNG export, artifact preview/download/export, research mode (`/research`) with Plan/Execute/Synthesize prompting and a persistent source ledger, the autonomous goal loop (`/goal` and its alias `/loop`), context compaction for local GGUF models, per-turn perf metrics (TTFT / LLM time / tool time / tokens-per-second, surfaced in the composer), per-session permission modes (read_only / manual / auto_edit / full_auto), and a Connectors framework (OAuth + remote MCP for Notion, GitHub, Google, Gmail, Kiwi). See `CONTRACT.md` Chat section for the full IPC contract.

Both harnesses run as normal CLI processes; the app does **not** need to reimplement their protocols. The app spawns them in a pseudo-terminal (pty) with the working directory set to the target project folder, and lets their native TUI render inside the pane. This means:
- Relay does not need to parse or understand the agent's internal message format for v1's baseline experience — the pty output is rendered as terminal output (via xterm.js or equivalent), exactly as if the user ran the CLI directly.
- Session ID capture: after a session starts, Relay must capture the session ID the harness generates (both harnesses expose this — Kimi Code prints a resume hint like `kimi -r <session-id>` on every exit path) so it can be stored and used for later resume.
- The harness list must be implemented as a pluggable adapter interface (see §6.4) so a third harness (e.g. Codex, OpenCode) can be added later without rearchitecting.

**Architecture implication:** because both harnesses persist session state to disk and resume by ID, Relay does **not** need to keep agent processes resident in memory when a pane is not visible/focused. Process lifecycle is spawn-on-focus, kill-on-blur-or-close, resume-by-ID-on-reopen. This is a deliberate simplification — do not build a background process supervisor for v1.

> **Implementation note:** The final implementation diverges from this section's "kill-on-blur" statement. Per §6.5 (which takes precedence), panes are killed only on explicit close or app quit, never on blur. The original "kill-on-blur-or-close" phrasing was aspirational and was corrected during implementation to match the user's expectation that unfocused parallel panes keep running.

---

## 4. Core User Flows

### 4.1 First launch
1. User opens the app. Empty state: sidebar shows "No projects yet" with an "Add Project" button.
2. User clicks "Add Project" → native OS folder picker → selects a local directory.
3. If the directory is not a git repo, prompt: "This folder isn't a git repository yet. Initialize git? (recommended — enables worktrees, git status, and one-click PR flow)." User can accept (`git init`) or skip.
4. The folder is added to the sidebar under "Projects," and persisted to local storage.

### 4.2 Starting a session
1. User selects a project in the sidebar.
2. Sidebar expands to show that project's session history (empty on first use).
3. User clicks "New Session" and picks a harness (Claude Code or Kimi Code) from a small selector (radio/dropdown), or a default harness if only one is configured.
4. A new pane opens in the main grid, a pty is spawned with cwd = project folder, running the harness's default interactive command (e.g. `claude` or `kimi`).
5. Once the harness reports a session ID (parsed from its startup/exit output), Relay stores `{ project_id, session_id, harness, title: null, created_at, last_active_at }` in the local session index.
6. User types prompts directly into the pane; the harness's native TUI handles rendering, tool-call confirmations, diffs, etc.

### 4.3 Switching between sessions
1. User clicks a past session in the sidebar (under its project).
2. If a pane for that session already exists on screen, focus it.
3. If not, and there is an empty pane slot (< 6 panes open), spawn a new pty running the harness's resume command (`claude --resume <id>` / `kimi -r <id>`) in that project's directory, and place it in the grid.
4. If all 6 pane slots are full, prompt the user to either close/free a pane or replace the least-recently-used one.

### 4.4 Closing a pane
1. User closes a pane (button, or Cmd+W scoped to focused pane).
2. The underlying pty process is terminated (SIGTERM, escalate to SIGKILL after timeout).
3. Session record remains in history (title, harness, project, timestamps) — closing a pane never deletes a session, only ends the live process. It can be resumed again later per §4.3.

### 4.5 Broadcast prompt
1. User enables "broadcast mode" (toggle in toolbar, or holds a modifier while typing).
2. User selects 2+ panes (checkbox on each pane header, or "select all visible").
3. User types one prompt into a broadcast input bar.
4. On submit, the same literal text is sent as input to every selected pane's pty simultaneously.
5. Each pane continues to behave independently after that (this is a one-shot fan-out, not a synced session).

### 4.6 Browser preview
1. User opens a "Browser" pane (via the bottom-layout split shown in the design sketch: one cmd pane + one browser pane side-by-side, or as a standalone pane type available in the main grid).
2. Browser pane has a URL bar (defaults to `http://localhost:3000` or last-used URL per project), refresh, and back/forward.
3. Browser pane is a plain embedded webview — it does not need special agent integration in v1, it's for the user to visually check dev server output next to the agent that's driving it.

> **Implementation note:** The browser pane uses native Tauri child webviews (`Window::add_child`) on Windows/macOS rather than a secondary `WebviewWindow`. This provides a top-level browsing context with no `X-Frame-Options` restrictions and full navigation history. Linux uses standalone `WebviewWindow`s (one per tab) because wry/gtk has no multi-webview support. No iframe fallback remains on any platform. The webview is positioned over the pane's body div by syncing bounds from the frontend (ResizeObserver) to the backend, with occlusion logic that hides the webview when overlays/modals are open.

> **Implementation note (v0.3.0+):** Agent-driven browser control is available via the bundled `relay-browser-mcp` sidecar (a standalone MCP binary that bridges JSON-RPC over stdio to the desktop's WebSocket relay) and the in-app chat tools `browser_read`/`browser_click`/`browser_type`/`browser_scroll`/`wait_for`. Visual feedback overlays (cursor tween, click ripple, typing caret, element highlight) show the user what the agent is doing. Page extraction uses Mozilla's Readability.js with consent-banner dismissal, lazy-load/infinite-scroll handling, and structured output (full/summary_only/section modes). See `task-browser-agent-visual-feedback.md`, `task-browser-extraction-quality.md`, and `task-relay-browser-mcp.md` for full specs.

---

## 5. Information Architecture / Sidebar

```
┌─────────────────────────┐
│  [Search / Cmd+K]       │
├─────────────────────────┤
│  PROJECTS               │
│  ▸ nobogyan              │
│    ├─ Session: "auth    │
│    │   refactor" (3h ago)│
│    ├─ Session: "fix DB   │
│    │   pool leak" (1d)   │
│    └─ + New Session      │
│  ▸ trading-bot          │
│  ▸ eyeshield            │
│  + Add Project           │
├─────────────────────────┤
│  ⚙ Settings              │
│  📚 Skills Library        │
└─────────────────────────┘
```

- Projects are collapsible; expanding shows session history for that project, most recent first.
- Sessions show an editable auto-generated title (see §7.4), relative timestamp, harness icon/badge, and live-state badge if a pane for that session is currently open (see §7.3 pane states — same iconography reused in the sidebar).
- Git status badge (see §7.11) shown next to project name: branch name + dirty/clean dot.

---

## 6. Technical Architecture

### 6.1 Platform / Stack

- **Shell:** Tauri v2 (Rust backend + system webview frontend). Chosen over Electron for lower resource overhead, since the app's core surface is multiple terminal panes plus one embedded webview, not a full browser-grade rendering need per pane.
- **Frontend:** React + TypeScript. State management: Zustand or Redux Toolkit (pick one, be consistent — Zustand recommended for this app's scale, less boilerplate).
- **Terminal rendering:** `xterm.js` in the frontend, connected to a Rust-side pty via `portable-pty` or `node-pty`-equivalent Rust crate (`portable-pty` is the standard choice in the Tauri ecosystem).
- **Process spawning:** Rust backend (Tauri commands) spawns harness CLI binaries as child processes attached to a pty, streams stdout/stdin over a Tauri event channel (or WebSocket if simpler) to the corresponding xterm.js instance in the frontend.
- **Local persistence:** SQLite (via `rusqlite` or `sqlx` on the Rust side) for structured data (projects, sessions, cost logs). Plain JSON file for app settings/preferences (theme, layout, keybindings) is acceptable, but session/project/cost data should be in SQLite for query flexibility (search, filtering, cost rollups).
- **Embedded browser pane:** Tauri's webview (or a secondary `WebviewWindow`/inline webview component) pointed at a user-provided local URL.

### 6.2 Directory Structure (suggested)

```
/relay
  /src                      # React frontend
    /components
      /panes                # Terminal pane, browser pane, pane grid
      /sidebar
      /command-palette
      /skills-library
      /cost-dashboard
      /settings
    /state                  # Zustand stores
    /hooks
    /lib                    # harness adapters (frontend-side types/utils)
    /styles                 # glass theme tokens, light/dark
  /src-tauri                # Rust backend
    /src
      /commands              # Tauri command handlers (spawn_pty, kill_pty, resume_session, etc.)
      /pty                   # pty lifecycle management
      /harness_adapters       # one module per harness (claude_code.rs, kimi_code.rs)
      /db                     # SQLite schema + queries
      /git                     # git status, worktree creation
      /secrets                 # encrypted per-project env store
    Cargo.toml
    tauri.conf.json
  PRD.md                     # this document
```

### 6.3 Data Model (SQLite)

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,               -- uuid
  path TEXT NOT NULL UNIQUE,         -- absolute filesystem path
  name TEXT NOT NULL,                -- derived from folder name, editable
  is_git_repo BOOLEAN NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_opened_at INTEGER
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,               -- uuid, internal to Relay
  project_id TEXT NOT NULL REFERENCES projects(id),
  harness TEXT NOT NULL,             -- 'claude_code' | 'kimi_code'
  harness_session_id TEXT,           -- ID as reported by the harness itself, used for --resume
  title TEXT,                        -- auto-generated or user-edited
  worktree_path TEXT,                -- null if using project root directly
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle' -- 'idle' | 'working' | 'waiting_on_user' | 'diff_ready' | 'closed'
);

CREATE TABLE cost_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  timestamp INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  estimated_cost_usd REAL
);

CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slash_command TEXT NOT NULL UNIQUE,  -- e.g. "/audit-ai-slop"
  content TEXT NOT NULL,                -- the prompt/template body
  scope TEXT NOT NULL DEFAULT 'global', -- 'global' | project_id
  created_at INTEGER NOT NULL
);

CREATE TABLE project_secrets (
  project_id TEXT NOT NULL REFERENCES projects(id),
  key TEXT NOT NULL,
  value_encrypted BLOB NOT NULL,
  PRIMARY KEY (project_id, key)
);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### 6.4 Harness Adapter Interface

Every harness must implement a common Rust trait so new harnesses can be added without touching pane/session management code:

```rust
trait HarnessAdapter {
    fn id(&self) -> &'static str;                    // "claude_code", "kimi_code"
    fn spawn_new_command(&self, cwd: &Path) -> Command;   // e.g. `claude`, `kimi`
    fn spawn_resume_command(&self, cwd: &Path, session_id: &str) -> Command; // `claude --resume <id>`, `kimi -r <id>`
    fn parse_session_id(&self, pty_output: &str) -> Option<String>; // scrape/detect session id from output
    fn is_installed(&self) -> bool;                    // check binary on PATH
    fn login_command(&self) -> Command;                  // e.g. `claude auth login`, `kimi` then `/login`
}
```

On app startup, run `is_installed()` for each adapter and surface install/auth status in Settings (see §7 Onboarding checks).

### 6.5 Pane / Process Lifecycle State Machine

```
[no pane] --user clicks new/resume--> [spawning]
[spawning] --pty ready, process running--> [active, focused]
[active, focused] --user focuses another pane--> [active, unfocused]
[active, unfocused] --user closes app / explicit close--> [terminated]
[active, *] --process exits on its own (error/crash)--> [terminated, error]
[terminated] --user clicks session in sidebar again--> [spawning] (using resume command)
```

Rules:
- A pane's underlying process should only be killed on explicit close or app quit — NOT merely on losing focus (losing focus ≠ closing; the user is still working across 3-6 panes and expects them to keep running while unfocused, since that's the whole point of parallel panes). Re-read §4.4 — "close" is the user-driven action that kills the process; unfocused-but-open panes stay alive.
- On app relaunch, all sessions start as `terminated` and require an explicit resume click — do not auto-resume all previously open panes on launch (avoid surprise cost/resource spend).

---

## 7. Feature Specifications

### 7.1 Liquid Glass Visual System
- macOS 26 (Tahoe) and later: use `tauri-plugin-liquid-glass` (wraps native `NSGlassEffectView`) for true dynamic glass — configurable corner radius, tint color, and material variant (e.g. `Sidebar` variant for the sidebar, a different variant for pane chrome).
- macOS pre-26: fall back to `window-vibrancy`'s `apply_vibrancy` (`NSVisualEffectMaterial`) for a standard frosted look.
- Windows: `window-vibrancy`'s `apply_blur` for acrylic-style blur. Do not attempt to visually match macOS pixel-for-pixel; a clean Windows-native acrylic look is the correct target.
- Linux: no vibrancy/blur (compositor-dependent, unsupported by window-vibrancy) — ship a flat, well-designed dark/light theme as the Linux baseline, not a broken blur attempt.
- Required Tauri config: `"transparent": true` on the window, transparent CSS background on `html, body`, `"macOSPrivateApi": true` for macOS.
- Known issues to test for early (do not discover late): glass corner-radius misalignment on window resize/drag on some `NSGlassEffectViewStyle` variants; test resizing behavior in the first week of UI work, not at the end.

> **Implementation note:** The current implementation uses `window-vibrancy` (`apply_vibrancy` on macOS, `apply_blur` on Windows) rather than the `tauri-plugin-liquid-glass` plugin (which was specified here but does not exist as a stable Tauri v2 crate). The visual result is a frosted-glass look across all supported platforms; the Tahoe-era native `NSGlassEffectView` path remains deferred to a future release when the plugin stabilizes.

### 7.2 Light / Dark Theme
- Theme driven by tint tokens, not a flat black/white swap: dark theme uses a cool blue-gray base tint, light theme a warm off-white base tint, both layered under the glass material.
- Default: follow macOS system appearance automatically. Manual override available in Settings (Light / Dark / System).
- Typography: Space Grotesk for UI text, Space Mono for terminal/monospace surfaces, consistent with the user's existing design system.

### 7.3 Pane Visual States
Each pane (and its corresponding sidebar session entry) must reflect one of four states via a distinct tint/glow treatment (not just a colored dot — the glow should be part of the glass material, e.g. a soft edge-light in the state color):
1. **Idle** — no active process, or process running but no recent output.
2. **Working** — agent is actively producing output / running tools.
3. **Waiting on user** — agent has stopped and is awaiting input (e.g. a tool-call confirmation, a question, or the prompt is simply empty and idle at the input line after a completed turn).
4. **Diff ready** — agent has proposed a file change awaiting approval (state detected via pty output pattern matching for the harness's diff-approval prompt, or simply treated as a subset of "waiting on user" if reliable detection proves difficult — do not over-invest in fragile output-parsing heuristics here; a coarser 3-state model (idle/working/waiting) is an acceptable fallback if diff-detection parsing is unreliable in testing).

### 7.4 Session Titling
- On session creation, title is null/"Untitled Session" until the first user prompt is sent.
- After the first prompt, auto-generate a short title from it (simple truncation + ellipsis is an acceptable v1 approach; do not build a separate LLM call just to title sessions — use the first ~40 characters of the user's first prompt, cleaned of newlines).
- Title is editable inline in the sidebar at any time (double-click or an edit affordance).

### 7.5 Command Palette (Cmd+K)
- Global overlay, fuzzy search across: project names, session titles, and top-level actions ("New Session," "Add Project," "Open Settings," "New Worktree").
- Selecting a project focuses/expands it in the sidebar; selecting a session opens/focuses/resumes its pane per the flow in §4.3.

### 7.6 Keyboard Shortcuts (v1 baseline set)
| Shortcut | Action |
|---|---|
| Cmd+K | Open command palette |
| Cmd+1 … Cmd+6 | Focus pane 1–6 |
| Cmd+` | Cycle focus to next pane |
| Cmd+N | New session in current project |
| Cmd+W | Close focused pane |
| Cmd+Shift+B | Toggle broadcast mode |
| Cmd+, | Open Settings |

All shortcuts must be remappable in Settings — store overrides in `app_settings`.

### 7.7 Per-Project Quick Actions
- Each project can have a small set of user-defined quick actions: a label, an optional keybinding, and a shell command (e.g. `npm run dev`, `kimi -c`).
- Quick actions run in a new pane (their own pty) scoped to the project directory, not inside an existing agent pane.
- Optional: flag an action to "run automatically when a new worktree is created for this project" (useful for `npm install`-type setup commands).
- Stored per-project, editable via a small UI in the project's context menu or a "Project Settings" panel.

### 7.8 Broadcast Prompt & Model Comparison Mode
- See flow in §4.5.
- **Model comparison mode** is broadcast mode used specifically to send the same prompt to one Claude Code pane and one Kimi Code pane on the same project, displayed side-by-side, so the user can visually compare outputs. This does not need a distinct code path from generic broadcast — it's the same mechanism, just a UI shortcut/preset ("Compare harnesses on this prompt") that pre-selects one pane of each harness type if both exist for the current project.

### 7.9 Quick File/Diff Peek
- A lightweight, read-only panel (slide-over or modal) that can display the full contents of a file the agent just touched, and/or a full diff view, without leaving the app.
- Triggered from a link/reference in the pane output when the harness's diff-approval prompt is detected, or manually via a "peek" button/shortcut while a pane is focused, letting the user pick a file from the project tree to preview.
- This is explicitly NOT an editable surface in v1 — no save, no in-place editing. Use a simple diff-rendering library (e.g. `diff2html` equivalent, or a minimal custom unified-diff renderer) and a syntax-highlighted read-only code view (e.g. Shiki or Prism) for the file-content case.

### 7.10 New Worktree from Sidebar
- Context menu action on a project: "New Worktree." Prompts for a branch name, runs `git worktree add <path> -b <branch>` under the hood, registers the new worktree path against the project (see `sessions.worktree_path` — a worktree is associated with the session(s) run inside it, the project itself remains the canonical repo entry in the sidebar).
- If the project has a quick action flagged "run on worktree creation" (see §7.7), execute it automatically in a new pane once the worktree is created.

### 7.11 Git Status Badge
- Small badge per project (and optionally per session, if the session is running in a distinct worktree) showing: current branch name, a dirty/clean indicator (dot or icon), and ahead/behind counts vs. the upstream branch if one is configured.
- Computed via shelling out to `git status --porcelain` and `git rev-list --left-right --count` (or an equivalent git library binding) on a polling interval (e.g. every 5-10s while the project is visible in the sidebar) or on relevant pty output triggers (e.g. after a commit-like command is detected) — polling is the simpler, more robust v1 approach; do not attempt real-time filesystem-watch-driven git status for v1 unless polling proves visibly laggy in testing.

### 7.12 Token / Cost Tracking Dashboard
- A dedicated view (accessible from the sidebar or a toolbar icon) showing:
  - Per-session token usage and estimated cost, where obtainable from harness output (both Claude Code and Kimi Code CLIs report usage/context info in their sessions — parse this from pty output or, if available, from any structured session log files the harness writes to disk; check each harness's session storage format on disk, e.g. Kimi Code stores per-session metadata that may include usage stats, and use that as a more reliable source than pty-output-scraping if present).
  - Rollups: per-project daily/weekly totals, and an all-projects daily/weekly total.
  - This is a "best effort" cost estimate feature — clearly label it as an estimate in the UI, since harness-reported usage figures and actual billing may not always be in perfect sync.
- Data written to the `cost_events` table as it's parsed/detected; dashboard is a set of SQL aggregate queries over that table rendered as simple charts (a small charting lib is fine, e.g. a lightweight React chart component — this does not need to be elaborate).

### 7.13 System Notifications on Completion
- When a pane transitions from "working" to "waiting on user" or "diff ready" while that pane is not the currently focused pane, fire an OS-level notification (Tauri's notification API) with the project/session name.
- Settings toggle: "Do Not Disturb while recording" — when enabled, suppress OS notifications (in-app pane badges still update normally). This should be a simple manual toggle in v1; do not attempt to auto-detect screen recording/streaming software.

### 7.14 Session Export to Markdown
- Per-session action: "Export as Markdown." Dumps the full pty transcript (or, if the harness exposes structured turn history via an on-disk session log/JSON, prefer parsing that over raw ANSI-laden terminal scrollback) to a `.md` file, with basic formatting (user turns vs. agent turns vs. tool calls distinguished, e.g. via headers or blockquotes).
- Save via native OS "save file" dialog, defaulting to a sensible filename like `<project>-<session-title>-<date>.md`.

### 7.15 Prompt / Skill Library
- A dedicated sidebar section ("Skills Library") listing saved reusable prompts/templates, each with a name and a slash command (e.g. `/audit-ai-slop`).
- Skills can be scoped globally (available in any pane/project) or to a specific project.
- Typed into any pane's input, `/skill-name` expands to the full stored template text before being sent to the harness (simple client-side text substitution — this does not require harness-level integration, though if a harness has its own native skill/AGENTS.md mechanism, that remains a separate, complementary system the user can also use directly within the CLI itself).
- CRUD UI: create/edit/delete skills, stored in the `skills` table.

> **Implementation note (Chat tab skills):** In the Chat tab, skill loading works differently — enabled skills are appended to the system prompt on every turn (unconditional, not trigger-based). This deviates from the CLI-pane skill model described above, which uses frontend-side slash-expansion before `write_pty`.

### 7.16 Local Encrypted Secrets Store
- Per-project key-value store for env vars/API keys used by quick actions or dev servers run in panes.
- Values encrypted at rest (e.g. via OS keychain integration through a Tauri plugin, which is the preferred approach over custom encryption — use the platform keychain/credential manager where available, falling back to an encrypted local file only if keychain access isn't feasible).
- Injected into a pane's process environment only when explicitly referenced by a quick action or when the user opts to inject "this project's secrets" into a freshly spawned pane.
- Never logged, never included in session exports (§7.14), never sent to any network endpoint by Relay itself.

> **Implementation note (Linux):** The `keyring` crate is built with `linux-native` + `sync-secret-service` features, which talks to the Secret Service API (`gnome-keyring`, `kwalletd5`, `KeePassXC`). The XOR-obfuscated SQLite fallback documented in `AUDIT.md` (row 3.2/2.2) remains a last-resort fallback when no Secret Service is available.

---

## 7.17 Connectors (OAuth SaaS Integrations) — added in v0.3.0+

A Connectors framework bridges third-party SaaS accounts into the Chat tab as per-conversation MCP tool sources:

- **OAuth 2.0 flows** for third-party MCP servers. Supported connectors: **Notion**, **GitHub**, **Gmail**, **Google Drive/Calendar/Sheets/Docs/Slides/Chat/People**, and **Kiwi**.
- **Per-conversation opt-in** — connectors are attached to a specific chat session (`set_session_connectors`), never global. A connector's tools only appear in the tool schema for sessions that have explicitly enabled it.
- **Credentials stored in the OS keychain** (Windows Credential Manager / macOS Keychain / Linux Secret Service) — per-user access tokens are never in the database in cleartext.
- **Confidential-client credentials** (Notion/GitHub/Google `client_id`/`client_secret`) are baked into the binary at build time via `option_env!` (`src-tauri/src/connectors/config.rs`). These are shared across all installs so the app can complete the token exchange on behalf of any authorizing user; each end user still authorizes their own account. Canva uses Dynamic Client Registration (DCR, public client) and needs no build-time secret. See `RELEASE.md` for the build-time credential requirement and `AUDIT.md` row 3.6 for the acknowledged extractable-secret trade-off.
- **Per-tool permission gating** — connector tools route through the same `check_permission` gate as the filesystem tools and respect the session's permission mode.

---

## 7.18 Local Model Market & Context Compaction — added in v0.3.0+

- **Local models** (Settings → Local Models): scan the machine for `.gguf` files and serve them through a managed llama.cpp sidecar. Local models appear as a first-class chat provider (`local_gguf`) — free, offline, private. GPU offload is requested by default (`--n-gpu-layers=999`); on cards where the model + KV cache don't fit, llama.cpp spills layers to CPU.
- **Local Model Market**: browse a curated Hugging Face catalog and download models directly. Downloads are cancellable and report progress (`local-model:download:progress`); mmproj (vision) companion files are supported.
- **Context compaction**: automatically summarizes older conversation history when a local GGUF model's context window approaches capacity. The most recent exchanges stay verbatim; aged-out turns are condensed via a non-streaming summarization call. Compaction reserves tool-schema tokens out of the context budget and triggers before the prompt can overflow. Configurable threshold and pin count in Settings → Local Models → Compaction.
- **Context window meter**: a circular SVG ring below the send button shows how much context the last turn used (green < 70%, amber 70–90%, red > 90%).

---

## 7.19 Research Mode — added in v0.3.0+

- Triggered with `/research` (or keyword triggers) in the Chat tab when tools are enabled.
- **Plan / Execute / Synthesize** prompting scaffolding: the agent plans the research approach, gathers sources into a persistent **source ledger** (`add_source_note` / `get_source_ledger` / `reset_source_ledger` tools backed by SQLite), then synthesizes a cited answer.
- The source ledger dedups by `(session, url, fact)` and caps at 50 entries.
- Artifact generation appends a **Sources** section to the output.
- See `task-research-orchestration.md` for the full spec.

---

## 7.20 Mobile Companion App — added in v0.3.0+

- A **React Native / Expo** companion app connects to the desktop over a localhost WebSocket relay.
- The phone never holds API keys — every model call originates from the desktop process. The phone mirrors terminal sessions as styled-text snapshots (SGR-styled output from a vt100 parser), triggers chat turns, spawns local model sidecars, and resolves tool approvals (`SessionApprovalRequest` / `ResolveSessionApproval`).
- The relay auto-starts on app launch and auto-stops on exit. See `CONTRACT.md` → Mobile Relay for the full protocol (JSON over WebSocket, tagged-union message types).

---

## 8. Non-Functional Requirements

- **Startup time:** cold app launch to interactive sidebar under 2 seconds on typical developer hardware.
- **Resource usage:** with 0 panes open, idle memory footprint should be modest (Tauri's baseline, not an Electron-scale footprint) — this is a primary reason Tauri was chosen over Electron.
- **Process cleanup:** on app quit, all child pty processes must be terminated cleanly (SIGTERM with a grace period, then SIGKILL) — no orphaned agent processes left running after the app closes.
- **Data durability:** SQLite writes for session/project state should be synchronous enough that an app crash does not lose more than the last few seconds of session metadata (session content itself lives in the harness's own on-disk session store, not duplicated by Relay, except where explicitly exported per §7.14).
- **Offline behavior:** the app shell itself (sidebar, project list, past session list, settings) must remain fully usable with no network connection; only actual agent interaction requires the harness's own network access.
- **Cross-platform baseline:** macOS is the primary/reference platform for this build. Windows and Linux must be functional (all core flows work) even where the glass visual effect degrades gracefully per §7.1.

---

## 9. Onboarding / Setup Checks

On first launch (and available anytime from Settings):
1. Detect whether `claude` and `kimi` binaries are on `PATH`.
2. For each detected binary, show install/auth status (installed & authenticated / installed & not authenticated / not installed), with a direct "Run login" button that spawns the harness's login flow in a temporary pane (`claude auth login`, or `kimi` then guiding the user to run `/login`).
3. If neither harness is installed, show install instructions/links rather than blocking the rest of the app — the sidebar/project management should still be usable.

---

## 10. Build Phases (suggested order, maps to roughly 4-5 weeks solo reference estimate — adjust as needed for actual velocity)

1. **App shell & persistence** — Tauri scaffold, folder picker, recent-projects list, SQLite schema, basic sidebar UI (no glass yet, no panes yet).
2. **Pty engine** — spawn/kill lifecycle, xterm.js rendering, hardcode a single harness (pick one) spawn-and-resume flow end to end for one pane before generalizing.
3. **Multi-pane grid** — generalize to up to 6 panes, resizable layout, focus management, keyboard pane switching.
4. **Sidebar session history + harness adapter abstraction** — implement both Claude Code and Kimi Code adapters behind the trait in §6.4, session index wired to real resume behavior.
5. **Liquid Glass + theming** — apply the visual system in §7.1/7.2 across the now-functional app; this is deliberately sequenced after core function works, not before, so glass issues don't block functional development.
6. **Browser pane, quick actions, git status, worktrees** — §4.6, §7.7, §7.10, §7.11.
7. **Broadcast mode, comparison mode, cost dashboard, notifications, skills library, secrets store, export** — remaining §7 items, roughly in the order listed, as these are largely independent additive features at this point.
8. **Cross-platform QA pass** — explicit test pass on Windows and Linux fallback behavior, and macOS pre-26 vibrancy fallback, plus the known glass resize/corner-radius issue flagged in §7.1.

---

## 11. Open Questions to Resolve During Build (flag back to the user, do not silently assume)

- Exact diff-ready state detection reliability per harness (§7.3) — may need per-harness output-pattern tuning; confirm feasibility early rather than late.
- Whether harness-reported token/cost data is available via on-disk session logs (preferred) vs. requiring pty-output scraping (fallback) — check each harness's actual on-disk session file format before committing to a parsing approach for §7.12.
- Final choice of charting library for the cost dashboard (keep minimal — this is not a data-viz-heavy product).

---

## 12. ASCII Wireframes (layout reference for implementation)

These are structural references, not pixel specs — glass/tint/typography per §7.1–7.2 apply on top of these layouts.

### 12.1 Main window — 4 panes active (grid mode)

```
┌──────────────┬──────────────────────────────────────────────────────────────┐
│ ⌕ Cmd+K       │  [●nobogyan] [●trading-bot] [○eyeshield]        ⬒ ⬒ ⬒ ⚙       │
├──────────────┼──────────────────────────────────────────────────────────────┤
│ PROJECTS      │ ┌── Pane 1 ─ claude ─ nobogyan ─────┐┌── Pane 2 ─ kimi ─ nobogyan ┐│
│              │ │ 🟢 working          [git: main ●] ✕││ 🟡 waiting        [main ●] ✕││
│ ▾ nobogyan    │ ├────────────────────────────────────┤├────────────────────────────┤│
│   ● auth      │ │ $ claude --resume a1b2c3            ││ $ kimi -r x9y8z7             ││
│   refactor    │ │                                      ││                              ││
│   (3h ago)    │ │ > refactor the auth middleware to    ││ > same task, compare         ││
│   ○ fix DB    │ │   support token refresh...           ││   approach                   ││
│   pool leak   │ │                                      ││                              ││
│   (1d)        │ │ ⏺ Reading src/auth/middleware.ts     ││ ⏺ Reading src/auth/*.ts      ││
│   + New       │ │ ⏺ Editing 3 files...                 ││ ● thinking...                ││
│              │ │                                      ││                              ││
│ ▾ trading-bot │ │ ▍                                     ││ ▍                             ││
│   ● backtester│ └────────────────────────────────────┘└────────────────────────────┘│
│   sweep       │ ┌── Pane 3 ─ claude ─ trading-bot ──┐┌── Pane 4 ─ Browser ────────┐│
│   (running)   │ │ 🔵 diff ready       [main ✓clean] ✕││ localhost:3000        ↻  ⌂ ✕││
│              │ │ ├────────────────────────────────────┤├────────────────────────────┤│
│ ▸ eyeshield   │ │ Proposed changes to backtest.py:     ││  ┌──────────────────────┐  ││
│   + New       │ │  + def sweep_params(...):            ││  │                      │  ││
│              │ │  + ...                                ││  │   [ live preview ]   │  ││
│ + Add Project │ │  [ Approve ]   [ Reject ]   [ Peek ] ││  │                      │  ││
│              │ │                                      ││  └──────────────────────┘  ││
│ ─────────────│ │ ▍                                     ││                              ││
│ 📚 Skills      │ └────────────────────────────────────┘└────────────────────────────┘│
│ 💰 Cost        │                                                                        │
│ ⚙ Settings     │  [+ New Pane]           Broadcast: [ Pane1 ☑ Pane2 ☑ Pane3 ☐ Pane4 ☐ ]  │
└──────────────┴──────────────────────────────────────────────────────────────┘
```

### 12.2 Bottom layout — single cmd + browser split (from original sketch)

```
┌──────────────────────────────┬──────────────────────────────┐
│  cmd — nobogyan                │  browser                      │
│  🟢 working          [main●] ✕│  localhost:5173      ↻  ⌂  ✕  │
├──────────────────────────────┼──────────────────────────────┤
│ $ claude --resume a1b2c3       │  ┌──────────────────────────┐ │
│                                 │  │                          │ │
│ > add a settings page for      │  │                          │ │
│   theme toggle                 │  │      [ live preview ]    │ │
│                                 │  │                          │ │
│ ⏺ Writing src/Settings.tsx     │  │                          │ │
│ ⏺ Running npm run dev...       │  │                          │ │
│                                 │  └──────────────────────────┘ │
│ ▍                                │                                │
└──────────────────────────────┴──────────────────────────────┘
```

### 12.3 Command palette overlay (Cmd+K)

```
                 ┌───────────────────────────────────────┐
                 │  ⌕  refactor█                          │
                 ├───────────────────────────────────────┤
                 │  SESSIONS                              │
                 │  ● auth refactor        nobogyan  3h   │
                 │  ○ db refactor pass     trading-bot 2d │
                 │                                         │
                 │  PROJECTS                               │
                 │  ▸ nobogyan                              │
                 │                                         │
                 │  ACTIONS                                │
                 │  + New Session                          │
                 │  + Add Project                          │
                 │  + New Worktree                         │
                 └───────────────────────────────────────┘
```

### 12.4 Pane header state legend

```
🟢 working          — agent actively producing output / running tools
🟡 waiting on user   — agent stopped, awaiting input
🔵 diff ready        — agent proposed a change, needs Approve/Reject
⚪ idle              — pane open, no recent activity
```

### 12.5 Sidebar session row anatomy

```
  ● auth refactor            <- state dot (matches 12.4 legend)
    nobogyan · claude         <- project · harness badge
    3h ago                    <- relative timestamp, click row to open/resume
```

### 12.6 Six-pane full grid (max density)

```
┌────────┬────────┬────────┐
│ Pane 1 │ Pane 2 │ Pane 3 │
├────────┼────────┼────────┤
│ Pane 4 │ Pane 5 │ Pane 6 │
└────────┴────────┴────────┘
```

---

## 13. Engineering Process Requirements (applies to the whole build, not a phase)

This section is binding across every phase in §10. It is not optional polish — treat it as part of "done" for every task, not a cleanup pass at the end.

### 13.1 Follow the full software engineering lifecycle per feature, not just per phase
For every feature/task taken from §7 (not just every phase from §10), work through:
1. **Requirements check** — re-read the relevant §7 subsection and §12 wireframe before writing code; if anything is ambiguous, resolve it against §11's spirit (state the assumption explicitly rather than silently guessing) or flag it back to the user.
2. **Design/plan** — before writing implementation code for anything non-trivial (a new Tauri command, a new data flow, a new adapter), briefly state the approach (data flow, files touched, interfaces changed) before writing the code itself.
3. **Implement** — write the code.
4. **Test** — see §13.2. Do not move to the next feature with known-failing or untested behavior from the current one.
5. **Document** — see §13.3.
6. **Integrate/verify in context** — confirm the new piece actually works alongside what already exists (e.g. a new pane state doesn't break existing pane rendering), not just in isolation.

Do not batch multiple unrelated features into one untested, undocumented pass. Small, verified increments are required, even if that means more, smaller commits/sessions than doing it all at once.

### 13.2 Testing after each step
- Every backend unit (Tauri command, harness adapter, SQLite query layer, git status logic) needs at least a basic automated test (Rust `#[test]` unit tests where feasible) before being considered complete — especially the harness adapter trait implementations in §6.4, since a subtle bug there (wrong resume flag, mis-parsed session ID) silently breaks the app's core value proposition.
- Frontend components with real logic (pane state machine, broadcast-mode pane selection, command palette fuzzy search) need at least basic component/unit tests, not just visual eyeballing.
- For flows that are inherently interactive/hard to automate (actual pty spawn-and-resume against a real installed harness, glass rendering, drag-resize), do a manual verification pass and explicitly note in the session log/commit message what was manually verified and how — do not silently skip testing just because it isn't automatable.
- Before moving from one build phase (§10) to the next, do a regression pass on the previously completed phases' core flows — do not assume earlier work still works untouched, since shared state (pane grid, sidebar, session index) is touched by nearly every later feature.
- Known-fragile areas flagged elsewhere in this doc (diff-ready state detection in §7.3, glass corner-radius/resize behavior in §7.1) require dedicated test passes, not just incidental coverage.

### 13.3 Documentation as you go
- Maintain a running **build log** (e.g. `BUILD_LOG.md` at the repo root) updated at the end of each meaningful work session: what was built, what was tested and how, what was deferred or left as a known issue, and any assumptions made resolving ambiguity from this PRD. This is the primary artifact the user will read to track progress without reading every commit/diff.
- Code-level documentation: every Tauri command, harness adapter, and non-obvious state-machine transition (§6.5) needs a comment explaining *why*, not just what — especially the pane lifecycle rules (unfocused ≠ closed) and the resume-by-ID architecture, since those are the decisions most likely to get "simplified" incorrectly by a future editor (human or agent) who doesn't have this PRD's context in front of them.
- Keep `PRD.md` (this document) as the source of truth for scope; if implementation reveals a decision that meaningfully deviates from what's written here, update this document (or explicitly log the deviation in `BUILD_LOG.md`) rather than letting the doc silently go stale.
- A short `README.md` covering setup (dependencies, how to run in dev mode, how to build a release) should exist and stay accurate from Phase 1 onward, not written only at the very end.

### 13.4 Use the right skill/tooling for the task at hand
- When working on this codebase, actively select and use the appropriate available skill or tool for each sub-task rather than defaulting to one generic approach for everything — e.g. use proper Rust tooling/idioms for the Tauri backend work, proper React/TypeScript conventions for frontend work, and any available documentation-generation, linting, or testing skill appropriate to whichever part of the stack is being touched at that moment.
- If a task involves a domain this PRD doesn't fully specify (e.g. exact charting library choice in §7.12, exact diff-rendering library in §7.9), make a reasonable choice using appropriate judgment for that domain, note the choice and reasoning in `BUILD_LOG.md`, and move on rather than blocking progress on an open question that isn't listed in §11.

---

## 14. Explicitly Deferred to v2

- Open marketplace for third-party plugins/skills (search, install, permission-scoped sandboxing for code-executing plugins). Skills library (§7.15) in v1 is local-only, no discovery/sharing mechanism.
- Additional harness adapters beyond Claude Code, Kimi Code, and OpenCode (e.g. Codex) — the adapter interface (§6.4) is designed to make this straightforward later, but only three are implemented for v1.
- Real-time collaborative/remote sessions.
- Tahoe-era native `NSGlassEffectView` (true dynamic glass with per-corner radius) — waiting on a stable `tauri-plugin-liquid-glass` for Tauri v2; current build uses `window-vibrancy` (frosted look) as a stopgap.

### 14.4 Added in v0.3.0+ (out of original scope)

- **Mobile companion app** — React Native / Expo client over a localhost WebSocket relay. (Was listed as a non-goal in the original §2; added in v0.3.0.)
- **Connectors framework** — OAuth + remote MCP for Notion, GitHub, Google, Gmail, Kiwi. (Not in the original PRD; added in v0.3.0.)
- **Local Model Market** — Hugging Face model browsing and download. (Not in the original PRD; added in v0.3.0.)
- **Context compaction for local models** — auto-summarize aged-out turns to fit context window. (Not in the original PRD; added in v0.3.2.)
- **Research mode** — Plan/Execute/Synthesize orchestration with source ledger. (Not in the original PRD; added in v0.3.0.)
- **Agent-driven browser control** — `relay-browser-mcp` sidecar + in-app browser tools with visual feedback overlays. (Not in the original PRD; added in v0.3.0.)
