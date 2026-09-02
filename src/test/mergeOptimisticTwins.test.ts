// mergeOptimistic twin matching (state/chat) — the optimistic just-sent row
// must be dropped when its persisted twin lands in a refetch, for EVERY
// attachment kind. The optimistic note for docs is `[Attached file: NAME]`
// while the backend persists `Attached file: NAME` + a fenced block with the
// EXTRACTED body (unreproducible client-side); exact-content matching
// stranded the optimistic row next to its twin, so the same user message
// rendered twice after every doc/text send (user card, assistant turn, user
// card again).
import { describe, expect, it } from "vitest";
import type { ChatMessageRecord } from "../lib/ipc";
import { mergeOptimistic } from "../state/chat";

const row = (id: number, role: "user" | "assistant", content: string): ChatMessageRecord => ({
  id,
  chatSessionId: "s1",
  role,
  content,
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  createdAt: 1,
  startedAt: null,
  completedAt: null,
});

const OPTIMISTIC_TEXT = "please summarize\n\n[Attached file: Pasted text.txt]";
const PERSISTED_TEXT =
  "please summarize\n\nAttached file: Pasted text.txt\n```\n# Relay backlog\n…\n```";
const OPTIMISTIC_DOC = "read this\n\n[Attached file: report.docx]";
const PERSISTED_DOC =
  "read this\n\nAttached file: report.docx\n```\n(extracted doc body)\n```";

describe("mergeOptimistic attachment twins", () => {
  it("drops the optimistic doc row once its fenced persisted twin lands", () => {
    const optimistic = [row(-1, "user", OPTIMISTIC_DOC)];
    const fetched = [row(10, "user", PERSISTED_DOC), row(11, "assistant", "ok")];
    const merged = mergeOptimistic(optimistic, fetched);
    expect(merged).toHaveLength(2);
    expect(merged.every((m) => m.id >= 0)).toBe(true);
  });

  it("drops the optimistic text row whose folding now mirrors the backend", () => {
    const optimistic = [row(-1, "user", OPTIMISTIC_TEXT)];
    const fetched = [row(10, "user", PERSISTED_TEXT), row(11, "assistant", "done")];
    expect(mergeOptimistic(optimistic, fetched)).toHaveLength(2);
  });

  it("keeps image-marker sends deduping as before", () => {
    const optimistic = [row(-1, "user", "shot\n\n[Attached image: image.png]")];
    const fetched = [row(10, "user", "shot\n\n[Attached image: image.png]")];
    expect(mergeOptimistic(optimistic, fetched)).toHaveLength(1);
  });

  it("keeps optimistic rows with NO persisted twin (pre-persist refetch)", () => {
    const optimistic = [row(-1, "user", OPTIMISTIC_DOC)];
    const fetched = [row(9, "user", "an older message")];
    const merged = mergeOptimistic(optimistic, fetched);
    expect(merged).toHaveLength(2);
    expect(merged.some((m) => m.id === -1)).toBe(true);
  });

  it("does not strand unrelated optimistic rows (different base text)", () => {
    const optimistic = [row(-1, "user", "different question\n\n[Attached file: a.txt]")];
    const fetched = [row(10, "user", PERSISTED_TEXT)];
    expect(mergeOptimistic(optimistic, fetched)).toHaveLength(2);
  });
});
