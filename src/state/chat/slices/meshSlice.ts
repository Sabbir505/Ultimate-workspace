// Subagent + Session Mesh slice: live subagent panels and the cross-session
// mail/spawn events (chat:subagent-* / chat:session-mail / chat:session-spawn).
import type {
  SessionMailPayload,
  SessionSpawnPayload,
  SubagentDonePayload,
  SubagentSpawnPayload,
  SubagentTokenPayload,
} from "../../../lib/ipc";
import { tailCodePointsHysteresis } from "../../../lib/safeSlice";
import { MESH_MAIL_HISTORY_CAP, MESH_MAIL_RECORDS_CAP, STREAM_TAIL_CAP, STREAM_TAIL_MARGIN } from "../moduleState";
import type { ChatStoreGet, ChatStoreSet } from "../types";

export function createMeshSlice(set: ChatStoreSet, _get: ChatStoreGet) {
  return {
    onSubagentSpawn: (payload: SubagentSpawnPayload) => {
      set((s) => {
        const sessionSubagents = { ...(s.subagents[payload.chatSessionId] ?? {}) };
        sessionSubagents[payload.id] = {
          id: payload.id,
          role: payload.role,
          task: payload.task,
          prompt: payload.prompt,
          output: "",
          status: "running",
        };
        return { subagents: { ...s.subagents, [payload.chatSessionId]: sessionSubagents } };
      });
    },

    onSubagentTokens: (payload: SubagentTokenPayload) => {
      set((s) => {
        const sessionSubagents = s.subagents[payload.chatSessionId];
        const sub = sessionSubagents?.[payload.subagentId];
        if (!sessionSubagents || !sub) return {};
        // Same capped tail as the main token stream (onToken) — an uncapped
        // subagent output grows memory without bound (audit H3); same hysteresis
        // so per-chunk cost stays O(chunk) past the cap (audit A5).
        const output = tailCodePointsHysteresis(sub.output + payload.chunk, STREAM_TAIL_CAP, STREAM_TAIL_MARGIN);
        const updated = { ...sessionSubagents, [payload.subagentId]: { ...sub, output } };
        return { subagents: { ...s.subagents, [payload.chatSessionId]: updated } };
      });
    },

    onSubagentDone: (payload: SubagentDonePayload) => {
      set((s) => {
        const sessionSubagents = s.subagents[payload.chatSessionId];
        if (!sessionSubagents) return {};
        const existing = sessionSubagents[payload.id];
        if (!existing) return {};
        const status: "running" | "completed" | "error" = payload.error ? "error" : "completed";
        const updated = {
          ...sessionSubagents,
          [payload.id]: {
            ...existing,
            output: payload.output || existing.output,
            status,
            error: payload.error ?? existing.error,
          },
        };
        return { subagents: { ...s.subagents, [payload.chatSessionId]: updated } };
      });
    },

    // ---- Session Mesh (chat:session-mail / chat:session-spawn) ----

    onSessionMail: (payload: SessionMailPayload) => {
      set((s) => {
        // One event covers both parties; index the mail under each so the
        // sidebar shows the exchange from either session's perspective.
        const bySession = { ...s.meshMailBySession };
        for (const sid of [payload.fromSession, payload.toSession]) {
          const list = bySession[sid];
          bySession[sid] = list
            ? list.includes(payload.mailId)
              ? list
              : [...list, payload.mailId].slice(-MESH_MAIL_HISTORY_CAP)
            : [payload.mailId];
        }
        // Delivery means a turn is about to run in the target. onToken only
        // accumulates for sessions already present in `streaming` (it never
        // CREATES an entry — sendMessage/broadcast pre-create), so mesh turns
        // must pre-create here or every token is dropped and the chat view
        // shows nothing until done. Same shape broadcastToSessions uses.
        let streaming = s.streaming;
        let chatStatus = s.chatStatus;
        if (payload.status === "delivered" && !(payload.toSession in streaming)) {
          streaming = { ...streaming, [payload.toSession]: "" };
          chatStatus = { ...chatStatus, [payload.toSession]: { reason: "thinking", message: "" } };
        }
        // Cap total records (audit #7): per-session lists cap above, but the
        // mailId-keyed map itself grew for the app's lifetime. Oldest-inserted
        // records evict first; an updated mailId keeps its slot. The durable
        // audit trail is the DB — this is only the sidebar's cache.
        const meshMail = { ...s.meshMail, [payload.mailId]: payload };
        const mailIds = Object.keys(meshMail);
        if (mailIds.length > MESH_MAIL_RECORDS_CAP) {
          for (const stale of mailIds.slice(0, mailIds.length - MESH_MAIL_RECORDS_CAP)) {
            delete meshMail[stale];
          }
        }
        return {
          meshMail,
          meshMailBySession: bySession,
          streaming,
          chatStatus,
        };
      });
    },

    onSessionSpawn: (payload: SessionSpawnPayload) => {
      set((s) => {
        const list = s.meshChildren[payload.parentSessionId] ?? [];
        const nextChildren = list.some((c) => c.childId === payload.childSessionId)
          ? list
          : [
              ...list,
              { childId: payload.childSessionId, title: payload.title, agent: payload.agent },
            ];
        // The spawned session's first turn starts right after this event —
        // pre-create its streaming entry so its tokens stream (see
        // onSessionMail: onToken drops tokens for unknown sessions).
        const streaming = !(payload.childSessionId in s.streaming)
          ? { ...s.streaming, [payload.childSessionId]: "" }
          : s.streaming;
        const chatStatus = !(payload.childSessionId in s.chatStatus)
          ? { ...s.chatStatus, [payload.childSessionId]: { reason: "thinking", message: "" } }
          : s.chatStatus;
        return {
          meshChildren: { ...s.meshChildren, [payload.parentSessionId]: nextChildren },
          streaming,
          chatStatus,
        };
      });
    },
  };
}
