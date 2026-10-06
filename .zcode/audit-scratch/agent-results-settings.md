# Agent findings: settings panels (30 files)
# Status: COMPLETE — verified result captured 2026-10-02 19:33

FILES COVERED: all 30 .ts/.tsx under src/components/settings/ — AcpAgentsPanel, ApiKeysPanel, ConnectorIcon, ConnectorsPanel, DataPanel, FontSettingsPanel, GitPanel, HooksPanel, ImageGenPanel, ImprovementsPanel, KnowledgePanel, LocalModelsPanel, LogGatewayPanel, McpGalleryPanel, MemoryPanel, MeshPanel, ModelDownloadIndicator, ModelMarket, PermissionRulesPanel, RemotePanel, ServerBuildsCard, SettingsView, SidebarArtPanel, SttPanel, SubagentModelPanel, ThemeGalleryPanel, ToggleSwitch, TtsPanel, WallpaperPanel, WikiPanel. Cross-verified against state/settings.ts, configSlice.ts, and Rust (api_keys.rs, memory/worker.rs, chat/tools/search.rs).

## P0

**1. Search-engine API keys stored in plaintext settings DB instead of the OS keychain — SettingsView.tsx:908-917.**
`setKey` persists provider keys via the generic KV store: `void setSetting(\`search.${id}_key\`, value)`; the backend reads them straight from the plaintext SQLite app_settings table (chat/tools/search.rs:557 `get_setting(conn, &format!("search.{known}_key"))`). Every other secret deliberately uses the OS keychain — chat API keys (`secrets::set_chat_api_key`, api_keys.rs:67, "The key value is NEVER returnable via any IPC command"), the GitHub PAT ("goes to the OS keychain", GitPanel.tsx:245-246), the HF token. Serper/Tavily/Brave keys are billing-grade secrets and are the only ones left on disk in cleartext. Fix: add a `search.<provider>` entry type to secrets.rs mirroring set_chat_api_key/has_chat_api_key; expose only a boolean "configured".

## P1

**2. Memory extraction-model pick persisted without the `provider::` prefix — silently lost / applied to the wrong provider — MemoryPanel.tsx:279-282 (write) and :118-127 (read).**
`changeExtractModel` debounces into `persistExtractModel` which stores the bare model id; the read path and backend require `provider::model` (worker.rs:73-76 `raw.split_once("::")` — a bare id becomes "same provider as the session"). Trigger: pick a Cloud API agent + model → `memory.extractModel` = `gpt-4o-mini`; any subsequent `refresh()` resets the UI to "Chat model (automatic)" while the backend keeps applying the bare id against the session's provider — the choice silently does nothing or sends the wrong model to the wrong API. The sibling SubagentModelPanel does it correctly (:142). Fix: persist `` `${extractAgent}::${value.trim()}` `` matching `applyExtractOverride`.

**3. Commit-message model list never releases its loading state on failure — input disabled forever — GitPanel.tsx:120-137.**
No `.catch` on `listChatModels(cmProvider).then(...)`; `list_chat_models` rejects routinely ("no API key configured for provider: openrouter", api_keys.rs:310). The rejection is unhandled, `setCmModelsLoading(false)` never runs, and the fallback input renders `disabled={cmModelsLoading}` with placeholder "Loading models…" (:209-215) permanently — no model can be set for that provider at all. Fix: `.catch(() => { if (!stale) setCmModels([]); })` + `finally` behind the stale guard.

**4. Assistant system-prompt save has no failure path — status pill stuck on "Saving…" forever — SettingsView.tsx:734-741.**
`void setSetting(K_SYSTEM_PROMPT, systemPrompt).then(() => setSaveState("saved"))` — on rejection the pill shows "Saving…" indefinitely, no retry. Secondary: an older write resolving late calls setSaveState("saved") over a fresh "dirty" state (no currency check). Fix: `.catch(() => setSaveState("dirty"))` (or error pill with retry); transition to "saved" only when the persisted value is still current.

