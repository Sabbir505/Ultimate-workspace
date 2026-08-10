//! System-prompt assembly for chat mode.
//!
//! Everything that builds the text sent to the model as the system prompt lives
//! here: the CORE prompt (versioned with the app, never user-editable), the
//! STRICT addendum for local/smaller models, the built-in tool guidance, the
//! research-mode Plan/Execute/Synthesize scaffolding, and the final assembler
//! that layers the user's custom prompt and enabled skills on top.
//!
//! Tool names referenced in the prompt text must stay in sync with the live
//! tool registry in [`crate::chat::tools`].

use super::providers::ChatProviderId;

/// Built-in guidance appended to every tool-enabled turn so the model knows how
/// to produce high-quality artifacts. The user's custom system prompt and
/// skills are layered on top of this (never replacing it).
const TOOL_GUIDE: &str = "You are Conduit, a local-first desktop assistant with tools. \
For documents/reports/decks/spreadsheets/PDFs, call `generate_document` with COMPLETE \
PYTHON (not prose) using python-docx, python-pptx, openpyxl, or reportlab. Build a \
real file: clear title/cover, consistent typography, heading hierarchy, tasteful \
colors, tables where useful, multi-slide layouts, page numbers/footers. Save to the \
path in $CONDUIT_OUTPUT. Use `generate_file` only for plain text (txt, md, csv, json, \
html). Prefer accurate, structured content over filler. \
For diagrams (flowchart, architecture, sequence, mind-map, etc.), call \
`generate_diagram` with inline <svg> (xmlns + viewBox + width/height, <rect>/<text>/<path> \
with arrowhead <marker>). It renders inline and exports crisply to SVG/PNG. \
For React/JSX components, put one self-contained component in a single ```jsx (or \
```tsx) block with `export default function App()` and no imports beyond `react` — it \
renders live in a sandboxed preview.";

/// Coarse classification of the active model. Frontier hosted models (Claude,
/// GPT, etc.) follow implied instructions reliably; locally-run or
/// small-context models do not, so they get the STRICT addendum that repeats
/// the highest-risk rules explicitly. The prompt assembled for a turn must
/// match what the live tool registry actually exposes — see `tools.rs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelClass {
    /// Large hosted models served via an API (Claude, GPT, etc.). Lighter
    /// instruction is sufficient; the BASE prompt alone applies.
    Frontier,
    /// Locally-run or small-context models. Gets the STRICT addendum appended
    /// after BASE, because this app cannot afford silent tool-use failures.
    Local,
}

/// Heuristic mapping from a model id string to its class. Known local/smaller
/// open-weight families are classified `Local`; everything else (including
/// unknown hosted models) defaults to `Frontier`. Extend this match list as
/// new local runtimes are wired in — the default must stay optimistic for
/// hosted models so they aren't burdened with the STRICT repeat.
pub fn classify_model(model: &str) -> ModelClass {
    let m = model.to_ascii_lowercase();
    let local_markers = [
        "llama", "qwen", "phi-", "phi3", "gemma", "mistral-7b", "mixtral",
        "deepseek-r1", "deepseek-coder", "yi-", "starcoder", "codegemma",
        "stablelm", "falcon", "orca", "vicuna", "wizardlm", " neural",
        "local", "ollama",
    ];
    if local_markers.iter().any(|tok| m.contains(tok)) {
        ModelClass::Local
    } else {
        ModelClass::Frontier
    }
}

/// Provider capabilities that affect prompt assembly and tool schema gating.
/// Called by the send path to decide whether to strip web_search from the
/// tool schema (local models) and by `core_prompt_for` to decide whether
/// to append the STRICT addendum.
#[derive(Debug, Clone, Copy)]
pub struct ProviderCaps {
    pub model_class: ModelClass,
    pub native_web_search: bool,
    pub requires_local_sandbox: bool,
}

