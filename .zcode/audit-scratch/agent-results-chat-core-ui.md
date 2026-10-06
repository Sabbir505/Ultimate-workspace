# Agent findings: frontend chat core UI (9 files)
# Status: COMPLETE — verified result captured 2026-10-02 18:38

FILES COVERED: src/components/chat/{ChatView,ChatComposer,ActivitySteps,composerShared,composerChrome,composerModals,useTranscriptScroll,useVoiceDictation,useLocalModelSidecar}.tsx/.ts (store slices cross-checked only to confirm/eliminate findings)

## P0

none

## P1

**1. Composer state bleeds across session switches: attachments, command pill, forceResearch, attachError (ChatComposer) and quotedSelections (ChatView) prepared in chat A ride into chat B's next send.**
- ChatComposer.tsx:230-236 (`attachments`, `forceResearch` useState), ChatComposer.tsx:356 (`commandPill`), ChatView.tsx:787-798 (`quotedSelections` — the effect on `activeChatSessionId` only re-registers the prefill callback, never clears the stack).
The composer instance explicitly survives session switches — the file's own comment (ChatComposer.tsx:263-267) says the per-session draft exists because "the old component-local useState smeared the half-written prompt into every chat you switched to" (state/chat/types.ts:328 codifies it). But every other send-affecting composer state is still component-local with no reset keyed on `effectiveSessionId`: attach a screenshot or pick the `/research` pill in chat A, switch to chat B, send text — `handleSend` (ChatComposer.tsx:1189 `const base = (commandPill ? \`/${commandPill.slug} ${content}\` : content).trim()`; :1291 `onSend(outgoing, attachments, forceResearch || undefined)`) ships A's file/pill into B's conversation. Same for `quotedSelections` stacked in A (prepended to the next message sent in B, ChatComposer.tsx:1190-1194). Cross-conversation content leakage into the wrong model/request. Fix: effect on `effectiveSessionId` change (compare against a `useRef` of previous id) clearing `attachments`, `commandPill`, `forceResearch`, `attachError`; and clear `quotedSelections` in ChatView's registration effect (line 789).

**2. Live-streaming markdown rebuilds inline component identities per token flush, remounting every code block / mermaid subtree in the streaming bubble.**
- ActivitySteps.tsx:1746-1859 — inside `build()`: `components={{ table: MarkdownTable, pre({children}){...}, code({className, children, ...props}){...}, img(...), a(...) }}`; consumed with `cache={false}` on the live path (MessageBubble.tsx:451 `const mdCache = !live;` / :478).
With `cache` false, `Markdown` calls `build()` on every parent render (live MessageBubble re-renders each token flush via the rebuilt live item in ChatView's `items` memo). Each `build()` produces a brand-new `components` object with fresh function references; react-markdown uses them directly as element types, so React sees a different component type per flush and unmounts/remounts those subtrees on every streamed token. Each code block remounts per flush — `StepCodeHighlighter` re-initializes with `comp = null`, flashes the plain fallback `<pre>` (ActivitySteps.tsx:796-820) until the lazy-load effect re-runs; `CopyButton`/`ChatImage` state resets; a completed mermaid block remounts per flush. Fix: hoist the components map to a reference-stable value (module-level object or `useMemo(..., [onPreviewArtifact, sources, chatSessionId])` passed into `build()`).

**3. Sending with no active session silently drops and clears the composed message (typed text + pasted attachments).**
- ChatComposer.tsx:1291-1308: `onSend(...); onClearQuotedSelections?.(); ... setContent(""); setCommandPill(null); setAttachments([]);`
- Store guard: state/chat/slices/streamingSlice.ts:62 — `if (!activeChatSessionId) return;` (no error, no queue, nothing the composer can check).
ChatView renders the composer unconditionally (ChatView.tsx:1951-1961), including the boot window before a session exists. The auto-start is gated on `loaded && config` (ChatView.tsx:859) and fires `void newChat(...)` (874) whose rejection is unhandled; `deleteEmptyChatSessions().catch(() => {})` swallows failures. In that window the composer is fully interactive; on Enter, `handleSend` clears everything immediately while `sendMessage` early-returns — the user's pasted screenshot and text vanish with no toast. Fix: bail (or toast "no chat session yet") in `handleSend` when there's no session before clearing; or surface a rejected/queued result the composer awaits.

## P2

**4. Pin "settle window" backoff is not implemented — `frames` values never used; settle pass runs 6 consecutive frames (~100ms) instead of the documented spread over ~0.5s.**
- useTranscriptScroll.ts:583-593: `const frames = [1,2,4,8,16,32]; let frame = 0; const step = () => { patchTailAndPin(); frame++; if (frame < frames.length) raf = requestAnimationFrame(step); };`
`step` only uses `frames.length`; the values are dead. Passes run back-to-back (~100ms); async tail growth (mermaid/highlighter) landing between ~100ms and the one-shot 350/1200ms mount-heal timers (605-612, deps `[]`, fire once per ChatView mount, not per turn) can leave the last row under the floating composer. Fix: skip frames per the schedule or re-arm heal timers on `messages` changes.

**5. `useLocalModelSidecar` warmup keys off the global active session, not the pane's session — split view warms (or skips warming) the wrong chat.**
- useLocalModelSidecar.ts:182-184 (`spawnLocalModel` reads `s.activeChatSessionId` instead of the hook's `activeChatSessionId` prop); :232 (chat-switch warmup checks `s.messages` — the main list, not the pane buffer; a pane pinned to a fresh local chat while main has history skips warmup, paying full cold prompt-eval, and vice-versa). Fix: use the hook's parameter; read `paneBuffers` for the pane's session.

**6. Extended-thinking tri-state cycle logic duplicated.**
- composerChrome.tsx:499 and ChatComposer.tsx:1696-1698 — identical null→true→false→null cycling implemented twice; a change to one diverges silently. Fix: shared `nextThinkingValue(value)` helper.

**7. `StepCodeHighlighter` cache keys embed the full code string, retaining up to ~46MB in the shared 240-entry LRU worst case — the exact pattern the `Markdown` key was already fixed for.**
- ActivitySteps.tsx:830: `` cachedMarkdown(`hl:${themeKey}:${language}:${code}`, ...) `` vs the md-key fix at :1873-1877 ("the key used to embed the FULL content — multi-KB strings held per cached row. Hash + length identifies the content just as well"). `MAX_CODE_BLOCK_BYTES = 200_000` (1575) bounds a single block but the key (and string) is retained by `markdownElementCache` up to `MD_CACHE_MAX = 240` entries — 240 × 200KB ≈ 46MB worst case. Fix: hash+length key like the markdown path.
