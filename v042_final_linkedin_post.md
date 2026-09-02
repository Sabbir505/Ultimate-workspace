---
platform: LinkedIn
draft: "the credibility play"
---

We just shipped the most thorough release we've ever done.

Relay v0.4.2 isn't a feature release. It's a foundation release.

Here's what's in it — and why each piece matters:

---

**The problem we solved: AI agents hit walls.**

When an AI agent builds something real — a document, a web app, a pull request — it needs to show you the result. Every existing tool breaks at that moment. It screenshots its terminal. It links to a localhost URL that doesn't work on your machine. It hands you a file and says "you'll need to open this."

Relay v0.4.2 eliminates all three failure modes:

→ Web app built? The agent opens it inside Relay's in-app browser. `file://` just works. You see what it built.

→ PDF, DOCX, or PPTX? Real generation engines — WebView2 + Paged.js for PDF, the `docx` npm lib for Word, PptxGenJS for PowerPoint. Preview in-app, no export required.

→ Git work? Built-in file viewer with inline diffs, per-type icons, and working review cards — not a modal, not a pane flip, expand in place.

---

**The problem we didn't know we had: silent failures.**

The in-app browser's WebView2 controller was silently dropping every command. Navigate. Evaluate. Set bounds. All of it — gone. No error, no warning, just a browser pane that looked alive and did nothing. We rewrote the controller stack from scratch. Now it works.

This was hiding 44 other edge cases too. We ran a full codebase audit and closed every one.

---

**The workflow that's now possible:**

1. You ask Relay to build a web app
2. The agent spawns parallel subagents to work simultaneously
3. It opens the result in the in-app browser and shows you
4. You approve the output
5. It writes the file, generates the docs, submits the PR

That's the full loop. No terminal. No context switching. No "let me screenshot that for you."

---

**What we ship:**

- Parallel subagents with tools — fan-out visible in real time
- Split chat view — two full ChatViews, draggable divider
- CDP execution layer (Phase 1) — Chrome DevTools Protocol as a first-class capability
- Queued messages — edit, delete, and reorder before sending
- Structured plan tracking — model-declared plans surface inline
- Boot splash + onboarding flow
- 44 bugs closed, 48 TS errors cleared, 574 cargo tests, 499 vitest

Verified clean.

---

Download Relay v0.4.2:
https://github.com/Sabbir505/Ultimate-workspace/releases/latest/download/Relay_0.4.2_x64-setup.exe

If you're building with AI agents today, this is the release that makes the workflow feel finished.

#AI #DeveloperTools #SoftwareEngineering #Productivity #MachineLearning
