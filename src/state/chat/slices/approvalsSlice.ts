// Approvals slice: tool-approval + harness-question cards, background task
// progress, and per-turn checkpoint chips.
import {
  resolveAgentQuestion,
  resolveToolAction,
} from "../../../lib/ipc";
import type { ChatCheckpoint, ChatTaskProgressPayload } from "../../../lib/ipc";
import { resolvePendingCard } from "../moduleState";
import type { ChatStoreGet, ChatStoreSet } from "../types";

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
      await resolvePendingCard(
        get,
        set,
        "pendingQuestions",
        chatSessionId,
        "Couldn't deliver the answer",
        (pending) => resolveAgentQuestion(chatSessionId, pending.pendingId, answers, response),
      );
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
