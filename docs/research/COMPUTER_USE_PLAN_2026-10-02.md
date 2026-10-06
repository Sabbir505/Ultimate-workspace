# Computer Use for Relay — Plan (2026-10-02)

Supersedes `Random Stuff/computer-use.md` (Sept 2026 scratch research). That doc's
architecture is still ~70% right; the load-bearing correction is in §2 below.

> **Status: Phases 0–2 are implemented.** Phase 3 (OS-level desktop control) is
> not started. See §12 for what landed and what was verified.
>
> **Re-verified 2026-10-05:** Phases 0–2 remain accurate. Two figures in the body
> were stale and have been corrected — the sidecar's advertised tool count (now 63
> static schemas, 27 browser + 36 relay, plus a live 34-entry allowlist) and the
> chat-tool browser surface (now 14 `BROWSER_*` tools, not 8; see the asymmetry note
> in §2, whose gap has since closed). Phase 3 is still genuinely not started —
> `src-tauri/src/app_ui.rs` covers Phase 2 self-control only and is a DOM bridge, not
> an OS-level pixel loop.

---

## 1. Bottom line

"Computer use" is three different products with very different costs. Relay should
build them in that order, and should not treat #3 as the headline.

| # | Surface | What it means | Cost | Value |
|---|---------|---------------|------|-------|
| **1** | **Browser pane parity** | Relay already has a ref-based, tree-first agent browser. Close it to Anthropic's official `browser_toolset_20260801`. | Days | High — makes existing tools materially better |
| **2** | **Relay self-control** | The agent drives *Relay's own* UI. Relay is a Tauri app: its UI is web content. A DOM bridge beats pixels by an order of magnitude. | ~1–2 weeks | High — unique, and no competitor ships it well |
| **3** | **Desktop OS control** | Real computer use: drive Excel, Explorer, other apps. Pixel loop + input synthesis. | Weeks, and reliability-capped | Moderate, high risk |

**Do #1 and #2 now. Treat #3 as a Phase 3 gated behind safety foundations.**

The Sept research led with #3. That was the wrong lead: it's the hardest, least
reliable, and most dangerous, and Relay already owns 70% of the substrate it needs.

---

## 2. What changed since the Sept research

The Sept plan was **pixel-first, desktop-screenshot-first, hijack-the-real-cursor**.
The 2026 industry converged on the opposite. Four corrections:

### 2.1 Tree-first, pixels-as-fallback — now vendor-official
Anthropic ships `browser_toolset_20260801` (GA, same models as the computer toolset):
`read_page` returns the **accessibility tree as tagged text** with stable refs
(`button "Search" [ref_4]`), `find` does NL search over it, and **targets are
dual-mode** — `{"type":"ref","ref":"ref_2"}` or `{"type":"coordinate","x","y"}`.
Explicit guidance: *"Prefer references… a tree read of a typical page often costs
fewer input tokens than a screenshot."* `scroll_to`, `form_input`, `file_upload` are
ref-only.

Relay already does this. `bridge_snapshot.js` tags `data-relay-ref` in document
order, `browser_read`/`browser_observe` return the tree, `browser_click` takes a ref.
**The Sept research treated the browser pane as a lesser subset; it is actually the
correct architecture, already built.**

### 2.2 Agent-owned cursor + background delivery, not cursor hijacking
Claude Code (macOS 15+), OpenAI Codex, and Cua Driver all landed the same way: the
agent **does not take your pointer or keyboard** and delivers input to a specific
window. The Sept plan's "input synthesis fights the real cursor" risk is not a risk
to mitigate — it's an architecture to not build.

### 2.3 Reliability is the ceiling, and it is *state*, not clicking
OSWorld 2.0 (108 long-horizon tasks, ~318 tool calls avg), binary completion at 500 steps:

| Model | Binary | Partial |
|---|---|---|
| Claude Opus 4.8 | **20.6%** | 54.8% |
| Claude Opus 4.7 | 18.2% | — |
| GPT-5.5 | ~14% | — |

Above 163-minute tasks, **every model scores zero**. Weakest phenomena are
implicit-state inference, multi-item state tracking, conflict disambiguation —
all state management. Published failure trajectories show agents skipping
verification and validating their own wrong story against itself.

