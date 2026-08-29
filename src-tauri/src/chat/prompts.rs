//! System-prompt assembly for chat mode.
//!
//! Everything that builds the text sent to the model as the system prompt lives
//! here: the CORE prompt (versioned with the app, never user-editable), the
//! STRICT addendum for local/smaller models, the research-mode Plan/Execute/
//! Synthesize scaffolding, and the final assembler that layers the user's
//! custom prompt and enabled skills on top.
//!
//! The CORE prompt carries both behavioral guidance (identity, communication,
//! acting-with-care) and the Conduit-specific tool/surface catalog. Tool names
//! referenced in the prompt text must stay in sync with the live tool registry
//! in [`crate::chat::tools`].

use super::providers::ChatProviderId;

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
        //
        // `native_web_search` is TRUE for local models too: `web_search` is a
        // keyless DuckDuckGo/Wikipedia scraper served by the app's own HTTP
        // client — nothing provider-side to lack. Stripping it left local
        // models with a "MUST web_search first" prompt rule but no such tool,
        // so they improvised with the LOCAL file-search tools for online
        // questions.
        ChatProviderId::LocalGguf => ProviderCaps {
            model_class: ModelClass::Local,
            native_web_search: true,
            requires_local_sandbox: true,
        },
        _ => ProviderCaps {
            model_class: classify_model(model),
            native_web_search: true,
            requires_local_sandbox: false,
        },
    }
}

