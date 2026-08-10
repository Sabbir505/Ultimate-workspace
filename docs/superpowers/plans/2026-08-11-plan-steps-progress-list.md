# Plan Steps → Git Sidebar Progress List — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show AI-generated plan checkpoints as individual progress items in the Git tools sidebar, auto-marking them complete via backend tool-execution events and text-pattern scanning.

**Architecture:** A new frontend `PlanStep` data model lives in `useChatStore` alongside existing `ChatTaskProgress`. Plan steps are parsed from assistant messages by a pure `planParser.ts` function, matched to completion signals by `planMatcher.ts`, and orchestrated by a `usePlanTracker` hook. The backend emits lightweight `chat:plan-step-progress` events when tools complete or TodoWrite tool calls carry structured task updates.

**Tech Stack:** TypeScript/React (frontend), Rust/Tauri (backend), existing `chat:task-progress` emit pattern as reference

## Global Constraints

- Works across all model sources: CLI harnesses (Claude Code, Kimi, OpenCode), API providers, local GGUF models
- No new SQLite tables — plan steps are derived from stored messages
- Existing Plans section stays unchanged
- Existing background-task system (downloads/shells) stays unchanged
- Plan steps are separate from ChatTaskProgress — different lifecycle, no download/speed fields

---

## File Structure

| File | Role |
|---|---|
| `src/lib/planParser.ts` | **Create.** Pure function: plan markdown → `{label, index}[]` |
| `src/lib/planMatcher.ts` | **Create.** Pure function: fuzzy-match PlanStep against signal |
| `src/hooks/usePlanTracker.ts` | **Create.** React hook: watches messages, parses plans, listens for events |
| `src/state/chat.ts` | **Modify.** Add `PlanStep` interface, `planSteps` store, `onPlanStepProgress` action |
| `src/hooks/useChatEvents.ts` | **Modify.** Wire `chat:plan-step-progress` listener |
| `src/lib/ipc.ts` | **Modify.** Add `PlanStepProgressPayload` + `listenPlanStepProgress` |
| `src/components/chat/GitToolsSidebar.tsx` | **Modify.** Show plan steps in Progress section alongside completed tasks |
| `src/styles/global.css` | **Modify.** Style progress row states (pending, in-progress, completed, failed) |
| `src-tauri/src/types.rs` | **Modify.** Add `PlanStepProgressPayload` struct |
| `src-tauri/src/chat/tasks.rs` | **Modify.** Add `emit_plan_step_progress` helper |
| `src-tauri/src/chat/dispatch.rs` | **Modify.** Emit plan-step events on tool execution completion |
| `src-tauri/src/agent_sessions.rs` | **Modify.** Parse TodoWrite content → structured plan-step events |

---

### Task 1: Frontend — PlanStep Data Model & Store

**Files:**
- Modify: `src/state/chat.ts` (add interface + store + action)

**Interfaces:**
- Produces: `PlanStep` interface, `planSteps` store property, `onPlanStepProgress` action, `setPlanSteps` action

- [ ] **Step 1: Add `PlanStep` interface**

In `src/state/chat.ts`, add after the `ChatTaskProgress` interface (after line 119):

```typescript
/** A single checkpoint/step extracted from a model-generated plan. Displayed
 *  in the Git sidebar Progress section alongside background task items. */
export interface PlanStep {
  stepId: string;           // "plan-{sessionId}-{planIndex}-{stepIndex}"
  label: string;            // human-readable step text
  status: "pending" | "in_progress" | "completed" | "failed";
  source: "parsed" | "todo_write";  // how this step was discovered
  planIndex: number;        // which plan (increments per plan detected)
  stepIndex: number;        // order within the plan
  completedAt?: number;     // Date.now() when marked done
  failedReason?: string;
  matchedToolCall?: string; // e.g. file path that triggered completion
}
```

- [ ] **Step 2: Add `planSteps` to the store interface**

In `ChatStoreState` interface (after the `tasks` line ~194), add:

```typescript
  /** Plan checkpoints extracted from model-generated plans, keyed by
   *  chat session id → steps array. Displayed in Git sidebar Progress. */
  planSteps: Record<string, PlanStep[]>;
```

- [ ] **Step 3: Add `setPlanSteps` and `onPlanStepProgress` to the actions interface**

