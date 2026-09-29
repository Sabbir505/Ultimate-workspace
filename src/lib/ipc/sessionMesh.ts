// Extracted domain of lib/ipc.ts (see its header). Command names and
// payload shapes are binding (CONTRACT.md).
//
// Session Mesh events (SESSION_MESH_DESIGN_ARCHITECTURE.md §5.3/§6.2):
// cross-session mail transitions and spawn notices. ONE mail event covers
// both parties — the store routes it into each session's list by id.
import { safeListen } from "../ipcCore";

/** Mirrors crate::types::SessionMailPayload. */
export interface SessionMailPayload {
  mailId: string;
  fromSession: string;
  fromTitle: string;
  toSession: string;
  toTitle: string;
  /** "question" | "notify" */
  mode: string;
  /** queued | delivered | answered | expired | rejected */
  status: string;
  bodyExcerpt: string;
  answerExcerpt?: string | null;
  depth: number;
}

/** Mirrors crate::types::SessionSpawnPayload.
 *
 *  `parentSessionId` is OPTIONAL (research doc §F.5): a subagent run spawned by
 *  hand (Phase 2.5, `run_subagent`) emits this same event with no parent —
 *  its `origin` stays NULL because `spawned_by:<id>` is the mesh's own
 *  provenance vocabulary. `parentSessionId == null` therefore means "NOT a mesh
 *  child", and meshSlice routes those to the subagent runs list instead of keying
 *  `meshChildren` under a phantom parent. `agentId` is the subagent definition
 *  that produced the session (absent for a plain mesh spawn). Both use
 *  `skip_serializing_if = "Option::is_none"` on the Rust side, so an absent
 *  field is `undefined` here rather than `null`. */
export interface SessionSpawnPayload {
  parentSessionId?: string;
  childSessionId: string;
  title: string;
  agent: string;
  /** Model the child runs on (post subagent-model orchestration). */
  model?: string;
  /** The subagent definition backing this session, when there is one. */
  agentId?: string;
}

export const listenSessionMail = (handler: (payload: SessionMailPayload) => void) =>
  safeListen<SessionMailPayload>("chat:session-mail", handler);

export const listenSessionSpawn = (handler: (payload: SessionSpawnPayload) => void) =>
  safeListen<SessionSpawnPayload>("chat:session-spawn", handler);