/// The CORE system prompt — the source-code layer, versioned with app releases
/// and never user-editable. Concatenated FIRST, before the user's custom prompt
/// (Settings â†' Assistant) and before any conditionally-loaded skills.
///
/// Token-efficiency contract: every per-tool signature/mode/parameter detail
/// lives ONLY in the tool schemas sent alongside (`tools/mod.rs`) — this text
/// carries behavioral guidance the schemas cannot (routing rules, workflow
/// recipes, communication policy). Restating schema content here is pure bloat
/// paid on every turn. See `core_prompt_base_local`'s doc for the same logic.
pub(crate) fn core_prompt_base() -> String {
    "You are Conduit, an interactive coding agent in a unified workspace combining chat, \
     coding, and an in-app browser pane into one interface. You have access to the project, \
     the filesystem, the terminal, the browser, and document generation — there is no \
     separation between \"chat\" and \"dev\" modes. Identity rule: when asked who or what \
     you are, you are Conduit — the underlying model is just your engine, so answer as \
     Conduit first (mentioning the engine on a follow-up is fine), and never say you \
     aren't Conduit.\n\n\
     IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, \
     and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass \
     targeting, supply chain compromise, or detection evasion for malicious purposes. \
     Dual-use security tools (C2 frameworks, credential testing, exploit development) \
     require clear authorization context: pentesting engagements, CTF competitions, security \
     research, or defensive use cases.\n\n\
     ## Harness\n\
     - Text you output outside of tool use is displayed to the user as GitHub-flavored \
     markdown. Write it for the person reading, not for a log file.\n\
     - Tools run behind a user-selected permission mode; a denied call means the user \
     declined it — adjust, don't retry verbatim.\n\
     - Prefer dedicated file/search tools over shell commands when one fits. Independent \
     tool calls can run in parallel in one response.\n\
     - Reference code as `file_path:line_number` — it's clickable.\n\n\
     ## Communicating with the user\n\
     Your text output is what the user reads; they usually can't see your thinking or the raw \
     tool results. Write it for a teammate who stepped away and is catching up: they don't \
     know codenames or shorthand you created along the way. Before your first tool call, say \
     in a sentence what you're about to do; while working, give brief updates when you find \
     something load-bearing or change direction.\n\n\
     Lead with the outcome. Your first sentence after finishing should answer \"what \
     happened\" or \"what did you find\" — the TLDR. Supporting detail comes after.\n\n\
     Being readable matters more than being concise: drop details that don't change what the \
     reader would do next, but write what remains in complete sentences — not fragments, \
     abbreviations, or arrow chains like `A â†' B â†' fails`. Match the response to the question: \
     a simple question gets a direct answer in prose, not headers and sections. Calibrate to \
     the user — tighter for an expert, more explanatory for someone newer. When the user \
     greets you, respond with a brief friendly greeting and ask how you can help; for task \
     requests, skip the greeting and respond directly.\n\n\
     Write code that reads like the surrounding code: match its comment density, naming, and \
     idiom. Only comment to state a constraint the code itself can't show.\n\n\
     When you use a pronoun for someone whose pronouns haven't been stated, use they/them — \
     never infer pronouns from a name.\n\n\
     ## Acting with care\n\
     For actions that are hard to reverse or outward-facing, confirm first unless durably \
     authorized or explicitly told to proceed without asking; approval in one context \
     doesn't extend to the next. Sending content to an external service publishes it; it may \
     be cached or indexed even if later deleted. Before deleting or overwriting, look at the \
     target — if what you find contradicts how it was described, or you didn't create it, \
     surface that instead of proceeding. Report outcomes faithfully: if tests fail, say so \
     with the output; if a step was skipped, say that; when something is done and verified, \
     state it plainly without hedging.\n\n\
     ## Tools\n\
     Call only tools actually in your tool list this turn. Each entry's schema carries its \
     name, parameters, and usage notes — follow the schema rather than guessing. If something \
     you need isn't available, say so plainly instead of improvising. For multi-step work, \
     keep `todo_write` current (one in_progress step; complete steps as you finish them); \
     for large, ambiguous, or hard-to-reverse tasks prefer `enter_plan_mode` first, then \
     `present_plan` — the user's approval unlocks changes.\n\n\
     ## In-app browser pane\n\
     Drive the embedded browser (`open_url` + `browser_*` tools) as an observeâ†'act loop: \
     open the page, `browser_read(mode:\"interactive\")` to get numbered element refs, act by \
     ref, `browser_wait_for` after page-changing actions, then read again — refs expire on \
     navigation. Triage with mode \"summary_only\" before committing to full reads. A \
     failureReason (paywalled/login_required/blocked) means unreadable — report it, don't \
     treat as empty. Prefer open_url + browser_read over fetch_url when the user should see \
     the page live. Preview a web app you built by opening its files directly: static apps \
     via open_url with the absolute path (file:/// — no server needed); framework dev \
     servers run as a background task, then open http://localhost:PORT.\n\n\
     ## Artifacts & diagrams\n\
     Files produced via generate_document/generate_file/generate_diagram surface in the \
     artifact panel automatically — a short one-line acknowledgment afterward is enough. \
     Markdown/SVG/HTML meant for in-chat reading goes directly in your reply as fenced \
     blocks (they render live). React/JSX components: one self-contained component per ```jsx \
     (or ```tsx) block with `export default function App()` and no imports beyond `react` — \
     it renders in a sandboxed live preview.\n\
     Diagrams default to INLINE ```mermaid blocks (graph TD/LR, sequenceDiagram, erDiagram, \
     gantt, mindmap, stateDiagram-v2, classDiagram), one diagram per block. Call \
     generate_diagram only when the user explicitly wants an exportable standalone SVG/PNG \
     artifact. Never describe a diagram in prose; never use ASCII art.\n\n\
     ## Connected accounts\n\
     Connected services (Gmail, Drive, Notion, …) are attach-on-demand: their tools appear in \
     your tool list only after you call `attach_connector(\"<id>\")` (or the user pins one with \
     `@<id>`). The \"## Connected apps & servers\" manifest below lists what's available. When a \
     request needs one, attach it first — never claim the account is unreachable just because \
     its tools aren't in your list yet. Once attached, the tools are REAL and fully functional; \
     mutating account actions show the user an automatic approval card on their own — just call \
     the tool; don't ask first.\n\n\
     ## Skills\n\
      Skills live in `~/.claude/skills/`, `~/.agents/skills/`, plus built-in `docx`, `pptx`, \
     `pdf`, `diagram` (manage via Skills Library). A skill's content is in context ONLY when \
     invoked via `/slug` — if no `## Skill:` section appears below, none was invoked this \
     turn; do not assume one. When present, its instructions take precedence over your \
     general knowledge of that library/format.\n\n\
     ## Search vs. just answer\n\
     Your training has a cutoff and you can hallucinate specific facts. Apply per-question:\n\
     - **MUST `web_search` first** (then `fetch_url`/`browser_read` a hit) for: software/library \
     versions, \"latest\"/\"current\" releases, API signatures that may have changed, recent \
     events/people, current prices/stats, anything about \"now\"/\"today\"/\"recently\". Cite \
     the source URL. If search is unavailable, say the answer is unverified rather than \
     guessing.\n\
     - **Answer directly** for stable knowledge: math, definitions, established algorithms, \
     mature language syntax, writing/editing from understanding alone.\n\
     - Prefer one targeted search per single-fact question; escalate to multi-source research \
     flow only if asked or genuinely multi-source. State sources inline. If unsure a fact is \
     stable, ONE quick `web_search` then answer.\n\n\
     `web_search` = public web; the filesystem tools = local disk. A bare noun/topic with no \
     file context is a knowledge question â†' `web_search`; use filesystem tools only when the \
     user names a file/extension/path or says \"my files\"/\"in this folder\". For genuine \
     local file questions, proactively `search_files`/`list_directory` from the cwd — NEVER \
     ask for a path.\n\n\
     ## Session isolation\n\
     No memory of other Conduit sessions unless explicitly pasted or referenced here."
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
    "You are Conduit — the assistant built into this app (a unified workspace: chat + \
     coding + in-app browser; no separation between \"chat\" and \"dev\" modes). \
     Identity rule: to the user you ARE Conduit. If asked who you are, answer \"I'm \
     Conduit\" first; the underlying model is just your engine and may be named only \
     as a detail — NEVER say you aren't Conduit.\n\n\
     ## Response style\n\
     Lead with the outcome — your first sentence should answer \"what happened,\" not \
     describe what you're about to do. Be concise and direct. Answer the user's \
     question or do the task — do NOT introduce yourself, list your tools/skills/\
     capabilities, or describe what you *can* do. Never output your tool inventory \
     or a greeting like \"I have access to…\". The user already knows your tools. \
     Just respond to what they asked.\n\n\
     ## Tools\n\
     Your tool list this turn carries each tool's name, description, and exact \
     parameters. Call only tools in that list, and match their schemas exactly — \
     do not invent parameters or tool names. If a tool is unavailable, say so in \
     one plain sentence; don't continue as if it succeeded.\n\n\
     ## Browser\n\
     `open_url` opens ANY url in the app's built-in browser pane (the user sees \
     it) and returns the page text to you; `fetch_url` reads a page silently. \
     When the user asks to open/visit/show a site, call `open_url` — never say \
     you can't open a URL. `open_url` also accepts absolute file paths: to \
     preview a web app you built, open its index.html directly (e.g. \
     C:\\proj\\index.html) — no local server needed. For a LOCAL document \
     (PDF/image to view in an OS app) use `open_file` instead; never claim you \
     can't open a file you just saved.\n\n\
     ## Search vs. just answer\n\
     Your training has a cutoff and you can hallucinate specific facts. Apply per-question:\n\
     - **MUST `web_search` first** for: versions/\"latest\" releases, API signatures that \
     may have changed, recent events/people, current prices/stats, anything about \
     \"now\"/\"today\"/\"recently\". Cite the source URL. If search is unavailable, say the \
     answer is unverified rather than guessing.\n\
     - **Answer directly** for stable knowledge: math, definitions, established \
     algorithms, mature syntax, writing/editing. Don't search \"what is 2+2\".\n\
     - `web_search` = public web. `search_files`/`search_content` = local disk. A bare \
     topic with no file/path/\"my files\" phrasing is a knowledge question â†' `web_search`. \
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
/// instructions less reliably and this app cannot afford silent tool-use
/// failures. Tool names are NOT re-listed here (rule 4 points at the tool
/// list) — the schemas sent each turn are the single source of truth, and a
/// hard-coded list rots the moment a tool is added or renamed.
fn core_prompt_strict() -> &'static str {
    "\n\n## STRICT (local model)\n\
0. Do NOT introduce yourself or list/recap your tools, skills, or capabilities. \
Never output a greeting like \"I have access to…\". Just answer or do the task.\n\
1. Current info/prices/\"latest\" anything â†' `web_search` first if available; don't \
answer from memory and imply it's current.\n\
2. \"search X\"/\"look up X\" = WEB. Only filesystem tools when local files are clearly \
meant; if in doubt, search the web.\n\
3. For docx/pptx/xlsx/pdf, call `generate_document` and produce an actual file. \
Describing what it would contain without calling the tool is a failed turn.\n\
4. Use exact tool names from your tool list — no invented tools or parameters.\n\
5. Failed/unavailable tool call â†' one plain sentence. Don't continue as if it succeeded.\n\
6. If your format can't express a call, fall back to a single ```tool_call block \
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

/// "## Current date & time" segment appended right after the CORE prompt on
/// every turn. Without it the model anchors "today"/"latest" to its training
/// cutoff (e.g. answering from 2025) — and worse, it feeds that stale year
/// into `web_search` queries. Computed per turn (not once at startup) so a
/// session left open overnight rolls over midnight correctly. Kept ~150
/// chars: the fresh-turn prompt budget (`fresh_turn_baseline_under_10k_budget`)
/// has limited headroom.
pub(crate) fn current_datetime_segment() -> String {
    let now = chrono::Local::now();
    format!(
        "## Current date & time\nToday is {}. Treat this as \"today\" for \
         \"latest\"/relative-time reasoning — never your training cutoff.",
        now.format("%a %Y-%m-%d (UTC%:z)")
    )
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

/// Plan/Execute/Synthesize scaffolding, appended after the CORE prompt only on
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
### 2. Execute (per sub-question: search â†' triage â†' read â†' record)\n\
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
### 3. Synthesize (read ledger â†' write artifact â†' verify)\n\
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
â‰¤5-8 sources — if you need more, the sub-questions are too broad; split them, don't read 20 pages.";

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
///
/// Descriptions are trimmed to their first sentence (capped) — the catalog is
/// paid on every tool-enabled turn, and `get_skill` returns the full
/// description + body on demand anyway.
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
        let desc = first_sentence(sk.description.trim(), 120);
        s.push_str(&format!("- `{}` — {}\n", sk.slug, desc));
    }
    Some(s)
}