**Implication:** sell bounded, verifiable tasks. Do not ship "agent runs my desktop."
Ship "agent does this 12-step thing and confirms it landed." Budget for an explicit
task-state store and a verification step that queries the system of record.

### 2.4 Using the official tool type is a security feature
Anthropic runs injection classifiers **free and automatically** on official tool
types — they evaluate screenshots for prompt injection and steer the model. Build
custom tools instead and you get **no classifiers**. That alone argues for
`computer_toolset_20260801` / `browser_toolset_20260801` over hand-rolled schemas
where the provider supports it.

Threat model is not theoretical: adversarial pop-up windows hit **86% attack success
rate** across OSWorld/VisualWebArena, cutting task completion 47% — and *"system
prompts saying 'ignore pop-ups' did not work."*

---

## 3. Architecture

```
┌─ Relay self (Tauri webview) ──────────────┐
│  DOM/AX bridge → ref-based tools           │  Phase 2
│  (reuse bridge_snapshot.js machinery)      │
├─ Browser pane (WebView2 + CDP) ───────────┤
│  refs + coordinates, tree-first           │  Phase 1 (parity)
│  existing: read/click/type/scroll/…        │
├─ OS desktop (other apps) ─────────────────┤
│  xcap capture + enigo input + UIA tree     │  Phase 3
│  {element+bg → pixel+bg → page → fg} ladder│
└────────────────────────────────────────────┘
        all three gated by one permission axis
```

### 3.1 The action ladder (steal from Cua Driver)

Every action targets `{kind:"window", pid, window_id}` or `{kind:"desktop", display_id}`.
Escalate only on failure:

1. **Element + background** — UIA `Invoke` / macOS `AXPerformAction` / AT-SPI.
   *The only rung that can be self-verified.* Refs/tokens.
2. **Pixel + background** — click x,y from a screenshot we already took. For typing
   into a field, click first to give it renderer focus.
3. **Page** — for browser tabs, use DOM-over-CDP (we already do).
4. **Foreground** — last resort. Raise window, land input, restore.

Every response reports `effect: confirmed | unverifiable | suspected_noop | partial | refused`
plus `escalation:{recommended, reason}`. *"A delivered event is not an applied change:
Electron, Catalyst, and web content can echo a write they did not apply."* This is the
single highest-leverage design detail to copy — it is what makes the loop debuggable.

### 3.2 Permission model

Extend `chat/permission.rs` with an orthogonal axis (the file already documents the
Codex-style sandbox/approval split — this fits the existing shape):

```
ComputerPolicy: off | observe | control_windows | control_all
```

Per-app tiers, borrowed from Claude Code: **view-only** (browsers, trading apps),
**click-only** (terminals, IDEs), **full** (everything else). Sentinel warnings for
shell-equivalent and system-settings apps. Denied-apps list. Modes are fixed at
session start — **an agent cannot widen its own permissions.**

Two non-negotiables from Claude Code's design:
- **Hide other windows while the agent works**; restore after.
- **Exclude Relay's own terminal/settings UI from screenshots** — otherwise the agent
  screenshots its own escape hatch.

---

## 4. Phase 0 — Safety foundations (blocking, do first)

These are prerequisites for *any* computer control, and two of them are live problems
today regardless.

### 4.1 Cap the tool loop — **currently unbounded**
`src/chat/streaming.rs:40` — `const MAX_TOOL_ITERS: usize = usize::MAX;`
(and `RESEARCH_MAX_TOOL_ITERS` at `:44`, same). A runaway GUI agent clicks real
things. Cap per-turn iterations (25–50) with an explicit continue. Do this before
shipping anything that can move a mouse.

### 4.2 Close the `run_code` backdoor — **live hole**
`src/chat/codeexec.rs:78` — `sandbox_available()` is hardcoded `false`; `apply_sandbox`
is a documented no-op on every platform. `run_code` is advertised in **both** wire
formats (`specs.rs:383`, `:808`).

So today the model can already reach OS control with **no computer tool at all**:
`pip install pyautogui` in a `run_code` turn, then screenshot via a one-liner. The
entire permission model is bypassable. Shipping a *gated* computer tool while an
*ungated* equivalent exists is theatre.

