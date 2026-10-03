// Approvals slice: tool-approval + harness-question cards, background task
// progress, and per-turn checkpoint chips.
import {
  cancelAgentChatMessage,
  cancelChatMessage,
  finishArtifactRuns,
  getChatMessages,
  loopSessionFinish,
  resolveAgentQuestion,
  resolveToolAction,
} from "../../../lib/ipc";
import type {
  ChatCheckpoint,
  ChatMessageRecord,
  ChatTaskProgressPayload,
} from "../../../lib/ipc";
import {
  appendUserBubble,
  bufferTargetFor,
  bufferWriteBack,
  isCliAgent,
  optimisticMsgIdCounter,
  persistPartialAndClearStream,
  resolvePendingCard,
} from "../moduleState";
import type { ChatStoreGet, ChatStoreSet } from "../types";

/** Mirror of the backend's `compose_ask_display` (agent_sessions/ask.rs):
 *  the clean answer text the follow-up turn persists as its user message.
 *  The optimistic bubble below must match that string EXACTLY or
 *  mergeOptimistic keeps both when the persisted row lands. */
function answerDisplayText(
  answers: Record<string, string | string[]>,
  response?: string,
): string {
  const skipped = !response?.trim() && Object.keys(answers).length === 0;
  const parts: string[] = [];
  if (!skipped) {
    for (const v of Object.values(answers)) {
      if (Array.isArray(v)) {
        if (v.length > 0) parts.push(v.join(", "));
      } else if (v.trim().length > 0) {
        parts.push(v);
      }
    }
    const free = response?.trim();
    if (free) parts.push(free);
  }
  return parts.length > 0 ? parts.join("\n") : "(skipped the question)";
}