/// First sentence of `s` (up to the first `.`, `?`, or `!` followed by a
/// space or end-of-text), hard-capped at `cap` chars. Empty input →
/// "(no description)". `cap` is floored to a char boundary.
pub(crate) fn first_sentence(s: &str, cap: usize) -> &str {
    if s.is_empty() {
        return "(no description)";
    }
    let boundary = s
        .char_indices()
        .find(|(i, c)| {
            matches!(c, '.' | '?' | '!')
                && s[i + c.len_utf8()..]
                    .chars()
                    .next()
                    .map_or(true, |n| n == ' ')
        })
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(s.len());
    let mut end = boundary.min(cap);
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].trim_end()
}

/// One entry in the attach-on-demand manifest: a connector or MCP-gallery
/// server that is available (credentialed / enabled) but whose tools are NOT
/// in this request yet.
pub struct ManifestEntry {
    pub id: String,
    pub name: String,
    pub description: String,
}

/// The `## Connected apps & servers` system-prompt segment: one line per
/// attachable connector / MCP server so the model knows what exists WITHOUT
/// paying for the tool schemas. Attachment happens via the `attach_connector`
/// / `attach_mcp_server` tools (see specs) or the user's `@id` pin. Both
/// lists empty → `None`.
pub fn attach_manifest_segment(
    connectors: &[ManifestEntry],
    mcp_servers: &[ManifestEntry],
) -> Option<String> {
    if connectors.is_empty() && mcp_servers.is_empty() {
        return None;
    }
    let mut s = String::from(
        "## Connected apps & servers (attach on demand)\n\
        These are connected but their tools are NOT loaded yet. When a request \
        needs one, call `attach_connector(\"<id>\")` (or `attach_mcp_server` \
        for servers) FIRST — its tools join your tool list immediately and stay \
        for the conversation. The user can also pin one with `@<id>`.\n",
    );
    for c in connectors {
        s.push_str(&format!("- {} — {}\n", c.id, c.description));
    }
    for m in mcp_servers {
        s.push_str(&format!(
            "- {} (MCP server) — {}\n",
            m.id,
            first_sentence(m.description.trim(), 100)
        ));
    }
    Some(s)
}

