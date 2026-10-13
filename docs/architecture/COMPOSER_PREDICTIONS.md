# Composer Predictions — suggested next message in the composer

**Status:** Shipped (Unreleased, 2026-10-12). Living doc — update when the feature changes.
**Reference:** OpenAI's "Composer predictions in Codex" beta (2026-10-09): after a reply, a suggested next message appears in the composer; Tab accepts, nothing auto-sends, on by default with a settings toggle and a clear off switch.

## What it is

After the assistant finishes a reply **in the session the user is viewing**, Relay asks a model for the user's likely NEXT message and renders it as **ghost text over an empty composer**. Tab fills the draft with it (editable; Enter/Send is still the only way to send), Escape dismisses, typing just hides it. Suggestions are **ephemeral**: computed on demand, held in the renderer's memory, and never written to `chat_messages` or anywhere on disk.

## Trigger flow (one path, all engines)

1. Any engine's turn completion reaches the renderer as `chat:done` → `streamingSlice.onDone`.
2. At the tail of `onDone`, behind the same guard the goal loop uses — `messages !== null && activeChatSessionId === sid && !(sid in streaming) && !(sid in messageQueue)` — and with `useSettingsStore.getState().composerPredictions` on, the renderer fires `generate_chat_suggestion(sid)` **fire-and-forget**. The goal-loop advance suppresses the call (`goalAdvanced`), since a loop turn immediately starts the next one.
3. The `.then` drops stale results by comparing the captured `turnGeneration[sid]` and re-checking the active session + streaming state.
4. The backend returns `string | null` — `null` for every skip (feature off, nothing reachable, empty generation). There is no event, no error surface, and no retry.
5. The result lands in `composerSuggestions[sid]` (composerSlice). Cleared on send, cancel, error, turn completion (before regeneration), session delete, and delete-all — see `clearSessionState`.

Background/automation turns produce no predictions: the active-session guard means only the chat on screen generates one. In split view that is the **focused** pane's session — a pinned but unfocused pane doesn't predict until it becomes active (see Non-goals).

## Model resolution and family dispatch (`src-tauri/src/chat/suggestion.rs`)

**Default (no override): the active chat's own model/agent.** The session row's `provider`/`model` are used as-is; `provider == "auto"` or `auto_model` sessions resolve through the auto router (`resolve_auto_session_pick`) exactly like `/create` does.

**Override:** `composer.predictionsModel` — `""` = default, else `provider::model` with the `chat.subagentModel` pick syntax (`SubagentModelPick`). The provider half may name any family:

| Family | Provider form | Dispatch | Reachability gate |
|---|---|---|---|
| API | `anthropic`, `openai`, `openrouter`, `*_compatible`, `openai_chat`, `openai_responses` (instance ids ok) | `llm_client::oneshot` (HTTP, non-streaming) | provider key via `secrets::get_chat_api_key`; base from `chat.<provider>.base_url` with the usual managed defaults |
| Local | `local_gguf` | `llm_client::oneshot` against llama-server | a **live** sidecar (`LocalModelState.status()`); the wire model goes through `local_models::resolve_request_model` |
| Harness | `harness:<id>` (session rows) or an engine id in a pick (`claude_code::sonnet`; `kimi_code` accepted) | `agent_sessions::harness_oneshot_text` (one CLI process per prediction) | CLI installed/spawnable; failures are silent |
| ACP | `acp:*` | — | **Unsupported** — no one-shot path exists (same exclusion `/create` and memory extraction make); skipped silently |

Prompts: a system line ("predict the user's next message; reply with ONLY the message text…") + the last ≤8 non-superseded user/assistant messages (≤600 chars each, ≤6k total) from `list_active_chat_messages`; at least one assistant reply is required. Output: max ~96 tokens (the OpenAI-family wire gained an optional `max_tokens` in `llm_client` for this), then **sanitized** — think-blocks stripped, code fence unwrapped, first paragraph only, quotes/labels removed, collapsed to one line, capped at 400 chars; empty → `None`.

In-flight dedupe is per session (module-level set), so a double-triggered `onDone` can't spend tokens twice.

