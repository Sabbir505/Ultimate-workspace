---
name: Dependency audit
description: Recurring pass over the project's dependencies — outdated packages, known advisories, and unused declarations — reported as copy-pasteable upgrade actions.
version: 1.0.0
---

# Dependency Audit

A recurring pass over the project's dependency manifests. Run it on demand or
from an automation (e.g. monthly). It REPORTS and proposes; it never upgrades,
pins, or edits a manifest without the run's approval posture explicitly
allowing writes.

## Procedure

1. **Manifests.** Find the dependency surfaces: `Cargo.toml` (+ workspace
   members), `package.json` (+ lockfile), `pyproject.toml`/`requirements*.txt`,
   `go.mod`, `*.csproj` — whichever exist. Skip vendored and example dirs.
2. **Outdated.** For each ecosystem, run the cheapest read-only checker
   available (`cargo search`-style probes or lockfile versions against the
   registry, `npm outdated --json`, `pip list --outdated`). List the top
   outdated entries: name, current, latest, and whether the current version
   is pinned (e.g. `=3.0.0-beta.2` — deliberate pins are flagged as such, not
   as drift).
3. **Advisories.** Run the read-only audit tool for the ecosystem when it is
   installed (`cargo audit`, `npm audit --json`); when it is not, say so
   instead of guessing. Report severity, id, and the affected range.
4. **Suspects.** Grep for dependencies declared but never imported in first
   party code (spot-check, don't exonerate), duplicate-purpose pairs (two
   HTTP clients, two date libraries), and direct git/path dependencies that
   bypass registries.
5. **Upgrade plan.** Order safe-to-bump items first (patch/minor in-range),
   then major bumps with their breaking-change notes, then the deliberate
   pins to leave alone.

## Report format

Sections **Outdated**, **Advisories**, **Suspects**, **Upgrade plan** — every
item one line with a copy-pasteable action (`cargo update -p x`, `npm i x@y`).
End with the single most urgent action.

## Required output format

End every reply with, on its own final line, one of:

```
LOOP_STATUS: continue     # more manifests or checks to process
LOOP_STATUS: complete     # every found manifest audited and reported
LOOP_STATUS: blocked      # e.g. no manifests found, network unavailable
```

Immediately above it, one line: `STATUS: <manifests audited and what remains>`.

Only emit `complete` when every discovered manifest was actually processed
this pass, and every advisory claim came from a real tool run.