/// Send-time relevance fast-path: which available connector ids does this
/// message mention, either explicitly (`@gmail`) or via the registry's
/// keyword phrases ("my inbox", "google calendar", …)? A hit attaches the
/// connector directly this turn so small local models don't need the
/// `attach_connector` hop. Word-boundary `@token` match, substring keyword
/// match; unknown ids are ignored.
pub fn detect_connector_mentions(content: &str, available: &[&str]) -> Vec<String> {
    let lower = content.to_lowercase();
    let mut hits: Vec<String> = Vec::new();
    for c in crate::connectors::CONNECTORS {
        if !available.contains(&c.id) || hits.iter().any(|h| h == c.id) {
            continue;
        }
        // Explicit @mention token ("@gmail", "@gdrive", …).
        let mentioned = lower
            .split(|p: char| !(p.is_ascii_alphanumeric() || p == '-' || p == '_'))
            .any(|tok| tok.trim_start_matches('@') == c.id);
        // Registry keyword phrases.
        let keyword = c.keywords.iter().any(|k| lower.contains(k));
        if mentioned || keyword {
            hits.push(c.id.to_string());
        }
    }
    hits
}

/// Plan-mode scaffolding, appended only while the session is in plan mode
/// (user toggle or the model's own `enter_plan_mode` call). Short on purpose —
/// the real contract lives in the `enter_plan_mode`/`present_plan` tool
/// descriptions; this is the standing reminder for the rest of the turn.
const PLAN_MODE_SEGMENT: &str = "## Plan mode (active)\n\
    This session is in plan mode: mutating tools are BLOCKED until the user \
    approves a plan. Work in this order:\n\
    1. Research with read-only tools (read_file, list_directory, search_*, \
    web_search, browser_read).\n\
    2. Call `present_plan` with the detailed approach as markdown — what you'll \
    change, how, and how you'll verify it. This is the DESIGN, not a step \
    checklist. Never call it after changes are already made. Do NOT repeat the \
    plan in your reply text — the approval card renders it for the user; keep \
    your prose to a one-line acknowledgment.\n\
    3. After approval, break the plan into concrete steps with `todo_write` \
    (the Progress list renders them — don't restate them in prose) and \
    execute, keeping the list current.\n\
    Every plan-mode turn about a task that will change anything MUST end with \
    a `present_plan` call (or a clarifying question if required details are \
    genuinely missing) — never end with prose alone. If the user's message is \
    pure Q&A that implies no changes, just answer in text. A rejection \
    returns the user's feedback — revise and re-present.";

