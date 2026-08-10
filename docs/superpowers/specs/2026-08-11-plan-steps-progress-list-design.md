# Plan Steps → Git Sidebar Progress List

**Date:** 2026-08-11
**Status:** design-approved

## Summary

When a model (harness, API, or local) generates a plan with checkpoints/tasks,
each step should appear as an item in the Git tools sidebar's Progress section
with a live status indicator. When the model completes a step — detected via
backend tool-execution events or text parsing — the item is marked complete.

Currently, the Progress section only shows completed background tasks
(downloads, shell runs). Plans are extracted as opaque markdown and shown in a
separate Plans section with no step-level tracking.

## Goals

1. Parse individual steps from model-generated plans (numbered items,
   checkboxes, bullet lists, and structured TodoWrite tool calls)
2. Show every step in the Progress section with status: `pending`,
   `in_progress`, `completed`, or `failed`
3. Auto-mark steps complete using two channels: backend tool-execution events
   (primary) and text-pattern scanning (fallback)
4. Work across all model sources: CLI harnesses (Claude Code, Kimi, OpenCode),
   API providers (Anthropic, OpenAI), and local GGUF models

## Non-Goals

- Persisting plan steps to SQLite (they are derived from stored messages)
- Changing the Plans section (quick-links to full plan markdown stay as-is)
- Replacing the existing background-task progress system (downloads/shells)

---

## Data Model

### Frontend: `PlanStep`

```typescript
interface PlanStep {
  stepId: string;           // "plan-{chatSessionId}-{planIndex}-{stepIndex}"
  label: string;            // human-readable step text
  status: "pending" | "in_progress" | "completed" | "failed";
  source: "parsed" | "todo_write";  // how this step was discovered
  planIndex: number;        // which plan (may be multiple plans per session)
  stepIndex: number;        // order within the plan
  completedAt?: number;     // Date.now() when marked done
  failedReason?: string;
  matchedToolCall?: string; // e.g. file path that completed this step
}
```

### Store shape (in `useChatStore`)

```typescript
// keyed by chat session id
planSteps: Record<string, PlanStep[]>
```

### Backend event payload (`chat:plan-step-progress`)

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStepProgressPayload {
    pub chat_session_id: String,
    pub step_label: String,
    pub status: String,    // "pending" | "in_progress" | "completed" | "failed"
    pub detail: Option<String>,
    pub tool_call: Option<String>,
}
```

`PlanStep` is separate from `ChatTaskProgress` — plan steps are conceptual
milestones, not background processes. They coexist in the store but have
different lifecycles.

---

## Architecture

### Plan parsing (frontend, new: `src/lib/planParser.ts`)

A pure function that takes plan markdown and returns individual step labels:

1. **Numbered items:** `/^(\d+)[.)]\s+(.+)$/gm`
2. **Checkboxes:** `/^-\s*\[([ x])\]\s*(.+)$/gm` (initial status from `[x]` vs `[ ]`)
3. **Bullet lists:** `/^[-*•]\s+(?!(?:\[[ x]\]))(.+)$/gm`
4. Strip markdown formatting (`**bold**`, `` `code` ``, `_italic_`)
5. Deduplicate by word-overlap ratio > 0.8

### Completion detection (two channels)

**Channel 1 — Backend events (primary):**

- `src-tauri/src/agent_sessions.rs`: Parse `TodoWrite` tool-call JSON content,
  extract individual task items with statuses, emit `chat:plan-step-progress`
  for each. This replaces the current generic "Updating task list" tool row.
- `src-tauri/src/chat/dispatch.rs`: After a system tool executes successfully,
  emit `chat:plan-step-progress` with the tool description.
- `src-tauri/src/chat/tasks.rs`: Add `emit_plan_step_progress` method, separate
  from the download/shell emit (no throttling needed).

**Channel 2 — Text scanning (fallback, new: `src/lib/planMatcher.ts`):**

After each new assistant message, scan for completion patterns:
- `- [x] <text>`
- `✓ <text>`, `✔ <text>`
- `~~<text>~~`
- `completed: <text>`, `finished: <text>`

Match against pending steps by:
1. Exact label match (case-insensitive, trimmed)
2. Word overlap > 60% (Jaccard on word sets)
3. File-path match if the signal references a file the step label mentions

### Orchestration (new: `src/hooks/usePlanTracker.ts`)

A React hook that:
1. Watches `useChatStore.messages` for plan sections (reuses existing
   `PLAN_HEADERS` regexes from `GitToolsSidebar.tsx`)
2. Extracts steps via `planParser.ts` when a new plan is detected
3. Listens for `chat:plan-step-progress` events and dispatches to
   `useChatStore.onPlanStepProgress`
4. Runs text-scanning fallback after each new assistant message

---

## UI: GitToolsSidebar Progress Section

The Progress section changes from "completed tasks only" to a full task list:

```
Progress 3/5
  ✓ Set up project structure          (completed — green check)
  ● Implement the API route           (in_progress — blue dot w/ pulse)
  ○ Add tests                         (pending — gray circle)
  ○ Write documentation               (pending — gray circle)
  ✓ Create README                     (completed — green check)
```

- Status indicator: `✓` green, `●` blue, `○` gray, `✕` red (failed)
- Completed items: muted/strikethrough style
- Header: `in_progress + completed / total` count
- Plan step rows render alongside existing completed-task rows
- Already-completed background tasks (downloads/shells) continue to show as before

---

## Files to Create

| File | Purpose |
|---|---|
| `src/lib/planParser.ts` | Step extraction from plan markdown |
| `src/lib/planMatcher.ts` | Fuzzy matching for completion signals |
| `src/hooks/usePlanTracker.ts` | Orchestrates parsing + listening + matching |

## Files to Modify

| File | Change |
|---|---|
| `src/components/chat/GitToolsSidebar.tsx` | Show all plan steps + completed tasks in Progress section |
| `src/state/chat.ts` | Add `planSteps` store + `onPlanStepProgress` handler |
| `src/hooks/useChatEvents.ts` | Listen for `chat:plan-step-progress` event |
| `src/lib/ipc.ts` | Add `PlanStepProgressPayload` type + listener |
| `src-tauri/src/types.rs` | Add `PlanStepProgressPayload` struct |
| `src-tauri/src/chat/tasks.rs` | Add `emit_plan_step_progress` helper |
| `src-tauri/src/chat/dispatch.rs` | Emit plan-step events on tool completion |
| `src-tauri/src/agent_sessions.rs` | Parse TodoWrite → plan-step events |
| `src/styles/global.css` | Style progress row states |

---

## Edge Cases

- **Multiple plans per session:** Steps carry `planIndex` to group correctly.
  New plans accumulate — old steps stay in the list until completed or manually
  cleared. The most recent plan's pending steps render at the top.
- **Duplicate steps:** Fuzzy dedup by label word-overlap at parse time.
- **Harness resume:** Steps are re-parsed from stored messages on session load,
  so they survive app restart.
- **Empty plans:** If a plan section has no parseable steps, fall back to
  showing the plan as a single item.
- **Backend unavailable:** Text scanning is purely frontend — works even if
  the `chat:plan-step-progress` event never fires (e.g. for API models that
  don't use the backend task system).