export function createApprovalsSlice(set: ChatStoreSet, get: ChatStoreGet) {
  return {
    resolveApproval: async (
      chatSessionId: string,
      approved: boolean,
      selected?: number[],
      always?: boolean,
    ) => {
      // Optimistic removal avoids a flicker if the backend's
      // `chat:approval-resolved` event is slow. `selected` is the
      // confirm-edits partial accept (§4.2.5): the occurrence indexes the
      // user kept on the review card — omitted = accept everything. `always`
      // is the card's "always allow" tick; the backend persists a directory
      // grant ONLY for that variant (audit H6).
      await resolvePendingCard(
        get,
        set,
        "pendingApprovals",
        chatSessionId,
        "Couldn't deliver the approval decision",
        (pending) => resolveToolAction(pending.pendingId, approved, selected, always),
      );
    },

    onApprovalRequest: ({ chatSessionId, pendingId, tool, summary, args }: { chatSessionId: string; pendingId: string; tool: string; summary: string; args: unknown }) => {
      // Surface the per-action approval card for this session. Only one card is
      // shown at a time (the tool loop pauses on it); a new request replaces any
      // stale one (the prior would already have been resolved or cancelled).
      set((s) => ({
        pendingApprovals: {
          ...s.pendingApprovals,
          [chatSessionId]: { pendingId, tool, summary, args },
        },
      }));
    },

    onApprovalResolved: ({ chatSessionId }: { chatSessionId: string }) => {
      // The backend resumed the paused tool loop — dismiss the card.
      set((s) => {
        const next = { ...s.pendingApprovals };
        delete next[chatSessionId];
        return { pendingApprovals: next };
      });
    },

    onQuestionRequest: ({ chatSessionId, pendingId, questions }: { chatSessionId: string; pendingId: string; questions: unknown }) => {
      // Surface the question card. Only one at a time (the harness blocks on
      // it); a new request replaces any stale one.
      const parsed = Array.isArray(questions) ? questions : [];
      set((s) => ({
        pendingQuestions: {
          ...s.pendingQuestions,
          [chatSessionId]: { pendingId, questions: parsed },
        },
      }));
    },

    resolveQuestion: async (chatSessionId: string, answers: Record<string, string | string[]>, response?: string) => {
      // The harness is still blocked on stdin — if the IPC fails the card goes
      // back so the turn can't hang silently.
      const display = answerDisplayText(answers, response);
      await resolvePendingCard(
        get,
        set,
        "pendingQuestions",
        chatSessionId,
        "Couldn't deliver the answer",
        (pending) => resolveAgentQuestion(chatSessionId, pending.pendingId, answers, response),
      );
      // Surface the answer as a user bubble immediately: the follow-up turn
      // dispatches on a backend thread, so without this nothing in the
      // transcript shows the answer landed until the assistant's NEXT reply
      // arrived. The persisted row (written inside the backend's send) carries
      // the exact same text, so mergeOptimistic swaps this twin out when the
      // turn's refetch lands. Only a VIEWING pane gets the bubble — a
      // background session's answer surfaces when that chat is opened (same
      // contract as broadcastToSessions).
      const s = get();
      if (bufferTargetFor(s, chatSessionId) == null) return;
      const userMsg: ChatMessageRecord = {
        id: optimisticMsgIdCounter.next--,
        chatSessionId,
        role: "user",
        content: display,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        createdAt: Date.now(),
        startedAt: null,
        completedAt: null,
      };
      set((st) => ({ ...appendUserBubble(st, chatSessionId, userMsg) }));
    },

    skipQuestion: async (chatSessionId: string) => {
      // Skip DISMISSES the question and STOPS the turn — it does not answer.
      // Answering an empty card used to resume the harness instead: the
      // RELAY_ASK path dispatched a whole follow-up turn ("the user dismissed
      // the question — continue with your best judgment"), the Claude Code
      // control protocol resumed on stdin, and opencode got a reject that let
      // the model proceed. The user asked for the run to end there.
      //
      // The cancel is what makes that true: agent_sessions' cancel drops the
      // pending ask (so no follow-up turn is ever dispatched) and the pending
      // question, and kills the paused CLI process. Unlike resolveQuestion it
      // writes NO user bubble — nothing was said to the agent.
      const session = get().sessions.find((s) => s.id === chatSessionId);
      let stopped = "";
      // Set only once the cancel IPC resolved. `resolvePendingCard` swallows a
      // failure (restoring the card and toasting), so this is what
      // distinguishes "the turn really was stopped" from "the stop failed" —
      // on failure the turn is still running backend-side and must keep its
      // side effects.
      let cancelled = false;
      await resolvePendingCard(
        get,
        set,
        "pendingQuestions",
        chatSessionId,
        "Couldn't dismiss the question",
        async () => {
          // Skip is Stop, and Stop's first half is persisting what the turn had
          // already streamed: the paused harness's buffer dies with the
          // process, so cancelling without this made the assistant bubble the
          // user was reading disappear along with it.
          stopped = await persistPartialAndClearStream(get, set, chatSessionId);
          if (isCliAgent(session?.agent)) {
            await cancelAgentChatMessage(chatSessionId);
          } else {
            await cancelChatMessage(chatSessionId);
          }
          cancelled = true;
        },
      );
      // Keep the stopped turn's bubble showing what it produced, so the row
      // keeps its process section expanded instead of collapsing to an empty
      // "Worked" — same treatment the Stop button gives it. Queued messages are
      // deliberately NOT drained: skip means the run ends here.
      if (stopped) {
        set((s) => ({
          stoppedPartial: { ...s.stoppedPartial, [chatSessionId]: stopped },
        }));
      }

      // Skip ends a turn exactly the way Stop does, so it owes the same three
      // side effects. The cancel path emits NO terminal event, so nothing else
      // performs them:
      //  - the loop stays armed, and the next ordinary turn's onDone would see
      //    it and auto-dispatch the "/loop iteration N/M — continue" follow-up
      //    the user just tried to stop;
      //  - the turn's artifact runs stay open forever in the self-improving
      //    artifacts ledger;
      //  - and the persisted partial never re-enters the transcript buffer, so
      //    the text the user was reading vanishes until the next send/reload
      //    (the live bubble was torn down, and nothing else reads the backend
      //    row back).
      // All three are conditioned on the cancel SUCCEEDING, not on whether the
      // turn had streamed anything: a /goal run that asks its question straight
      // away still has to be disarmed.
      if (!cancelled) return;
      const loop = get().loopState[chatSessionId];
      if (loop && loop.active) {
        if (loop.backendId) void loopSessionFinish(loop.backendId, "stopped").catch(() => {});
        set((s) => ({
          loopState: { ...s.loopState, [chatSessionId]: { ...loop, active: false } },
        }));
      }
      void finishArtifactRuns(chatSessionId, "abandoned").catch(() => {});
      try {
        // Same 200-row page cap and bufferWriteBack contract as cancelStream.
        const messages = await getChatMessages(chatSessionId, undefined, 200);
        if (messages) {
          set((s) => bufferWriteBack(s, chatSessionId, messages, { merge: true }));
        }
      } catch {
        /* best-effort refresh */
      }
    },

    onCheckpointCreated: (payload: ChatCheckpoint) => {
      // Baselines / safety snapshots (messageId null) have no bubble to hang a
      // chip on — they sit in the backend timeline until a restore needs them.
      const mid = payload.messageId;
      if (mid == null) return;
      set((s) => {
        const existing = s.checkpointsByMessage[mid] ?? [];
        if (existing.some((c) => c.id === payload.id)) return {};
        return {
          checkpointsByMessage: { ...s.checkpointsByMessage, [mid]: [...existing, payload] },
        };
      });
    },

    onTaskProgress: (payload: ChatTaskProgressPayload) => {
      const { chatSessionId, taskId, kind, state, message, downloaded, total, speedBps, destPath } = payload;
      set((s) => {
        const sessionTasks = { ...(s.tasks[chatSessionId] ?? {}) };
        sessionTasks[taskId] = { taskId, kind, state, message, downloaded, total, speedBps, destPath };
        return { tasks: { ...s.tasks, [chatSessionId]: sessionTasks } };
      });
    },

    // Drop a finished task's card. The card calls this after its fade-out
    // (auto-dismiss on success, click on a terminal card) — without it the
    // task map only ever grows, so every download the agent ever ran stayed
    // on screen for the life of the session.
    removeTask: (chatSessionId: string, taskId: string) => {
      set((s) => {
        const sessionTasks = s.tasks[chatSessionId];
        if (!sessionTasks || !(taskId in sessionTasks)) return {};
        const next = { ...sessionTasks };
        delete next[taskId];
        return { tasks: { ...s.tasks, [chatSessionId]: next } };
      });
    },
  };
}