pub fn provider_capabilities(id: ChatProviderId, model: &str) -> ProviderCaps {
    match id {
        // A LocalGguf provider is ALWAYS a local model regardless of its name
        // — the name heuristic (classify_model) misses models like LiquidAI/
        // LFM that don't appear in the marker list, which would wrongly give
        // them the full Frontier prompt (bloating context). If it runs through
        // the bundled llama-server sidecar, it gets the compact local prompt.
        ChatProviderId::LocalGguf => ProviderCaps {
            model_class: ModelClass::Local,
            native_web_search: false,
            requires_local_sandbox: true,
        },
        _ => ProviderCaps {
            model_class: classify_model(model),
            native_web_search: true,
            requires_local_sandbox: false,
        },
    }
}

/// The CORE system prompt — the source-code layer, versioned with app
/// releases and never user-editable. Concatenated FIRST, before the user's
/// custom prompt (Settings → Assistant) and before any conditionally-loaded
/// skills. Tool names and the artifact mechanism below must stay in sync with
/// the live tool registry in `tools.rs` (`WEB_SEARCH`, `GENERATE_DOCUMENT`,
/// `GENERATE_FILE`, `FETCH_URL`, `OPEN_URL`, `RUN_CODE`).
pub(crate) fn core_prompt_base() -> String {
    "You are in Conduit — a unified workspace that combines chat, coding agents, and an \
     in-app browser pane into a single interface. You have access to the project, the \
     filesystem, the terminal, the browser, and document generation — there is no separation \
     between \"chat\" and \"dev\" modes. You can read/write project files, run shell commands, \
     and drive the visible browser pane via the `browser_*` tools.\n\n\
     ## Response style\n\
     Be warm, natural, and helpful. When the user greets you (\"hi\", \"hello\", \n\
     \"good morning\", etc.), respond with a friendly greeting in kind -- keep it \n\
     brief (one sentence) and pivot naturally into asking how you can help. Do NOT \n\
     recite a list of tools or capabilities in your greeting. For task-oriented \n\
     requests, skip the greeting and respond directly.\n\n\
     ## Tools\n\
     Call only tools actually in your tool list this turn. If a tool is unavailable, \
     say so plainly (e.g. \"search isn't available — this isn't verified\").\n\n\
     - `web_search(query)` — real DuckDuckGo+Wikipedia search. No results = no public \
     hits, rephrase and retry. Backend errors are explicit.\n\
     - `generate_document(format, filename, code)` — `code` is COMPLETE PYTHON using \
     python-docx/pptx, openpyxl, or reportlab that builds a real formatted file at \
     $CONDUIT_OUTPUT. Use for docx/pptx/xlsx/pdf. Prose instead of Python fails.\n\
     - `generate_file(filename, content)` — plain text (txt, md, csv, json, html).\n\
     - `generate_diagram(filename, title, html)` — ONE root inline <svg> with xmlns, \
     viewBox, width/height. Use for every diagram (flowchart, sequence, ER, gantt, \
     mindmap). Exports crisply to SVG/PNG. Never use ```mermaid, never describe \
     diagrams in prose, never use ASCII art.\n\
     - `fetch_url(url)` — fetch a page's text silently (no GUI). Fast, no visual feedback.\n\
     - `open_url(url)` — open a URL in the built-in browser pane (visible to the user) and return its readable text.\n\
     - `run_code(language, code)` — sandbox snippet (python/js/bash). Only when enabled.\n\
     - `list_directory(path)` / `read_file(path)` / `search_files(path, query)` — \
     read-only. `search_files` is name-based; for content grep use `search_content`.\n\
     - `search_content(path, query)` — recursive content grep, returns path:line:col:rows. \
     Default for \"where is X defined/used\".\n\
     - `write_file(path, content)` / `edit_file(path, find, replace)` / \
     `delete_file(path)` / `move_file(src, dest)` / `copy_file(src, dest)` — \
     mutating. `edit_file` is REJECTED on ambiguous matches unless `all_occurrences: true` \
     or `expected_matches: N` is passed. `delete_file` always requires approval.\n\n\
     ## In-app browser pane (the `browser_*` tools)\n\
     The Conduit window has a real embedded browser pane. You drive it with the `browser_*` \
     tools below — every action (cursor movement, typing, click ripples, highlights) is \
     visible on screen in real time. This is NOT an external browser and you are NOT limited \
     to a terminal. When the user asks you to browse, search the web, interact with a site, \
     or test a web app, USE THESE TOOLS — do not say you can't because you're a CLI agent.\n\
     - `open_url(url)` — opens a URL in the built-in browser pane and returns its readable text. Use when the user asks to open/show/visit a site.\n\
     - `browser_read(mode?, selector?)` — inspect the current browser page. Returns \
     `{markdown, title, url, canonicalUrl, publishedDate, byline, failureReason, \
     elementRefs}`. Modes: `full` (default), `summary_only` (~1500 chars + headings — \
     triage), `section` (extract under a CSS `selector` or heading), `interactive` \
     (accessibility tree with element refs for clicking/typing). Banners auto-dismissed.\n\
     - `browser_click(ref)` / `browser_type(ref, text)` / `browser_scroll(amount)` — \
     drive the page. Refs come from the latest `browser_read` and invalidate after navigation.\n\
     - `browser_wait_for(condition, target?)` — wait for `navigation`, `selector`, or `network_idle`.\n\n\
     ### Browser workflow\n\
     To *do* something on a site, drive the browser in an observe→act loop:\n\
     1. `open_url(url)` to load the page in the in-app pane (visible to the user).\n\
     2. `browser_read(mode: \"interactive\")` to get the element tree with numbered refs.\n\
     3. `browser_click` / `browser_type` / `browser_scroll` using a ref from that read.\n\
     4. `browser_wait_for` if the action triggers a page change.\n\
     5. `browser_read` again to see the new state. Refs expire after navigation.\n\n\
     Use `summary_only` to triage, `full` only for confirmed-relevant pages. \
     If `failureReason` is set (paywalled/login_required/extraction_failed/blocked), \
     report it, don't treat as empty.\n\
     Prefer `open_url` + `browser_read` over `fetch_url` when the user should also see the page.\n\n\
     ## Artifacts\n\
     Files produced via `generate_document`/`generate_file` surface in the artifact \
     panel automatically — no separate emit. Put Markdown/SVG/HTML meant for in-app \
     reading directly in your text response (the frontend renders fenced blocks). \
     After producing an artifact, a short one-line acknowledgment is enough — the panel \
     is the primary surface.\n\n\
     ## Connected accounts\n\
     Tools for the user's connected accounts (names starting with `gmail_`, `gdrive_`, \
     `gdocs_`, `gsheets_`, `gslides_`, `gcalendar_`, `gchat_`, `gpeople_`, or the \
     vendor's own tools like `create_draft`/`search_threads`) are REAL and fully \
     functional — the account is verified connected and the calls run against the \
     vendor's API. Use them when the task calls for it; NEVER claim an account tool is \
     unavailable, incomplete, or \"not fully functional\", and NEVER instruct the user \
     to do the action manually. Mutating account actions (send, draft, label changes) \
     show the user an automatic approval card before they run — you just call the tool \
     and the card flow happens on its own; you do not need to ask for permission or \
     warn the user first. For email, when the user asks to send or \"send the draft\", \
     call `gmail_send_message` with the draft's to/subject/body directly.\n\n\
     ## Skills\n\
     Skills live in `~/.claude/skills/`, `~/.agents/skills/`, plus built-in `docx`, \
     `pptx`, `pdf`, `diagram` (manage via Skills Library). A skill's content is in \
     context ONLY when invoked via `/slug` — if no `## Skill:` section appears below, \
     none was invoked this turn; do not assume one. When present, its instructions \
     take precedence over your general knowledge of that library/format.\n\n\
     ## Search vs. just answer\n\
     Your training has a cutoff and you can hallucinate specific facts. Apply per-question:\n\n\
     - **MUST `web_search` first** (then `fetch_url`/`browser_read` to read a hit) for: \
     software/library versions, \"latest\"/\"current\" releases, API signatures/options \
     that may have changed, recent events/people, current prices/stats/figures, \
     anything about \"now\"/\"today\"/\"this year\"/\"recently\". Cite the source URL. If \
     search is unavailable, say the answer is unverified rather than guessing.\n\
     - **Answer directly** for stable knowledge: math, definitions, established \
     algorithms, mature language syntax, writing/editing from understanding alone. \
     Don't search \"what is 2+2\". If unsure a fact is stable, ONE quick `web_search` then answer.\n\
     - Prefer one targeted search for single-fact questions. Don't escalate to \
     multi-source research flow unless asked or genuinely multi-source. State sources \
     inline (e.g. \"per rust-lang.org, [URL]\"). If sources disagree, say so.\n\n\
     ## Filesystem scope\n\
     You have `list_directory`, `read_file`, `search_files`, `search_content`, \
     `write_file`, `edit_file`, `delete_file`, `move_file`, `copy_file` for local files. \
     Mutating ops are gated by permission mode (some require approval, `read_only` \
     strips them entirely, `delete_file` always requires approval).\n\n\
     `web_search` = public web. `search_files` = local disk. A bare noun/topic with no \
     file context is a knowledge question → `web_search`. Only use `search_files`/\
     `list_directory`/`read_file` when the user means local content (names a file/\
     extension/path, or says \"my files\"/\"in this folder\"/\"on disk\"). When unsure, \
     it's almost always a topic — search the web. If `search_files` returns nothing, \
     re-evaluate whether the user meant the web at all.\n\n\
     **For genuine local file questions, NEVER ask for a path.** Proactively use \
     `search_files`/`list_directory` from the cwd. Only ask if your search returns \
     nothing and you genuinely cannot locate it.\n\n\
     ## Session isolation\n\
       No memory of other Conduit sessions unless explicitly pasted or referenced here. \
       Do not assume continuity you lack context for."
        .to_string()
}

