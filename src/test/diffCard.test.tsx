// Tests the inline diff review card (mockup 01 callout 5): a file-edit tool
// call (`kind: "edit"` in the `<tool>` stream marker) breaks out of the
// collapsed activity group into its own DiffCard with filename, +/− stats and
// red/green preview lines, while non-edit tools still fold into the group.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MessageBubble } from "../components/chat/MessageBubble";
import type { ChatMessage } from "../lib/ipc";

function assistantMsg(content: string): ChatMessage {
  return {
    id: 1,
    chatSessionId: "s1",
    role: "assistant",
    content,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    createdAt: 0,
  } as ChatMessage;
}

/** The `<tool>` marker shape the backend's `tool_block` emits for edit_file. */
function editTool(path: string, find: string, replace: string): string {
  return `<tool>${JSON.stringify({
    kind: "edit",
    title: `Editing file "${path}"`,
    detail: path,
    path,
    edit: { mode: "replace", find, replace },
  })}</tool>`;
}

function webTool(detail: string): string {
  return `<tool>${JSON.stringify({ kind: "web", title: "Reading a web page", detail })}</tool>`;
}

afterEach(() => cleanup());

describe("MessageBubble inline diff cards", () => {
  it("renders an edit tool call as a diff card with stats and preview lines", () => {
    const content = [
      editTool("src/lib/auth.ts", "const token = legacyVerify(session)", "const token = await tokenStore.verify(session)\nif (token.expired) await tokenStore.rotate()"),
      "\n\nDone.",
    ].join("");
    const { container, queryByText } = render(
      <MessageBubble message={assistantMsg(content)} />,
    );

    const card = container.querySelector(".diff-card");
    expect(card).not.toBeNull();
    // Header: filename and +/− stats (1 del, 2 adds, one hunk).
    expect(queryByText("src/lib/auth.ts")).not.toBeNull();
    expect(queryByText("+2")).not.toBeNull();
    expect(queryByText("−1")).not.toBeNull();
    expect(queryByText(/· 1 hunk/)).not.toBeNull();
    // Preview lines: red del + green adds.
    expect(container.querySelectorAll(".diff-card .diff-line.del").length).toBe(1);
    expect(container.querySelectorAll(".diff-card .diff-line.add").length).toBe(2);
    // Auto-applied edit (no matching pending approval): Applied state, no
    // Accept/Reject buttons.
    expect(queryByText("Applied ✓")).not.toBeNull();
    expect(queryByText("Accept ✓")).toBeNull();
    // The trailing answer still renders outside any collapsed group.
    expect(queryByText(/Done\./)).not.toBeNull();
  });

  it("keeps non-edit tools in the collapsed group while the edit breaks out", () => {
    const content = [
      webTool("rust-lang.org/learn"),
      editTool("src/main.rs", "fn old() {}", "fn new() {}"),
      webTool("doc.rust-lang.org/book"),
      "\n\nSummary.",
    ].join("");
    const { container } = render(<MessageBubble message={assistantMsg(content)} />);

    // One diff card for the edit, and the two web reads fold into collapsed
    // activity groups (the edit splits the run in two).
    expect(container.querySelectorAll(".diff-card").length).toBe(1);
    expect(container.querySelectorAll(".chat-activity-toggle").length).toBe(2);
  });

  it("caps the preview at 5 lines with a more-lines footer", () => {
    const many = Array.from({ length: 8 }, (_, i) => `line ${i}`).join("\n");
    const content = `<tool>${JSON.stringify({
      kind: "edit",
      title: "Writing file \"big.txt\"",
      detail: "big.txt",
      path: "big.txt",
      edit: { mode: "write", content: many },
    })}</tool>`;
    const { container, queryByText } = render(
      <MessageBubble message={assistantMsg(content)} />,
    );

    expect(container.querySelectorAll(".diff-card .diff-line.add").length).toBe(5);
    expect(queryByText(/3 more lines/)).not.toBeNull();
  });
});
