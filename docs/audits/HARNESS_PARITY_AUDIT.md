# Harness vs Built-in Chat — Parity Audit

*Research report · 2026-09-05 · no code changes*

> **UPDATE 2026-09-05 (later same day): G1, G2, G3, G4, G5, G6, G7 and G9 are now FIXED** (G8/ACP remains a v1 protocol limitation by design). See `§5 Recommended fixes` — items 1–5 and the PTY documentation shipped; gallery MCP servers ride the claude/kimi/opencode configs as stdio entries, pi/omp/commandcode/opencode get the instructions on their first turn, date + manifest + memory sections render into the bundle instructions, one-shot automations get persona + bundle, and `browser_screenshot` is advertised in both wire formats.

Question: does a harness agent (Claude Code, Kimi, OpenCode, pi, omp, commandcode, ACP) get the same context as Relay's built-in chat — tools, MCP, connectors, system prompt, skills?

**Short answer: no — partly by design, partly by omission.** Harnesses get their own CLI's tools plus a 9-tool Relay bridge and (for three of six adapters) the Relay MCP/connector bundle. They never get the core system prompt, memory, the attach-on-demand manifest, or the user's MCP-gallery servers. One-shot automations get none of it.

## 1. The two pipelines

| | Built-in chat | Harness agents |
|---|---|---|
| Prompt | `build_system_prompt` (`chat/prompts.rs:660`) — 10 assembled sections | CLI's own prompt + `harness_persona` prefix per turn (`agent_sessions.rs:634`) |
| Tools | ~40 registered schemas (`chat/tools/specs.rs`) + connector/MCP tools per turn | CLI's native tools + `conduit-tools` bridge (9 tools) + `conduit-browser` MCP |
| Config | none (in-process) | bundle written to `<app-data>/harness/<project>/` per spawn (`harness_bundle.rs`) |

## 2. What harnesses DO get

- **Per-turn prefix on every turn** (all harnesses + ACP): `harness_persona` ("You are Relay…", artifacts behavior) + the user's custom system prompt + the DB context primer on fresh sessions (`agent_sessions.rs:287-308`).
- **Bundle** (`harness_bundle.rs`), rebuilt on every spawn:
  - `claude/`: `instructions.md` (env preamble + `## Available skills` catalog + `## Artifacts` section w/ 10 recent artifacts) via `--append-system-prompt-file`, `settings.json` (permission mapping, allow `mcp__conduit-tools__*`), `mcp.json` (`conduit-browser`, `conduit-tools`, attached connectors as remote HTTP servers).
  - `kimi/`: same via `--mcp-config-file` + `--agent-file`.
  - `opencode.json`: both MCP servers + connectors via `OPENCODE_CONFIG`.
  - Connector OAuth tokens refreshed at write time (`connectors/harness.rs:71`).
- **Bridge tools** (`mcp_tools_bridge.rs:27-37`, whitelist): `generate_document, plan_document, revise_document, generate_diagram, generate_file, get_skill, list_skills, search_docs, get_capabilities` — routed through the same `execute_tool` dispatcher as built-in chat.
- **Connectors attached to the chat session**: become remote MCP servers in claude/kimi/opencode bundles.
- **Skills on disk**: the Skills Library writes into `~/.claude/skills/` and `~/.agents/skills/` so Claude/Kimi see them natively.

## 3. Parity gaps (ordered by impact)

### G1 — User's MCP-gallery servers never reach harnesses ⚠ biggest gap
`harness_mcp_servers` filters `mcp:` rows out of the session attachment list (`connectors/harness.rs:46-53`, comment: "have no harness meaning"). Every MCP server the user installed in Relay's gallery (rmcp stdio/remote) works in built-in chat (tools merged per turn, `chat/mod.rs:492-497`) and is **silently absent** in every harness. Harnesses see gallery names only as `get_capabilities` text.

### G2 — No instructions channel for OpenCode/pi/omp/commandcode
Bundle injection exists only for claude (`claude_bundle_args`, `agent_sessions.rs:2092`), kimi (`2921`), opencode (`OPENCODE_CONFIG`, `3478`). pi, omp and commandcode spawns consume **nothing from the bundle** — no MCP config, no skills catalog, no artifacts section, no env preamble. They get only the per-turn persona prefix. The bundle is written to disk for them, then unused.

