// B3 (ISSUES.md): the timeline item list used to be ONE useMemo that included
// `activeStream`, so every streaming token rebuilt EVERY item object (and its
// onDelete/onEdit closures) for all persisted messages. After the fix the
// persisted rows live in their own memo (messages/session/proposals/callbacks/
// epoch only) and the live/typing rows are appended in a second memo.
//
// Structural assertion: MessageBubble is memo'd — here it is replaced by a spy
// wrapped in a DEFAULT shallow memo. With stable persisted item identities a
// token flush produces identical props for persisted rows, so the shallow memo
// must skip them entirely; only the live row re-renders per token. (The real
// MessageBubble hides identity churn behind a custom value comparator, which
// is why the spy is what can observe the rebuild at all.)
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { bubbleRenders } = vi.hoisted(() => ({
  bubbleRenders: { persisted: 0, live: 0 },
}));

vi.mock("../components/chat/MessageBubble", async () => {
  const React = await import("react");
  const Bubble = (props: { live?: boolean; message?: { key?: string } }) => {
    if (props.live) bubbleRenders.live++;
    else bubbleRenders.persisted++;
    return React.createElement(
      "div",
      { "data-bubble": String(props.message?.key ?? "") },
      String((props.message as { content?: string } | undefined)?.content ?? ""),
    );
  };
  return { MessageBubble: React.memo(Bubble) };
});

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // Mount-time loaders (silence the real IPC wrappers).
  scanLocalModels: vi.fn(async () => []),
  localModelStatus: vi.fn(async () => null),
  getLocalModelOverrides: vi.fn(async () => ({})),
  countContextTokens: vi.fn(async () => null),
  listConnectors: vi.fn(async () => []),
  mcpGalleryList: vi.fn(async () => ({ installed: [] })),
  listSessionConnectors: vi.fn(async () => []),
  listChatSkills: vi.fn(async () => []),
  listPromptTemplates: vi.fn(async () => []),
}));

import { useChatStore } from "../state/chat";
import { ChatView } from "../components/chat/ChatView";

function msg(id: number, role: "user" | "assistant", content: string) {
  return {
    id,
    chatSessionId: "s1",
    role,
    content,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    createdAt: 0,
  } as never;
}

beforeAll(() => {
  // @tanstack/virtual skips the visible range entirely when the scroll
  // element reports size 0 (jsdom has no layout) — give every element a
  // nonzero box so the virtualizer materializes the rows.
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return 600;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return 800;
    },
  });
});

afterAll(() => {
  // @ts-expect-error restore the jsdom accessor for other suites in the file
  delete HTMLElement.prototype.offsetHeight;
  // @ts-expect-error restore the jsdom accessor for other suites in the file
  delete HTMLElement.prototype.offsetWidth;
});

beforeEach(() => {
  useChatStore.setState({
    activeChatSessionId: "s1",
    splitChatSessionId: null,
    loaded: true,
    config: { provider: "openai_compatible", model: "m" } as never,
    sessions: [
      { id: "s1", title: "S1", provider: "openai", model: "m", createdAt: 0, lastActiveAt: 0 } as never,
    ],
    messages: [msg(1, "user", "hi"), msg(2, "assistant", "hello there")],
    messagesSessionId: "s1",
    // A turn is in flight with a partial buffer (the live row exists).
    streaming: { s1: "hel" },
    chatStatus: {},
    livePerf: {},
    lastTurnPerf: {},
    sessionMetrics: {},
    artifacts: {},
    artifactProposals: {},
    artifactsByMessage: {},
    tasks: {},
    loopState: {},
    error: null,
  });
});

afterEach(() => {
  cleanup();
  useChatStore.setState({ streaming: {}, messages: [], activeChatSessionId: null });
});

describe("ChatView timeline memo vs streaming flushes", () => {
  it("keeps persisted bubble props stable while stream tokens flush", async () => {
    render(<ChatView />);
    // Wait for the lazy bubble chunk + first mount.
    await waitFor(() => {
      expect(bubbleRenders.persisted).toBeGreaterThanOrEqual(2);
    });
    // First flush settles the one-shot entrance flags (undefined → false on
    // every row — a real value change under the old code as well).
    await act(async () => {
      useChatStore.setState({ streaming: { s1: "hello" } });
    });
    const persistedAfterSettle = bubbleRenders.persisted;
    const liveAfterSettle = bubbleRenders.live;

    // Flush more tokens. Each one changes `activeStream` only.
    for (const text of ["hello wor", "hello world", "hello world!"]) {
      await act(async () => {
        useChatStore.setState({ streaming: { s1: text } });
      });
    }

    // The live row must have re-rendered with the new text…
    expect(bubbleRenders.live).toBeGreaterThan(liveAfterSettle);
    // …while the persisted rows kept their item identity: the shallow-memo'd
    // spy sees identical props, so NOT ONE persisted re-render may happen.
    // (Pre-fix, every token rebuilt every item object and both persisted
    // rows re-rendered on EVERY flush.)
    expect(bubbleRenders.persisted).toBe(persistedAfterSettle);
  });

  it("still re-renders persisted rows when the messages themselves change", async () => {
    render(<ChatView />);
    await waitFor(() => {
      expect(bubbleRenders.persisted).toBeGreaterThanOrEqual(2);
    });
    const before = bubbleRenders.persisted;

    await act(async () => {
      useChatStore.setState({
        messages: [msg(1, "user", "hi"), msg(2, "assistant", "hello there"), msg(3, "user", "again")],
      });
    });

    expect(bubbleRenders.persisted).toBeGreaterThan(before);
  });
});