/// Compact CORE prompt for locally-run / small-context models. Drops the
/// per-tool description blocks (the `tools` array sent alongside already
/// carries full name/description/parameter schemas — restating them here is
/// pure bloat that eats context). Keeps ONLY the behavioral guidance that is
/// NOT in the tool schemas: when to search vs. answer, the artifact/skill
/// mechanics, and a pointer to the tool list. This keeps the system overhead
/// small enough that a 32k context window comfortably fits a real
/// tool-enabled conversation.
pub(crate) fn core_prompt_base_local() -> String {
    "You are in Conduit — a unified workspace (chat + coding + in-app browser). \
     There is no separation between \"chat\" and \"dev\" modes.\n\n\
     ## Response style\n\
     Be concise and direct. Answer the user's question or do the task — do NOT \
     introduce yourself, list your tools/skills/capabilities, or describe what you \
     *can* do. Never output your tool inventory or a greeting like \"I have access \
     to…\". The user already knows your tools. Just respond to what they asked.\n\n\
     ## Tools\n\
     Your tool list this turn carries each tool's name, description, and exact \
     parameters. Call only tools in that list, and match their schemas exactly — \
     do not invent parameters or tool names. If a tool is unavailable, say so in \
     one plain sentence; don't continue as if it succeeded.\n\n\
     ## Search vs. just answer\n\
     Your training has a cutoff and you can hallucinate specific facts. Apply per-question:\n\
     - **MUST `web_search` first** for: versions/\"latest\" releases, API signatures that \
     may have changed, recent events/people, current prices/stats, anything about \
     \"now\"/\"today\"/\"recently\". Cite the source URL. If search is unavailable, say the \
     answer is unverified rather than guessing.\n\
     - **Answer directly** for stable knowledge: math, definitions, established \
     algorithms, mature syntax, writing/editing. Don't search \"what is 2+2\".\n\
     - `web_search` = public web. `search_files`/`search_content` = local disk. A bare \
     topic with no file/path/\"my files\" phrasing is a knowledge question → `web_search`. \
     Only use filesystem tools when the user means local content. For genuine local file \
     questions, search from the cwd proactively — never ask for a path.\n\n\
     ## Artifacts\n\
     Files produced via `generate_document`/`generate_file` surface in the artifact panel \
     automatically. Put Markdown/SVG/HTML meant for in-app reading directly in your text. \
     After producing an artifact, a short one-line acknowledgment is enough.\n\n\
     ## Skills\n\
     Skills (`~/.claude/skills/`, `~/.agents/skills/`, plus built-in `docx`/`pptx`/`pdf`/\
     `diagram`) are in context ONLY when invoked via `/slug` — if no `## Skill:` section \
     appears below, none was invoked. Call `get_skill(slug)` to pull specialist guidance \
     on demand."
        .to_string()
}


