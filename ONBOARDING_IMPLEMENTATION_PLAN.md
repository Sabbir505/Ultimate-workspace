# First-Run Onboarding Wizard — Implementation Plan

Status: proposal · 2026-09-12
Scope: desktop app (`src/`) only. Mobile pairing is already its own implicit first-run flow.

## 1. Problem

A first-launch user today lands directly in the chat view and encounters four *unrelated* nudges that each assume context they don't have:

| Surface | Trigger | Gap |
|---|---|---|
| `OnboardingBanner` | zero agent-harness CLIs on PATH (`src/components/onboarding/OnboardingBanner.tsx`) | session-only dismissal, no key setup, no theme, no intro |
| `LocalModelModal` | `localModels.onboarded` unset **and** zero GGUF models (`LocalModelModal.tsx`) | fires independently, can stack with the banner |
| `ChatWelcome` | empty chat (`ChatWelcome.tsx`) | starter chips, but a chip click with no configured model just prefills — dead end for a newcomer |
| git-init prompt | adding a non-git project (`App.tsx:572`) | fine, but arrives with zero framing |

There is **no first-run flag anywhere** (verified: only `localModels.onboarded`, `worktrees.nudgeSeen`, `localModels.infoDismissed` exist as one-off KV flags). PRD §9 ("Onboarding / Setup Checks") covers only harness detection; §4.1 covers first-launch project flow. Neither defines a welcome wizard.

## 2. Goal

A single skippable **welcome wizard** on true first launch that, in ≤ 4 short steps: introduces the product, sets a chat model (cloud key **or** local model **or** "later"), checks agent harnesses, and picks a theme — then lands the user in a working chat. Existing users upgrading must never see it.

Non-goals: forced sequence (every step skippable), account creation, mobile onboarding, interactive coach-marks over the running UI (possible follow-up).

## 3. Verified integration points (all exist, no backend changes)

| Need | Existing mechanism |
|---|---|
| First-run flag | KV settings: `getSetting`/`setSetting` (`src/lib/ipc.ts:407`) — add `onboarding.completed`. Precedent: `localModels.onboarded` (`LocalModelModal.tsx:28,52`) |
| Boot gate | `App.tsx:205–214`: `settings.load()` → `projects.loadAll()` chain; wizard init runs after both resolve |
| Save API key | chat store `saveApiKey(provider, key, baseUrl, model)` (`src/state/chat.ts:2885`) → `set_chat_api_key` → OS keychain (`src-tauri/src/secrets.rs`) |
| Validate key live | `listChatModels(provider, baseUrl?, apiKey?)` (`src/lib/ipc/chatSessions.ts:367`) hits the provider's models API |
| "Has key?" probe | `getChatConfig(provider)` → `{ hasKey }` (`chatSessions.ts:96–102`) |
| Default model | `setChatDefaultModel(provider, model)` (`chatSessions.ts:353`) |
| Providers list | `CLOUD_PROVIDER_IDS` (`src/lib/agents.ts:34`) + labels from `ApiKeysPanel.PROVIDERS` (hoist to shared lib) |
| Harness status | `useProjectsStore.harnesses: HarnessStatus[] {id, displayName, installed}` (`src/types.ts:26–30`); re-scan `refreshHarnesses(true)` (`projects.ts:88`) |
| Local model path | deep-link exactly like `LocalModelModal`: `setSettingsCategory("localmodels") + setLocalModelsOpenMarket(true) + setActiveView("settings")` (ui.ts:450–451); GPU info via `getGpuVram()` |
| Theme | `useSettingsStore.setTheme("light"\|"dark"\|"system")` (settings.ts:419) |
| Overlay pattern | lazy overlay like SettingsView (`App.tsx:76,530`); styling per `.view-overlay.modal-centered` (`overlays.css:11–57`) + glass tokens (`tokens.css`) |
| Native-webview occlusion | `useOcclusion("app:onboarding", open)` — every modal registers its own id (App.tsx:286–287, M22 rule) |
| Re-entry | Command palette: new `action:replay-onboarding` beside `action:open-settings` (`CommandPalette.tsx:101–151`); plus a "Replay welcome" row in Settings → Data |
| Tests | vitest + testing-library; mock shape per `src/test/apiKeysPanel.test.tsx` (must enumerate every symbol imported from `../lib/ipc`) |

## 4. Design

Full-window overlay (not the small `Modal` — a wizard needs a step rail and custom footer). Glass card centered on a dimmed backdrop, consistent with the Settings overlay; entry animation per `motion.css`. Progress dots + step title. Footer: `Back` (ghost) · `Skip` (ghost, always) · `Continue` (primary).

```
┌────────────────────────────────────────────────────────┐
│  ◆ RELAY                                               │
│                                                        │
│   [step content: 1 of 4]          ● ○ ○ ○             │
│                                                        │
│                        Back   Skip   Continue →        │
└────────────────────────────────────────────────────────┘
```