**5. Unrelated download completions toast "Speech model installed" / "Embedding model installed" — SttPanel.tsx:50-54 and KnowledgePanel.tsx:201-204.**
The shared progress stream carries every download in the app. ImageGenPanel guards against this (ImageGenPanel.tsx:131-141, filtered via imageDownloadIdsRef) and TtsPanel filters (`if (!p.id.startsWith("tts/")) return;`, TtsPanel.tsx:121) — SttPanel and KnowledgePanel do not. Trigger: start a multi-GB GGUF download from Model Market, open STT/Knowledge settings; on finish, a false "Speech model installed" toast + pointless refresh. Fix: gate on id whitelist as ImageGen/Tts do.

## P2

**6. HF token save/clear and models-dir pick have no error handling — silent dead clicks — ModelMarket.tsx:256-280.**
`onSaveToken`/`onClearToken`/`onPickDir` invoked as `void …()` with no try/catch; keychain failure or dialog rejection = unhandled rejection, zero UI feedback, input keeps the typed token. Neighboring panels toast on the same ops. Fix: try/catch + toastError, mirror disabled state.

**7. Success message shares the error slot and renders with an unrelated action — ApiKeysPanel.tsx:263 + 565-569.**
`setFetchError("Saved successfully!")` renders inside the fetch-failure block, always attaching the "Use manual input" button (which also wipes the fetched model list). Fix: separate saveOk/feedback-kind state.

**8. Base URL saved untrimmed and unvalidated — ApiKeysPanel.tsx:255 + 554.**
`canSave` only trims for validation, so `" https://api.example.com/v1 "` or `api.example.com/v1` (no scheme) is accepted silently and consumed verbatim by list_chat_models (api_keys.rs:288-289) and the send path → cryptic HTTP/URL-parse failures later. Fix: trim before save + minimal URL/scheme check with inline feedback.

**9. Optimistic settings writes with no revert on failure — UI shows a state the backend didn't accept — 6 verified sites.**
MeshPanel.tsx:22-26 (toggle — on rejection the switch shows Off while Rust keeps mesh enabled); ImprovementsPanel.tsx:202-209 (changeTier never reverts); KnowledgePanel.tsx:334-351 (handleToggleRerank leaves the checkbox flipped after an error note); LogGatewayPanel.tsx:80/89/104/121/168/179 (`void llmLogConfigSet(...).then(...)` no catch); LocalModelsPanel.tsx:842-846 (two setSettings unguarded on onBlur); DataPanel.tsx:144-159 (pickArtifactsDir/resetArtifactsDir unguarded). MemoryPanel.tsx:218-227 has the correct revert-on-catch pattern. Fix: apply it (or a shared persistWithRollback helper).

**10. Extraction leftovers: ~25 dead imports per panel, orphaned comment blocks, duplicate category, dead cache — ApiKeysPanel.tsx:3-52, GitPanel.tsx:3-51+288-297, DataPanel.tsx:3-52, ConnectorsPanel.tsx:3-51, SettingsView.tsx:122-167, ModelMarket.tsx:40-44.**
Four panels import the identical ~25-symbol block from ../../lib/ipc of which nearly none are used in that file (copied wholesale when panels were extracted). GitPanel/ConnectorsPanel carry trailing comment blocks describing OTHER panels. SettingsView lists "subagents" twice in both the Category union and CATEGORY_KEYS (:126-129, :150-153). ModelMarket's `fileSizeCache` (:44) is never read or written (the real logic lives in KnowledgePanel.tsx:160). Fix: delete unused imports (enabling noUnusedLocals would prevent regression), dedupe categories, remove the dead cache.

Deliberately not reported: LocalModelsPanel folder persist→rescan ordering (theoretical race, SQLite write lands orders of magnitude faster than the scan); compaction number-input Number("") behavior (standard controlled-input with in-range finals accepted); WikiPanel is a model citizen (radix-parseInt, clamping, alive-guards, Enter-to-blur persistence).