In `ChatStoreActions` interface (after `onTaskProgress` line ~307), add:

```typescript
  /** Replace all plan steps for a session (called after parsing a new plan). */
  setPlanSteps: (chatSessionId: string, steps: PlanStep[]) => void;
  /** Update a single plan step's status from a backend event or text match. */
  onPlanStepProgress: (chatSessionId: string, stepId: string, status: PlanStep["status"], detail?: string, toolCall?: string) => void;
```

- [ ] **Step 4: Initialize `planSteps` in the store**

In the initial state object (after `tasks: {}` line ~343), add:

```typescript
  planSteps: {},
```

- [ ] **Step 5: Implement `setPlanSteps` in the `set` callback**

In the store creation `set` callback (after `onTaskProgress` ~1316), add:

```typescript
  setPlanSteps: (chatSessionId, steps) => {
    set((s) => ({
      planSteps: { ...s.planSteps, [chatSessionId]: steps },
    }));
  },

  onPlanStepProgress: (chatSessionId, stepId, status, detail, toolCall) => {
    set((s) => {
      const sessionSteps = s.planSteps[chatSessionId];
      if (!sessionSteps) return {};
      const updated = sessionSteps.map((st) => {
        if (st.stepId !== stepId) return st;
        return {
          ...st,
          status,
          completedAt: status === "completed" ? Date.now() : st.completedAt,
          failedReason: status === "failed" ? (detail ?? st.failedReason) : st.failedReason,
          matchedToolCall: toolCall ?? st.matchedToolCall,
        };
      });
      // Set the first non-pending step as in_progress if none is active
      const hasActive = updated.some((st) => st.status === "in_progress");
      if (!hasActive && status === "completed") {
        const nextPending = updated.find((st) => st.status === "pending");
        if (nextPending) {
          const idx = updated.indexOf(nextPending);
          updated[idx] = { ...nextPending, status: "in_progress" };
        }
      }
      return { planSteps: { ...s.planSteps, [chatSessionId]: updated } };
    });
  },
```

- [ ] **Step 6: Clear `planSteps` in `deleteAllChats`**

In `deleteAllChats` (line ~618), add `planSteps: {}` to the reset object.

- [ ] **Step 7: Commit**

```bash
git add src/state/chat.ts
git commit -m "feat: add PlanStep data model and store to chat state"
```

---

### Task 2: Frontend — Plan Step Parser

**Files:**
- Create: `src/lib/planParser.ts`

**Interfaces:**
- Produces: `parsePlanSteps(markdown: string, sessionId: string, planIndex: number): PlanStep[]`

- [ ] **Step 1: Write the file with step-extraction logic**

Create `src/lib/planParser.ts`:

```typescript
import type { PlanStep } from "../state/chat";

/** Normalize a step label: strip markdown formatting, trim whitespace,
 *  collapse internal newlines. */
function normalizeLabel(raw: string): string {
  return raw
    .replace(/\*\*(.+?)\*\*/g, "$1")    // bold
    .replace(/\*(.+?)\*/g, "$1")         // italic
    .replace(/`(.+?)`/g, "$1")           // inline code
    .replace(/_/g, "")                   // underscores
    .replace(/\s+/g, " ")
    .trim();
}

/** Word-overlap ratio between two strings. Used to deduplicate steps
 *  that are near-identical. */
function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  return overlap / Math.min(wordsA.size, wordsB.size);
}

/** Parse individual plan steps from a plan markdown section.
 *  Returns steps in order, deduplicated by label overlap.
 *  `sessionId` and `planIndex` are used to construct unique `stepId` values. */
export function parsePlanSteps(
  markdown: string,
  sessionId: string,
  planIndex: number,
): PlanStep[] {
  const lines = markdown.split("\n");
  const rawSteps: { label: string; isChecked: boolean }[] = [];

  // Strategy 1: Checkboxes — "- [x] Do the thing" or "- [ ] Not done yet"
  const checkboxRe = /^\s*[-*]\s*\[([ xX])\]\s*(.+)$/;
  // Strategy 2: Numbered items — "1. Do X", "2) Do Y"
  const numberedRe = /^\s*(\d+)[.)]\s+(.+)$/;
  // Strategy 3: Bullet lists (but NOT checkboxes)
  const bulletRe = /^\s*[-*•]\s+(?!(?:\[[ xX]\]))(.+)$/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let match: RegExpExecArray | null;

    match = checkboxRe.exec(line);
    if (match) {
      rawSteps.push({ label: normalizeLabel(match[2]), isChecked: /[xX]/.test(match[1]) });
      continue;
    }

    match = numberedRe.exec(line);
    if (match) {
      rawSteps.push({ label: normalizeLabel(match[2]), isChecked: false });
      continue;
    }

    match = bulletRe.exec(line);
    if (match) {
      rawSteps.push({ label: normalizeLabel(match[1]), isChecked: false });
    }
  }

  // Deduplicate by word overlap
  const unique: { label: string; isChecked: boolean }[] = [];
  for (const s of rawSteps) {
    if (s.label.length < 3) continue; // skip noise like "1." with no text
    const isDup = unique.some((u) => wordOverlap(u.label, s.label) > 0.8);
    if (!isDup) unique.push(s);
  }

  // Build PlanStep array
  return unique.map((s, i) => ({
    stepId: `plan-${sessionId}-${planIndex}-${i}`,
    label: s.label,
    status: s.isChecked ? "completed" : (i === 0 ? "in_progress" : "pending"),
    source: "parsed" as const,
    planIndex,
    stepIndex: i,
  }));
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/planParser.ts
git commit -m "feat: add plan step parser for markdown plan detection"
```