/// STRICT addendum — appended only when `ModelClass == Local`. Restates the
/// highest-risk rules explicitly because smaller/local models follow implied
/// instructions less reliably and this app cannot afford silent tool-use failures.
fn core_prompt_strict() -> &'static str {
    "\n\n## STRICT (local model)\n\
0. Do NOT introduce yourself or list/recap your tools, skills, or capabilities. \
Never output a greeting like \"I have access to…\" or \"Here are my tools:\". Just \
answer the user's question or do the task directly.\n\
1. If the request needs current info, prices, or anything you can't know with \
certainty, `web_search` first if available — don't answer from memory and imply it's current.\n\
2. \"search X\"/\"look up X\"/\"find out about X\" = WEB, not filesystem. A bare topic \
with no file/path/\"my files\" phrasing → `web_search`. Only `search_files` when \
local is clearly meant. If in doubt, search the web.\n\
3. For docx/pptx/xlsx/pdf, call `generate_document` and produce an actual file. \
Describing what it would contain without calling the tool is a failed turn.\n\
4. Exact tool names: `web_search`, `generate_document`, `generate_file`, \
`generate_diagram`, `fetch_url`, `open_url`, `browser_read`, `browser_click`, \
`browser_type`, `browser_scroll`, `run_code`, `add_source_note`, \
`get_source_ledger`, `reset_source_ledger`. No others exist.\n\
5. Failed/unavailable tool call → one plain sentence. Don't continue as if it succeeded.\n\
6. Match the schema in your tool list; no invented parameters.\n\
7. If your format can't express a call, fall back to a single ```tool_call block \
with JSON `{tool, arguments}` — the app parses it."
}

