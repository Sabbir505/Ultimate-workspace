// Perf slice: session aggregate metrics + the live per-turn perf snapshot +
// citation-integrity verdicts.
import { getChatSessionMetrics } from "../../../lib/ipc";
import type { ChatCitationReportPayload, ChatPerfPayload } from "../../../lib/ipc";
import { omitKey } from "../moduleState";
import type { ChatStoreGet, ChatStoreSet } from "../types";

export function createPerfSlice(set: ChatStoreSet, get: ChatStoreGet) {
  return {
    loadSessionMetrics: async (chatSessionId: string) => {
      // Best-effort (call sites fire this with `void`): a rejection here must
      // not surface as an unhandled rejection — keep the previous aggregate.
      let metrics: Awaited<ReturnType<typeof getChatSessionMetrics>> = null;
      try {
        metrics = await getChatSessionMetrics(chatSessionId);
      } catch {
        return;
      }
      set((s) => {
        if (!metrics) {
          const next = { ...s.sessionMetrics };
          delete next[chatSessionId];
          return { sessionMetrics: next };
        }
        return { sessionMetrics: { ...s.sessionMetrics, [chatSessionId]: metrics } };
      });
    },

    onPerf: (payload: ChatPerfPayload) => {
      // Ignore stragglers: a perf event emitted just before an abort can cross
      // IPC AFTER cancelStream/onDone cleared the entry. Re-creating it here
      // would seed the NEXT turn's live timer with the OLD turn's elapsed
      // (elapsedMs resets to 0 on the new turn, and the display's monotonic
      // guard then froze the stale value on screen). Only a session that is
      // actually streaming may hold a live perf snapshot.
      if (!(payload.chatSessionId in get().streaming)) return;
      set((s) => ({
        livePerf: { ...s.livePerf, [payload.chatSessionId]: payload },
      }));
    },

    onCitationReport: (payload: ChatCitationReportPayload) => {
      set((s) => ({
        citationReports: { ...s.citationReports, [payload.chatSessionId]: payload },
      }));
    },

    /** Drop the session's citation verdict — the "Fix citations" action calls
     *  this when it dispatches the repair turn, so the strip disappears while
     *  the fix runs. If the repaired turn produces a report of its own, the
     *  fresh verdict replaces this (and the strip re-renders accordingly). */
    clearCitationReport: (chatSessionId: string) => {
      set((s) => {
        if (!(chatSessionId in s.citationReports)) return {};
        const next = { ...s.citationReports };
        delete next[chatSessionId];
        return { citationReports: next };
      });
    },
  };
}