---

### Task 3: Frontend — Plan Step Matcher

**Files:**
- Create: `src/lib/planMatcher.ts`

**Interfaces:**
- Produces: `matchPlanStep(signal: {stepLabel: string, status: string, toolCall?: string}, pendingSteps: PlanStep[]): PlanStep | null`
- Produces: `scanForCompletions(messageText: string, pendingSteps: PlanStep[]): PlanStep[]`

- [ ] **Step 1: Write the matcher**

Create `src/lib/planMatcher.ts`:

```typescript
import type { PlanStep } from "../state/chat";

/** Word-overlap ratio (Jaccard-style on word sets). */
function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  return overlap / Math.min(wordsA.size, wordsB.size);
}

/** Try to match a backend signal (stepLabel + optional toolCall) against
 *  a pending PlanStep. Returns the matched step or null.
 *
 *  Matching strategies (tried in order):
 *  1. Exact label match (case-insensitive, trimmed)
 *  2. Significant word overlap (>60%)
 *  3. File-path match — signal.toolCall is a path that appears in the label
 */
export function matchPlanStep(
  signal: { stepLabel: string; toolCall?: string },
  pendingSteps: PlanStep[],
): PlanStep | null {
  const sig = signal.stepLabel.toLowerCase().trim();
  if (!sig) return null;

  // 1. Exact match
  for (const step of pendingSteps) {
    if (step.label.toLowerCase().trim() === sig) return step;
  }

  // 2. Word overlap > 0.6
  let best: { step: PlanStep; score: number } | null = null;
  for (const step of pendingSteps) {
    const score = wordOverlap(sig, step.label);
    if (score > 0.6 && (!best || score > best.score)) {
      best = { step, score };
    }
  }
  if (best) return best.step;

  // 3. File path match
  if (signal.toolCall) {
    const fileName = signal.toolCall.split(/[\\/]/).pop()?.toLowerCase() ?? "";
    if (fileName) {
      for (const step of pendingSteps) {
        if (step.label.toLowerCase().includes(fileName)) return step;
      }
    }
  }

  return null;
}

/** Scan an assistant message text for completion markers and return the
 *  matching pending steps that should be marked complete.
 *
 *  Patterns detected:
 *  - `- [x] <label text>` (checked checkbox)
 *  - `✓ <label text>` or `✔ <label text>`
 *  - `~~<label text>~~` (strikethrough)
 *  - `completed <label text>` or `finished <label text>` or `done <label text>`
 */
export function scanForCompletions(
  messageText: string,
  pendingSteps: PlanStep[],
): PlanStep[] {
  if (pendingSteps.length === 0) return [];
  const completed: PlanStep[] = [];

  // Build patterns to search: each pending step's label as a sub-pattern
  for (const step of pendingSteps) {
    if (step.status === "completed" || step.status === "failed") continue;

    const label = step.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // escape regex chars
    const patterns = [
      new RegExp(`-\\s*\\[x\\]\\s*${label}`, "i"),
      new RegExp(`[✓✔]\\s*${label}`, "i"),
      new RegExp(`~~${label}~~`, "i"),
      new RegExp(`(?:completed|finished|done)[\\s:]*${label}`, "i"),
    ];

    for (const re of patterns) {
      if (re.test(messageText)) {
        completed.push(step);
        break;
      }
    }
  }

  return completed;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/planMatcher.ts
git commit -m "feat: add plan step matcher for completion detection"
```