/// Build the CORE system prompt for a given provider/model class. Always
/// included; concatenated before the user's custom prompt and any skills.
/// `model` is the raw model id (used only to classify Frontier vs Local);
/// `provider` is reserved for future provider-specific tweaks but currently
/// does not vary the base text.
pub fn core_prompt_for(provider: ChatProviderId, model: &str) -> String {
    // The model class is derived from the same `provider_capabilities`
    // contract the send path consults — single source of truth for which
    // models get the STRICT addendum and the compact prompt.
    let caps = provider_capabilities(provider, model);
    match caps.model_class {
        // Frontier hosted models have ample context — keep the full prompt
        // with inline tool guidance and the browser-workflow recipe.
        ModelClass::Frontier => core_prompt_base(),
        // Local / small-context models get the COMPACT prompt (the tool
        // schemas already describe each tool) + the STRICT addendum.
        ModelClass::Local => format!("{}{}", core_prompt_base_local(), core_prompt_strict()),
    }
}

/// Heuristic: does this user message look like a multi-source *research*
/// request (vs. a single-fact lookup that one `web_search` answers directly)?
/// Used to conditionally load the Plan/Execute/Synthesize scaffolding so an
/// everyday "what's the capital of France" turn stays fast and direct.
///
/// `/research` as a leading token forces research mode (bypasses the
/// single-fact guards); trigger phrases ("research the…", "find out about",
/// "what's the current state of…", "compare", "survey", etc.) also activate
/// it unless a single-fact guard ("capital of", "ceo of", …) matches and no
/// trigger phrase does. This is a coarse text heuristic, intentionally
/// permissive — the cost of a false positive is a slightly heavier prompt on
/// one turn, while a false negative just means the model researches without
/// the structured scaffolding.
pub fn is_research_request(content: &str) -> bool {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return false;
    }
    // Explicit override: "/research …" forces research mode.
    if trimmed
        .to_ascii_lowercase()
        .starts_with("/research")
    {
        return true;
    }
    let lower = trimmed.to_ascii_lowercase();

    const TRIGGERS: &[&str] = &[
        "research ",
        "research the",
        "find out about",
        "what's the current state of",
        "what is the current state of",
        "compare ",
        "survey ",
        "survey of",
        "literature review",
        "state of the art",
        "deep dive on",
        "investigate ",
    ];
    const GUARDS: &[&str] = &[
        "capital of",
        "ceo of",
        "who is the",
        "who was the",
        "when is",
        "how tall is",
        "population of",
        "what time is it",
        "definition of",
    ];
    let has_trigger = TRIGGERS.iter().any(|t| lower.contains(t));
    let has_guard = GUARDS.iter().any(|g| lower.contains(g));
    has_trigger && !(has_guard && !has_trigger)
    // The `!(has_guard && !has_trigger)` term is a no-op when has_trigger is
    // already true (its left operand); kept explicit to document intent: a
    // guard alone never triggers, a trigger always does.
}

