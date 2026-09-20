# Hooks System Research — pre/post tool-call user scripts

> **Status:** implemented (Phases 1–5 all shipped 2026-09-19: core, ask/rewrite wiring, Settings panel + test button, bridge coverage, Claude Code import, regex matchers, `turn_complete`/`session_start`, Claude `can_use_tool` gate, harness post-tool observations) · **Date:** 2026-09-19 · **Effort estimate:** M (3–5 days for Phase 1+2)
> **Verdict:** build it. The Action_list's "cheap because `check_permission()` is centralized" claim is verified —
> but the *right* insertion point is `run_tool`, not `check_permission`, and there are four coverage caveats
> (harness panes, the relay-tools bridge, spawned sessions, and cloud automations) that shape the design below.

---

## 1. Why hooks

Hooks are user-defined commands that run at agent lifecycle points — before/after each tool call — and can
observe, block, rewrite, or annotate what the agent does. They are the standard extensibility surface for
2026 coding agents (Claude Code, Gemini CLI, OpenCode all ship one). Concrete Relay use cases:

- **Guardrails**: block `write_file`/`edit_file` touching paths outside a protected set (secrets, migration dirs); deny `run_shell` commands matching a blocklist (`rm -rf`, `git push --force`).
- **Auto-format after edits**: run `prettier`/`gofmt`/`biome` after every successful `edit_file` on a matching file (the single most-requested hook in every ecosystem).
- **Audit trail**: append every mutating tool call to a JSONL log (compliance, replay, debugging).
- **Injection**: feed extra context to the model before a tool runs ("this repo's tests live in X"; vault/MSTEST conventions).
- **Rewrite**: redact secrets from tool args before they reach disk (`updatedInput`), or force a model choice.
- **Notifications/automation**: trigger a webhook on any mutating tool; post to Slack when a turn uses `run_shell`.

Without hooks, each of these needs a Relay code change; with them, users extend the agent themselves.

## 2. Current state in Relay — verified interception points

### 2.1 The real choke point is `run_tool`, not `check_permission`

`chat::dispatch::run_tool` (`src-tauri/src/chat/dispatch.rs:2026`) is a single async fn through which **every**
built-in-chat tool call flows — in-order rounds and deferred subagent `Task` calls alike (`spawn_task_fanout`
→ `spawn_run_tool` → `run_tool`, `streaming.rs:1180–1262`). It has `sid`, `tool name`, parsed `args` JSON, and
the `AppHandle` in scope, and it internally routes through a fixed ladder of family branches, each computing a
`PermissionDecision`:

1. plan-mode gate + plan tools (first — plan tools must not hook-block, they ARE the consent UI)
2. browser tools → 3. attach meta-tools → 4. source-ledger → 5. cached web → 6. automations → 7. vault →
   8. memory/mesh/connector/MCP-gallery → 9. system tools (`check_system_permission`) → 10. filesystem tools
   (`check_permission`, `permission.rs:836+`) → 11. fallback `tools::execute_tool`.

`check_permission` itself only governs the **filesystem family** — hooking there alone would miss browser,
shell, MCP, connector, and automation calls. PreToolUse belongs at the **top of `run_tool`** (after the
plan-tool dispatch, before the first family branch); PostToolUse wraps the return.

**The denial mechanism already exists**: every family returns a plain `String` fed back to the model, and
`plan::gate_denial` already produces refusal strings for plan-mode. A hook "deny" is just another string —
zero new plumbing. The **pause-and-ask** mechanism also exists: the `run_gated_*_tool` family
(register pending approval → emit `chat:approval-request` → await the same oneshot the approval cards use)
means a hook returning "ask" can route into the existing approval-card UX unchanged.

### 2.2 Coverage map — where tool calls happen and what hooks would see

