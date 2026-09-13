// Goal-loop slice (/goal / /loop): arm/disarm/advance per-session loops.
import { loopSessionAdvance, loopSessionFinish, loopSessionStart } from "../../../lib/ipc";
import { GOAL_LOOP_MAX, parseLoopStatus } from "../moduleState";
import type { ChatStoreGet, ChatStoreSet, LoopDecision } from "../types";

export function createLoopsSlice(set: ChatStoreSet, get: ChatStoreGet) {
  return {
    startLoop: (goal: string, sessionIdOverride?: string) => {
      const id = sessionIdOverride ?? get().activeChatSessionId;
      if (!id) return;
      set((s) => ({
        loopState: {
          ...s.loopState,
          [id]: { goal, iteration: 0, max: GOAL_LOOP_MAX, active: true, startedAt: Date.now() },
        },
      }));
      // Persist the loop session (run telemetry + survival across restarts).
      // Fire-and-forget: telemetry must never block arming the loop.
      void loopSessionStart(id, goal, GOAL_LOOP_MAX)
        .then((ls) => {
          if (!ls) return;
          set((s) => {
            const cur = s.loopState[id];
            if (!cur) return {};
            return { loopState: { ...s.loopState, [id]: { ...cur, backendId: ls.id } } };
          });
        })
        .catch(() => {});
    },

    stopLoop: (sessionIdOverride?: string) => {
      const id = sessionIdOverride ?? get().activeChatSessionId;
      if (!id) return;
      set((s) => {
        const cur = s.loopState[id];
        if (!cur) return {};
        if (cur.active && cur.backendId) {
          void loopSessionFinish(cur.backendId, "stopped").catch(() => {});
        }
        return { loopState: { ...s.loopState, [id]: { ...cur, active: false } } };
      });
    },

    advanceLoop: (chatSessionId: string, lastReply: string): LoopDecision => {
      const cur = get().loopState[chatSessionId];
      // No loop armed for this session — nothing to do.
      if (!cur || !cur.active) return "stop";
      const nextIter = cur.iteration + 1;
      const status = parseLoopStatus(lastReply);
      // Cap reached: stop regardless of what the model said, so a runaway can
      // never drive past the safety rail. Mark complete so onDone's caller
      // treats this as a final stop.
      if (nextIter >= cur.max) {
        set((s) => ({
          loopState: { ...s.loopState, [chatSessionId]: { ...cur, iteration: nextIter, active: false } },
        }));
        if (cur.backendId) void loopSessionFinish(cur.backendId, "maxed").catch(() => {});
        return "stop";
      }
      if (status === "continue") {
        set((s) => ({
          loopState: { ...s.loopState, [chatSessionId]: { ...cur, iteration: nextIter } },
        }));
        if (cur.backendId) void loopSessionAdvance(cur.backendId, nextIter).catch(() => {});
        return "continue";
      }
      // complete | blocked | stop: end the loop.
      set((s) => ({
        loopState: { ...s.loopState, [chatSessionId]: { ...cur, iteration: nextIter, active: false } },
      }));
      if (cur.backendId) {
        const terminal = status === "complete" ? "complete" : status === "blocked" ? "blocked" : "stopped";
        void loopSessionFinish(cur.backendId, terminal).catch(() => {});
      }
      return status === "complete" ? "complete" : status === "blocked" ? "blocked" : "stop";
    },
  };
}