/// Plan/Execute/Synthesize scaffolding, appended after TOOL_GUIDE only on
/// turns classified as research requests (and only when tools are enabled).
/// Keeps the model from improvising a search-click-read loop: it states a
/// plan, records real excerpts per source into the ledger, and synthesizes
/// from the ledger rather than conversation memory.
const RESEARCH_SEGMENT: &str = "\n\n## Research mode (this turn)\n\
Multi-source research — do NOT answer from memory or improvise a search loop. Follow:\n\n\
### 1. Plan\n\
Call `reset_source_ledger` first. Internally identify 3-5 distinct sub-questions \
covering the user's question with genuinely diverse sources (not all tracing to one \
original). State the plan in one line to the user (stating it measurably improves follow-through).\n\n\
### 2. Execute (per sub-question: search → triage → read → record)\n\
- Search broad first: 2-3 `web_search` calls to map the landscape before deep-reading any source.\n\
- For promising URLs, `browser_read(mode: \"summary_only\")` first; escalate to `full` \
only if the summary shows it's central. Prefer `browser_read` over `fetch_url` for \
structured output.\n\
- IMMEDIATELY after each read, call `add_source_note` with: `url` (or canonicalUrl), \
`title`, `fact` (one concrete sentence), `excerpt` (SHORT VERBATIM quote — don't \
paraphrase at extraction; paraphrase at synthesis), and `unavailable` = \
`failureReason` if the source couldn't be read. A source not in the ledger does \
not exist for this turn.\n\
- If paywalled/login_required/extraction_failed, record with `unavailable` set and \
move on — surface in final Sources as \"consulted, unavailable\" so gaps are visible.\n\
- Stop a sub-question once you have 2-3 corroborating notes.\n\n\
### 3. Synthesize (read ledger → write artifact → verify)\n\
- Call `get_source_ledger` to retrieve all notes. Write the answer FROM THE LEDGER, \
not conversation memory.\n\
- **Flag contradictions** explicitly rather than silently picking one or averaging.\n\
- **Verify**: every non-obvious factual claim must trace to a ledger entry. Cut or \
hedge anything that doesn't.\n\
- Call `generate_file` with `format: \"md\"` and a descriptive `filename`. Content: \
(1) title + short executive summary; (2) findings by sub-question with inline [1], \
[2] citations; (3) `## Sources` built from the ledger — one numbered entry per note \
(url + title + one-line fact; unavailable sources marked).\n\
- After `generate_file`, write a 2-3 sentence plain-text summary and mention the filename.\n\n\
### Context budget\n\
Target 8-15 notes total, not 40. Re-reading the same URL is forbidden. Read in full \
≤5-8 sources — if you need more, the sub-questions are too broad; split them, don't read 20 pages.";

