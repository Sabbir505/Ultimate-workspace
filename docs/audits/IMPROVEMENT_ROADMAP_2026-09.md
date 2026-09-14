# Relay — Consolidated Improvement Roadmap (2026-09-06)

A single prioritized list of what to **fix**, **improve**, and **add**, built from a full
review of the codebase (298 registered commands, 42-table DB, three chat paths, mobile
companion), all ~20 existing audit/research docs in the repo, the in-repo competitor
research (Browser Use, Skyvern, Stagehand, T3 Code), and a September 2026 scan of the
wider market (Claude Code, Cursor, Warp).

Provenance is marked per item: ✅ = verified in code today, 📄 = documented open, never
re-verified against code.

---

## State of the app (why this list is mostly forward-looking)

The app is in unusually good shape. Every major audit wave is resolved and verified
current: ISSUES.md's 60 findings, BUG_LIST rounds 1–2 (117 findings), round-3 findings
A/B/C series, harness-parity G1–G7/G9, and the full compaction redesign. Test suites are
green (798 vitest, 898 cargo). What remains is: **2–3 real bugs, one live performance
regression, a cluster of consciously deferred security items, and feature gaps versus
the market** — plus the fact that several older audit docs have drifted out of sync with
the code and now misreport open work.

---

## FIX — verified open bugs (correctness / data integrity)

1. **`remove_project` is non-transactional** ✅ — `src-tauri/src/db/projects.rs:50-62`
   runs seven sequential DELETEs with no `unchecked_transaction` and swallows the
   session-deletion error (`let _ = delete_chat_sessions_for_project(...)`). A crash
   mid-sequence orphans chat sessions and cost events. This is the last surviving piece
   of audit finding B-29. Fix: wrap in a transaction like `db/chat.rs` already does.

2. **PTY reader/writer thread panics freeze panes silently** ✅ — `src-tauri/src/pty/mod.rs`
   (~lines 713, 746) uses plain `thread::spawn` with no panic hook, so a panic in a
   reader/writer thread kills the pane with no event to the UI and nothing in the log.
   Round-3 finding M1, still unchecked. Fix: panic hook that emits an existing
   backend→frontend event so the pane can show a "session crashed, restart" affordance.

3. **One-shot children registry leaks an Arc on crash** ✅ — Round-3 finding M2,
   still unchecked. Low severity; cleanup on the process-registry path.

4. **Deferred low-severity leftovers from FIXES.md** 📄 — all verified still accurate as
   a group: `onStatus` symmetric guard, artifact-map eviction (P-3), navigation-injection
   thread pooling (P-2), and the non-Windows automation lock that stays on the
   6-hour-stale fallback (B-28). Batch them into one hygiene PR.

5. **Known browser flakiness** ✅ — `run_action_for_pane` result reporting intermittently
   fails against child webviews (`navigate` returns empty, `read_page` can time out at
   15 s). Documented in AI_CONTEXT §2.7 as the one open browser bug; suspected
   `browser_action_result` capability allowance for `browser-*` windows. Worth a
   dedicated debugging session — this is the moat feature.

6. **Audit docs have drifted and now lie about open work** ✅ — `FIXES.md` still lists
   E-2 (compaction) and E-7 (zombie process trees) as "deferred" but both are fixed in
   code (`chat/compaction.rs:55-68`, `agent_sessions.rs:5078-5081`); the
   `BROWSER_SYSTEM_RESEARCH.md` header claims the P1/P2 trust layer is "the open
   roadmap" but fill_form/press_key/console+network reads/wait_for/autonomy gates are all
   shipped. Update the headers so the next audit doesn't re-chase resolved items.

---

## IMPROVE — performance, safety, and quality of existing features

1. **Entry-chunk regression — the top perf item** ✅ — main bundle went 459 KB → 1,179 KB
   raw (141 → 357 KB gzip) since 08-27, and `dist/index.html` eagerly modulepreloads
   Babel (2.98 MB) and the syntax-highlighter grammar pack (1.59 MB). Research mode, the
   harness picker, and citation UI landed in the entry graph. Fix with `React.lazy` +
   `manualChunks` and re-run the visualizer pass. Also lazy-load KaTeX fonts (~500 KB
   eager) and audit the >500 KB async chunks (flowchart-elk 1.45 MB, ArtifactPreviewPane
   1.24 MB, mindmap 544 KB).

2. **Global sessions mutex held too long** ✅ — `send()` still holds the global `sessions`
   mutex across harness spawn, git snapshot, and up to a 20 s wait-ready; only the
   async-cancel half of B-8 shipped. UI-freeze risk whenever a harness boots slowly.
   Narrow the lock scope to map insert/remove only.

