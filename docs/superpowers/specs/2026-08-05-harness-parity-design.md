# Harness Parity: Conduit System Prompt, Skills & Tools for Claude Code / Kimi / OpenCode

**Date:** 2026-08-05
**Status:** Approved (design review), pending implementation plan

## Problem

Harness sessions (Claude Code, Kimi Code, OpenCode running in the Dev-tab
terminal pane) do not behave like Conduit's built-in chat. They spawn with the
CLI's bare system prompt, no knowledge of Conduit's skills (docx/pdf/pptx/
diagram), and no access to Conduit's tools. Result: when asked to produce a
document, PPT, PDF or diagram, the harness either hand-builds it (wrong
quality, missing artifacts pipeline) or stalls on permission walls that
Conduit's chat never hit — because the harness has no permission rules on disk
at all.

## Goal

Full parity for all three CLIs:

1. The harness receives Conduit's system prompt + skill catalog ("what to do
   and where to do it").
2. The harness can call Conduit's document/diagram/file/skill tools — the same
   implementations the built-in chat uses.
3. Generated files surface as artifact chips in the harness session, exactly
   like the built-in chat.
4. Conduit-safe operations auto-approve (document generation, project file
   reads/edits, git); dangerous operations (arbitrary bash, network, writes
   outside project/artifacts) still require the approval card.

## Approach (chosen: A — Conduit-owned config bundle + spawn flags)

Extend the pattern `browser_mcp_register.rs` already uses: at harness spawn,
write a Conduit-owned config bundle into the app data dir and point the CLI at
it via native flags. The project folder's own `.claude/`, `opencode.json` etc.
are never touched. Rejected alternatives: writing into the project folder
(clobber/merge risk with user files, no clean Kimi equivalent) and wrapping the
CLI binary (brittle, breaks resume/login/upgrades).

## Architecture

New module `src-tauri/src/harness_bundle.rs` (sibling of
`browser_mcp_register.rs`). At every harness spawn — the same point where
`resolve_mcp_config` is called today (`src-tauri/src/agent_sessions.rs:557`) —
it writes a per-project bundle:

```
<app-data>/harness/<project-slug>/
  claude/
    instructions.md      # Conduit system prompt + skill catalog
    settings.json        # permissions.allow for conduit-safe ops
    mcp.json             # existing conduit-browser + NEW conduit-tools
  kimi/
    agent.md             # agent definition carrying the system prompt
    skills/              # conduit skill .md files (via --skills-dir)
    mcp.json             # existing conduit-browser + NEW conduit-tools
  opencode/
    opencode.json        # existing MCP + permission section + instructions
```

Bundle writes are idempotent (overwritten per spawn — stale copies self-heal).
Failure degrades gracefully: write fails → session spawns without bundle flags
(exactly like today's browser-MCP fallback).

### Spawn flag mapping (per adapter)

| CLI | System prompt | Permissions | Tools (MCP) |
|-----|--------------|-------------|-------------|
| Claude Code | `--append-system-prompt-file <instructions.md>` | `--settings <settings.json>` (permissions) + `--add-dir <artifacts>` | `--mcp-config <mcp.json>` (existing) |
| Kimi Code | `--agent-file <agent.md>` | `--yolo` for manual/auto_edit (auto-approve regular tools, still asks), `--auto` for full_auto (existing); `--add-dir <artifacts>` | `--mcp-config-file <mcp.json>` (existing) |
| OpenCode | instructions entry in `opencode.json` (exact key verified at implementation time — OpenCode's config schema version-dependent; fallback: instructions file referenced from config) | `permission` section in `opencode.json` (allow/edit auto-approve, bash stays `ask`) | `OPENCODE_CONFIG` env (existing) |

If a CLI lacks a flag (e.g. old version), the adapter skips that flag — never
fails the spawn.

## Tool bridge: `conduit-tools` MCP server

A second MCP server registered alongside `conduit-browser`, exposing:

- `generate_document` (docx / pptx / xlsx / pdf)
- `generate_diagram` (mermaid → SVG/PNG)
- `generate_file`
- `get_skill` / `list_skills`

It reuses the existing loopback WebSocket bridge (`BROWSER_MCP_PORT` pattern)
and dispatches to the app's existing tool handlers in
`src-tauri/src/chat/tools/mod.rs` — the exact code the built-in chat uses.
No duplicate implementations; identical output pipeline, identical artifact
events.

## Permission model (conduit-safe auto, danger gated)

- **Claude Code** `settings.json`:
  - `permissions.defaultMode: "acceptEdits"` — project file reads/writes auto-approve (as today)
  - `permissions.allow: ["mcp__conduit-tools__*"]` — doc/diagram/skill tools never prompt
  - `permissions.additionalDirectories: [<artifacts dir>, <project dir>]` + `--add-dir`
  - `Bash(git:*)` auto-approves; other bash/network remain gated → approval card (existing relay)
- **Kimi**: `--yolo` (manual/auto_edit), `--auto` (full_auto, existing), `--add-dir`
- **OpenCode**: `permission.allow` for `mcp__conduit-tools`, `permission.edit` auto-approves workspace edits, bash stays `ask`

Nothing baked in can run arbitrary bash without the approval card.

## System prompt content

`instructions.md` / `agent.md` = three parts:

1. **Environment preamble** (new, small): "You are running inside Conduit.
   Project at `<path>`. Generated documents/diagrams go to `<artifacts dir>`
   via the `conduit-tools` MCP tools — do not hand-build docx/pptx/pdf; use
   `generate_document`. Skills catalog: …"
2. **Conduit core system prompt** — existing `conduit-chat-system-prompt.md`
3. **Skill catalog** — same skills list the built-in chat advertises (docx,
   pdf, pptx, diagram), so `get_skill("docx")` behaves identically

Provider-specific chat prompt parts (`core_prompt_for(provider, model)`) are
excluded — the CLI has its own provider personality; only Conduit's environment
rules and skills cross over.

## Artifacts surfacing

Already wired: harness sessions snapshot the spawn dir before each turn and
diff after (`DirWatch`, `agent_sessions.rs:462`), surfacing files the CLI
created/modified as artifacts with file chips. The `conduit-tools` MCP path
writes through the same `artifacts::generate` code as the built-in chat into
the same artifacts dir, so the existing post-turn diff picks files up with zero
new plumbing. Rule to preserve: MCP writes must land in the same spawn/artifacts
dir the session's `DirWatch` watches (guaranteed by shared
`configured_artifacts_dir` logic).

## Error handling

- Bundle write failure → spawn without bundle flags (never fails the turn)
- Missing CLI flag → adapter skips that flag
- User config never touched; regenerated per spawn (self-healing)

## Testing

- **Unit**: bundle JSON shapes per CLI (`permissions.allow` contains
  `mcp__conduit-tools__*`; `mcp.json` lists both servers; opencode.json has the
  permission section); `instructions.md` contains the skill catalog;
  per-adapter arg assembly appends the right flags
- **Integration**: spawn a real session and assert flags on the process
  command line; generate a docx via the harness and assert the artifact chip
  event fires