---

### Task 4: Frontend — `usePlanTracker` Hook

**Files:**
- Create: `src/hooks/usePlanTracker.ts`

**Interfaces:**
- Consumes: `useChatStore` (messages, activeChatSessionId, planSteps, setPlanSteps, onPlanStepProgress), `parsePlanSteps` from `planParser`, `scanForCompletions` from `planMatcher`
- Produces: nothing — side-effect hook that runs in `GitToolsSidebar`

- [ ] **Step 1: Write the hook**

Create `src/hooks/usePlanTracker.ts`:

```typescript
import { useEffect, useRef } from "react";
import { useChatStore } from "../state/chat";
import { parsePlanSteps } from "../lib/planParser";
import { scanForCompletions } from "../lib/planMatcher";

/** Same plan-header detection regex as GitToolsSidebar's PLAN_HEADERS.
 *  We need our own copy here to avoid a circular dependency. */
const PLAN_HEADERS = [
  /^#{1,3}\s*(?:Plan|Planning|Approach|Strategy|Steps|Implementation|Proposed Solution|Game Plan|Roadmap|To[- ]Do|Action Plan)/im,
  /(?:^|\n\n)(?:Here(?:'s| is) (?:my |the |a |an )?(?:plan|approach|breakdown|strategy|outline|steps?))/im,
  /(?:^|\n\n)(?:Let me (?:(?:quickly )?(?:plan|outline|break(?:\s+down)?|sketch|lay out|map out|walk through)|explain (?:my |the )?(?:plan|approach|thinking)))/im,
  /(?:^|\n\n)(?:I(?:'ll| will) (?:plan|break|outline|do the following|take the following|proceed (?:as follows|in these steps)|tackle this (?:in |with )?steps?|start by))/im,
  /(?:^|\n\n)(?:My (?:plan|approach|strategy|recommendation|suggestion) (?:is|would be|:))/im,
  /(?:^|\n\n)(?:Here(?:'s| is) (?:how|what) I(?:'ll| will) (?:do|approach|proceed|tackle|handle|implement))/im,
];

/** Detect whether an assistant message contains a plan section, and if so,
 *  return the plan text (from header to next `##` section or ~800 chars). */
