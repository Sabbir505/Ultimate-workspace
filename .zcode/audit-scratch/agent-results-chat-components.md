# Agent findings: frontend chat components (47 files)
# Status: COMPLETE — verified result captured 2026-10-02 19:03

FILES COVERED: 47 files in src/components/chat/ — ApprovalFlow, ArtifactExportMenu, ArtifactProposalCard, ArtifactTypeSelector, ArtifactsMenu, BranchDropdown, ChatCitation, ChatPaneGrid, ChatSelectionToolbar, ChatSessionRow, ChatWelcome, CitationReportStrip, CommitModal, ComposerMetrics, ContextMeter, DiffCard, DiagramLightbox, DocCodeRunner, DocDesignRunner, DocxViewer, ForkChatModal, GitMenu, ImageGenCard, InlineDiagram, JsxPreview, LlamaAdvancedFields, MarkdownTable, MdLink, MermaidDiagram, MessageAttachments, MessageBubble, MissingFieldsPrompt, PermissionModeMenu, PlanProposalCard, QuestionCard, SegmentedSlider, TaskProgressCard, TurnChangesRow, TurnNavigator, TtsPlayerBar, TypingIndicator, agentIcons, agentPickerParts, agentPickerShared, chatWelcomeShared, docRunnerFrame (+ cross-checks in lib/sanitize.ts, lib/contextWindow.ts, lib/ipcCore.ts, hooks/useTheme.ts, state/chat/slices/approvalsSlice.ts, src-tauri/src/chat/jsdocgen.rs).

Posture note: content-rendering security is genuinely strong — every `dangerouslySetInnerHTML` site (MermaidDiagram, DiagramLightbox) runs through `sanitizeSvg`/`sanitizeHtml` with correct DOMPurify profiles and CSS url()/position neutralization; iframes use correct sandbox sets; object URLs consistently revoked; listeners/timers/observers cleaned up; async races guarded with stale flags/epochs in nearly every loader.

## P0

none

## P1

**1. ApprovalFlow.tsx:186-189 — Bubbled Enter keydowns from inner controls trigger full approval (Enter on Deny = Approve).**
```tsx
onKeyDown={(e) => {
  if (e.key === "Enter") void handleAllow();
  else if (e.key === "Escape") onResolve(false);
}}
```
Handler sits on the card's root div, so keydowns from descendant focusable controls bubble. (a) Focus **Deny**, press Enter — the container handler synchronously runs `handleAllow()` → `onResolve(true)` before the button's default activation fires `onResolve(false)`; `resolveApproval` (approvalsSlice.ts:54-66) optimistically removes the pending card on the first call, so the **approve** decision is what reaches `resolveToolAction** — pressing Enter on Deny approves the gated tool call. (b) In the confirm-edits card, Enter on an occurrence checkbox calls `onResolve(true)` with no `selected` subset — "apply all", silently discarding deselections. Fix: `if (e.target !== e.currentTarget) return;` at the top of the handler.

**2. BranchDropdown.tsx:70-93 — `fetchAll` has no stale guard; a late-resolving fetch from the previous repo paints the wrong branch list, and a click checks out in the wrong repo.**
Unlike every other async loader in this audit, `fetchAll` sets state unconditionally. When `path` changes mid-fetch (session switch rebinding `sessionProjects`, watcher refresh racing a path-change fetch — deps `[fetchAll, path]` at 90-93), the older `Promise.all` can resolve last and its `setBranches`/`setDirtyCount` overwrite the new repo's data. `performCheckout` (126) uses the *current* `checkoutGitBranch(path!, name)` — clicking a branch listed from repo A executes a checkout in repo B (wrong-repo git mutation). Fix: epoch/stale flag per effect run, drop late resolutions.

## P2

**3. ContextMeter.tsx:131 — `contextWindowForModel(...)` with no `.catch` → unhandled rejection on harness/custom-endpoint sessions.**
The opencode branch (contextWindow.ts:307) and compatible-endpoint branch (352) call `fetchProviderModelWindows` = bare `safeInvoke`, which rethrows backend errors inside Tauri (ipcCore.ts:24-32); neither branch nor the call site catches → unhandled rejection on every meter mount for those sessions (falls back to registry, so noise/telemetry). Fix: `.catch(() => {})` at call site or null-resolving wrapper in the branches.

**4. DocCodeRunner.tsx:30-46 — result handler lacks the `event.source` check its sibling has (hardening).**
DocDesignRunner.tsx:107 guards `if (event.source !== frameRef.current?.contentWindow) return;` ("a foreign window must never be able to settle a run"); DocCodeRunner accepts a `relay-docgen` postMessage from *any* window — including sibling sandboxed frames executing model-authored scripts. Only protection is the unguessable UUIDv4 requestId (jsdocgen.rs:86) — defense-in-depth, but the check exists 60 lines away. Fix: mirror the source check.

**5. ArtifactTypeSelector.tsx:61-64 + 102-111 — Escape in the instruction input closes the whole selector, contradicting the "Esc to go back" hint.**
Document listener fires `onClose()` AND the input's `handleInstructionKeyDown` fires `setShowInstruction(false)` for one press (no stopPropagation) — the selector unmounts instead of returning to the type list. Fix: `e.stopPropagation()` in the input's Escape branch.

**6. MermaidDiagram.tsx:428-435 — theme observer watches only `data-theme`; custom-theme token swaps leave mounted diagrams on the old palette.**
Custom themes set `--diagram-*` tokens inline without touching `data-theme` when no base is pinned (useTheme.ts:23-29); the re-render trigger (`themeAttr`, deps `[code, themeAttr]` at 545) never changes on a token-only swap, though `diagramInitKey` exists precisely because "two dark-based themes with different accents must not share one initialized mermaid instance". Fix: extend `attributeFilter` to `["data-theme", "style"]` or observe the token signature.

**7. PdfViewer.tsx:263-276 — superseded full-document search keeps scanning every page; generation check only after the loop.**
Re-searching while a slow scan is in flight leaves the stale run walking getPage/getTextContent over every remaining page of a 1000+ page PDF, competing with the live run for the pdf.js worker (results correctness preserved). Fix: check `gen !== searchGenRef.current` inside the loop each page.

**8. ImageGenCard.tsx:184-191 — `sessionScopesTo` prop and `anchorSessionId` subscription are dead code; documented scoping not enforced here.**
The scoping described by the prop comment is actually done by ChatView's `imageGenOwnedHere` gate. The unused `useImageGenStore((s) => s.anchorSessionId)` subscription re-renders every mounted ImageGenCard (incl. static history rows) on anchor changes for nothing. Fix: delete prop + subscription or enforce the scope in-component.

**9. MissingFieldsPrompt.tsx:209 (with 75/85) — array/object-valued spec fields prefill as comma-joined strings, not the JSON the field asks for.**
`value={fieldValues[path] ?? ""}` seeded from the live spec (151-165); JSON-typed fields (`spec.inputs`, `spec.steps`, …) hold actual arrays and `value={value as string}` stringifies them as `name,type` — invalid JSON for a field labeled "(JSON array)". Submitting sends a broken string. Fix: `JSON.stringify(value, null, 2)` non-string primitives when seeding.

Cleared for the record: InlineDiagram live-viz and JsxPreview srcDocs intentionally unsanitized with sandbox sets omitting allow-same-origin + documented threat model (static paths all sanitize); MessageBubble artifact-sources effect, DocxViewer render epoch, ImageGenCard bounded preview caches, ChatSelectionToolbar listeners, ChatCitation timers all clean up correctly.
