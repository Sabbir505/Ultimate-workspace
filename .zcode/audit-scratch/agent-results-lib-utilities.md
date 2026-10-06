# Agent findings: frontend lib utilities (~60 files)
# Status: COMPLETE — verified result captured 2026-10-02 19:07

FILES COVERED: src/lib/*.ts (all except tts*/voice*/sound/ipc* per scope split) + lib/docdesign/* + lib/pets/*. Verification notes: DOMPurify 3.4.13 supports `HTML_INTEGRATION_POINTS` (checked node_modules) so the foreignObject config is correct; mermaid 11.17.2 `useMaxWidth:true` emits width="100%" with no height attr, so diagramExport's viewBox fallback fires correctly (suspicion disproven, not reported).

## P0

none — no script-execution, app-crash, or data-loss path. compilePdfHtml/compileDeck escape or JSON-stringify all model text; docdesign compilers emit only token-driven layout code; theme values applied via style.setProperty (whitelisted keys, inert as custom-property values).

## P1

**1. sanitize.ts:154 — the `position:` neutralizer misses the first declaration of an inline style attribute, defeating the main-window overlay guard (90%).**
```ts
.replace(/([;{\s"'])position\s*:/gi, "$1refused-position:")
```
`neutralizeMainDocCss` is applied to the *extracted* style-attribute value (L133-137), so when `position` is the first declaration there is no preceding `[;{\s"']` char and the regex never matches. Verified: `"position:fixed;inset:0".replace(...)` is a no-op; `"a;position:fixed"` is mangled. Trigger: MermaidDiagram.tsx:96-102 runs mermaid at `securityLevel:"antiscript"` (label HTML reaches the DOM with inline handlers/styles intact per its own comment); model-authored labels like `A["<div style='position:fixed;top:0;left:0;width:100vw;height:100vh;background:#000;z-index:99999'>…</div>"]` survive DOMPurify (style allowed in SVG/HTML profiles) and land in the **privileged main window** via dangerouslySetInnerHTML (MermaidDiagram.tsx:587). The mangled-CSS layer exists precisely to stop "position:fixed/absolute overlays can redress the entire UI" (sanitize.ts:116-118) — a prompt-injected diagram can paint a full-screen overlay/clickjack cover over the whole app. The `behavior` rule on the next line uses `\b` (works at index 0) — the inconsistency confirms the anchoring bug. Fix: `/(^|[{;,\s])position\s*:/gi` (or `\bposition\s*:` with a background-position guard) + regression test.

**2. irDoc.ts:179-192 — table cells never validated as strings; a numeric cell crashes PDF compilation (88%).**
The validator only stringifies for the length check (`String(cell ?? "").length > 90`) then stores raw rows (`rows as string[][]`). Downstream compilePdfHtml.ts:19-24 `esc = (s: string) => s.replace(...)` called at L114 `esc(cell ?? "")` — `esc(4200 ?? "")` throws TypeError. The runner catch (DocDesignRunner.tsx:276-278) converts to `fail(String(err))`, so one numeric table cell (an entirely plausible model emission: `{"Revenue": 4200}`) fails generation with an opaque JS error. Same bug class the file documents fixing for kpi-strip (irDoc.ts:208-212). compileDoc.ts:179 is also affected (`text: 4200` bare number literal). Fix: coerce cells in the validator (`rows.map(r => r.map(c => String(c ?? "")))`) or emit an actionable error issue.

## P2

**3. sanitize.ts:22-58 — `ALLOWED_ATTR` silently strips standard SVG presentation attributes from all model-authored srcDoc content (82%).**
Setting ALLOWED_ATTR *replaces* DOMPurify's default (~150-entry SVG set; verified purify.js:746/320). The 35-entry list drops `opacity`, `fill-opacity`, `stroke-dasharray`, `stroke-linecap`, `font-family`, `font-size`, `text-anchor`, `dominant-baseline`, `dx`, `dy`, `clip-path`, `fill-rule`, `marker-end`, `gradientUnits`, `offset`, `stop-color`, `stop-opacity`, etc. The comment justifies it for office converters, but this config is also the policy for model-authored markup on every srcDoc surface (ArtifactPreviewPane.tsx:280, InlineDiagram.tsx:70, TerminalPane.tsx:754, DiagramLightbox.tsx:130) — model-written SVG styled via presentation attributes renders with solid-black gradient stops, missing opacity, unanchored text. Fix: append the default SVG presentation set (non-dangerous: no URI/event semantics) or use USE_PROFILES + FORBID_* for srcDoc content, keeping the tight list only for office converters.

**4. Duplicated `wordOverlap` (95%) — planParser.ts:20-27 and planMatcher.ts:4-11, byte-identical Jaccard overlap for the same plan-step pipeline.** Extract shared helper.

**5. Duplicated `loadNotified()` (95%) — buildUpdates.ts:19-26 and harnessUpdates.ts:22-29, identical localStorage dedupe-map loaders + notify flow.** Extract `loadDedupeMap(key)`.

**6. Duplicated `skeletonOf` + `STRING_LITERAL_RE` (95%) — compileDeck.ts:342-348 and compileDoc.ts:233-239, identical string-literal-blanking skeletons (incl. audit-#26 comment).** Move to shared `skeleton.ts` so the L2 invariant checkers can't drift.

**7. Second, divergent fuzzy matcher (85%) — components/vault/VaultQuickSwitcher.tsx:16-34 hand-rolls a subsequence scorer alongside lib/fuzzy.ts** with different no-match semantics (number 0 vs FuzzyResult|null) and bonus math — vault search ranks differently from the palette for identical input; scoring fixes must be made twice. Export a `fuzzyScoreToNumber` wrapper and delete the local copy.

Checked and sound (for the record): safeSlice.ts boundary handling (never splits surrogate pairs); diff.ts hunk parsing; fuzzy.ts O(n); segments.ts parse loop always progresses; chatCitations protect/restore; objectUrl refcounting; localStorage access fully try/catch'd; sessionLauncher artifactFileUrl percent-encodes #/?/non-ASCII; exportSession uses native save dialog; vaultFrontmatter round-trip; chatScroll/chatSelection registries owner-scoped-cleaned.