3. **Code execution runs unsandboxed** ✅ — `chat/codeexec.rs:103-134` has explicit
   TODO(landlock) / TODO(sandbox-exec) / TODO(job+token) stubs; `run_shell`/`run_code`
   execute with full app privileges. This is a *decision* more than a bug: implement
   Windows Job Objects + restricted token first (Windows is the first-class platform),
   Landlock on Linux, sandbox-exec on macOS. Until then the honest warning in the result
   text is the mitigation.

4. **Pairing proof is replayable** ✅ — mobile pairing uses static `HMAC(token,"E2E")`;
   the nonces in `relay_crypto.rs` are transport counter-nonces only. Add a
   challenge-response to the pairing handshake. Requires a phone-side protocol change,
   so it needs a coordinated release.

5. **Kimi/OpenCode harnesses always run full-auto** ✅ — no approval cards on those
   paths, only post-hoc `DiffCard`s, unlike the Claude Code `can_use_tool` relay. Close
   the parity gap by wiring their permission prompts through the same approval flow.

6. **Static harness model catalog** ✅ — `src/lib/harnessModels.ts:7` still carries the
   static fallback TODO despite live `list_harness_models`. Wire it up; also schedule a
   refresh path for the static pricing/model catalogs (documented drift risk, 📄).

7. **MCP sessions re-opened per tool turn** 📄 — FEATURE_AUDIT §1.1; persistent
   sessions would cut latency on every connector/tool call.

8. **Linux is a second-class citizen** ✅ — iframe browser fallback, XOR "encryption" for
   secrets, no code-exec sandbox. Decide whether Linux is a supported platform; if yes,
   the secret storage upgrade (libsecret/keyring) comes first.

9. **Quick-action keybindings stored but never registered** ✅ — no `globalShortcut`
   usage anywhere (`lib.rs`, `ui.ts` verified). Either register them OS-wide or remove
   the settings UI so it stops promising something that doesn't happen.

10. **Placeholder app icon** ✅ — `src-tauri/icons/icon.ico` is a minimal 32×32. Visible
    polish item on every taskbar and installer.

11. **Mobile companion is minimal** ✅ — 4 screens (Home/QR-pair, SessionChat with a
    vt100 grid, Settings). Highest-value additions: voice input (the desktop whisper
    sidecar exists; the phone has none), background push when an agent finishes or
    needs approval, and read-only cost/budget view.

12. **Connector breadth and health** 📄 — add Slack / Linear / Jira / Discord
    connectors, plus a connectors health page (token expiry, reconnect status). OAuth
    client secrets are still baked into the binary via `option_env!` — move to a small
    local config or dynamic registration long-term.

---

## ADD — feature gaps worth closing (ranked by expected impact)

### Differentiator upgrades (browser agent — the moat)

1. **Self-healing browser actions + AI-fallback selectors** (from Stagehand & Skyvern
   research) — when a selector fails or the DOM changed, retry targeting via the
   a11y tree / natural-language prompt instead of failing. Pairs with
   **a11y-tree token trimming** to cut `read_page` token cost.
2. **`observe()`-style "what's actionable here" tool** and **structured
   `extract(prompt, schema)`** — Stagehand's two best API shapes; both fit Relay's
   existing tool surface cleanly (Browser Phase 3 in `BROWSER_SYSTEM_RESEARCH.md` §5).
3. **Credentials & 2FA for browser agents** (from Skyvern/Browser Use research) — the
   biggest functional hole: TOTP generation, password-manager integration
   (Bitwarden/1Password), and real Chrome-profile auth reuse. Relay already has
   takeover-on-credential-fields; this completes the login story.
4. **`relay-browser` CLI verbs for harness panes** (Browser Phase 3) — let PTY harnesses
   drive the visible browser via short CLI verbs instead of huge MCP snapshot payloads;
   the research doc's own 114K-vs-27K-token lesson. Also: performance trace /
   CPU-network emulation, `upload_file`, WebMCP watch.

### Orchestration & automation

5. **Non-blocking background subagents in built-in chat** — Claude Code shipped
   "main keeps working while subagents run" (June 2026) and it changed the feel of
   parallel work. Relay's SubagentPanel + "Now" strip should be verified against this
   pattern and extended so the main conversation never blocks on a subagent.
6. **Automation triggers beyond cron** — Cursor/Warp both push richer triggers
   (source-control events, API calls, file watch). Relay has cron + webhooks; adding
   git-event triggers (push, branch create, PR open) and file-watch triggers makes
   automations feel like a real agent platform.