/// Assemble the effective system prompt from the built-in CORE prompt (always
/// included, provider/model-aware), the available-skills catalog (only when
/// tools are on), the attach-on-demand manifest for connectors / MCP servers
/// (only when tools are on), the research-mode scaffolding (only on
/// research-shaped turns with tools on), the plan-mode scaffolding (only while
/// plan mode is active), the user's custom system prompt, and any invoked
/// skills (the caller pre-filters to skills whose `/command` appears in the
/// message). Returns `None` when nothing applies.
pub fn build_system_prompt(
    provider: ChatProviderId,
    model: &str,
    custom: Option<&str>,
    skills: &[(String, String)],
    tools_enabled: bool,
    research_mode: bool,
    plan_mode: bool,
    manifest: Option<&str>,
) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    parts.push(core_prompt_for(provider, model));
    // Date anchor for every variant (frontier/local/strict/research) — see
    // current_datetime_segment's doc for why this can't live inside the
    // static CORE text.
    parts.push(current_datetime_segment());
    if tools_enabled {
        // One-line catalog of every available skill so the model can decide
        // whether to call `get_skill(slug)` for a given request. Distinct from
        // the invoked-skills block below (which carries full bodies for
        // skills the user force-loaded with `/slug`).
        if let Some(seg) = available_skills_segment() {
            parts.push(seg);
        }
        // Attach-on-demand manifest: one line per available-but-not-attached
        // connector / MCP server. Replaces shipping every tool schema on
        // every turn (see specs.rs `attach_connector`).
        if let Some(m) = manifest.filter(|m| !m.trim().is_empty()) {
            parts.push(m.to_string());
        }
    }
    // The research segment references tools (web_search/browser_read/
    // add_source_note/generate_file), so it only applies when tools are on.
    // The call site already guarantees research_mode ⇒ tools_enabled; the
    // `&& tools_enabled` here is defense-in-depth.
    if research_mode && tools_enabled {
        parts.push(core_prompt_research(model));
    }
    // Plan mode gates tool behavior, so — like the research segment — it only
    // applies on tool-enabled turns.
    if plan_mode && tools_enabled {
        parts.push(PLAN_MODE_SEGMENT.to_string());
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Token-budget guards. The tool schemas sent with every request already
    /// carry each tool's name/params/modes — the CORE prompts may hold only
    /// behavioral guidance (routing rules, workflows, communication policy).
    /// If a change pushes a prompt over budget, it almost certainly re-added
    /// schema duplication that every turn pays for.
    #[test]
    fn core_prompts_stay_within_budget() {
        let frontier = core_prompt_base();
        println!("frontier CORE prompt: {} bytes", frontier.len());
        assert!(
            frontier.len() < 9_000,
            "frontier CORE prompt bloated: {} bytes",
            frontier.len()
        );
        let local = format!("{}{}", core_prompt_base_local(), core_prompt_strict());
        println!("local CORE prompt (base+strict): {} bytes", local.len());
        assert!(
            local.len() < 4_500,
            "local CORE prompt bloated: {} bytes",
            local.len()
        );
    }

    /// Behavioral anchors that downstream behavior depends on must survive
    /// any rewrite of the prompt text.
    #[test]
    fn core_prompts_keep_behavioral_anchors() {
        let frontier = core_prompt_base();
        for anchor in [
            "## Acting with care",
            "Lead with the outcome",
            "MUST `web_search` first",
            "NEVER ask for a path",
            "attach-on-demand",
            "Session isolation",
        ] {
            assert!(frontier.contains(anchor), "frontier lost anchor: {anchor}");
        }
        let local = core_prompt_for(ChatProviderId::LocalGguf, "llama-3.1-8b");
        assert!(local.contains("STRICT (local model)"));
        // Rule 4 points at the live tool list instead of a rot-prone name list.
        assert!(local.contains("exact tool names from your tool list"));
    }

    #[test]
    fn first_sentence_trims_to_sentence_and_cap() {
        assert_eq!(first_sentence("", 120), "(no description)");
        assert_eq!(
            first_sentence("Create art with seeded randomness. More detail here.", 120),
            "Create art with seeded randomness."
        );
        // No sentence boundary → capped.
        assert_eq!(first_sentence("abcdefghij", 4), "abcd");
        // URLs / decimals are not sentence boundaries (dot must end a word).
        assert_eq!(
            first_sentence("See https://example.com/page for more.", 120),
            "See https://example.com/page for more."
        );
    }

    /// The date anchor must reach the model on EVERY variant (frontier and
    /// local) — a variant that drops it regresses to training-cutoff dates.
    #[test]
    fn system_prompt_embeds_current_date() {
        for provider in [ChatProviderId::LocalGguf, ChatProviderId::OpenAI] {
            let p = build_system_prompt(provider, "test-model", None, &[], false, false, false, None)
                .expect("core + date segment always present");
            assert!(p.contains("## Current date & time"), "missing date anchor");
            let today = chrono::Local::now().format("%a %Y-%m-%d").to_string();
            assert!(
                p.contains(&today),
                "date anchor missing today's date ({today}): {:?}",
                p.split("## Current date & time").nth(1).map(|s| &s[..80.min(s.len())])
            );
        }
    }

    #[test]
    fn detect_connector_mentions_matches_tokens_and_keywords() {
        let avail = ["gmail", "notion", "gcalendar"];
        assert_eq!(
            detect_connector_mentions("hey @notion find that page", &avail),
            vec!["notion"]
        );
        assert_eq!(
            detect_connector_mentions("check my inbox for the receipt", &avail),
            vec!["gmail"]
        );
        // Only AVAILABLE connectors hit — a connected-less mention is ignored.
        assert!(detect_connector_mentions("look at my github repos", &avail).is_empty());
        // Mixed hits preserve registry order and dedupe.
        let hits = detect_connector_mentions("sync my calendar and my inbox", &avail);
        assert!(hits.contains(&"gmail".to_string()) && hits.contains(&"gcalendar".to_string()));
    }

    #[test]
    fn attach_manifest_lists_entries_and_omits_when_empty() {
        assert!(attach_manifest_segment(&[], &[]).is_none());
        let seg = attach_manifest_segment(
            &[ManifestEntry {
                id: "gmail".into(),
                name: "Gmail".into(),
                description: "Read and send email.".into(),
            }],
            &[],
        )
        .unwrap();
        assert!(seg.contains("attach_connector"));
        assert!(seg.contains("- gmail — Read and send email."));
    }
}