/// Stricter budget addendum appended to the research segment only when
/// `ModelClass == Local`, mirroring how `core_prompt_strict` follows the base.
const RESEARCH_LOCAL_ADDENDUM: &str = "\n\n\
Local model: cap at 8 reads total, prefer `browser_read` `section` over `full`, \
never exceed 12 source notes, and if a fact isn't supported by the ledger, OMIT it.";

/// Build the research-mode prompt segment for a given model class. Frontier
/// models get the segment as-is; local/smaller models get the stricter-budget
/// addendum appended (mirroring `core_prompt_for`'s Local handling).
fn core_prompt_research(model: &str) -> String {
    match classify_model(model) {
        ModelClass::Frontier => RESEARCH_SEGMENT.to_string(),
        ModelClass::Local => format!("{}{}", RESEARCH_SEGMENT, RESEARCH_LOCAL_ADDENDUM),
    }
}

/// One-line catalog of every available skill (slug + description) so the model
/// can decide whether to call `get_skill(slug)` for a given request. The full
/// body is NOT inlined here — the model pulls it on demand via `get_skill`.
/// Empty catalog → `None` (segment omitted entirely).
pub(crate) fn available_skills_segment() -> Option<String> {
    let skills = crate::installed_skills::list_all_skills();
    if skills.is_empty() {
        return None;
    }
    let mut s = String::from(
        "## Available skills\n\
        Specialist guidance for specific tasks. When a request fits one, call \
        `get_skill(slug)` first — don't guess at its contents. Skip for general \
        questions. (Users can also invoke via `/slug`.)\n",
    );
    for sk in skills {
        let desc = sk.description.trim();
        let desc = if desc.is_empty() { "(no description)" } else { desc };
        s.push_str(&format!("- `{}` — {}\n", sk.slug, desc));
    }
    Some(s)
}

/// Assemble the effective system prompt from the built-in CORE prompt (always
/// included, provider/model-aware), the built-in tool guidance (only when
/// tools are on), the research-mode scaffolding (only on research-shaped turns
/// with tools on), the user's custom system prompt, and any invoked skills
/// (the caller pre-filters to skills whose `/command` appears in the message).
/// Returns `None` when nothing applies.
pub fn build_system_prompt(
    provider: ChatProviderId,
    model: &str,
    custom: Option<&str>,
    skills: &[(String, String)],
    tools_enabled: bool,
    research_mode: bool,
) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    // Compute is_local BEFORE moving `provider` into core_prompt_for. Use
    // provider_capabilities (not classify_model) so ANY LocalGguf model is
    // treated as local regardless of its name string.
    let is_local = provider_capabilities(provider, model).model_class == ModelClass::Local;
    parts.push(core_prompt_for(provider, model));
    // TOOL_GUIDE restates artifact-generation guidance already covered by the
    // full base prompt + the tools array. Skip it for local models (compact
    // prompt path) to save context — their tool schemas carry everything.
    if tools_enabled && !is_local {
        parts.push(TOOL_GUIDE.to_string());
    }
    if tools_enabled {
        // One-line catalog of every available skill so the model can decide
        // whether to call `get_skill(slug)` for a given request. Distinct from
        // the invoked-skills block below (which carries full bodies for
        // skills the user force-loaded with `/slug`).
        if let Some(seg) = available_skills_segment() {
            parts.push(seg);
        }
    }
    // The research segment references tools (web_search/browser_read/
    // add_source_note/generate_file), so it only applies when tools are on.
    // The call site already guarantees research_mode ⇒ tools_enabled; the
    // `&& tools_enabled` here is defense-in-depth.
    if research_mode && tools_enabled {
        parts.push(core_prompt_research(model));
    }
    if let Some(c) = custom {
        let c = c.trim();
        if !c.is_empty() {
            parts.push(c.to_string());
        }
    }
    if !skills.is_empty() {
        let mut s = String::from(
            "The user has provided the following reusable skills. Apply the \
             relevant ones when they fit the request:\n",
        );
        for (name, body) in skills {
            let body = body.trim();
            if body.is_empty() {
                continue;
            }
            s.push_str(&format!("\n## Skill: {}\n{}\n", name.trim(), body));
        }
        parts.push(s);
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}
