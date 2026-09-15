// Approvals slice: tool-approval + harness-question cards, background task
// progress, and per-turn checkpoint chips.
import {
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
  optimisticMsgIdCounter,
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
    resolveApproval: async (chatSessionId: string, approved: boolean) => {
      // Optimistic removal avoids a flicker if the backend's
      // `chat:approval-resolved` event is slow.
      await resolvePendingCard(
        get,
        set,
        "pendingApprovals",
        chatSessionId,
        "Couldn't deliver the approval decision",
        (pending) => resolveToolAction(pending.pendingId, approved),
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
  };
}