function extractPlanSection(content: string): string | null {
  const cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (cleaned.length < 50) return null;

  for (const pattern of PLAN_HEADERS) {
    const m = pattern.exec(cleaned);
    if (m && m.index >= 0) {
      const start = m.index;
      const after = cleaned.slice(start);
      const headerLen = m[0].length;
      const nextSection = after.slice(headerLen).search(/^#{1,3}\s+(?!Plan|Step)/m);
      const full = nextSection !== -1
        ? after.slice(0, headerLen + nextSection).trim()
        : after.slice(0, Math.min(after.length, 800)).trim();
      if (full.slice(headerLen).trim().length < 30) continue;
      return full;
    }
  }
  return null;
}

/** Orchestrates plan-step parsing and completion tracking for the active
 *  chat session. Place in GitToolsSidebar (or any component that lives
 *  alongside the chat message stream). */
export function usePlanTracker(): void {
  const planSteps = useChatStore((s) => s.planSteps);
  const messages = useChatStore((s) => s.messages);
  const activeSessionId = useChatStore((s) => s.activeChatSessionId);
  const setPlanSteps = useChatStore((s) => s.setPlanSteps);
  const onPlanStepProgress = useChatStore((s) => s.onPlanStepProgress);

  // Track which messages we've already parsed so we don't re-parse
  const parsedMessageIdx = useRef<number>(-1);

  // Parse new plans from assistant messages
  useEffect(() => {
    if (!activeSessionId) return;

    const currentSteps = planSteps[activeSessionId] ?? [];
    let nextPlanIndex = currentSteps.length > 0
      ? Math.max(...currentSteps.map((s) => s.planIndex))
      : 0;
    let foundNew = false;
    const allSteps = [...currentSteps];

    // Only scan messages newer than the last parsed
    for (let i = parsedMessageIdx.current + 1; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== "assistant") continue;

      const content = m.content || "";
      const plan = extractPlanSection(content);
      if (!plan) continue;

      nextPlanIndex++;
      const newSteps = parsePlanSteps(plan, activeSessionId, nextPlanIndex);
      if (newSteps.length > 0) {
        allSteps.push(...newSteps);
        foundNew = true;
      }
    }

    parsedMessageIdx.current = messages.length - 1;

    if (foundNew) {
      setPlanSteps(activeSessionId, allSteps);
    }
  }, [messages, activeSessionId]);

  // Scan new messages for text-based completion markers
  useEffect(() => {
    if (!activeSessionId) return;
    const steps = planSteps[activeSessionId];
    if (!steps || steps.length === 0) return;
    const pending = steps.filter((s) => s.status === "pending" || s.status === "in_progress");
    if (pending.length === 0) return;

    // Only scan the latest assistant message
    const lastMsg = [...messages].reverse().find((m) => m.role === "assistant");
    if (!lastMsg) return;

    const content = lastMsg.content || "";
    const completed = scanForCompletions(content, pending);
    for (const step of completed) {
      onPlanStepProgress(activeSessionId, step.stepId, "completed", "detected in message");
    }
  }, [messages, planSteps, activeSessionId]);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/hooks/usePlanTracker.ts
git commit -m "feat: add usePlanTracker hook for plan-step parsing and completion tracking"
```

---

### Task 5: Frontend — IPC & Event Wiring

**Files:**
- Modify: `src/lib/ipc.ts` (add payload type + listener)
- Modify: `src/hooks/useChatEvents.ts` (wire listener → store)

**Interfaces:**
- Consumes: `PlanStepProgressPayload` from backend (defined in Task 7)
- Produces: `PlanStepProgressPayload` type, `listenPlanStepProgress` function

- [ ] **Step 1: Add `PlanStepProgressPayload` type to `src/lib/ipc.ts`**

After `ChatTaskProgressPayload` (after line 414), add:

```typescript
/** Plan step progress pushed as `chat:plan-step-progress`. Lighter than
 *  ChatTaskProgressPayload — no download/speed fields, just status. */
export interface PlanStepProgressPayload {
  chatSessionId: string;
  stepLabel: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  detail: string | null;
  toolCall: string | null;
}
```

- [ ] **Step 2: Add `listenPlanStepProgress` listener**

After `listenChatTaskProgress` (after line 792), add:

```typescript
export const listenPlanStepProgress = (handler: (payload: PlanStepProgressPayload) => void) =>
  safeListen<PlanStepProgressPayload>("chat:plan-step-progress", handler);
```

- [ ] **Step 3: Wire in `useChatEvents.ts`**

In `src/hooks/useChatEvents.ts`:
- Add `listenPlanStepProgress` to imports (line 16 area)
- Add after the task-progress listener block (after line 90):

```typescript
    // Plan step progress — backend emits when tools complete or TodoWrite
    // tool calls carry structured task updates. The frontend matches these
    // against parsed plan steps and updates status.
    unlistens.push(
      listenPlanStepProgress(({ chatSessionId, stepLabel, status, detail, toolCall }) => {
        const store = useChatStore.getState();
        const steps = store.planSteps[chatSessionId];
        if (!steps) return;
        // Fuzzy-match the stepLabel against pending steps
        const { matchPlanStep } = require("../lib/planMatcher");
        const matched = matchPlanStep({ stepLabel, toolCall: toolCall ?? undefined }, steps);
        if (matched) {
          store.onPlanStepProgress(chatSessionId, matched.stepId, status, detail ?? undefined, toolCall ?? undefined);
        }
      }),
    );
```

Note: The dynamic require is intentional to avoid circular deps — `planMatcher.ts` imports from `chat.ts` which imports from `ipc.ts`. Wrap in a try/catch for safety.

Actually, use a static import since `planMatcher.ts` only imports `PlanStep` from `chat.ts` (a type) and has no runtime dependency on `ipc.ts`:

```typescript
import { matchPlanStep } from "../lib/planMatcher";
```

Add this import at line 21 (after existing imports).

Then the listener body:

```typescript
    // Plan step progress from backend — matches against parsed plan steps
    unlistens.push(
      listenPlanStepProgress(({ chatSessionId, stepLabel, status, detail, toolCall }) => {
        const store = useChatStore.getState();
        const steps = store.planSteps[chatSessionId];
        if (!steps) return;
        const matched = matchPlanStep(
          { stepLabel, toolCall: toolCall ?? undefined },
          steps,
        );
        if (matched) {
          store.onPlanStepProgress(
            chatSessionId,
            matched.stepId,
            status,
            detail ?? undefined,
            toolCall ?? undefined,
          );
        }
      }),
    );
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/ipc.ts src/hooks/useChatEvents.ts
git commit -m "feat: add plan-step-progress IPC payload, listener, and event wiring"
```

---

### Task 6: Frontend — GitToolsSidebar Progress Section UI

**Files:**
- Modify: `src/components/chat/GitToolsSidebar.tsx`
- Modify: `src/styles/global.css`

**Interfaces:**
- Consumes: `planSteps` from `useChatStore`, `usePlanTracker` hook

- [ ] **Step 1: Import and activate `usePlanTracker`**

In `GitToolsSidebar.tsx`:
- Add import: `import { usePlanTracker } from "../../hooks/usePlanTracker";`
- Add hook call at the top of the component body (after the store hooks, ~line 44):

```typescript
  usePlanTracker();
```

- [ ] **Step 2: Read `planSteps` from the store**

After the existing `tasks` selector (after line 36), add:

```typescript
  const planSteps = useChatStore((s) =>
    s.activeChatSessionId ? s.planSteps[s.activeChatSessionId] ?? [] : [],
  );
```

- [ ] **Step 3: Replace the Progress section rendering**

Replace the existing Progress section (lines 315-337) — from the section header to closing `</div>` — with this combined view that shows both plan steps and completed background tasks:

```tsx
      {/* Progress section — plan steps + completed background tasks */}
      <div className="git-sidebar-section">
        <div className="git-sidebar-section-header">
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
          </svg>
          <span className="git-sidebar-section-title">
            Progress {completedPlanSteps + completed}/{totalPlanSteps + totalTasks}/{totalPlanSteps + totalTasks}
          </span>
        </div>
        {planSteps.length === 0 && completed.length === 0 ? (
          <div className="git-sidebar-empty">No progress yet.</div>
        ) : (
          <>
            {/* Plan steps — all statuses */}
            {planSteps.map((step) => {
              const Icon = STATUS_ICON[step.status] ?? STATUS_ICON.pending;
              return (
                <div
                  key={step.stepId}
                  className={`git-sidebar-progress-item progress-${step.status}`}
                  title={step.status === "failed" ? (step.failedReason ?? "Failed") : step.label}
                >
                  <Icon width={14} height={14} stroke={STATUS_COLOR[step.status]} />
                  <span
                    className={`git-sidebar-progress-text${step.status === "completed" ? " completed" : ""}`}
                  >
                    {step.label}
                  </span>
                </div>
              );
            })}
            {/* Completed background tasks (downloads/shells) — unchanged */}
            {completed.map((t) => (
              <div key={t.taskId} className="git-sidebar-progress-item">
                <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                <span className="git-sidebar-progress-text">{t.message || t.kind}</span>
              </div>
            ))}
          </>
        )}
      </div>
```

- [ ] **Step 4: Add derived values and icon maps above the JSX**

Before the return statement (before line 194, the collapsed-state check), add:

```typescript
  // Derived progress counts
  const totalPlanSteps = planSteps.length;
  const completedPlanSteps = planSteps.filter((s) => s.status === "completed").length;

  // Status icon components (inline SVGs)
  const STATUS_ICON: Record<string, React.FC<{ width: number; height: number; stroke: string }>> = {
    pending: ({ width, height, stroke }) => (
      <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={2} strokeLinecap="round">
        <circle cx="12" cy="12" r="3" />
      </svg>
    ),
    in_progress: ({ width, height, stroke }) => (
      <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={2} strokeLinecap="round">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
      </svg>
    ),
    completed: ({ width, height, stroke }) => (
      <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 6 9 17l-5-5" />
      </svg>
    ),
    failed: ({ width, height, stroke }) => (
      <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={2.5} strokeLinecap="round">
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    ),
  };

  const STATUS_COLOR: Record<string, string> = {
    pending: "#6b7280",      // gray-500
    in_progress: "#3b82f6",  // blue-500
    completed: "#22c55e",    // green-500
    failed: "#ef4444",       // red-500
  };
```

- [ ] **Step 5: Add CSS for progress row states**

In `src/styles/global.css`, after the existing `.git-sidebar-progress-text` rules, add:

```css
/* Plan step status variations */
.git-sidebar-progress-item.progress-completed .git-sidebar-progress-text {
  text-decoration: line-through;
  opacity: 0.6;
}
.git-sidebar-progress-item.progress-failed .git-sidebar-progress-text {
  color: #ef4444;
}
.git-sidebar-progress-item.progress-in_progress .git-sidebar-progress-text {
  color: #93c5fd; /* blue-300 */
}
```

- [ ] **Step 6: Commit**

```bash
git add src/components/chat/GitToolsSidebar.tsx src/styles/global.css
git commit -m "feat: show plan steps in git sidebar Progress section with status indicators"
```

---

### Task 7: Backend — PlanStepProgressPayload Type

**Files:**
- Modify: `src-tauri/src/types.rs`

**Interfaces:**
- Produces: `PlanStepProgressPayload` struct (consumed by Tasks 8, 9, 10 and frontend IPC)

- [ ] **Step 1: Add the struct**

In `src-tauri/src/types.rs`, after `ChatTaskProgressPayload` (after line 481), add:

```rust
/// Plan step progress — lighter than ChatTaskProgressPayload (no download/speed
/// fields). Emitted when backend tools execute or TodoWrite tool calls carry
/// structured task updates. The frontend fuzzy-matches `step_label` against
/// parsed PlanStep items.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStepProgressPayload {
    pub chat_session_id: String,
    /// Human-readable step label — frontend fuzzy-matches against PlanStep.label
    pub step_label: String,
    /// "pending" | "in_progress" | "completed" | "failed"
    pub status: String,
    /// Optional detail (error message for failed, "tool executed" for completed)
    pub detail: Option<String>,
    /// Optional tool-call context (e.g. the file path from a Write tool)
    pub tool_call: Option<String>,
}
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/src/types.rs
git commit -m "feat: add PlanStepProgressPayload type for plan-step events"
```

---

### Task 8: Backend — Emit Helper

**Files:**
- Modify: `src-tauri/src/chat/tasks.rs`

**Interfaces:**
- Produces: `pub fn emit_plan_step_progress(app: &AppHandle, sid: &str, step_label: &str, status: &str, detail: Option<&str>, tool_call: Option<&str>)`
- Consumes: `PlanStepProgressPayload` from Task 7

- [ ] **Step 1: Add the helper function**

In `src-tauri/src/chat/tasks.rs`, after the `TaskManager` impl block (after line 305), add:

```rust
/// Emit a `chat:plan-step-progress` event for the frontend to match against
/// parsed PlanStep items. Separate from the TaskManager emit (which is for
/// download/shell progress) — this is a lightweight signal, no throttling.
pub fn emit_plan_step_progress<R: tauri::Runtime>(
    app: &AppHandle<R>,
    sid: &str,
    step_label: &str,
    status: &str,
    detail: Option<&str>,
    tool_call: Option<&str>,
) {
    let _ = app.emit(
        "chat:plan-step-progress",
        crate::types::PlanStepProgressPayload {
            chat_session_id: sid.to_string(),
            step_label: step_label.to_string(),
            status: status.to_string(),
            detail: detail.map(|s| s.to_string()),
            tool_call: tool_call.map(|s| s.to_string()),
        },
    );
}
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/src/chat/tasks.rs
git commit -m "feat: add emit_plan_step_progress helper in TaskManager"
```

---

### Task 9: Backend — Tool Completion Hooks in Dispatch

**Files:**
- Modify: `src-tauri/src/chat/dispatch.rs`

**Interfaces:**
- Consumes: `emit_plan_step_progress` from Task 8
- Produces: plan-step progress events on tool completion

- [ ] **Step 1: Add import**

At the top of `src-tauri/src/chat/dispatch.rs`, add after existing `use crate::chat::tasks` imports:

```rust
use crate::chat::tasks::emit_plan_step_progress;
```

- [ ] **Step 2: Emit plan-step progress on tool completion**

Find the `run_tool` function (or `execute_tool`). After a tool executes successfully, emit a plan-step progress event. The exact location is after the tool's successful return — look for where the tool result string is built.

After the tool result is determined (in `execute_system_tool` for system tools, or `dispatch_tool` for other tools), add:

```rust
// Emit a plan-step progress signal so the frontend can mark the
// corresponding checkpoint as complete. The frontend fuzzy-matches
// the label against parsed PlanStep items.
emit_plan_step_progress(
    app,
    sid,
    &tool_description,
    "completed",
    Some("tool executed successfully"),
    None::<&str>,
);
```

This should go after the tool's return value is prepared but before the `return` statement. The `tool_description` should be a short description of what the tool did — for `download_file` it's the URL, for `run_shell` it's the command snippet, for file tools it's the file path.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/chat/dispatch.rs
git commit -m "feat: emit plan-step-progress on tool completion in dispatch"
```

