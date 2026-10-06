# Agent findings: state stores (36 files)
# Status: COMPLETE — verified result captured 2026-10-02 19:46

FILES COVERED: src/state/chat/{index,moduleState,paneTree,types}.ts + 12 slices + 24 root stores (appearance…wiki). All read in full; suspect patterns cross-checked against consumers (ChatView, GitToolsSidebar, useViewNav, VaultView, ToolPanel).

Posture note: unusually well-hardened — session-keyed streaming, tombstoned deletes, generation-guarded loads, capped histories, buffer-ownership guards are implemented and commented. Only these survived verification.

## P0

none

## P1

**1. Vault note-switch drops keystrokes typed during the open/restore IPC window (data loss) — state/vault.ts:477-481, 510-517 (openNote); 952-973 (restoreSnapshot); 634-640 (closeNoteTab); 603-605 (saveNow).**
`openNote` flushes pending edits only once, and only when a debounce timer is armed (`if (saveTimer) { clearTimeout(saveTimer); await get().saveNow(); }`), then awaits resolveNotePath (a full vault text search, :484) and vaultReadNote (:510) before overwriting the buffer (:517). The editor arms the timer on every keystroke (VaultView.tsx:436-437), so any keystroke landing *during* those awaits is armed against the OLD note — then :517 replaces content, and the straggler timer no-ops in saveNow (`if (!activePath || content === savedContent) return;`, :605) because activePath now names the NEW note whose content === savedContent. The typed text is nowhere — not on disk, not in the buffer. Same one-shot flush + await + overwrite in restoreSnapshot (flush 952-956, read 969, overwrite 973) and closeNoteTab's fire-and-forget saveNow (634-638). The `if (saveTimer)` gate also skips the flush entirely after a *failed* save (saveNow's catch only toasts, :611-613): switching notes without typing again silently abandons edits that never reached disk. Fix: dirty-check flush immediately before each buffer switch (`if (get().activePath && get().content !== get().savedContent) await get().saveNow();` before the activePath set in openNote/:498 and restoreSnapshot/:963 — saveNow pairs the still-old activePath with the latest content); re-arm the timer in saveNow's catch.

**2. Chat terminal events carry no turn-epoch guard — a cancelled turn's late `chat:error` wipes the replacement turn's live streaming state — streamingSlice.ts:832-873 (onError), :563 (onToken); triggers at composerSlice.ts:45-58 (steerQueuedMessage) and streamingSlice.ts:81-84 (silent-turn auto-cancel).**
`onError` clears the session's streaming state unconditionally. The codebase itself documents cancels emitting terminal events asynchronously (moduleState.ts:902-904). `steerQueuedMessage` awaits the full cancelStream (incl. 200-row refetch) then immediately sendMessage(...) re-creates `streaming[id] = ""` — for harness/ACP sessions the cancel is a process kill whose death-driven chat:error can land hundreds of ms later, AFTER the replacement entry exists. onError deletes it, flashes an error banner for a turn that didn't fail, and every subsequent token of the live steered turn is dropped by onToken's guard (`if (!(chatSessionId in get().streaming)) return;`) until onDone's refetch. Same in sendMessage's auto-cancel of a silent pre-token turn and send-again-right-after-stop. Fix: per-session monotonic turn epoch (bumped when the entry is created, carried in a Record, cleared with the entry); onError/onDone ignore terminal events older than the current entry's epoch (or timestamp the entry at creation and compare).

## P2

**3. `loadGraph` has no error handling — every call site `void`, stuck graph overlay — state/vault.ts:888-892; call sites 896, 937, 998.**
The only loader in the store without `.catch`; `vaultGraph` is a raw safeInvoke that rejects on IPC/backend failure. A failed load leaves `graph: null` while `graphOpen: true`, rejection unhandled. Sibling loaders all catch (vaultTree().catch(() => []) etc.). Fix: `.catch(() => [null, null])` + early return.

**4. Subagent `runs` map grows without bound for the app's lifetime — state/subagents.ts:169, 245-252.**
Two merge-only writers (ingestRun fires per parent-less chat:session-spawn; loadRuns merges history pages), no eviction or cap — the class the codebase caps everywhere else (MESH_MAIL_RECORDS_CAP, MAX_ARTIFACTS_PER_SESSION, MAX_ITEMS, MAX_CLIENT_TIMELINE, DOC_QA_CAP). Fix: docQa pattern — delete-then-set, evict oldest past ~200.

**5. Verbatim-duplicated send-failure reset blocks in the streaming slice (DRY) — streamingSlice.ts:253-268 and 297-312 (byte-identical except the log tag), third near-copy at 386-392.**
Both copies' unconditional `streamingChatSessionId: null` also contradicts the conditional contract in clearStreamState (moduleState.ts:886) — currently harmless (no component gates on the scalar; ChatView.tsx:346-350 reads the map) but it defeats the tested conditional. Fix: extract `resetFailedSend(get, set, id, err)` next to clearStreamState; derive the scalar via the same `=== id ? null : keep` rule.

Notable non-findings: sessions-list relist stale-snapshot races self-heal on next relist; paneTree split/remove/promote preserve the one-main/one-pane-per-session invariants; mergeOptimistic's twin matching, tombstoned deletes, buffer-ownership guards correct as documented.
