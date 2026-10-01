---
name: Repo hygiene sweep
description: Recurring cleanup pass over the bound repo — stray files, stale branches, TODO debt, and uncommitted work, reported without deleting anything irreversible.
version: 1.0.0
---

# Repo Hygiene Sweep

A recurring maintenance pass over the current repository. Run it on demand or
from an automation (e.g. weekly). The sweep is REPORT-FIRST: it never deletes,
moves, or rewrites anything without the user's explicit approval in the same
conversation.

## Procedure

1. **Working tree.** Run `git status --porcelain` and `git stash list`. Report
   uncommitted files, untracked strays (build artifacts that should be
   ignored, editor droppings, large binaries), and stale stashes with dates.
2. **Branches.** List local branches with `git branch -v` and note any that
   are fully merged into the default branch and untouched for 14+ days. Check
   the remote for branches whose upstream is gone (`git remote prune origin
   --dry-run`). Do not prune — list them.
3. **Ignore health.** Diff the stray files from step 1 against `.gitignore`.
   Propose exact ignore lines for anything that should never be tracked.
4. **TODO debt.** Grep the tracked sources for `TODO`, `FIXME`, and
   `HACK` markers. Count them, and call out any that mention a past date, a
   person, or "before release".
5. **Repo size smells.** Report the ten largest tracked files
   (`git ls-files -z | xargs -0 ls -l | sort -k5 -n | tail -10`-equivalent,
   PowerShell-safe on Windows) and any lockfiles over 1 MB.

## Report format

Group findings under **Uncommitted**, **Strays**, **Branches**, **Ignore
proposals**, **TODO debt**, **Large files** — each item one line, each
proposal copy-pasteable. End with a single recommended next action.

## Required output format

End every reply with, on its own final line, one of:

```
LOOP_STATUS: continue     # findings processed, more analysis remains
LOOP_STATUS: complete     # sweep finished and report delivered
LOOP_STATUS: blocked      # e.g. not a git repository, or git is unavailable
```

Immediately above it, one line: `STATUS: <what was swept and what remains>`.

Only emit `complete` when every section above was actually produced from real
command output — never from memory of what the repo "usually" contains.