| Path | Executes tools via | Hook coverage if built at `run_tool` | Notes |
|---|---|---|---|
| Built-in chat (interactive, all providers incl. local GGUF) | `run_tool` | ✅ full | The one true choke point. |
| Subagent `Task` calls + spawned Session Mesh children (builtin engine) | `spawn_run_tool` → `run_tool` | ✅ full | Inherit hooks automatically; input JSON should carry a parent/agent marker. |
| Harness PTY panes (Claude Code, Kimi, OpenCode, Pi, OMP, CommandCode) | the **CLI's own** in-process executor | ❌ not interceptable — observe only | Relay sees stream events only. `tracker.rs::tool_use()` (`agent_sessions/tracker.rs:172`) already books every tool call + args → **PostToolUse-style observations for all six CLIs are cheap**. A true PreToolUse *gate* exists only for Claude Code via `handle_can_use_tool` (`agent_sessions/claude.rs:300`), the same channel that powers the approval relay. |
| `relay-tools` MCP bridge (harness CLIs calling Relay-native tools like `generate_document`) | `mcp_tools_bridge::execute_relay_tool` → `tools::execute_tool` **directly** — bypasses `run_tool` | ❌ unless wrapped | The bridge's own doc comment says it deliberately skips the gated dispatcher (`mcp_tools_bridge.rs:5–25`). Wrapping `execute_relay_tool` with the same hook helper is ~1 day. |
| Automations — CLI harnesses | `agent_sessions::run_one_shot` (CLI process) | ❌ observe-only (same as harness) | |
| Automations — cloud/local providers | `chat::run_one_shot_chat` (`chat/mod.rs:1994`) | ⚠️ **nothing to hook** | Side-finding: this path is a **single-shot LLM call with no tool loop at all** — cloud/local automations cannot use tools today (separate gap, worth its own ticket). |

### 2.3 Reusable precedents already in the codebase

- **`exec_gate.rs`** — native-dialog + hash-remembered allow for arbitrary-execution surfaces
  (`spawn_shell`, MCP-gallery custom installs, `set_llama_server_path`). A user hook script is exactly this
  trust class; reusing `confirm_remembered(kind="hook", ident=command-line)` gives the first-run trust prompt
  for free, fail-closed, outside the webview.
- **Approval oneshot + `chat:approval-request`** — the "ask" decision and its UI already exist.
- **`app_settings` KV JSON config pattern** — MCP gallery stores `mcp.servers`; hooks store as `hooks` the
  same way (Settings-panel-managed JSON, not hand-edited files).
- **`installed_skills.rs` dual-root write convention** — relevant if hooks ever import from
  `~/.claude/settings.json` (see §6.6).
- **ActivitySteps tool rows + `emit_marker`** — hook executions can render as collapsible rows inside the
  existing "Working…" process block; no new transcript machinery needed.

## 3. Competitor survey (Sept 2026)

### Claude Code — the reference design (30+ events, 5 handler types)

