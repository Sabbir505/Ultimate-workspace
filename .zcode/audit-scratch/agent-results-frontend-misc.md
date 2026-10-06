# Agent findings: frontend misc components (60 files)
# Status: COMPLETE — verified result captured 2026-10-03

FILES COVERED: all 60 files in the 13 scoped directories (automations/ 3, sidebar/ 6, subagents/ 6, onboarding/ 11, common/ 11, skills-library/ 1, wiki/ 2, logs/ 2, command-palette/ 1, pet/ 5, cost-dashboard/ 9, peek/ 1, hotkey-overlay/ 1), each read in full; cross-checked against state stores, useLlmLogs/useCostRollups/useOcclusion, ipcCore.ts (safeInvoke rejects on backend errors — underpins several findings), App.tsx.

## P0 / P1

none

## P2

**1. Skills: opening a skill whose read fails leaves the previous skill's body editable under the new slug (file-corruption path) — skills-library/SkillsLibrary.tsx:352-360.**
`setSelected(item)` switches BEFORE the read; `readInstalledSkill` (safeInvoke) rejects on a deleted/locked SKILL.md (the panel itself documents external mutation — it re-scans on window focus :324-340): unhandled rejection, setContent never runs, editor header shows `/new-slug` while the textarea holds the previous skill's body. Save then writes the old body over the new skill's file. Fix: try/catch, clear content + toast on failure.

**2. LocalModelModal: "Browse the Model Market" leaves its own blocking overlay up over the destination — onboarding/LocalModelModal.tsx:69-74.**
`openMarket` navigates to settings/market but never dismisses; the component is mounted unconditionally at App level (App.tsx:486) so the full-screen modal-overlay keeps covering the view it navigated to. Sibling StepAgents.tsx:48-57 does it right (closeOnboardingForDeepLink before navigating). Fix: dismiss in openMarket.

**3. Skills: template save has an unhandled rejection and a partial-failure duplicate path — SkillsLibrary.tsx:652-666 (void save() at :756).**
`create` then `createInstalledSkill` both reject; if the DB template is created but the harness-dir install fails: unhandled rejection, no feedback, reset() skipped — the form looks unsent and clicking Create again inserts a duplicate row. Also :706 `void remove(skill.id)` rejects unhandled. Fix: try/catch + toastError; treat disk-install failure as non-fatal for reset.

**4. Skills: Gallery panel load has no catch — stuck "Loading the gallery…" forever — SkillsLibrary.tsx:134-135.**
`?? []` only covers non-Tauri null; safeInvoke rejects on backend error → entries stays [], UI renders the loading empty-state permanently, no retry. Fix: error state + retry button (pattern the installed panel's installFromUrl already uses).

**5. Automations: store `load()` rejects unhandled — silent empty view on boot, dead Refresh button — AutomationsView.tsx:324, :401; state/automations.ts:41-44.**
On IPC/DB failure: unhandled rejection, `loaded` never true, view renders empty list with no error surface; header Refresh silently does nothing; `update`'s await load() surfaces a save error even when the save succeeded. state/subagents.ts:110-119 handles this correctly. Fix: catch in the store, set an error field the view renders.

**6. Logs list: unvirtualized rows re-rendered wholesale on every append-driven refresh — logs/LogsView.tsx:219 + hooks/useLlmLogs.ts:57.**
useLlmLogs replaces the whole array per debounced llm-log:appended (1.2s) — during a local-model tool loop this re-renders all mounted row buttons every ~1.2s; "Load older" grows the DOM 200 rows/click, no windowing. Peers are virtualized (Sidebar.tsx:394-404, AutomationRunTable.tsx:224-233, ArtifactLibrary.tsx:333-338 — all @tanstack/react-virtual). Fix: useVirtualizer or at minimum memo the row.

**7. ProjectSettingsPanel: unhandled rejections on every quick-action/secret mutation + optimistic deletes with no rollback — sidebar/ProjectSettingsPanel.tsx:57-90, 120, 131-134, 186-189.**
createQuickAction/updateQuickAction/setSecret/deleteSecret/deleteQuickAction all safeInvoke; `void`-ed callers leave rejections unhandled with zero feedback; deletes remove the row immediately so a failed delete leaves UI showing a row that still exists backend-side. Fix: try/catch + toastError; re-list or roll back on delete failure.

**8. LogsView: three unhandled rejection paths — LogsView.tsx:80, 175, 193.**
`gatewayStatus().then(...)` no .catch; `llmLogPrune().finally(...)` / `llmLogClear().finally(...)` — .finally does not absorb rejections, so a failed Prune/Clear is an unhandled rejection with no feedback. Fix: .catch writing to the existing logs-error banner.

**9. Windows paths shown whole as the chat's folder label (primary platform) — sidebar/Sidebar.tsx:361 and ProjectsSidebar.tsx:93.**
`overridePath.split(/[\/]/)` never splits backslash; Windows folder-picker paths persist verbatim, so every Windows chat with a folder override shows the full path as the row label. Own equivalents handle both separators (AutomationsView.tsx:951, LogDetail.tsx:52). Fix: `split(/[\\/]/)`.

**10. CommandPalette: "Add Project" chain has no catch — command-palette/CommandPalette.tsx:221-223.**
If the dialog or addProjectAtPath rejects, no feedback at all. Fix: `.catch((e) => toastError(...))` — toastError already imported.

**11. AutomationDetail: runs fetch has no stale guard — quick A→B switch renders A's run history — AutomationsView.tsx:763-786.**
No cancelled/token guard (contrast the sibling webhook effect :749-756 and PeekPanel.tsx:37-90 which guard the same shape). A's in-flight response resolves last and populates B's "Past runs" until the next 5s tick. Fix: request-token guard keyed on automation.id.

**12. AutomationForm: model select keeps a stale model id while the UI shows no selection — AutomationsView.tsx:1503, 1395.**
When the stored model isn't among availableModels (deleted GGUF, changed catalog), the select renders blank but `model` state holds the stale id and save() sends it — the automation keeps firing on a nonexistent model. SubagentsPanel.tsx:648 solves this exact case. Fix: same normalization.

**13. DRY: Sidebar and ProjectsSidebar duplicate ~120 lines of identical chat-row wiring — Sidebar.tsx:284-339 vs ProjectsSidebar.tsx:131-182.**
Same eight handlers + identical branch/folderName derivation; concretely harmful — the Windows path bug (#9) existed twice because of it. Fix: extract useChatRowActions() + shared sessionRowContext().

Checked and sound: AutomationRunTable hook ordering; cron preset/parse/build round-trip (keepOriginalCron guards unrepresentable crons); formatNextFire Date mutation harmless; subagents store absorbs mutation errors; WelcomeWizard STEPS bounds; all IPC listeners/intervals/rAF loops cleaned up or keyed to open state.
