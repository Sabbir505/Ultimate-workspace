## Goal

Implement a single `/goal` slash command (with `/loop` as an alias) in the Chat UI for long-running tasks. Invoking `/goal <description>` starts an autonomous, UI-driven iteration loop: Conduit sends the goal, and after each assistant turn completes it inspects the reply for a completion sentinel and automatically issues follow-up turns until the goal is done (or an iteration cap is hit), showing a visible iteration counter.

This is a **frontend-driven loop** — no new backend scheduler. It reuses Conduit's existing skill-injection path and the `onDone`/`drainQueue` turn pipeline.

## Design overview

### 1. Built-in `/goal` + `/loop` skills (backend)
Add two built-in skills to `src-tauri/src/installed_skills.rs::builtins()`, both leaning on a single prompt file. Both slugs must be registered so they (a) appear in the chat `/` popup and (b) get injected as a system-prompt skill when invoked via the existing `parse_invoked_skills` path (no new injection code).

- `slug: "goal"` → name "Run a goal-driven loop" role=... 
- `slug: "loop"` → name "Run an autonomous work loop" (alias)
- Body (new `src-tauri/skills/goal-loop-skill.md`): instructs the agent to work toward the user's stated goal in iterative passes and to end **each reply** with a machine-readable sentinel line:
  `LOOP_STATUS: continue|complete|blocked`
  plus a one-line status summary and what remains. Emphasize: stay autonomous, re-check the goal each pass, keep working until `complete`, never stall, and always emit exactly one `LOOP_STATUS` line on the final line of the reply.

Both builtin bodies come from the same `include_str!("../../skills/goal-loop-skill.md")`.

### 2. Loop state + actions (frontend store — `src/state/chat.ts`)
Add per-session loop tracking to the chat store:

```ts
interface LoopState {
  goal: string;
  iteration: number;   // turns/replies completed so far
  max: number;         // default 10
  active: boolean;
}
// state: loopState: Record<string, LoopState>
```

Actions:
- `startLoop(goal: string): void` — arm the loop for the active session (iteration 0), used by `onSend` when content starts with `/goal` or `/loop`.
- `stopLoop(): void` — disarm/mark inactive (Stop button).
- `advanceLoop(chatSessionId, lastReply): "continue" | "complete" | "blocked" | "stop"` — called from `onDone`: if loop inactive or iteration >= max → `complete`; else parse the last assistant message's trailing `LOOP_STATUS` line → decide.

### 3. Loop continuation in `onDone` (`src/state/chat.ts`)
After the existing `drainQueue` call in `onDone`, add loop handling for the finishing session:
- Guard: only continue if `activeChatSessionId === chatSessionId` (loop pauses when the user switches away) and the loop is active and not already exhausted.
- Increment `iteration`.
- Parse the just-completed assistant reply (final message in `messages`) for `LOOP_STATUS`.
  - `continue` → `advanceLoop` returns continue → auto-send the next iteration via `sendMessage` with a clear body like:
    `[loop iteration {n+1}/{max}] Continue working toward the goal. Do exactly the next work that remains (from the previous status summary), then end with LOOP_STATUS.`
  - `complete` or `blocked` or missing sentinel → mark loop inactive (missing sentinel = graceful stop, never infinite-loop).
- Keep `onDone`'s queued/auto-title/metrics behavior untouched; the loop continuation is added after `drainQueue`. A `chat:error` during an iteration also disarms the loop (see `onError`).

### 4. `/goal` / `/loop` expansion at send time (`src/components/chat/ChatView.tsx` + `ChatComposer`)
- In `handleSend` (ChatView), detect a leading `/goal ` or `/loop ` token in the content. Strip it into a `goal` string and call `useChatStore.getState().startLoop(goal)` before `sendMessage(...)` so the (already-slash-stripped) message is plain text and the loop arms. (Keep the slash out of the persisted user bubble; the skill body is still injected because the *stored* `/goal` token would otherwise be lost — see note below.)

**Injection note:** `parse_invoked_skills` matches the literal `/goal` token in the persisted message, so we must NOT fully strip it. Instead: keep `/goal` (or `/loop`) as the first token of the sent user message so injection works, and pass the remaining text as the goal. Concretely: send `content` unchanged (still starts with `/goal …`), storing the goal string for the loop tracker separately. The assistant replies via the injected sentinel protocol.

### 5. Visible iteration UI (`src/components/chat/ChatView.tsx`)
Render a slim "loop chip" above the composer when `loopState[activeChatSessionId]?.active`:
- Text: `🔁 Goal loop — iteration {iteration}/{max}`
- A **Stop** button that calls `stopLoop()`.
- A brief hint of the goal (truncated).
Reuses existing composer-area styles/classes (e.g. the `composer-queue` row pattern).

### 6. Safety / lifecycle rules
- Iteration cap default `max = 10` (constant in chat.ts).
- Pause on session switch (active-session guard), resume on switch-back via `selectSession` → also run loop resumption (or just let the next `onDone` pick it up).
- Disarm on manual `cancelStream`/`onError` so a stopped/ errored loop never keeps firing.
- If the model omits `LOOP_STATUS`, treat as complete (no infinite loop).

## Files touched
- `src-tauri/src/installed_skills.rs` — add `goal`/`loop` builtins.
- `src-tauri/skills/goal-loop-skill.md` — new prompt body.
- `src/state/chat.ts` — `LoopState`, `startLoop`/`stopLoop`/`advanceLoop`, loop handling in `onDone` (+ disarm in `onError`/`cancelStream`).
- `src/components/chat/ChatView.tsx` — detect `/goal|/loop` in `handleSend`, start loop, render iteration chip + Stop.
- Possibly `src/components/chat/ChatComposer.tsx` — only if the chip belongs there; default is to keep it in ChatView.

## Verification
- `npm run build` (vite + tsc) passes.
- `npm test` (vitest) — add a focused test for `advanceLoop` parse logic (`continue`/`complete`/`blocked`/missing/cap) and for `onDone` continuation triggering `sendMessage` on `continue`.
- `cargo test` for the new builtins (skills library tests already cover `builtins()` indirectly; add assertion that `/goal`/`/loop` resolve from `list_all_skills` and `parse_invoked_skills`).