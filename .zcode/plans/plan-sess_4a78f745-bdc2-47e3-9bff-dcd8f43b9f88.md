# Attach-on-demand tools + 8k baseline budget (all providers & harnesses)

## Research summary (what others do)

| System | Approach |
|---|---|
| ChatGPT | `api_tool` meta-tool: one-line-per-connector manifest (~100 tokens for 161 functions) + `list_resources`/`call_tool`. No router model. |
| OpenAI API | `tool_search` + `defer_loading` + namespaces; client-executed variant resolves search in the app. |
| Claude Code ≥v2.1.7 | Auto-defers all MCP tools behind an `MCPSearch` meta-tool when definitions exceed 10% of context window. |
| Anthropic API | Tool Search Tool (`defer_loading`): 85% context cut, selection accuracy *improved* (74%→88%). |
| Copilot | 128-tool cap; embedding-clustered "virtual tools"; trimming 40 built-ins to 13 essentials **improved** resolution 2–5pp. |
| pi | 4 fixed tools, <1k tokens; capabilities as CLI+README via bash (zero schema cost). |
| Hermes | Tool defs embedded in the system prompt — static always-send is structurally worst-case. |

**Consensus pattern:** tiny always-present manifest + in-band meta-tool attach + explicit user attach. No separate router classifier (nobody ships one). Our app already has both precedents: the skills catalog + `get_skill` (progressive disclosure), and the intact-but-idle v0.3.0 `@`-attach plumbing (DB table, commands, IPC).

## Token budget (hard target: assembled baseline < 8k tokens, all paths)

| Component | Budget | Mechanism |
|---|---|---|
| Core system prompt (local ~3.2k chars / frontier <9k chars) | ~1.0k tok | unchanged (already test-bounded) |
| Skills catalog | ≤ 1.0k tok | first-sentence-only descriptions (~120 chars/skill cap) |
| Connector/server manifest | ~0.25k tok | one line per available connector/MCP server |
| 31 built-in tool schemas | ≤ 3.2k tok (from 5.9k) | descriptions compressed to 2–3 sentences; param schemas untouched; long behavioral guidance (generate_document/diagram style rules) moves into the tool *result* at call time |
| Template/turn overhead | ~0.3k tok | — |
| **Total** | **~5–6k tok** | headroom under 8k for history |

Harness caveat: we control only our injected mcp.json + custom prompt (drops to ~0 by default); the CLI's own system prompt/tools are its own.

## Design

Three attachment paths, one store — the existing `chat_session_connectors` table, extended with `"mcp:<server_id>"` rows for gallery servers:

1. **@-mention (explicit):** composer `@` menu (mirrors existing slash-menu) listing connected connectors + enabled MCP servers; writes a session row; removable chips in composer footer.
2. **Keyword fast-path (pre-attach at send):** curated `keywords` per connector matched against the message (mirrors `is_research_request`); attaches + persists immediately — lets small local models skip the meta-tool hop.
3. **Meta-tool (model-driven):** always-present `attach_connector` / `attach_mcp_server` tools. Model calls them when the manifest suggests relevance; dispatcher connects, extends the live `tools` array mid-turn, persists the row (persists for session → composer chips).

Auto-detected and model-initiated attachments **persist for the session** (user decision). MCP gallery servers get identical treatment (user decision).

**Default turn:** no session rows → system prompt + built-in tools only → ~5–6k tokens.

## Implementation steps

1. **Registry metadata** — `connectors/config.rs`: add `description` + `keywords` to `Connector` (11 entries). Update registry tests.
2. **DB** — `db/chat.rs`: append/remove single-row fns alongside `set_chat_session_connectors`.
3. **Kill global auto-attach (chat path)** — `chat/commands.rs:1309-1324`: session rows only (drop credential + public unions). Parse `mcp:` rows; thread allowed ids into `ChatManager::send` → filter `mcp_gallery::attach_enabled(app, allowed)`.
4. **Manifest segment** — `chat/prompts.rs`: `## Connected apps & servers` segment (tools-on only); caller passes it into `build_system_prompt` as a param (fn stays pure); include in `count_context_tokens`.
5. **Meta-tools** — `chat/tools/specs.rs`: `attach_connector`/`attach_mcp_server` specs (enum ids). Dispatcher (`chat/tools/mod.rs` + `dispatch.rs`): validate → connect one → result "Attached X (N tools): …". Mid-loop: `ChatManager` holds per-turn `Arc<Mutex<Vec<…>>>` the dispatcher fills; tool loops drain it after each round and extend `tool_specs`. Persist row + emit chip event.
6. **Keyword fast-path** — `detect_connector_mentions(content)` (incl. literal `@gmail` tokens, parsed like slash-tokens); union into send + persist. Tests mirror `is_research_request` suite (`chat/mod.rs:1010-1083`).
7. **Harness path** — `connectors/harness.rs:36-69` + `commands/agent_cmds.rs:47`: filter `harness_mcp_servers` to session rows (kimi/opencode respawn per turn → next turn; claude_code → next spawn; note in UI). Update `harness_bundle.rs` merge tests.
8. **Composer UI** — `ChatComposer.tsx`: `@` menu mirroring slash-menu (`641-830`); attachment chips w/ remove; `state/chat.ts` + `ipc.ts` wire-up. Restore on session load.
9. **Skills catalog trim** — `prompts.rs available_skills_segment`: description → first sentence, capped ~120 chars + "…" (full description stays available via `get_skill`).
10. **Built-in description compression** — `chat/tools/mod.rs` DESC consts: 2–3 sentences each; move `GENERATE_DOCUMENT_DESC`/`GENERATE_DIAGRAM_DESC` style rules into the tool result payload at execution time.
11. **Budget guards (tests)** — extend `core_prompts_stay_within_budget`: assembled baseline (core + skills segment + manifest + 31 compressed specs serialized) under a char-budget proxy for the 8k target (e.g. < 26k chars total ≈ 8k tok); fail loudly on regression.
12. **Meter honesty** — `count_context_tokens`/`count_context_breakdown`: include manifest; connector row reports attached-set estimate.

## Verification
- `cargo check` + `cargo test`; `npm run test`.
- Manual via existing `[prompt-audit]` logs: fresh local turn → expect ~31 specs / ≤ ~10k chars tools JSON / server prompt_tokens ≈ 5–7k. `@notion` or "search my drive" → only that source attaches. Harness turn → mcp.json contains only attached servers.

## Out of scope (later)
Embedding pre-routing (Copilot-style), Anthropic server-side `defer_loading` beta, dropping built-in tools for local models (compression is enough; no capability loss).