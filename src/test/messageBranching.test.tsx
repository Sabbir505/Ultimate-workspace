// Conversation branching (roadmap #9) — frontend wiring tests:
//  * MessageBubble opens an inline editor on Edit and calls the submit handler
//    with the edited text; Cancel/Escape aborts; superseded rows dim + tag.
//  * The chat store's editMessage/regenerate retire the tail (supersedeChatTail)
//    before re-sending, following the chatStreamLifecycle mock pattern.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const supersedeChatTailMock = vi.fn();

vi.mock("../lib/ipc", () => ({
  supersedeChatTail: (...a: unknown[]) => supersedeChatTailMock(...a),
}));

import { MessageBubble } from "../components/chat/MessageBubble";
import { useChatStore } from "../state/chat";
import type { ChatMessage, ChatMessageRecord } from "../lib/ipc";

// The store holds ChatMessageRecord[]; the bubble takes ChatMessage. This
// factory produces a ChatMessageRecord; the few bubble render sites cast it
// to ChatMessage (role union) with an `as` cast.
const bubble = (
  over: Partial<ChatMessageRecord> & { id?: number; supersededBy?: number | null } = {},
): ChatMessageRecord & { supersededBy?: number | null } =>
  ({
    role: "user",
    content: "original question",
    id: 1,
    chatSessionId: "s1",
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    createdAt: 1,
    startedAt: null,
    completedAt: null,
    ...over,
  }) as ChatMessageRecord & { supersededBy?: number | null };

beforeEach(() => {
  vi.clearAllMocks();
  supersedeChatTailMock.mockResolvedValue(2);
});

afterEach(() => {
  cleanup();
  useChatStore.setState({ messages: [], activeChatSessionId: null });
});

describe("MessageBubble inline edit editor", () => {
  it("opens an editable textarea on Edit and submits the changed text", async () => {
    const onSubmit = vi.fn();
    render(<MessageBubble message={bubble() as ChatMessage} msgId={1} onEdit={onSubmit} />);

    // Edit button is on the hover action bar — find by aria-label.
    fireEvent.click(screen.getByLabelText("Edit message"));
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "revised question" } });
    fireEvent.click(screen.getByText("Save & Submit"));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("revised question"));
  });

  it("Cancel closes the editor without submitting", () => {
    const onSubmit = vi.fn();
    render(<MessageBubble message={bubble() as ChatMessage} msgId={1} onEdit={onSubmit} />);
    fireEvent.click(screen.getByLabelText("Edit message"));
    fireEvent.click(screen.getByText("Cancel"));
    // Editor closed; original content rendered again.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("renders a superseded bubble dimmed with a previous-version tag", () => {
    render(
      <MessageBubble
        message={bubble({ supersededBy: 1 }) as ChatMessage}
        msgId={3}
        superseded
      />,
    );
    const root = screen.getByText("original question").closest(".chat-bubble");
    expect(root?.classList.contains("superseded")).toBe(true);
    expect(screen.getByText("previous version")).toBeTruthy();
  });

  it("renders the edited divider at a segment start", () => {
    render(
      <MessageBubble
        message={bubble({ content: "revised" }) as ChatMessage}
        msgId={5}
        superseded
        segmentStart
      />,
    );
    expect(screen.getByText(/— edited —/)).toBeTruthy();
  });
});

describe("chat store editMessage / regenerate (branch-aware)", () => {
  it("editMessage retires the tail then sends the edited text", async () => {
    const sendMessage = vi.spyOn(useChatStore.getState(), "sendMessage").mockResolvedValue(undefined);
    const loadMessages = vi.spyOn(useChatStore.getState(), "loadMessages").mockResolvedValue(undefined);
    useChatStore.setState({ activeChatSessionId: "s1", messages: [bubble()] });

    await useChatStore.getState().editMessage(1, "edited");
    expect(supersedeChatTailMock).toHaveBeenCalledWith(1);
    expect(loadMessages).toHaveBeenCalledWith("s1");
    expect(sendMessage).toHaveBeenCalledWith("edited");
  });

  it("regenerate retires the last active user message tail before re-sending", async () => {
    useChatStore.setState({
      activeChatSessionId: "s1",
      messages: [
        bubble({ id: 1, role: "user", content: "q1" }),
        bubble({ id: 2, role: "assistant", content: "retired", supersededBy: 1 }),
        bubble({ id: 3, role: "user", content: "q2" }),
        bubble({ id: 4, role: "assistant", content: "a2" }),
      ],
    });
    const sendMessage = vi.spyOn(useChatStore.getState(), "sendMessage").mockResolvedValue(undefined);
    const loadMessages = vi.spyOn(useChatStore.getState(), "loadMessages").mockResolvedValue(undefined);

    await useChatStore.getState().regenerate();
    // It superseded from message 3 (the last ACTIVE user), retiring 3+4.
    expect(supersedeChatTailMock).toHaveBeenCalledWith(3);
    expect(sendMessage).toHaveBeenCalledWith("q2");
  });
});
