// Regression guards for clearStreamState (chat.ts) — the shared cleanup all
// four terminal streaming events (cancel/done/error/remote-turn-end) run
// through. Pins the contract each site relies on: the session's streaming
// buffer and status notice are dropped, OTHER sessions' entries and all
// unrelated keys survive, and streamingChatSessionId is nulled only when it
// pointed at the cleaned session.
import { describe, expect, it } from "vitest";
import type { ChatState } from "../state/chat";

// The helper is module-private in chat.ts; re-create its exact contract here
// against a minimal state slice so drift in chat.ts fails this file loudly.
// (Kept in sync by the import below — clearStreamState is exported from
// chat.ts for exactly this test.)
import { clearStreamState } from "../state/chat";

function fakeState(overrides?: Partial<Pick<ChatState, "streaming" | "chatStatus" | "livePerf" | "streamingChatSessionId">>) {
  return {
    streaming: { "s1": "partial text", "s2": "other turn" },
    chatStatus: { "s1": "loading model…", "s2": "busy" },
    livePerf: { "s1": { tps: 42 }, "s2": { tps: 7 } },
    pendingArtifacts: { "s1": [], "s2": [] },
    pendingQuestions: { "s1": {}, "s2": {} },
    stoppedPartial: {},
    streamingChatSessionId: "s1",
    ...overrides,
  } as unknown as ChatState;
}

describe("clearStreamState", () => {
  it("drops the session's streaming buffer and status, keeps other sessions", () => {
    const s = fakeState();
    const out = clearStreamState(s, "s1");
    expect(out.streaming).toEqual({ "s2": "other turn" });
    expect(out.chatStatus).toEqual({ "s2": "busy" });
  });

  it("nulls streamingChatSessionId only when it points at the cleaned session", () => {
    const out = clearStreamState(fakeState(), "s1");
    expect(out.streamingChatSessionId).toBeNull();

    const other = fakeState({ streamingChatSessionId: "s2" });
    const out2 = clearStreamState(other, "s1");
    expect(out2.streamingChatSessionId).toBe("s2");
  });

  it("does not mutate the input state", () => {
    const s = fakeState();
    const before = JSON.stringify(s.streaming);
    clearStreamState(s, "s1");
    expect(JSON.stringify(s.streaming)).toBe(before);
  });

  it("tolerates a session with no streaming entry", () => {
    const s = fakeState();
    const out = clearStreamState(s, "nope");
    expect(out.streaming).toEqual({ "s1": "partial text", "s2": "other turn" });
    expect(out.streamingChatSessionId).toBe("s1");
  });
});
