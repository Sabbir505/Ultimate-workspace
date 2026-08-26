## Glassmorphic Agent Composer — Redesign Plan

### Current state (from exploration)
The composer is a two-part assembly: `.chat-composer-card` (top-rounded glass card with textarea + footer) + a separate `.composer-context-meter-wrap` notch bar below it carrying AgentMenu / FolderNotch / GitHubNotch / ContextMeter, with a plain-text `ComposerMetrics` strip under that. "Select an agent to start" appears **3 times** (textarea placeholder, `composer-model-hint` badge, `model-chip-locked`). Metrics chips are plain text with inline dot + label + value.

### What I will change

**1. Copy cleanup (ChatComposer.tsx)**
- Textarea placeholder: locked state becomes `"Ask anything, or select an agent to customize performance…"` (the spec text). Unlocked state keeps the existing `"Write a message…  type / for skills"` so slash-skills discoverability isn't lost.
- Remove the redundant `composer-model-hint` "Select an agent to start" badge (line ~1218).
- Locked model chip becomes a single low-profile inline chip: `🔒 Model locked — pick agent` (existing `model-chip-locked` class, restyled).

**2. Control-bar integration (ChatComposer.tsx)**
- Move AgentMenu / FolderNotch / GitHubNotch out of the external `.composer-context-meter-wrap` into a new `.composer-control-bar` row **inside the composer card** (bottom-left): one horizontal toolbar of frosted-glass pill controls (Agent · Workspace · Branch), with a spacer on the right to keep pills left-aligned.
- Keep the ContextMeter: it stays near the send button (its circular ring lives in the send column today; I'll keep it hosted in a slim container below/next to the send button). No functionality removed.
- The old `.composer-context-meter-wrap` external bar is removed from the JSX since the controls move into the card.

**3. Telemetry HUD refactor (ComposerMetrics.tsx + composer.css)**
- Render the metrics strip **inside the composer card**, anchored to the card's bottom border as a dedicated HUD status bar.
- New structure: `IN OUT LLM TOOLS TTFT SPEED CACHE` chips in a monospace font with tabular numerals.
- 1px top border separation (rgba(255,255,255,0.05) in dark mode; mirrored rgba(0,0,0,0.08) in light mode for readability).
- Idle/empty chips render muted gray with `—` (IN —). Active/live chips switch to accent colors: cache hits → green (`--state-working`), speed/tokens → cyan (`--editor-bracket-match` / a token accent), live pulses retained.
- Add hover tooltips: each chip gets a `title`-style breakdown tooltip (e.g. CACHE → "42% of input tokens served from prompt cache", TOOLS → "Total tool execution time across the session", TTFT → "Avg time to first token"). Implemented as a lightweight custom tooltip panel on hover, consistent with the existing `.context-meter-tooltip` pattern.

**4. Glassmorphism design system (composer.css + tokens)**
- `.chat-composer-card`: upgrade to the glass recipe — `background: rgba(255,255,255,0.03)` (dark) / `rgba(0,0,0,0.03)` (light), `backdrop-filter: blur(16px)`, `border: 1px solid rgba(255,255,255,0.08)` / `rgba(0,0,0,0.08)`, `border-radius: 16px`, `box-shadow: 0 20px 40px rgba(0,0,0,0.4)`.
- Focus state: `:focus-within` brightens the border to `rgba(255,255,255,0.2)` (dark) and adds a soft ambient glow (`box-shadow` with accent-glow), respecting `prefers-reduced-motion`.
- Control pills: frosted `bg rgba(255,255,255,0.05)` → hover `rgba(255,255,255,0.1)` with a 1px inner border (rim), following the existing pill shape language (`border-radius: 999px`).
- Send CTA: keep the solid accent circle but boost visibility on the translucent body (existing `.composer-send-btn` accent fill, slightly brighter hover).
- Remove/supersede the now-unused external notch-bar CSS only if it has no other consumers (checked during implementation).

### Files touched
- `src/components/chat/ChatComposer.tsx` — copy cleanup, control bar, HUD placement
- `src/components/chat/ComposerMetrics.tsx` — HUD status bar + per-chip tooltips
- `src/styles/composer.css` — glass card, control bar pills, HUD strip, focus glow
- `src/styles/pickers.css` — `model-chip-locked` restyle (or move into composer.css)
- `src/test/composerHud.test.tsx` (new) — placeholder text, control bar presence, locked chip, HUD chips + tooltips render per state (idle placeholders vs live values), using the existing Testing Library patterns

### Verification
- TypeScript `--noEmit`, production build, targeted Vitest suite (new composer HUD tests + existing composer/chat tests if any), then full suite.
- Launch the Tauri dev app and screenshot the composer at desktop width to confirm the glass card, control bar, locked chip, and HUD strip render correctly in **dark** and **light** themes.

### Deliberate non-changes
- No Rust/IPC/state changes — this is purely presentational.
- AgentMenu, FolderNotch, GitHubNotch, ContextMeter components themselves are untouched; only their container changes.
- Slash `/`, attachments, research, permission mode, broadcast, voice, model/effort menus all keep their exact behavior/positioning semantics.