**Steps**
1. **Welcome** — logo, one-liner ("Relay wraps the agent CLIs you already use…"), 3 feature tiles (agent panes / built-in chat / local models). Theme segmented control (light / dark / system) applied live via `setTheme`.
2. **Chat model** — two cards: *Cloud* (provider `GlassSelect` + API key input + "Verify & save" → `listChatModels` live check → `saveApiKey`; success shows fetched model count, offers `setChatDefaultModel`) or *Local model* (shows `getGpuVram()` result when available; CTA deep-links to the model market). *I'll do this later* link.
3. **Agent harnesses** — table of `harnesses` with ✓ installed / install command (copy button) per CLI; `Re-scan` calls `refreshHarnesses(true)`; deep-link to Settings → Harnesses. Purely informational — never blocking (PRD §9 rule).
4. **Done** — "Add your first project" CTA (opens the existing project picker) + pointers to Connectors and Mobile pairing (no flows inside the wizard). Continue closes.

Completion writes `onboarding.completed = "1"`; if the user saw/skipped step 2's local card also write `localModels.onboarded = "1"` so `LocalModelModal` doesn't fire right after.

## 5. Files

| File | Change |
|---|---|
| `src/state/onboarding.ts` | **new** — store: `{loaded, visible, step, completed}`; `init()` reads the flag and decides visibility; `next()/back()/skip()/complete()` |
| `src/components/onboarding/WelcomeWizard.tsx` | **new** — overlay shell (portal, focus trap, Escape = Skip, occlusion registration, step renderer) |
| `src/components/onboarding/steps/StepWelcome.tsx`, `StepChatModel.tsx`, `StepHarnesses.tsx`, `StepFinish.tsx` | **new** |
| `src/styles/onboarding.css` | **new** — appended at the END of the `global.css` aggregator (its documented rule) |
| `src/App.tsx` | lazy-mount `<WelcomeWizard />` in the main branch only (popout branch must never render it); call `initOnboarding()` after the settings→projects boot chain (~line 214) |
| `src/components/settings/ApiKeysPanel.tsx` | hoist `PROVIDERS` metadata to `src/lib/agents.ts` (shared, no behavior change) |
| `src/components/onboarding/LocalModelModal.tsx` | guard: no-op while the wizard is visible |
| `src/components/command-palette/CommandPalette.tsx` | add `action:replay-onboarding` (~line 151) |
| `src/components/settings/DataPanel.tsx` | "Replay welcome" row (calls `open()`) |
| `src/test/welcomeWizard.test.tsx` | **new** — see §7 |
| `AI CONTEXT/PRD.md` §9 | extend with the wizard spec (canon doc) |

## 6. Phases

**Phase 1 — Foundation (≈ ½ day).** Store + flag + gating + empty overlay + occlusion + `LocalModelModal` guard. Gating rules (the correctness-critical part):
- Show only when `onboarding.completed` is unset **and** this is a genuine first run: if `projects.length > 0 || sessions.length > 0` at init (upgrading user), silently write `onboarding.completed = "1"` and never show. Without this, every existing install sees the wizard once after update.
- Wait for `settings.load()` **and** `projects.loadAll()` before deciding — otherwise the wizard flashes on every launch while stores load.
- Never render in the `?popout=chat` window (App.tsx:296 early-return).

**Phase 2 — Steps 1–2 (≈ 1 day).** Welcome/theme + chat-model step (cloud verify/save via existing IPC; local deep-link). Reuses `GlassSelect`.

**Phase 3 — Steps 3–4 (≈ 1 day).** Harness table + finish step + completion flag write-through (`onboarding.completed`, conditional `localModels.onboarded`).

**Phase 4 — Re-entry + polish (≈ ½ day).** Command-palette action, Settings → Data replay row, PRD §9 edit, motion/accessibility pass (focus trap, aria), banner tuning: keep `OnboardingBanner` as the *recurring* nag only when the wizard finished with zero harnesses — it already only renders in that case; make its dismissal session-scoped as today.

Total ≈ 3 days.

## 7. Tests

`src/test/welcomeWizard.test.tsx` (vitest + testing-library, mock pattern from `apiKeysPanel.test.tsx`):
1. Gate: renders when flag unset + fresh profile; suppressed + flag auto-written when projects/sessions exist; never in popout mode.
2. Theme step applies `setTheme` immediately.
3. Cloud card: verify calls `listChatModels`, save calls `saveApiKey`, failure shows inline error without advancing.
4. Harness step: renders `installed` states; Re-scan calls `refreshHarnesses(true)`.
5. Completion: writes `onboarding.completed` (and `localModels.onboarded` when step 2 was seen); `Skip` writes the flag too (never re-nags).
6. `LocalModelModal` stays hidden while wizard is visible.

Verification commands: `npx tsc --noEmit` · `npm test` · manual `npm run tauri dev` with the replay command (no profile wipe needed).

## 8. Risks

- **Upgrade flash** — mitigated by the projects/sessions heuristic in Phase 1 (most important correctness detail).
- **Entry-bundle bloat** — wizard is lazy-loaded like Settings; step components load with it.
- **Double-modal on first run** — `LocalModelModal` guard + write-through flag.
- **Escape-to-close losing users permanently** — Escape/Skip both persist the flag, but the command-palette replay keeps it discoverable.