Fix before Phase 1: either enforce the sandbox (Windows restricted token + Job Object,
Linux Landlock, macOS `sandbox-exec`), or make `run_code` and computer-control share
one permission axis so neither is a hole in the other.

### 4.3 Persistent, non-logged screenshot storage
`ChatImage` is live-turn-only — `src/chat/providers.rs:94`: *"history rebuilt from the DB
drops images."* A within-turn loop works; a multi-turn GUI session does not.

Budget: >20 images in a request triggers stricter per-side limits (≤2000 px). Prune
screenshots **in batches** (keep last 3, prune every ~25 turns) — pruning every turn
destroys the prompt-cache prefix. On Fable 5.1 / Opus 5.5 / Sonnet 5.5, do **not**
prune client-side at all (it invalidates every later thinking block); use server-side
tool-result clearing.

### 4.4 Consent + a kill switch
Anthropic requires informing users and obtaining consent before enabling computer use
in a product. Need: an explicit onboarding gate, a global Stop, and an Esc-style
abort **whose keypress is consumed by the app** so injected on-screen text cannot
press it to dismiss dialogs.

---

## 5. Phase 1 — Browser pane parity (days)

Close the gap between Relay's chat-tool surface and the official browser toolset. Cheap
because the machinery exists.

**Asymmetry worth noting (re-verified 2026-10-05 — this gap has since closed):** the MCP
server (`bin/relay_browser_mcp.rs`) has
`zoom`, `press_key`, `fill_form`, `select_option`, `find`, `batch`, `read_console`,
`read_network`, `print_to_pdf`. At the time of this plan the **chat-tool** surface had
only 8 (`browser_read/click/type/scroll/screenshot/observe/extract/upload_file`), leaving
`zoom` and `press_key` unreachable from a chat turn. That is no longer true — the chat
registry now ships 14 `BROWSER_*` tools, with `browser_upload_file`, `browser_zoom`,
`browser_press_key`, `browser_fill_form`, `browser_select_option`, `browser_find` and
`browser_batch` added alongside the original eight. *(The "54 tools" figure in the
original line was also stale: the sidecar declares 63 static schemas — 27 browser + 36
relay — merged at runtime with a live 34-entry allowlist.)*

Work:
1. Promote `zoom`, `press_key`, `fill_form`, `select_option` to chat tools.
2. Add `browser_batch` — sequential, stop-on-first-failure, every block gets a result
   (the toolset requires it; unanswered blocks are a hard `invalid_request_error`).
3. Add `browser_find` (NL search over the tree) — currently `browser_observe` only.
4. Accept a `{type:"ref"}` / `{type:"coordinate"}` union on click/type targets rather
   than ref-only.
5. Return a structured `stale ref` error so the model re-reads instead of guessing.
6. Render the official `browser_toolset_20260801` when provider is Anthropic and a
   real browser is attached; keep the dual `openai_tool_specs`/`anthropic_tool_specs`
   rendering otherwise.

Also cheap and worth doing: instruction text **before** the screenshot in the user turn
measurably improves accuracy, and Anthropic found coordinate-grid overlays give **no
reliable gain** — so don't build one, despite the `computer-use-grid` project claiming
otherwise.

---

## 6. Phase 2 — Relay self-control (~1–2 weeks)

**This is the differentiated one.** Relay's own UI is a React app in a WebView2. The
agent should drive it through the DOM, not through pixels of a screenshot.

There is currently **no eval bridge on the main window** — `eval_js` exists only on
`BrowserManager` panes (`src/browser.rs:367`). The browser-pane bridges
(`bridge_snapshot.js`, `bridge_resolve.js`, `bridge_extract.js`, `bridge_overlay.js`)
are exactly the machinery needed; they need a new injection site into the main webview.

Work:
1. Inject the snapshot/resolve bridges into the **main window**; expose
   `app_read` / `app_click(ref)` / `app_type` / `app_observe`.
2. Extract the ref contract into a shared module — today it's duplicated by hand across
   three bridge files with a "keep in exact sync" comment. That duplication is the
   main bug risk.
3. Prefer real UI affordances over clicks: if the agent needs to trigger
   "run automation", add a typed IPC command it can call directly, and treat
   `app_click` as the fallback. Every new agent-reachable action should ship with a
   first-class tool *before* it ships with a pixel target.