## UI behavior and key precedence

The ghost renders inside `.composer-slash-wrap` (absolute overlay mirroring the textarea's zoom-scaled typography) only while: a suggestion exists, the feature is on, the draft is **empty**, neither the `/` nor `@` menu is open, no turn is streaming, the textarea isn't disabled, no command pill / attach chips are present, and no ↑/↓ recall walk is active. Placeholder is blanked while it shows.

Keydown precedence in `handleKeyDown` (`ChatComposer.tsx`): IME guard → slash menu → @ menu → **Tab accepts the ghost** (Shift+Tab unaffected) → **Escape dismisses the ghost** → Backspace/pill → Enter send → Escape stop-turn → ↑/↓ recall. Consequences: an open menu always keeps Tab; Enter is never repurposed; recalled history text is never swapped for a suggestion.

## Settings

Settings → General → **Composer** (`ComposerPanel.tsx`):

- `composer.predictions` — default **ON**; only the literal `"false"` disables (the `checkpoints.enabled` convention; the backend gate reads the same key the same way).
- `composer.predictionsModel` — `""` = follow the active chat model; the picker lists the `AGENT_OPTIONS` groups (harness / API / local; ACP deliberately absent), fetching catalogs via `listHarnessModels` / `listChatModels` / `scanLocalModels`.

When an override points at another provider, the chat's transcript tail is sent there to write the suggestion — the panel states this, and it is the same data the chat itself already sends to a model.

## Files

| File | Role |
|---|---|
| `src-tauri/src/chat/suggestion.rs` | generation, pick resolution, family dispatch, sanitize, transcript builder, unit tests |
| `src-tauri/src/chat/llm_client.rs` | `oneshot`/`openai_oneshot` gained optional `max_tokens` (OpenAI family) |
| `src-tauri/src/chat/commands/generators.rs` | `generate_chat_suggestion` command (registered in `lib.rs`) |
| `src/state/chat/slices/composerSlice.ts`, `types.ts`, `index.ts`, `moduleState.ts` | `composerSuggestions` map + setter; cleared with the session |
| `src/state/chat/slices/streamingSlice.ts` | trigger at `onDone` tail + clears on send/cancel/error/done |
| `src/state/settings.ts` | `composerPredictions`, `composerPredictionsModel` (load/parse/persist) |
| `src/components/chat/ChatComposer.tsx` | ghost overlay, Tab/Escape handling, placeholder |
| `src/styles/composer.css` | `.composer-ghost` overlay styles |
| `src/components/settings/ComposerPanel.tsx` + `SettingsView.tsx` | the Composer settings category |
| `src/test/composerPredictions.test.tsx`, `src/test/composerPredictionTrigger.test.ts` | ghost render/Tab/Escape/hide/menu-precedence/recall guards; trigger guards (eligibility, feature-off, background session, automation source, stale-drop) |

## Tests & verification

- Rust unit tests (`cargo test --lib chat::suggestion`): sanitize (quotes/fences/labels/think/one-line/cap), transcript windowing (+ assistant requirement), family mapping.
- Frontend (`composerPredictions.test.tsx`): ghost only over an empty draft; Tab fills + clears + never sends; Escape dismisses; typing hides and re-shows on an emptied box; the slash menu keeps Tab; ↑ recall is untouched; feature toggle hides everything. Trigger guards (`composerPredictionTrigger.test.ts`): per-turn call in the viewed session, silence for feature-off / non-viewed sessions, rejection swallowed, and a late result dropped once a new turn bumps the generation.
- CI gates: `npx tsc --noEmit`, `npm test`, `cargo clippy -D warnings`, `cargo test --lib`.

## Non-goals (documented follow-ups)

- **Mobile parity** — the phone composer has no per-session drafts and no settings bridge; a relay op + local state would be needed.
- **Background predictions** — only the visible session predicts; no pre-computation for returning to a chat.
- **Split-pane predictions for the unfocused pane** — the trigger rides the active-session guard; the pinned pane predicts once focused (its own turn's `onDone` while active).
- **Accepting by any other key** — Tab only, matching the reference feature.