7. **Workflow/block chaining for automations** (Skyvern's workflow builder) — loops,
   conditionals, validation, HTTP steps composed visually. Natural evolution of the
   shipped headless cron.
8. **Hooks system** — pre/post tool-execution hooks (Claude Code's layer that
   power-users depend on). Low effort given the centralized `check_permission()` and
   tool dispatch already exist.

### Platform & distribution

9. **macOS .dmg / Linux bundles** — the only remaining open item in
   COMPETITOR_ANALYSIS_AND_GAPS.md's own priority table (P3). Compile-only macOS CI
   exists. Distribution reach was flagged in the T3 Code deep-dive as the axis Relay
   loses on (`npx`-style zero-install trial, winget/store presence).
10. **Multi-git-provider support** — GitHub-only today (8 PR commands); T3 Code ships
    GitHub/GitLab/Bitbucket/Azure DevOps with in-app PR review. At minimum: GitLab.
11. **Skills/plugins marketplace** — Claude Code's 2026 model (skills bundled by
    default, plugin = skills + commands + agents, marketplace distribution) is where
    ecosystem gravity is going. Relay has 6 builtin skills + an MCP gallery but no
    community distribution story. A curated "install from repo URL" flow would be a
    cheap first step.
12. **Auto-routing Phase 4** — `openrouter/auto` as a ranking source, TTFB-based
    ranking, eventually a learned classifier (deferred in
    `AUTO_MODEL_ROUTING_RESEARCH.md` §4.5).
13. **Browser watch-mode polish / livestream** — Devin-style watchability is partially
    shipped (synthetic cursor, ripples, typing animation); Skyvern's livestream framing
    suggests promoting this to a first-class "watch the agent work" experience.

### Self-improving artifacts (design decisions, not bugs)

14. Close the §12 open questions: judge-model cost policy (surface it in the cost
    dashboard), harvested-eval-case privacy caps, run-table unification, and one
    canonical truth for skills (filesystem vs DB).

---

## Explicit non-goals (revisit only deliberately)

Per the competitor gap doc, these stay out: cloud execution VMs, IDE autocomplete /
edit prediction, enterprise SSO/SCIM, free frontier-model access, and a web client.
They're structurally wrong for a local-first shell or consciously priced out. The list
above is calibrated around that strategy rather than against it.

---

## Hygiene

- Repo root cleanup: `tauri_dev.log` (4.2 MB, actively growing), the stray `nul` file,
  old screenshots (`api_screenshot.png`, `composer_dark.png`, `cursor.png`, …), social
  post drafts, and `generated_docs/` — move to `archive/` or `.gitignore` them.
- 15 TODO/FIXME hits in Rust, ~4 real ones in TS — very low density; no action needed
  beyond the sandbox TODOs called out above.
- Doc drift batch (FIX-6) plus: AI_CONTEXT §2.6 file list is missing
  `auto_router.rs`, `model_health.rs`, `context_windows.rs`, `docs_images.rs`, and the
  command count is off by 2.

---

## Suggested sequencing

| Wave | Theme | Items |
|---|---|---|
| 1 | Correctness + perf | FIX 1–2, IMPROVE 1–2, FIX 6 (doc drift) |
| 2 | Safety parity | IMPROVE 3–5 (sandbox decision, pairing replay, approval cards), FIX 3–5 |
| 3 | Moat upgrades | ADD 1–4 (browser: self-healing, extract, credentials, CLI verbs) |
| 4 | Platform | ADD 5–8 (subagents, triggers, workflows, hooks), IMPROVE 11–12 |
| 5 | Reach | ADD 9–11 (bundles, multi-git, marketplace) |

---

## Sources for the market claims

- Claude Code 2026 feature set (subagents, skills, plugins, hooks layers):
  [MarkTechPost guide](https://www.marktechpost.com/2026/06/14/claude-code-guide-2026-25-features-with-examples-demo/),
  [official "Extend Claude Code"](https://code.claude.com/docs/en/features-overview),
  [Week-27 changelog: non-blocking subagents](https://code.claude.com/docs/en/whats-new/2026-w27),
  [bundled skills /code-review, /verify, /run](https://www.totalum.app/blog/claude-code-skills-totalum)
- Warp/Cursor orchestration and automation triggers:
  [Warp vs Cursor 2026](https://www.augmentcode.com/tools/warp-vs-cursor),
  [Warp vs Claude Code (official)](https://docs.warp.dev/guides/agent-workflows/warp-vs-claude-code/),
  [Claude Code Routines vs Cursor Automations](https://aicatchup.com/comparisons/claude-code-routines-vs-cursor-automations),
  [ADE comparison: Claude Code / Cursor / Warp](https://medium.com/@md.mollaie/an-analytical-comparison-of-agentic-development-environments-claude-code-cursor-and-warp-5ab0019988b4)
- In-repo competitor research: `browseruse.md`, `skyvern.md`, `stagehand.md`,
  `COMPETITOR_ANALYSIS_AND_GAPS.md`, `BROWSER_SYSTEM_RESEARCH.md`