### G3 — No attach-on-demand manifest / meta-tools
Built-in chat gets `## Connected apps & servers` (unattached connectors + gallery servers, `prompts.rs:567`) plus `attach_connector`/`attach_mcp_server` tools. Harnesses have no discoverability for unattached sources and no attach mechanism — they only see connectors pre-attached to the chat session.

### G4 — No memory
The persistent-memory document (2200-tok budget, `memory/render.rs:53`) and `memory_save/recall/forget` tools are built-in-chat only. A harness agent starts every project cold.

### G5 — Date/time missing
`current_datetime_segment` (`prompts.rs:348`) is not included in `instructions.md`, so claude/kimi harnesses don't know today's date. (Persona prefix doesn't carry it either.)

### G6 — Tool-schema drift in built-in chat (bug, opposite direction)
`browser_screenshot` is dispatchable (`tools/mod.rs:573`) but missing from both wire-schema builders (`specs.rs`) — the built-in chat never advertises it. Fix while doing parity work.

### G7 — One-shot automations get nothing
`run_one_shot` (`agent_sessions.rs:4578`) prepends only the custom system prompt — no bundle, no persona, no MCP, no connectors. A scheduled harness run can't use conduit-tools at all.

### G8 — ACP agents excluded by design (v1)
No bundle ("not part of ACP v1", `agent_sessions.rs:1231`), and Relay refuses ACP tool calls with an error result (`acp/mod.rs:96-109`). They get only the persona prefix.

### G9 — Interactive PTY panes: connectors empty
PTY spawns pass an empty connector list (`pty_cmds.rs:86`) — attached connectors work headless-only. Browser/tools MCP do reach PTY panes.

### Smaller items
- `kimi_skills_dir` bundle field declared, never used (`harness_bundle.rs:323`).
- Research-mode scaffolding, source-ledger tools, `web_search`/`fetch_url` as chat tools, todo/plan tools (claude has native plan mode), task subagents, `run_code` — harnesss rely on their CLIs' equivalents; no action needed for most, but `web_search`-style capability genuinely doesn't exist for harnesses beyond what their CLI ships.

## 4. What is intentionally NOT shared (and should stay that way)

- **Relay's CORE prompt** — `harness_bundle.rs:57-62` documents this: CLIs keep their own provider personality; only Relay-specific environment is additive. Sending the whole built-in prompt would fight the harness's own system prompt and burn context.
- Permission model: harness permissions map through each CLI's own flags/settings (bundle `settings.json` for claude, flags for others) — appropriate.

## 5. Recommended fixes (priority order, if pursued)

1. **P1 — Gallery MCP servers in harness bundles**: extend `harness_mcp_servers` to include enabled gallery servers (spawn/connect via `mcp_gallery::connect_server` at bundle-write time, or translate stdio defs directly into `claude/mcp.json` / `kimi/mcp.json` / `opencode.json`, which support stdio natively). G1.
2. **P1 — Instructions channel for the other adapters**: pi/omp/commandcode read the turn prompt anyway — append the instructions/body text to the per-turn prefix on fresh sessions. OpenCode: inject via its rules mechanism (AGENTS.md-style file) or prepend to the turn text. G2.
3. **P2 — Date/time + manifest text in `instructions.md`** (and the persona prefix for the other adapters): trivial, high value. G5, G3 (text half).
4. **P2 — Bundle for one-shot automations.** G7.
5. **P2 — Add `browser_screenshot` to `specs.rs`.** G6.
6. **P3 — Memory block for harnesses** (respecting the "CLI has its own personality" rule by injecting it as the additive `## About this user` section like skills are). G4.
7. **P3 — Wire connectors into PTY spawns** or document headless-only. G9.

## Verification anchors

- Bundle scope: `harness_bundle.rs:57-62` (CORE prompt exclusion comment), `:63-127` instructions, `:134-161` artifacts section, `:460-478` claude args
- MCP filter: `connectors/harness.rs:46-53`; bridge whitelist: `mcp_tools_bridge.rs:27-37`
- Bundle wiring: `agent_sessions.rs:2092` (claude), `:2921` (kimi), `:3478` (opencode); persona prefix `:634-646`, turn assembly `:287-308`
- Built-in chat assembly: `chat/prompts.rs:660-732`, tools `chat/tools/specs.rs:12-265`, MCP attach `chat/mod.rs:492-497`, manifest `prompts.rs:567-598`
- Automations: `agent_sessions.rs:4578-4701`; ACP refusal `acp/mod.rs:96-109`; PTY connectors `commands/pty_cmds.rs:86`