Source: [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks). Events: `SessionStart/End`,
`UserPromptSubmit/Expansion`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`,
`PermissionRequest/Denied`, `Stop/StopFailure`, `SubagentStart/Stop`, `TaskCreated/Completed`,
`PreCompact/PostCompact`, `PreModelSwitch/PostModelSwitch`, `Elicitation/Result`, `Notification`,
`FileChanged`, `WorktreeCreate/Remove`, and more. Matchers: exact / `|`-lists / regex, `"*"` = all.

Handler types: **command** (exec form `command`+`args` — no shell — or shell form), **http** (POST JSON,
URL allowlist), **mcp_tool** (call a server tool with `${tool_input.*}` substitution), **prompt** (single-turn
LLM judge), **agent** (experimental subagent decides). `async: true` runs in background; `asyncRewake`
wakes the model on a blocking failure.

I/O contract: JSON on stdin (`session_id`, `tool_name`, `tool_input`, `tool_use_id`, `permission_mode`, …).
Exit 0 = continue (stdout → context on some events); **exit 2 = blocking** (stderr to model); other = non-blocking
error. JSON output refines this: `hookSpecificOutput.permissionDecision: deny|allow|ask` + reason,
`decision: block`, `additionalContext`, `updatedInput` (rewrite tool args), `systemMessage`.
Config: `~/.claude/settings.json` (user) + `.claude/settings.json` (project, shareable) + `.local` + plugins,
merged. Timeouts: 600 s default command hooks (30 s prompt-type). No controlling terminal for hooks.

### Gemini CLI

Source: [geminicli.com/docs/hooks](https://geminicli.com/docs/hooks/). Events: `SessionStart/End`,
`BeforeAgent/AfterAgent`, `BeforeModel/AfterModel`, `BeforeToolSelection`, **`BeforeTool`** (block/rewrite),
**`AfterTool`** (block result/inject context), `PreCompress`, `Notification`. Config in
`.gemini/settings.json` (project → user → system, merged), regex matchers, command-type only, 60 s default
timeout. Same stdin/stdout-JSON + exit-0/2/other contract. Notable trust idea: **project hooks are
fingerprinted — a changed hook (e.g. after `git pull`) re-triggers the untrusted-hook warning**. `/hooks`
management panel with per-hook enable/disable.

### OpenCode

Source: [opencode.ai docs](https://opencode.ai), [opencode.school](https://opencode.school). Not shell
commands — **TypeScript plugins** subscribing to 25+ typed events including `tool.execute.before`
(can block) and `tool.execute.after`; multiple plugins run in registration order and later hooks see earlier
hooks' mutations; plugins ship as project files (`opencode.json`-referenced) or npm packages. Stronger
ergonomics for developers, weaker for non-devs; no process-isolation story.

### What users actually write (ecosystem signal)

Format-on-post-edit, secret-scanning/redaction, dangerous-command blocklists, audit logging, context
injection, and notification/webhook fan-out dominate every hooks cookbook. Relay's memory + Session Mesh +
automations make the notification and cross-session fan-out cases especially natural here.

## 4. Design proposal for Relay

### 4.1 Events — v1 scope (tight)

| Event | Fires | Can | Priority |
|---|---|---|---|
| `pre_tool_use` | top of `run_tool`, after plan-tool dispatch | deny (string to model) · ask (approval oneshot) · allow · rewrite `args` | P0 |
| `post_tool_use` | after the family branch returns, before artifact/emit bookkeeping | observe · inject `additionalContext` appended to the tool result · fail-loud on non-zero | P0 |
| `post_tool_error` | tool returned `Error: …` | observe only | P2 |
| `turn_complete` / `session_start` | finalize / new session | observe · notify | P2 |

Harness panes: `post_tool_use` **observations** for all six CLIs from `tracker.rs` (read-only events, same
JSON contract, no blocking possible); Claude Code additionally gets real `pre_tool_use` via its
`can_use_tool` relay (v2 — piggyback the decision logic on `handle_can_use_tool`).

### 4.2 Config schema (stored as `hooks` in `app_settings`, edited in a Settings panel)

```jsonc
{
  "hooks": {
    "pre_tool_use": [
      {
        "name": "protect-secrets",
        "matcher": "write_file|edit_file",        // exact or |-list (v1); regex v2
        "command": "node",
        "args": ["C:/hooks/block-secrets.js"],    // exec form = direct spawn, no shell
        "timeout_secs": 30,                        // default 30
        "on_error": "open",                        // open (default) | closed (hook crash blocks)
        "enabled": true
      }
    ],
    "post_tool_use": [
      { "matcher": "edit_file", "command": "prettier", "args": ["--write", "${tool_input.path}"], "async": true }
    ]
  }
}
```

Deliberate choices: match Claude Code's three-level semantics but flatten to global-only in v1
(per-project hooks raise the untrusted-repo trust problem — see §4.4); `async` for post-hooks that must not
add latency (format-on-edit); `${tool_input.*}` substitution like Claude's `mcp_tool` type.

### 4.3 I/O contract (mirror Claude Code's — ecosystem compatibility)

- **stdin JSON**: `hook_event_name`, `chat_session_id`, `tool_name`, `tool_input` (object), `cwd`,
  `permission_mode`, `origin` (`chat` | `subagent` | `mesh_child` | `harness_observation`), `tool_use_seq`.
- **Exit codes**: `0` = continue (stdout parsed as JSON if it looks like JSON, else ignored);
  `2` = **deny** (stderr becomes the tool-result string fed to the model — the existing denial-string path);
  other = error (honors `on_error`).
- **JSON output** (stdout): `{ "decision": "deny"|"allow"|"ask", "reason": "…", "updatedInput": {…},
  "additionalContext": "…" }`. Mapping: `deny` → gate-style refusal string; `ask` → route into the existing
  gated-tool oneshot with the hook's reason on the card; `updatedInput` rewrites `args` before dispatch;
  `additionalContext` (post only) is appended to the tool result text.

### 4.4 Security model

1. **First run of every distinct command line** → `exec_gate::confirm_remembered("hook", command+args)` —
   native dialog outside the webview, remembered per hash (existing machinery, ~zero new code).
2. **Fail-open by default, per-hook `on_error: closed` opt-in** — a broken hook must never brick chat, but a
   security hook must be allowed to fail-closed. Claude Code's own doc warns a mistyped policy hook silently
   disables the gate; the explicit closed flag + a one-time Settings warning covers it.
3. **No project-scoped hooks in v1** — a cloned repo must not be able to ship executable config (the vector
   Gemini CLI mitigates with fingerprinting). If project hooks come later, adopt the same fingerprint +
   re-confirm-on-change approach.
4. **Hooks are user config, never model-visible surface** — but `get_capabilities` should *list active hook
   names* (not commands) so models can reason about why a call was blocked by "a user hook."
5. Substitution (`${tool_input.*}`) must **never go through a shell** — exec-form spawning only, matching
   Claude Code's exec-form guidance. If a shell form is ever added, it's a separate opt-in `shell: true`.

### 4.5 Implementation shape (Rust)

New `src-tauri/src/hooks.rs` (~300–400 lines): config load/cache (invalidate on settings write),
matcher, `run_pre(name, args, ctx) -> HookVerdict` / `run_post(...)` using `tokio::process::Command`
(direct spawn, stdin piped JSON, `kill_on_drop(true)`, per-hook timeout via `tokio::time::timeout`),
JSON stdout parse, verdict enum. Two call sites in `dispatch.rs::run_tool` (top + tail, ~30 lines) and one
wrapper call in `mcp_tools_bridge::execute_relay_tool`. One-shot observation emit in `tracker.rs` (optional,
v2). IPC: `hooks_list/set/test` (a "Run test event" button like MCP gallery's "Connect"), Settings panel
(`HooksPanel` modeled on `McpGalleryPanel`/`PermissionRulesPanel`), UI rows in `ActivitySteps` for hook runs
(pre rows show verdict, post rows show async completion).

### 4.6 Interop option (cheap win, later)

Read-only import of `~/.claude/settings.json` hooks: many users already have a hooks config; mapping its
schema onto Relay's is mechanical for `PreToolUse`/`PostToolUse` command hooks (skip `if` permission-rule
filters in v1 — Claude's docs itself calls them best-effort). Promote as "Claude Code hooks work in Relay."

## 5. Effort & phasing

| Phase | Contents | Est. |
|---|---|---|
| P1 | `hooks.rs` core + `pre_tool_use`/`post_tool_use` in `run_tool` + exec_gate trust + deny/allow | 2 d |
| P2 | `ask` → approval oneshot wiring · `updatedInput` rewrite · JSON output contract · unit tests (matcher, verdict mapping, timeout, on_error) | 1 d |
| P3 | Settings panel + test button + ActivitySteps rows | 1 d |
| P4 | relay-tools bridge coverage · harness post-tool observations (tracker) · async post-hooks | 1–2 d |
| P5 (later) | Claude Code config import · regex matchers · `turn_complete`/`session_start` · Claude `can_use_tool` pre-hook gate | open |

Total: **M (3–5 days)** to a user-visible, documented feature; the Action_list's "cheap" call is right for
P1–P2 because both the denial and the approval-pause mechanisms already exist.

## 6. Risks / open questions

Known edges accepted at implementation (2026-09-19): the one-time exec-gate dialog for a first-run hook can
appear during an UNATTENDED harness automation that calls relay-tools (nobody answers it; the MCP client
times out, the dialog lingers) — mitigate by running each hook's Test button once in Settings first, which
remembers trust; and two concurrent first-runs of the same hook can raise two dialogs (pre-existing
`exec_gate` check-then-ask race). `get_capabilities` is exempt so session startup can never block on a hook.

- **Latency**: sync hooks sit on every tool call. Default timeout 30 s is too generous for a hot path —
  consider 10 s default; async post-hooks cover the format-on-edit case.
- **Parallel rounds**: `Task` fanout means concurrent hooks; fine (each spawns its own process) but JSONL
  audit hooks must append atomically (user scripts' problem — document it).
- **Denial loops**: a model whose call keeps getting hook-denied can burn rounds like today's plan-mode
  refusals; the existing refusal text style ("user hook `<name>` blocked this because …") keeps it recoverable.
- **Which sessions**: hooks apply per *engine*, not per session, in v1 — per-session hook sets are a config
  model question deferred until real demand (Session Mesh children inherit, which is usually what you want).
- **Cloud automations**: no tool loop exists there today (§2.2) — hooks are moot until that gap is fixed;
  recommend a separate ticket for an agentic cloud automation path reusing the interactive loop.

## 7. Sources

- Relay code (2026-09-19): `src-tauri/src/chat/dispatch.rs` (`run_tool` ladder, gated families),
  `chat/permission.rs` (dual-policy model), `chat/streaming.rs` (rounds + Task fanout),
  `chat/mod.rs` (`run_one_shot_chat` — single-shot, no tools), `agent_sessions/tracker.rs` + `claude.rs`
  (harness tool booking, `can_use_tool`), `mcp_tools_bridge.rs` (direct `execute_tool`, gated skip),
  `exec_gate.rs`, `docs/audits/Action_list.md` (original "cheap" note).
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks) (primary, fetched 2026-09-19)
- [Gemini CLI hooks](https://geminicli.com/docs/hooks/) · [OpenCode plugins](https://opencode.ai) /
  [opencode.school](https://opencode.school) · [dev.to overview](https://dev.to)
