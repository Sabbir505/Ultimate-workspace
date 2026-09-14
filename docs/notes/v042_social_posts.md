---
title: "Relay v0.4.2 — The polish, reliability & document pipeline release"
platform: "Twitter / X"
character_count: ~270
---

🚀 Relay v0.4.2 is out.

Real boot splash. Parallel subagents. Split chat. Built-in Git file viewer. Full PDF/DOCX/PPTX pipeline. 44 bugs closed. 48 TS errors cleared.

Your agents can now open the web apps they build — file:// URLs just work.

Download → https://github.com/Sabbir505/Ultimate-workspace/releases/latest/download/Relay_0.4.2_x64-setup.exe

---
title: "Relay v0.4.2 — The polish, reliability & document pipeline release"
platform: "LinkedIn"
tone: "professional, specific"
---

🛠️ Just shipped Relay v0.4.2 — our biggest quality & reliability release yet.

Here's what's in it:

📦 Full document pipeline — PDF generation via a real WebView2 + Paged.js engine (full CSS/SVG/CJK support), DOCX via the docx npm library, PPTX via PptxGenJS. Built-in /pdf, /docx, /pptx skills rebuilt from scratch.

🤖 Subagents can now call tools in parallel. Agent chips appear everywhere — inline in the notch, in their own pane, on every agentic message. Click to open the full chat-fidelity agent pane.

🪟 Split chat view — two full-fidelity ChatViews side by side, draggable divider, tool panel docks beside the focused half.

📁 Git file viewer — per-type icons, click-to-expand inline diffs, working Unstaged/Staged filters, full markdown review cards.

🐛 44 bugs closed from a full codebase audit, including 60s stream watchdogs, WebView2 controller lifecycle fixes, security hardening on the mobile relay, and data integrity safeguards in the headless automation runner.

Also: boot splash, Web app preview in the in-app browser, metrics HUD accuracy fixes, 48 TypeScript errors cleared, smooth animations everywhere.

Download for Windows:
https://github.com/Sabbir505/Ultimate-workspace/releases/latest/download/Relay_0.4.2_x64-setup.exe

#AI #DeveloperTools #Productivity #SoftwareEngineering

---
title: "Relay v0.4.2 — Reddit"
platform: "Reddit (r/programming or similar)"
tone: "casual, technical, genuine"
---

Relay v0.4.2 dropped — this one was mostly about catching up on reliability debt.

The big stuff:

**Full document pipeline.** PDF generation now goes through a hidden WebView2 + Paged.js → PrintToPdf (full CSS/SVG/Unicode, real page numbers, margin boxes). DOCX uses the docx npm lib. PPTX uses PptxGenJS. No more Python fallbacks for the common cases.

**Subagents rebuilt.** They can call tools in parallel now. Agent chips appear in the composer notch, in the agent pane, and on every agentic message bubble. The agent pane matches full chat-view fidelity — streaming thinking, diff cards, ordered segments.

**Split chat view.** Two full ChatViews side by side, draggable divider, tool panel docks beside the focused half.

**Git file viewer.** Per-type icons, click-to-expand inline diffs, Unstaged/Staged/All-branch/Last-turn filters, review cards with styled markdown prose.

**WebView2 re-architecture.** The in-app browser had a long-standing issue where Tauri's message dispatcher silently dropped all commands for child webview panes. Rewrote the controller ownership to bypass the dispatcher entirely — navigate, eval, CDP, bounds, visibility all marshal through the main thread now. Also fixed the ghost click-blocking overlay that appeared after closing a browser pane.

**44 audit findings closed**, including stream watchdogs, security hardening on the mobile relay, data integrity in the headless automation runner.

Also: boot splash, Web app preview now works (models can open file:// URLs directly in the in-app browser), metrics HUD accuracy fixes, 48 TS errors cleared, smooth animations everywhere.

Link: https://github.com/Sabbir505/Ultimate-workspace/releases/latest/download/Relay_0.4.2_x64-setup.exe
