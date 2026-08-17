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

  // Track the newest message id we've already parsed so we don't re-parse.
  // An INDEX watermark breaks twice: loadOlderMessages PREPENDS rows and
  // onDone replaces the 200-row page with a fresh fetch — both shift indices,
  // re-parsing already-seen messages with a new planIndex and duplicating
  // their steps. Message ids are persisted-DB autoincrement values, so "parse
  // only ids strictly greater than the watermark" is invariant under both.
  // Paired with the session id and reset on a session switch (A5).
  const parsedUpToId = useRef<number | null>(null);
  const parsedSessionId = useRef<string | null>(null);

  // Parse new plans from assistant messages
  useEffect(() => {
    if (parsedSessionId.current !== activeSessionId) {
      parsedSessionId.current = activeSessionId;
      parsedUpToId.current = null;
    }
    if (!activeSessionId) return;

    const currentSteps = planSteps[activeSessionId] ?? [];
    let nextPlanIndex = currentSteps.length > 0
      ? Math.max(...currentSteps.map((s) => s.planIndex))
      : 0;
    let foundNew = false;
    const allSteps = [...currentSteps];

    const upTo = parsedUpToId.current;
    let watermark = upTo;
    for (const m of messages) {
      if (upTo !== null && m.id <= upTo) continue; // already parsed
      if (m.role === "assistant") {
        const plan = extractPlanSection(m.content || "");
        if (plan) {
          nextPlanIndex++;
          const newSteps = parsePlanSteps(plan, activeSessionId, nextPlanIndex);
          if (newSteps.length > 0) {
            allSteps.push(...newSteps);
            foundNew = true;
          }
        }
      }
      // Only advance on persisted ids — optimistic bubbles use negative
      // temp ids and must not move the watermark.
      if (m.id > 0 && (watermark === null || m.id > watermark)) watermark = m.id;
    }
    parsedUpToId.current = watermark;

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