4. Exclude the agent's own chrome from its snapshot (same rule as the terminal
   exclusion below).

**Rule to hold throughout:** each capability gets a purpose-built tool first, and a
generic UI-driving tool only as the fallback. Generic-first is how you end up with an
agent that clicks a sidebar 40 times because it has no `list_automations` verb.

---

## 7. Phase 3 — Desktop OS control (weeks; reliability-capped)

### 7.1 Crate reality check (verified 2026-10-02)

| Crate | Version | Last publish | Verdict |
|---|---|---|---|
| `xcap` | 0.9.8 | 2026-08-01 | Use. Best-maintained capture. |
| `enigo` | 0.6.1 | 2025-08-28 | Use, but stale ~1yr. |
| `uiautomation` | 0.25.1 | 2026-09-04 | Use. Actively maintained. |
| `arboard` | 3.6.1 | 2025-08-23 | Use for large text entry. |
| `windows` | 0.62.2 | **2025-10-06** | ⚠️ No crates.io publish in ~12mo despite GH tags 72/73/74 in 2026. Relay is on 0.61 — **pin, don't bump.** |
| `scrap` | 0.5.0 | 2018 | **Dead.** Do not use. |
| `rdev` | 0.5.3 | 2023-06-26 | **Dead.** Do not use. |
| `mouse_position` | 0.1.4 | 2024-05-31 | Dead; fold into capture module. |

Relay already links `windows` with `Win32_Graphics_Dxgi`, so raw Win32 (`SendInput`,
`GetSystemMetrics`, DXGI duplication) is a cheap fallback where `enigo`/`xcap` fall short.

Platform constraints that are architectural, not bugs:
- **Session 0** — a process in a service session cannot see or drive the interactive
  desktop. Any driver must run in the user's interactive session (a per-user daemon).
  Relevant to Relay's existing sidecar/boot-sweep architecture.
- **UAC / secure desktop** — elevated windows reject non-elevated input, by design.
  Surface an explicit "agent is blocked" state; do not retry.
- **DRM / exclusive fullscreen** — black on capture. Detect and report.
- **Wayland** — raw background input to occluded windows generally impossible; refuse
  rather than risk typing into the wrong app.
- **macOS** — Accessibility + Screen Recording TCC grants are **per-binary**. They
  attach to the signed app, not the spawning process. Affects any macOS build.

### 7.2 Coordinate math — build it in from day one
Anthropic's own reference demo handles **single display only** (Xvfb, fixed 1024×768 /
1280×800 / 1366×768 downscale targets). The macOS quickstart hands retina to pyautogui.
**Neither does multi-monitor or per-monitor DPI. If we need it, we build it.**

Requirements, all from day one:
- Client-side downscale — **the API does not downscale and rejects oversized images**.
  Current limit: **≤2576 px long edge, ~4784 visual tokens (~3.75 MP)**. Anthropic's
  baseline: 1280×720 for the 4.6 family, 1080p for Opus-4.7-class budgets.
- Coordinates are in **the pixel space of the screenshot you returned**. After a `zoom`,
  coordinates are still full-screenshot pixels — `zoom` does not change the frame.
