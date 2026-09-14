# Relay v0.4.2 — What's New

> Released 2026-08-31 · [Download for Windows](https://github.com/Sabbir505/Ultimate-workspace/releases/latest/download/Relay_0.4.2_x64-setup.exe)

---

## First impressions: a real boot splash + onboarding flow

Every launch now shows the Relay brand logo and animated wordmark the instant the window paints — before any JavaScript runs. It holds ~2.4 seconds while React finishes mounting, then fades out cleanly. The whole thing is pure HTML/CSS with CSP-safe inline styles and respects `prefers-reduced-motion`.

On first run, instead of a banner pinned awkwardly over the chat, a focused onboarding modal appears when no local model is configured. You can dismiss it with Escape or an overlay click, and your choice persists.

The real brand logo (`public/logo.png`) is now the single source of truth everywhere: the splash, the collapsed-sidebar restore button, and the update-available modal.

---

## Parallel subagents + full-fidelity agent pane

Subagents can now call tools in parallel — the fan-out is live and visible. Agent chips appear consistently across the chat (inline in the composer notch, in their own pane header, and on every agentic message bubble). Clicking a chip opens the agent pane, which now matches full chat-view fidelity: ordered segments, streamed thinking blocks, and diff cards render exactly as they do in the main thread.

Subagents also receive the complete read-side research stack, and the permission mode actually gates what they can do — harness subagents get real answerable tool cards instead of bare stubs.

---

## Structured plan tracking

Models that declare a structured plan (the "plan posture") now surface it inline in the chat with a visible Plan badge. Harness-native modes handle this cleanly too.

---

## Split chat view

You can now open a full-fidelity second `ChatView` side by side with the first. A glass-styled session menu lets you pick which chats go where. The split divider is draggable, the tool panel docks beside the focused half, and the Git sidebar appears only in the focused chat. The `×` button closes the split without closing either chat.

---

## Git file viewer rebuilt from scratch

The Git tools sidebar now has a proper file browser:

- **Per-type file icons** — instant visual scan of what changed
- **Click-to-expand inline diffs** — no modal, no pane flip, just expand in place
- **Working filters** — Unstaged / Staged / All-branch / Last-turn, with a liquid-glass dropdown
- **Review cards with full markdown prose** — styled, scrolled, pinned to the top of the pane
- **Live Send PR and Review-all buttons** — scoped to the focused chat, with a spinner during the request and real error feedback on failure

---

## Full document pipeline: PDF, DOCX, PPTX

The document generation and preview story is now production-grade across every format:

| Format | Generation | Preview |
|---|---|---|
| **PDF** | HTML authored by the model → rendered in a hidden WebView2 with Paged.js → printed via `ICoreWebView2_7::PrintToPdf`. Full CSS/SVG/Unicode/CJK support, real page numbers, running headers, margin boxes. | pdf.js viewer — page nav, zoom, text search, text selection. Identical across WebView2, WKWebView, and WebKitGTK. |
| **DOCX** | `docx` npm library — headings, tables, numbering, styles, no Python needed. Python fallback remains for complex cases. | docx-preview renders real OOXML styles. "PDF view" toggle runs the file through LibreOffice for true paginated output. |
| **PPTX** | PptxGenJS — 16:9 layouts, native charts, slide masters. |

Built-in `/docx`, `/pptx`, `/pdf` skills rewritten for the new engines.

---

## CDP execution layer (Phase 1)

The in-app browser now has a Chrome DevTools Protocol layer. Subagent round limits raised to 100 to take advantage. This unlocks programmatic browser control — element inspection, performance profiling, network interception — as a first-class capability.

---

## Queued messages: steer before you send

You can now edit, delete, and drag-reorder messages sitting in the composer notch before they go to the model. Compact inline editing, pointer-based reorder, one container. No more "send then fix" round-trips.

---

## WebView2 browser pane: major reliability work

The browser pane had a long-standing set of issues rooted in how Tauri's dispatcher routes messages for child `WebView2` panes — all touch commands were silently dropped. The fix was a full re-architecture:

- Browser pane now **owns** its entire WebView2 stack via `webview2-com`, bypassing Tauri's dispatcher entirely
- All controller access (`navigate`, `eval`, CDP, devtools, bounds, visibility, `close`) marshals through the main thread via a `with_core_on_main` primitive
- Controllers are created invisible and shown immediately — no more ghost blocks stealing focus
- Per-action nonces prevent untrusted pages from spoofing sequential request IDs
- Raw WebView2 panes (no Tauri IPC) fall back correctly; macOS compile-only CI job restored

The ghost click-blocking overlay that appeared after closing a browser pane is also gone — `controller.Close()` now actually destroys the native child window.

---

## Metrics HUD: accuracy fixes

The token/cost display was misreporting several numbers:

- **Cache hit rate** — was double-counting cached tokens (80% actual → 44% shown); now normalizes OpenAI-style inclusive `prompt_tokens` correctly and hides the chip when the provider reports no cache fields at all
- **Decode tok/s** — new `decode_ms` accumulator: output tokens ÷ (first delta → round close), prefill excluded; live and final share one definition
- **TTFT** — anchored to the first generation window's opening and captures on any first provider delta (including tool-call JSON), excluding pre-flight setup
- **IN/CACHE** — now renders live per round; `emit_marker` no longer inflates live OUT counts with tool blocks, think tags, result cards, or epilogues
- **Weighted-average tok/s** — fixed a double-counted denominator that was ~2× understated

---

## Web app preview: models can now open what they build

Previously, `open_url` hard-rejected everything except `http(s)` and explicitly forbade `file://` paths and local servers — so agents that built a static web app had no way to show it in the in-app browser and fell back to foreground `npx serve` commands that block and produce no output.

Now: `open_url` accepts `file:///` URLs, repairs the common `file://C:/…` slip, converts bare absolute paths, and skips fetch readback for files. The pane webview renders them directly; relative CSS/JS loads fine from the app folder. Dev servers (Vite, Next.js) are recognized and launched as background tasks, then `localhost` is opened automatically.

---

## UX polish

- **Smooth animations everywhere** — expand/collapse on thinking blocks, fold disclosures, edit-row diffs, turn-changes list, and the Files tab inline diff accordion all use a shared `grid-rows: 0fr → 1fr` reveal with `prefers-reduced-motion` support. Dropdown menus that used to snap now animate in with a subtle pop.
- **Session menu** — now uses the composer's liquid glass (true-transparent, `blur(24px)`, `saturate(160%)`, 16 px radius).
- **Welcome screen** — time-aware greeting (morning/afternoon/evening) with icon cards and a 500 ktoken context ceiling shown for cloud/harness meters.
- **Chat message text** — dimmed via a scoped `--chat-text` token for improved readability in longer sessions.
- **GitHub PR scope dropdown** — liquid glass treatment; API calls now route through git's proxy config.
- **Git file view** — compact diff gutters, liquid-glass filter menu, loading spinners on scope switch.

---

## 48 TypeScript errors cleared

`EMPTY_TASKS`, `EMPTY_STEPS`, and `EMPTY_SUBAGENTS` in the chat store were typed as `Record<string, unknown>` / `unknown[]`, which unioned Zustand selector return types down to `unknown`. Every `.filter`, `.map`, and field access in `GitToolsSidebar` (37 errors) and `ProgressPanel` (11 errors) was broken. All three constants are now typed with the real slice value types (`ChatTaskProgress`, `PlanStep`, `SubagentInfo`). `tsc --noEmit` exits clean.

---

## Full audit sweep

This release also closes **44 findings** from a full codebase audit (`AUDIT.md` / `FIXES.md`), including security (E2E relay pairing fail-closed, broadcast push registration gating), stream reliability (60 s stall watchdogs on all three loops, byte-buffered SSE assembly, mid-stream error surfacing), session lifecycle (reader-alive flag, process generations, dead harness respawn), headless automation (PID-aware stale locks, transactions for chunk-replace, marker-gated migration), and data integrity (poison recovery, tree-kill, child kill on spawn error).

---

**Verified:** `cargo test` 574 / 0 failures · `vitest` 499 / 499 passing · `tsc --noEmit` clean
