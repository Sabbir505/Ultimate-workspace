// Plans slice: plan steps, the model's authoritative todo list, plan mode,
// harness permission-mode/effort labels, and the present_plan approval cards.
import {
  resolvePlanProposal,
  setChatSessionPermissionMode,
  setChatSessionPlanMode,
  toastError,
  updateChatSessionEffort,
} from "../../../lib/ipc";
import type {
  ChatPlanAcceptedPayload,
  ChatPlanModePayload,
  ChatPlanProposalPayload,
  ChatPlanUpdatedPayload,
  PlanTodo,
} from "../../../lib/ipc";
import { omitKey, patchSessions, resolvePendingCard } from "../moduleState";
import type { PlanStep } from "../types";
import type { ChatStoreGet, ChatStoreSet } from "../types";

export function createPlansSlice(set: ChatStoreSet, get: ChatStoreGet) {
  return {
    setPlanSteps: (chatSessionId: string, steps: PlanStep[]) => {
      set((s) => ({
        planSteps: { ...s.planSteps, [chatSessionId]: steps },
      }));
    },

    onPlanStepProgress: (chatSessionId: string, stepId: string, status: PlanStep["status"], detail?: string, toolCall?: string) => {
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
        // Set the first pending step as in_progress when the active one completes
        const hasActive = updated.some((st) => st.status === "in_progress");
        if (!hasActive && status === "completed") {
          const nextPendingIdx = updated.findIndex((st) => st.status === "pending");
          if (nextPendingIdx !== -1) {
            const next = updated[nextPendingIdx];
            updated[nextPendingIdx] = { ...next, status: "in_progress" };
          }
        }
        return { planSteps: { ...s.planSteps, [chatSessionId]: updated } };
      });
    },

    setSessionPermissionMode: async (chatSessionId: string, mode: string) => {
      // Optimistic label; the harness spawn reads the persisted row per turn.
      set((s) => ({
        sessions: patchSessions(s.sessions, chatSessionId, { permissionMode: mode }),
      }));
      try {
        await setChatSessionPermissionMode(chatSessionId, mode);
      } catch (err) {
        toastError("Couldn't switch the harness mode", err);
      }
    },

    setSessionEffort: async (chatSessionId: string, effort: string) => {
      // Optimistic tier; the backend applies it at spawn (per-turn CLIs on the
      // next send, claude via respawn) — no live channel, mirroring the mode.
      set((s) => ({
        sessions: patchSessions(s.sessions, chatSessionId, { effortLevel: effort }),
      }));
      try {
        await updateChatSessionEffort(chatSessionId, effort);
      } catch (err) {
        toastError("Couldn't change the effort level", err);
      }
    },

    onPlanUpdated: (payload: ChatPlanUpdatedPayload) => {
      const { chatSessionId, todos } = payload;
      set((s) => {
        // The todo list is authoritative when present — mirror it into planSteps
        // (replacing any todo_write-sourced steps, keeping prose-parsed ones) so
        // the Git sidebar Progress section renders the same state.
        const parsed = (s.planSteps[chatSessionId] ?? []).filter((st) => st.source !== "todo_write");
        const mirrored: PlanStep[] = todos.map((t, i) => ({
          stepId: `todo-${chatSessionId}-${i}`,
          label: t.content,
          status: t.status,
          source: "todo_write",
          planIndex: 0,
          stepIndex: i,
          completedAt: t.status === "completed" ? Date.now() : undefined,
        }));
        return {
          sessionTodos: { ...s.sessionTodos, [chatSessionId]: todos },
          planSteps: { ...s.planSteps, [chatSessionId]: [...parsed, ...mirrored] },
        };
      });
    },

    onPlanMode: (payload: ChatPlanModePayload) => {
      set((s) => ({
        planMode: { ...s.planMode, [payload.chatSessionId]: payload.active },
        // Mirror the persisted label onto the session record so the composer's
        // mode selector (which reads session.permissionMode) shows "plan" while
        // active and the restored posture after exit — including when the flip
        // was model-initiated (enter_plan_mode) or came from an approval.
        sessions: s.sessions.map((sess) =>
          sess.id === payload.chatSessionId && payload.label
            ? { ...sess, permissionMode: payload.label }
            : sess,
        ),
      }));
    },

    setSessionPlanMode: async (chatSessionId: string, active: boolean) => {
      const prev = get().planMode[chatSessionId] ?? false;
      if (prev === active) return;
      // Optimistic: flip the flag; on entry the label becomes "plan" (on exit
      // the event carries the restored posture label — local IPC, so the gap
      // is imperceptible).
      set((s) => ({
        planMode: { ...s.planMode, [chatSessionId]: active },
        sessions: s.sessions.map((sess) =>
          sess.id === chatSessionId && active
            ? { ...sess, permissionMode: "plan" }
            : sess,
        ),
      }));
      try {
        await setChatSessionPlanMode(chatSessionId, active);
      } catch (err) {
        set((s) => ({
          planMode: { ...s.planMode, [chatSessionId]: prev },
        }));
        toastError("Couldn't switch plan mode", err);
      }
    },

    onPlanProposal: (payload: ChatPlanProposalPayload) => {
      set((s) => ({
        pendingPlanProposals: {
          ...s.pendingPlanProposals,
          [payload.chatSessionId]: {
            pendingId: payload.pendingId,
            title: payload.title,
            plan: payload.plan,
          },
        },
      }));
    },

    onPlanAccepted: (payload: ChatPlanAcceptedPayload) => {
      set((s) => ({
        sessionPlans: {
          ...s.sessionPlans,
          [payload.chatSessionId]: [
            payload.plan,
            ...(s.sessionPlans[payload.chatSessionId] ?? []),
          ],
        },
      }));
    },

    onPlanProposalResolved: (chatSessionId: string) =>
      set((s) => ({ pendingPlanProposals: omitKey(s.pendingPlanProposals, chatSessionId) })),

    resolvePlanProposal: async (chatSessionId: string, approved: boolean, feedback?: string) => {
      // The turn is still paused on the proposal — if the IPC fails the card
      // goes back so the user can retry instead of hanging the turn (audit M3).
      await resolvePendingCard(
        get,
        set,
        "pendingPlanProposals",
        chatSessionId,
        "Couldn't deliver the plan decision",
        (pending) => resolvePlanProposal(pending.pendingId, approved, feedback),
      );
    },
  };
}