- Persist the scale factor per capture and map model coords → physical pixels.
- Per-monitor DPI, and **negative virtual-desktop origins** on secondary displays.
  Put `display_id` in the target object (Cua's approach).
- macOS Retina: capture at DPR 2, downscale 2×, or halve coordinates.

This is the #1 source of "clicked the wrong thing" bugs. Anthropic's own diagnosis
table: consistent one-directional offset = coords applied to a different-sized display;
right area but missed = tiny target lost at downscale; wrong element entirely =
ambiguous instruction or similar neighbours.

### 7.3 Wire format
- **Anthropic** → official `computer_toolset_20260801`, one schema-less toolset entry,
  17 actions, results echo `"toolset_name": "computer"`, dispatch on the pair
  `(toolset_name, name)` — **there is no `action` field anymore**, and a tool loop that
  reads only `content[0]` breaks on the next call. Claude 5.5+ **accepts only the
  toolset** and errors on `computer_20251124` (Bedrock still accepts the older one).
- **OpenAI-compatible** → explicit function schemas. Load-bearing nuance: Chat
  Completions `tool`-role messages **cannot contain images** — return brief text from
  the tool and append the screenshot as a `user`-role image message immediately after.
  Anthropic natively allows images inside `tool_result`.
- **Gemini** → normalized **0–999** coordinates, a materially different convention.
  The executor needs a pluggable coordinate layer from the start.

### 7.4 Cost
Toolset definition ≈ **4,500 input tokens**. Each screenshot/zoom ≈ 1,000–1,800.
At ~30 screenshots in a session that is ~50k input tokens of pure observation before
any reasoning. Batch aggressively (the single biggest latency win), end every batch
with a screenshot, cache the system+tools prefix.

---

## 8. Verification harness (build with Phase 3, not after)

Cua's methodology is worth copying wholesale: a catalog of cells
(action × element/pixel × background/foreground × window/desktop × surface), run
against fixture apps in a real desktop session. A cell passes only when
**app- or desktop-owned state changed**, and for background cells only when focus,
z-order, the real cursor, and the foreground app were untouched. **An exact refusal
also passes; a silent success does not.**

Relay should also run every computer-use change against OSWorld-V2 (`osworld-v2.1`)
as a regression gate. The gap report's Phase 3 already calls for coordinate-scale tests
at 100/125/150% DPI and multi-monitor — keep that, and add Windows UIA timing tests
(UIA walks on Chromium/Electron apps run **10–30 s**; use `FindAll` with conditions,
scope to the target subtree, cap depth, cache across turns — never walk the full tree).

---

## 9. Model / provider matrix (Oct 2026)

| Model | Reachable via | Coordinate space | Note |
|---|---|---|---|
| **Claude Opus 5.5 / Sonnet 5.5** | Anthropic native | screenshot pixel space | Best tool ergonomics. 5.5+ require the toolset form. |
| **GPT-6.1 Sol / GPT-5.5** | OpenAI native | ⚠️ unverified | OpenAI now *recommends code execution* over the `computer` tool. |
| **GLM-4.6V** | OpenAI-compatible (`api.z.ai/api/paas/v4`) | TBD | Native multimodal function calling. ⚠️ No published ScreenSpot/OSWorld number found — do not assume one. GLM-5.3 is text-only. |
| **Qwen3-VL** | OpenAI-compatible, self-host | model-specific | Open weights, ships an official computer-use cookbook. |
| **UI-TARS-2** | seed-tars API | TBD | OSWorld 1.0: 47.5% (not comparable to OSWorld 2.0's 20.6%). |
| Gemini 3.x | needs a new provider | **normalized 0–999** | Nice pattern: every action carries an `intent`, responses carry `safety_decision: regular \| require_confirmation \| blocked`. |

**Recommendation:** Anthropic `computer_toolset_20260801` for Claude (the free injection
classifiers are worth more than the schema work). GLM-4.6V through the existing
`OpenAICompatible` provider as the cheap/self-hosted path. OpenAI CUA and Gemini as
later adapters — CUA needs a Responses-API wire protocol Relay doesn't have; Gemini
needs a provider Relay doesn't have.

---

## 10. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| **Prompt injection via screenshots** | Critical | Official tool types (free classifiers). Per-action HITL. Tree-first (act on identifiers, not pixels). Window hidden-except-target. Advisory pop-up detector — knowing it *fails* 86% of the time is not a mitigation. |
| **`run_code` bypasses the whole model** | Critical | Phase 0.4 — sandbox it or unify the permission axis. |
| Model clicks wrong thing (DPI/multi-monitor) | High | Scale mapping in `capture.rs` from day one; the test matrix in §8. |
| Agent fights the human user | High | Agent-owned cursor + background delivery. Never hijack. |
| Runaway loop | High | Iteration cap (Phase 0.1). Stop button. Esc consumed by the app. |
| Screenshots are sensitive | High | Never log. Strip from the mobile mirror by default. Redaction pass later. |
| Screenshots lost across turns | Medium | Phase 0.3. Batch-prune to preserve prompt caching. |
| Long-horizon state failure | Medium | Scope to bounded tasks; external task-state store; verification against the system of record, not self-assessment. |
| UIA too slow on Chromium/Electron | Medium | `FindAll` + subtree scope + cache; never full walks. |
| Screenshots of secure/DRM content | Low | Detect and report; explicit blocked state. |

---

## 11. What to do today

Ordered, with the blocking dependency called out:

1. **Cap `MAX_TOOL_ITERS`** (`streaming.rs:40`, `:44`). One-line, removes an unbounded
   loop from the codebase.
2. **Decide `run_code`'s fate.** Either wire the sandbox or put it behind the same
   gate. This is a live hole whether or not we ship computer use.
3. **Promote `zoom` + `press_key` from MCP-only to chat tools.** They already exist and
   are already tested; a chat turn just can't reach them. Cheapest capability win
   available.
4. **Add `browser_batch`** with the stop-on-first-failure + every-block-gets-a-result
   contract. Latency and correctness both improve.
5. **Prompt-side**: put instruction text before the screenshot in the user turn. Free.
6. **Then** decide Phase 2 vs Phase 3. My recommendation: Phase 2 (Relay self-control).
   It is where Relay is structurally advantaged — its UI *is* the DOM — and it
   delivers real agent capability without touching another application's pixels.

### Open decisions for the user
- **Scope**: is the goal "agent can drive my desktop apps" (Phase 3, hard, ~20% reliable
  on OSWorld 2.0) or "agent can do more inside Relay" (Phase 2, tractable)? These are
  very different products.
- **Positioning**: `FEATURE_MAP_AND_GAP_ANALYSIS_2026-09-19.md:347` still lists computer
  use as an undecided "decision item — compete or stay scoped." The Sept research
  already decided (build it). That doc needs updating either way.
- **`run_code`**: sandbox it, or remove it?

---

## Sources

Existing: `Random Stuff/computer-use.md`; `docs/research/BROWSER_SYSTEM_RESEARCH.md`;
`FEATURE_MAP_AND_GAP_ANALYSIS_2026-09-19.md:347`; `docs/notes/task-conduit-browser-mcp.md`.

Fresh (fetched 2026-10-02):
- [Computer use tool — Claude Platform Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) (append `.md` for clean markdown)
- [Browser use tool — Claude Platform Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool)
- [Best practices for computer and browser use with Claude](https://claude.com/blog/best-practices-for-computer-and-browser-use-with-claude) (2026-05-13)
- [Let Claude use your computer in Cowork](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork)
- [Cua Driver — what is computer use](https://cua.ai/docs/cua-driver/concepts/what-is-computer-use) · [platform support](https://cua.ai/docs/cua-driver/concepts/platform-support)
- [OSWorld-V2](https://osworld-v2.xlang.ai/) · [microsoft/WindowsAgentArena](https://github.com/microsoft/WindowsAgentArena) · [microsoft/UFO](https://github.com/microsoft/UFO)
- [CSA Research Note — Computer-Use Agent Safety Blind Spots](https://labs.cloudsecurityalliance.org/research/csa-research-note-computer-use-agent-safety-blindspots-20260/)
- [OpenAI computer use](https://developers.openai.com/api/docs/guides/tools-computer-use) · [Gemini computer use](https://ai.google.dev/gemini-api/docs/computer-use) · [GLM-4.6V](https://docs.z.ai/guides/vlm/glm-4.6v)
- [OpenAdapt](https://github.com/OpenAdaptAI/OpenAdapt) (verification-as-product) · [CaMeLs](https://arxiv.org/abs/2501.18836) (planner/perception separation)
- crates.io versions verified via API 2026-10-02.

---

## 12. Implementation status — Phases 0–2 landed

### Phase 0 — safety foundations ✅

| Item | Where | Note |
|---|---|---|
| Tool-loop cap | `chat/streaming.rs` | `MAX_TOOL_ITERS` 500 / research 1000. Was `usize::MAX`, which made the existing "stopped after reaching the tool-call limit" exit unreachable. |
| `run_code` gate | `chat/permission.rs`, `chat/dispatch.rs` | Added to `is_system_tool` so it routes through the system-tool gate; `check_system_permission` gates it exactly like `run_shell`. Its approval card now shows the snippet and states there is no OS sandbox. |
| Screenshot persistence | **not done** | `ChatImage` is still live-turn-only. A within-turn loop works; multi-turn GUI sessions do not. Deliberately deferred — it needs a DB migration plus the prune-in-batches policy, and neither Phase 1 nor 2 depends on it. |
| Consent + kill switch | **partial** | The agent-exclusion filter (Phase 2) removes the model's access to its own Stop/Approve controls. A global abort hotkey and an onboarding consent gate are still to do. |

### Phase 1 — browser pane parity ✅

Six tools promoted from MCP-only to first-class chat tools, plus dual-mode
targeting. All advertised in both wire formats, gated on `caps.browser`, and
plan-mode classified.

| Tool | Notes |
|---|---|
| `browser_find` | Substring search over the same census `browser_observe` lists, so results are directly actionable. |
| `browser_zoom` | Region crop, 0.5–4×, sharing the screenshot capture path. Distinct filename prefix; not registered as an artifact, like the full shot. |
| `browser_press_key` | Keys on the focused element. |
| `browser_fill_form` | ≤25 fields, ≤10 KiB each — same bounds as the MCP op. |
| `browser_select_option` | The semantic `<select>` action. |
| `browser_batch` | ≤15 steps, sequential, halts on first failure, **every step reports** (un-run ones marked). Validates every op up front so a typo in step 9 can't leave step 0 already applied. Nesting and `open_url` refused. |

**Coordinate targeting** — `browser_click` / `browser_type` now accept `x`/`y`
viewport CSS pixels as well as `ref`. The pixel path hit-tests through
`elementFromPoint` and climbs to the nearest interactive ancestor, so a click
inside a `<span>` still lands on the button — and the result reports which
element was actually hit, which is what makes a misjudged pixel debuggable.
`ref` wins when both are present. `browser_type` by coordinate **focuses** rather
than clicks, so typing into a textbox cannot submit it.

### Phase 2 — Relay self-control ✅

New module `src-tauri/src/app_ui.rs` + two injected bridges
(`bridge_refs.js`, `bridge_selfui.js`). Five tools: `app_snapshot`,
`app_click`, `app_type`, `app_press_key`, `app_select_option`.

The design decisions that mattered:

- **DOM, not pixels.** Relay's UI is React in a WebView2, so the agent addresses
  the real DOM with the same ref contract the browser pane uses. A ref survives
  a layout shift and is verifiable by reading the element back.
- **The ref contract is now one definition.** `bridge_refs.js` replaces three
  hand-synced copies of the selector and numbering rules across the browser
  pane bridges. This was listed as a bug risk in §6; it is the reason a ref
  cannot mean different things on the two surfaces.
- **The agent cannot click its own leash.** Elements under
  `data-relay-agent-exclude` are filtered *before* numbering, so a ref can
  never silently resolve into excluded chrome — that ordering is the whole
  invariant, and it is pinned by a test. Marked so far: the composer's Stop
  button and the approval dialog (Deny/Allow).
- **Native value setter**, so React-controlled inputs register the change.
  Typing never submits — submission is `app_press_key`'s deliberate job.
- **Stale refs fail loudly.** An orphaned ref returns `stale_ref` telling the
  model to re-snapshot, rather than hitting whatever moved into that slot.

### Verification

| Suite | Result |
|---|---|
| `cargo test --lib` | 1635 passed, 0 failed |
| `cargo check --lib` | 0 warnings |
| `npx tsc --noEmit` | clean |
| `npx vitest run` | 1697 passed |
| `npm run test:selfui` | 34 passed (jsdom, real bridge logic) |
| Live app | `npm run tauri dev` runs clean; the shipped bridge scripts were injected into the live DOM and produced correct census, filtering, exclusion and error codes |

Two contract tests earned their keep during the build: the tool-registry
classification test caught the new tools before they shipped unclassified, and
the schema budget test caught a drift where `browser_upload_file` was in the
dispatcher's allowlist but missing from the advertised step list.

### Known gaps

- `relay-browser-mcp` has one pre-existing test failure on `master`
  (`static_relay_schemas_cover_every_allowlisted_bridge_tool`, missing
  `search_wiki`). Unrelated to this work; confirmed by stashing.
- `ChatImage` persistence (§0.3) not done.
- `browser_zoom` remains Windows-only (it rides the CDP capture path).

### Phase 3 — not started

OS-level desktop control, per §7. The prerequisites it depends on are now in
place: a bounded tool loop, a real permission gate on `run_code`, and the ref
contract to build a hybrid UIA/vision ladder on.