---

### Task 10: Backend — TodoWrite Parsing in Harness Sessions

**Files:**
- Modify: `src-tauri/src/agent_sessions.rs`

**Interfaces:**
- Consumes: `emit_plan_step_progress` from Task 8
- Produces: structured plan-step events from TodoWrite tool calls instead of generic "Updating task list" markers

- [ ] **Step 1: Add import**

At the top of `src-tauri/src/agent_sessions.rs`, add after existing imports:

```rust
use crate::chat::tasks::emit_plan_step_progress;
```

- [ ] **Step 2: Parse TodoWrite JSON and emit plan-step events**

In the `tool_meta_generic` function (around line 1537), replace the `TodoWrite` match arm:

**Before (line 1537):**
```rust
"TodoWrite" | "todowrite" => json!({ "kind": "tool", "title": "Updating task list" }),
```

**After:**
```rust
"TodoWrite" | "todowrite" => {
    // Parse TodoWrite JSON content to extract individual task items
    // and emit plan-step-progress events for the frontend to track.
    // Expected format: {"todos": [{"content": "...", "status": "completed"|"pending"|"in_progress"}, ...]}
    if let Some(todos) = args.get("todos").and_then(|v| v.as_array()) {
        if let Some(app) = app_for_emit {
            for todo in todos {
                let content = todo.get("content")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let status = todo.get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("pending");
                if !content.is_empty() {
                    emit_plan_step_progress(
                        &app,
                        sid,
                        content,
                        status,
                        None,
                        None::<&str>,
                    );
                }
            }
        }
    }
    json!({ "kind": "tool", "title": "Updating task list" })
}
```

