// Tests the inline diff review card (mockup 01 callout 5): a file-edit tool
// call (`kind: "edit"` in the `<tool>` stream marker) breaks out of the
// collapsed activity group into its own DiffCard with filename, +/− stats and
// red/green preview lines, while non-edit tools still fold into the group.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
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

/** The redesign nests DiffCards inside the collapsed ProcessSummary body —
 *  expand the single process toggle before asserting on nested content. */
function expandProcess(container: HTMLElement) {
  const toggle = container.querySelector(".chat-process-toggle") as HTMLElement;
  fireEvent.click(toggle);
}

describe("MessageBubble inline diff cards", () => {
  it("renders an edit tool call as a diff card with stats and preview lines", () => {
    const content = [
      editTool("src/lib/auth.ts", "const token = legacyVerify(session)", "const token = await tokenStore.verify(session)\nif (token.expired) await tokenStore.rotate()"),
      "\n\nDone.",
    ].join("");
    const { container, queryByText } = render(
      <MessageBubble message={assistantMsg(content)} />,
    );
    expandProcess(container);

    // Edit steps render as a COMPACT row first (✏ Edit file dir +N −M) — the
    // inline diff card opens on click.
    const row = container.querySelector(".chat-edit-row-toggle");
    expect(row).not.toBeNull();
    fireEvent.click(row!);
    const card = container.querySelector(".diff-card");
    expect(card).not.toBeNull();
    // Header: filename and +/− stats (1 del, 2 adds, one hunk). Scoped to the
    // card — the turn's trailing TurnChangesRow repeats the same stats.
    expect(card!.querySelector(".diff-card-filename")?.textContent).toBe("src/lib/auth.ts");
    expect(card!.querySelector(".diff-card-adds")?.textContent).toBe("+2");
    expect(card!.querySelector(".diff-card-dels")?.textContent).toBe("−1");
    expect(card!.textContent).toMatch(/· 1 hunk/);
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

  it("keeps non-edit tools in the collapsed activity groups while the edit renders its own card", () => {
    const content = [
      webTool("rust-lang.org/learn"),
      editTool("src/main.rs", "fn old() {}", "fn new() {}"),
      webTool("doc.rust-lang.org/book"),
      "\n\nSummary.",
    ].join("");
    const { container } = render(<MessageBubble message={assistantMsg(content)} />);
    expandProcess(container);

    // The edit renders as a compact row (diff hidden until clicked); the two
    // web reads become single activity rows around it — all inside the turn's
    // single ProcessSummary.
    expect(container.querySelectorAll(".chat-edit-row").length).toBe(1);
    expect(container.querySelectorAll(".chat-process-toggle").length).toBe(1);
    // Edit row closed by default → no diff card yet; clicking opens it.
    expect(container.querySelectorAll(".diff-card").length).toBe(0);
    fireEvent.click(container.querySelector(".chat-edit-row-toggle")!);
    expect(container.querySelectorAll(".diff-card").length).toBe(1);
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
    expandProcess(container);

    fireEvent.click(container.querySelector(".chat-edit-row-toggle")!);
    expect(container.querySelectorAll(".diff-card .diff-line.add").length).toBe(5);
    expect(queryByText(/3 more lines/)).not.toBeNull();
  });
});
