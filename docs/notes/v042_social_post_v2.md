Relay v0.4.2 is out.

Here's what changed:

**New this version**

— Boot splash + first-run onboarding modal
— Parallel subagents: agents can now call tools at the same time, and chips appear in more places so you can track what's running
— Split chat: two full chat views side by side with a draggable divider
— Git file viewer rebuilt: per-type file icons, click-to-expand inline diffs, working filters (Unstaged / Staged / Branch / Last turn), review cards with full markdown prose
— Full document pipeline: PDF generation via WebView2 + Paged.js (full CSS/SVG/CJK support), DOCX via the docx npm library, PPTX via PptxGenJS — all previewable in-app without exporting
— CDP execution layer (Phase 1): Chrome DevTools Protocol support in the in-app browser
— Queued messages: edit, delete, and reorder messages in the composer notch before sending
— Structured plan tracking: model-declared plans surface inline in the chat
— Agents can now open web apps they build directly in the in-app browser (file:// URLs work)

**Improved**

— Real Relay brand logo in the update-available modal (was showing a generic refresh icon)
— Smooth expand/collapse animations throughout the app, including thinking blocks, fold disclosures, edit rows, and the Files tab diff accordion
— WebView2 browser reliability completely re-architected: navigate, eval, CDP, bounds, and visibility commands now work reliably
— Metrics HUD accuracy fixed: cache hit rate, decode tok/s, TTFT, and live IN/CACHE display all now report correctly
— Session menu styled to match the composer's liquid glass treatment
— Welcome screen gets a time-aware greeting (morning/afternoon/evening) and icon cards

**Fixed**

— 44 bugs closed from a full codebase audit, including:
  • Mobile relay E2E pairing security hardening
  • 60-second stream stall watchdogs on all chat loops
  • Byte-buffered SSE parsing (no more corrupted characters at chunk boundaries)
  • Browser pane ghost overlay after closing
  • Composer going blank on settings/skills/cost tabs
  • Harness subagent visibility: Claude Code Agent tool recognized, permissions actually apply
  • Agent browser chip reuse (was stacking duplicates on every page)
  • Background chat spinners and harness mode reset
  • Web app preview: models can now open local files and dev servers
  • Artifact gallery uniform card heights
  • Split tool panel: no more broken docking
  • 48 TypeScript errors cleared (empty store fallbacks were typed as unknown)

Verified: 574 cargo tests passing · 499 vitest passing · tsc --noEmit clean

Download: https://github.com/Sabbir505/Ultimate-workspace/releases/latest/download/Relay_0.4.2_x64-setup.exe

---

This is a personal, local-first harness. If you're running Claude Code locally and want a full UI around it — chat, git tools, document generation, browser automation, split views, automations — this is what we're building.