Note: `app_for_emit` may not be available in this scope — if not, capture the `AppHandle` from the calling function and pass it through to `tool_meta_generic`. Check the function signature and callers. If it's not accessible, skip the emit here and just keep the existing marker — the TodoWrite JSON content will be picked up by the frontend text scanner as a fallback.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/agent_sessions.rs
git commit -m "feat: parse TodoWrite content → plan-step-progress events"
```

---

### Task 11: Integration — Compile & Verify

**Files:**
- (Inspect) All files above

- [ ] **Step 1: Build the frontend**

```bash
npm run build
```
Expected: no TypeScript errors. Fix any that occur.

- [ ] **Step 2: Build the backend**

```bash
cd src-tauri && cargo check 2>&1
```
Expected: no Rust compilation errors. Fix any that occur.

- [ ] **Step 3: Run dev server and verify visually**

```bash
npx tauri dev
```

Expected: app launches. The Git sidebar Progress section shows "No progress yet." when no plan steps exist. Send a message that triggers a plan (e.g., "Plan out how to add a dark mode toggle") and verify that plan steps appear in the Progress section after the model responds.

- [ ] **Step 4: Verify completion detection**

Continue the conversation after the plan — ask the model to execute the first step. After a tool executes or the assistant messages completion text, verify the corresponding step gets marked ✓ in the Progress section.

- [ ] **Step 5: Final commit if any fixes were made**

```bash
git add -A
git commit -m "chore: integration fixes for plan-step progress tracking"
```
