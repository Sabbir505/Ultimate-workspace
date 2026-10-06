# Agent findings: panes/vault (23 files)
# Status: COMPLETE — verified result captured 2026-10-02 19:40

FILES COVERED: src/components/panes/ (8/8: BrowserPane, DevDiffPanel, PullsPanel, ToolPanel, PaneFrame, SubagentPanel, TerminalPane, BranchPanel), src/components/vault/ (12/12: VaultView, VaultGraph, VaultEditor, VaultPreview, VaultQuickSwitcher, VaultFileTree, VaultTabStrip, VaultPdfViewer, VaultAssetView, VaultLinkHover, VaultLocalGraph, vaultVoice), src/components/chat/{AgentModelPicker,GitToolsSidebar,ArtifactPreviewPane}.tsx + supporting modules for verification (state/vault.ts, state/panes.ts, lib/ipc/vault.ts, hooks/useTauriEvent.ts, MermaidDiagram.tsx, voiceDictationCore.ts, main.tsx — no StrictMode).

## P0

**1. Vault autosave can write note A's content into note B's file (silent cross-note data loss).**
- state/vault.ts:477-517 (`openNote`), :591-601 (`scheduleSave`) — reached via VaultView.tsx:427/914 and VaultEditor.tsx:788-793 (onEdit on every doc change).
`scheduleSave` arms a debounce guarded only by `saveGeneration`:
```ts
const gen = get().saveGeneration;
saveTimer = setTimeout(() => {
  saveTimer = null;
  // A stale timer (note switched since scheduling) must not fire.
  if (get().saveGeneration === gen) void get().saveNow();
}, VAULT_SAVE_DEBOUNCE_MS);
```
`saveGeneration` only bumps inside `saveNow` — it does NOT change when `activePath` changes, so the promised guard does not exist. In `openNote`, the pending-save flush runs *before* `loadingNote` is set (`if (saveTimer) { clearTimeout(saveTimer); await get().saveNow(); } const gen = ++openGeneration; set({ loadingNote: true }); ... set({ activePath: resolved }); const content = await vaultReadNote(resolved);`). During the flush await, the editor for A is still mounted — a keystroke (or dictation write) calls setContent + scheduleSave, arming a fresh 600ms timer never cleared when activePath flips to B. If it fires after the activePath set but before vaultReadNote lands, `saveNow` reads activePath=B with content still A's text and executes `vaultWriteNote(activePath, content)` → **B's file overwritten with A's content**; the subsequent set converges the UI, so the corruption is invisible. Same class in `restoreSnapshot` (flush await at :952-956) and `deleteNote` (claim wrong for an already-started saveNow). Fix: capture `activePath` when arming and compare in the callback, or bump saveGeneration in every path that mutates activePath (openNote/restoreSnapshot/closeNoteTab/deleteNote/bind); belt-and-suspenders re-check in saveNow before vaultWriteNote.

## P1

**2. BranchPanel: unguarded async fetch leaves project A's commit log under project B's branch header, no self-heal — BranchPanel.tsx:70-98.**
No cancelled flag/generation counter (unlike DevDiffPanel/GitToolsSidebar which guard the same pattern). Switching the bound chat A→B re-runs the effect, but A's in-flight getGitLog resolves and setLog(A's commits) clobbers B's list; setError(null) wipes B's error. No polling — refresh only on project:fs-changed under the NEW project — so the wrong repo's history (SHAs, authors, HEAD row) shows under B's branch badge indefinitely. Fix: `let cancelled = false` in the effect, checked after each await.

## P2

**3. PullsPanel IssueList: state-filter switch race shows wrong issues under the new filter label — PullsPanel.tsx:705-715.**
Switching Open→Closed/All recreates refresh + re-arms the 30s interval, but the previous filter's in-flight request has no cancellation; resolving last, setIssues(open-issues) lands under the "Closed" label. Self-heals only at next 30s tick. Fix: cancelled flag in the effect at :717-721.

**4. VaultPdfViewer: any text selection consumed into a highlight on pointerup — text layer un-copyable — VaultPdfViewer.tsx:382-421 (attached :596).**
Only eraser mode is gated; in default mode every finished drag-selection becomes a persisted highlight and `sel.removeAllRanges()` destroys it — Ctrl+C after selecting copies nothing. Contradicts the stated purpose ("a REAL text layer, so sentences are selectable") and the header ("Selecting text and pressing the highlighter" = deliberate action). Fix: gate on an active highlighter mode, or create the highlight without destroying the selection and commit via explicit button.

**5. VaultEditor: `noteContentCache` never invalidated when notes change — `[[Note#` subpath completion offers stale headings until restart — VaultEditor.tsx:55-63, 605-614.**
Only invalidation is clearNoteContentCache() from bind() (vault.ts:417-419). After a note is edited/renamed/deleted+recreated, completion keeps proposing old headings/^block ids — including links that no longer exist — for the session. Fix: invalidate the entry in saveNow/onVaultChanged (export invalidateNoteContent(path)) or key with the tracked mtime.

**6. VaultEditor: watcher-reload doc replacement is an undoable transaction — one Ctrl+Z reverts an external file change and autosave writes the old text back — VaultEditor.tsx:815-825.**
The external-sync dispatch carries no history annotation, so history() records it. The store only does this replacement when the buffer is clean (user has nothing of their own to undo) — yet one Ctrl+Z (or the toolbar Undo, wired at VaultView.tsx:133) reverts the on-disk change, and updateListener→onEdit→scheduleSave persists the reverted text back over the external file 600ms later. Fix: `Transaction.addToHistory.of(false)` (or isolated()) on the external swap.

**7. VaultGraph: hover-diagnostics `console.debug` runs in production on every hover change — VaultGraph.tsx:652-669.**
No dev gate (unlike the click log four lines down at :695-697). Sweeping the cursor fires it dozens of times per traversal in shipped builds. Fix: wrap in `import.meta.env.DEV`.

Clean areas worth noting: BrowserPane webview lifecycle (ghost-hide, off-screen belts, occlusion single-writer, create-in-flight ref) held up; vault store's openGeneration guards correctly prevent late note-read clobbering; cyclic wikilink embeds depth-capped (MAX_EMBED_DEPTH=3); iframe sandboxes correct everywhere (sandbox="" for static office/feed HTML, no allow-same-origin on live HTML preview, mermaid SVG sanitizeSvg'd upstream); graph canvas-rendered with documented node budget; TerminalPane resize debounced and BrowserPane bounds rAF-coalesced.
