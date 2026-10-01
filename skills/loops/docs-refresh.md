---
name: Docs refresh pass
description: Compare the repo's documentation against the current code and refresh the drifted parts — README claims, setup steps, and module overviews.
version: 1.0.0
---

# Docs Refresh Pass

A recurring pass that keeps documentation honest against the code. Run it on
demand or from an automation (e.g. after a merge-heavy week). It PROPOSES
edits; it only applies a rewrite when the user (or the run's approval posture)
explicitly allows file writes.

## Procedure

1. **Inventory.** Find the docs surface: `README*` at the root, `docs/**`
   (markdown only, skip generated API dumps), and any `CHANGELOG.md` head.
2. **Verify claims, not prose.** For each doc, extract CHECKABLE claims:
   commands to build/test/run, prerequisite versions, file and module paths,
   feature lists. Verify each against reality — run the cheap commands
   (`--version`, `--help`), confirm referenced paths exist, spot-check that
   listed features map to real entry points.
3. **Setup-step dry run.** Follow the README's setup steps in order as far as
   they can go without destructive effect (no installs without permission).
   Note the first step where a fresh machine would stall.
4. **Drift report.** Produce a table: doc file, section, claim, what the code
   says now, suggested one-line fix.
5. **Apply (optional).** If writes are permitted, apply the SAFE subset —
   factual corrections (paths, command flags, versions) — and leave style
   rewrites alone. List every applied edit.

## Report format

Lead with a verdict: **fresh**, **minor drift** (< 5 fixes), or **stale**
(≥ 5 fixes or a broken setup path). Then the drift table. Unapplied fixes
stay copy-pasteable so they survive into a PR.

## Required output format

End every reply with, on its own final line, one of:

```
LOOP_STATUS: continue     # more docs to verify
LOOP_STATUS: complete     # inventory fully verified and reported
LOOP_STATUS: blocked      # e.g. no docs found, or tooling unavailable
```

Immediately above it, one line: `STATUS: <docs verified so far and what remains>`.

Only emit `complete` when every inventoried doc was actually checked against
the code this pass.
