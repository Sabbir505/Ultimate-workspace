// Paste-to-attach wiring on the composer textarea: a paste carrying clipboard
// files (a screenshot, a copied image, an OS-copied file) must become composer
// attachments — exactly like the "+" picker — while a text-only paste must
// attach nothing and stay a normal paste. The real ipc module is spread with
// only the mount-time loaders stubbed; nothing under test touches Tauri.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChatComposer } from "../components/chat/ChatComposer";
import { useChatStore } from "../state/chat";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listConnectors: vi.fn(async () => []),
  mcpGalleryList: vi.fn(async () => ({ installed: [] })),
  listSessionConnectors: vi.fn(async () => []),
  listChatSkills: vi.fn(async () => []),
  listPromptTemplates: vi.fn(async () => []),
}));

afterEach(() => {
  cleanup();
  useChatStore.setState({ activeChatSessionId: null });
});

function renderComposer() {
  const onSend = vi.fn();
  // A session must exist: the silent-drop guard (audit H31) keeps the draft
  // and refuses to send when there is no chat to send into.
  useChatStore.setState({ activeChatSessionId: "paste-test-session" });
  render(<ChatComposer onSend={onSend} streaming={false} onAgentModelPick={vi.fn()} />);
  return onSend;
}

const attachmentNames = (): Array<string | null> =>
  Array.from(document.querySelectorAll(".composer-attachment-name")).map(
    (el) => el.textContent,
  );

const pasteFiles = (textarea: HTMLElement, files: File[]) => {
  fireEvent.paste(textarea, { clipboardData: { files, getData: () => "" } });
};

describe("composer paste-to-attach", () => {
  it("attaches a pasted screenshot as an image attachment", async () => {
    renderComposer();
    const textarea = screen.getByPlaceholderText(/Write a message/);
    pasteFiles(textarea, [
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", { type: "image/png" }),
    ]);
    expect(await screen.findByText("image.png")).toBeTruthy();
    expect(attachmentNames()).toEqual(["image.png"]);
  });

  it("dedupes the same clipboard file pasted twice", async () => {
    renderComposer();
    const textarea = screen.getByPlaceholderText(/Write a message/);
    pasteFiles(textarea, [new File(["hello"], "notes.txt", { type: "text/plain" })]);
    await screen.findByText("notes.txt");
    pasteFiles(textarea, [new File(["hello"], "notes.txt", { type: "text/plain" })]);
    await vi.waitFor(() => expect(attachmentNames()).toHaveLength(1));
  });

  it("attaches several files from one paste", async () => {
    renderComposer();
    const textarea = screen.getByPlaceholderText(/Write a message/);
    pasteFiles(textarea, [
      new File(["a, b"], "data.csv", { type: "text/csv" }),
      new File(["%PDF-1.4"], "report.pdf", { type: "application/pdf" }),
    ]);
    await screen.findByText("data.csv");
    expect(await screen.findByText("report.pdf")).toBeTruthy();
    expect(attachmentNames()).toHaveLength(2);
  });

  it("leaves text-only pastes alone", () => {
    renderComposer();
    const textarea = screen.getByPlaceholderText(/Write a message/);
    pasteFiles(textarea, []);
    fireEvent.paste(textarea, {
      clipboardData: { files: [], getData: () => "just text" } as unknown as DataTransfer,
    });
    expect(attachmentNames()).toEqual([]);
  });

  it("surfaces a readable error for binary junk pasted as a file", async () => {
    renderComposer();
    const textarea = screen.getByPlaceholderText(/Write a message/);
    pasteFiles(textarea, [
      // "MZ\0…" PE header — an .exe copied from Explorer.
      new File([new Uint8Array([0x4d, 0x5a, 0x00, 0x01])], "setup.exe", { type: "" }),
    ]);
    expect(await screen.findByText(/not a supported attachment type/)).toBeTruthy();
    expect(attachmentNames()).toEqual([]);
  });

  it("surfaces the size-cap error for an oversized paste", async () => {
    renderComposer();
    const textarea = screen.getByPlaceholderText(/Write a message/);
    pasteFiles(textarea, [
      new File([new Uint8Array(25 * 1024 * 1024 + 1)], "huge.png", { type: "image/png" }),
    ]);
    expect(await screen.findByText(/huge\.png is too large/)).toBeTruthy();
  });

  it("sends the pasted attachment through onSend with the message", async () => {
    const onSend = renderComposer();
    const textarea = screen.getByPlaceholderText(/Write a message/);
    fireEvent.change(textarea, { target: { value: "what is in this shot?" } });
    pasteFiles(textarea, [
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", { type: "image/png" }),
    ]);
    await screen.findByText("image.png");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const [content, attachments] = onSend.mock.calls[0];
    expect(content).toBe("what is in this shot?");
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ name: "image.png", kind: "image" });
  });
});

describe("composer pasted long text", () => {
  const pasteText = (textarea: HTMLElement, text: string) => {
    fireEvent.paste(textarea, { clipboardData: { files: [], getData: () => text } });
  };

  it("turns a paste past the document threshold into a text document card", async () => {
    renderComposer();
    const textarea = screen.getByPlaceholderText(/Write a message/) as HTMLTextAreaElement;
    pasteText(textarea, "error\n".repeat(300)); // 1800 chars — well past 1200
    expect(await screen.findByText("Pasted text.txt")).toBeTruthy();
    // The draft stays clean — the text lives in the card, not inline.
    expect(textarea.value).toBe("");
  });

  it("numbers a second, different long paste instead of deduping it away", async () => {
    renderComposer();
    const textarea = screen.getByPlaceholderText(/Write a message/);
    pasteText(textarea, "a".repeat(1300));
    await screen.findByText("Pasted text.txt");
    pasteText(textarea, "b".repeat(1400));
    expect(await screen.findByText("Pasted text 2.txt")).toBeTruthy();
    expect(attachmentNames()).toEqual(["Pasted text.txt", "Pasted text 2.txt"]);
  });

  it("keeps short pastes inline (no card)", () => {
    renderComposer();
    const textarea = screen.getByPlaceholderText(/Write a message/);
    pasteText(textarea, "a short sentence");
    expect(attachmentNames()).toEqual([]);
  });
});

describe("composer drag-and-drop attach", () => {
  const composerCard = () =>
    document.querySelector<HTMLElement>(".chat-composer-card")!;

  const dropFiles = (files: File[]) =>
    fireEvent.drop(composerCard(), {
      dataTransfer: { files, types: files.length ? ["Files"] : ["text/plain"] },
    });

  it("attaches a file dropped onto the composer card", async () => {
    renderComposer();
    dropFiles([
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "image/png" }),
    ]);
    expect(await screen.findByText("shot.png")).toBeTruthy();
    expect(attachmentNames()).toEqual(["shot.png"]);
  });

  it("attaches several files from one drop", async () => {
    renderComposer();
    dropFiles([
      new File(["a, b"], "data.csv", { type: "text/csv" }),
      new File(["%PDF-1.4"], "report.pdf", { type: "application/pdf" }),
    ]);
    await screen.findByText("data.csv");
    expect(await screen.findByText("report.pdf")).toBeTruthy();
    expect(attachmentNames()).toHaveLength(2);
  });

  it("attaches nothing for a drop without files (text drag)", async () => {
    renderComposer();
    dropFiles([]);
    expect(attachmentNames()).toEqual([]);
  });

  it("lights up the card only for file drags and clears on leave", () => {
    renderComposer();
    // A text/URL drag must not light the card up.
    fireEvent.dragOver(composerCard(), { dataTransfer: { types: ["text/plain"] } });
    expect(composerCard().className).not.toContain("is-drop-target");
    // A file drag does…
    fireEvent.dragOver(composerCard(), { dataTransfer: { types: ["Files"] } });
    expect(composerCard().className).toContain("is-drop-target");
    // …and leaving the card clears the highlight again.
    fireEvent.dragLeave(composerCard(), { relatedTarget: null });
    expect(composerCard().className).not.toContain("is-drop-target");
  });
});

describe("composer slash menu keyboard navigation", () => {
  const typeWithCaret = (textarea: HTMLElement, value: string) => {
    // selectionStart rides along so the caret-token logic sees the caret at
    // the end (jsdom does not move the caret on programmatic value sets).
    fireEvent.change(textarea, {
      target: { value, selectionStart: value.length, selectionEnd: value.length },
    });
  };

  it("moves the highlight with ↑/↓, picks with Enter, dismisses with Escape", async () => {
    renderComposer();
    const textarea = screen.getByPlaceholderText(/Write a message/) as HTMLTextAreaElement;
    typeWithCaret(textarea, "/");
    const menu = await screen.findByRole("listbox", { name: "Commands" });
    const items = () => within(menu).getAllByRole("option");
    expect(items().length).toBeGreaterThan(1);
    expect(items()[0].className).toContain("active");

    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(items()[1].className).toContain("active");
    expect(items()[0].className).not.toContain("active");
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(items()[0].className).toContain("active");

    // Escape dismisses without touching the draft; the menu comes back when
    // the token is edited again.
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
    expect(textarea.value).toBe("/");
    typeWithCaret(textarea, "/compact");
    await screen.findByRole("listbox", { name: "Commands" });

    // Enter picks the highlighted item — /compact becomes the command pill
    // and the token leaves the draft.
    fireEvent.keyDown(textarea, { key: "Enter" });
    await vi.waitFor(() =>
      expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull(),
    );
    expect(document.querySelector(".composer-token-command")?.textContent).toMatch(/compact/i);
    expect(textarea.value).toBe("");
  });
});

describe("composer Escape stops the turn", () => {
  it("calls onStop while a turn streams", () => {
    const onStop = vi.fn();
    useChatStore.setState({ activeChatSessionId: "esc-test-session" });
    render(
      <ChatComposer
        onSend={vi.fn()}
        onStop={onStop}
        streaming
        onAgentModelPick={vi.fn()}
      />,
    );
    const textarea = screen.getByPlaceholderText(/keep typing/);
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no turn is running", () => {
    const onStop = vi.fn();
    useChatStore.setState({ activeChatSessionId: "esc-test-session" });
    render(
      <ChatComposer
        onSend={vi.fn()}
        onStop={onStop}
        streaming={false}
        onAgentModelPick={vi.fn()}
      />,
    );
    const textarea = screen.getByPlaceholderText(/Write a message/);
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(onStop).not.toHaveBeenCalled();
  });

  it("leaves the slash popup its own Escape dismissal", async () => {
    const onStop = vi.fn();
    useChatStore.setState({ activeChatSessionId: "esc-test-session" });
    render(
      <ChatComposer
        onSend={vi.fn()}
        onStop={onStop}
        streaming
        onAgentModelPick={vi.fn()}
      />,
    );
    const textarea = screen.getByPlaceholderText(/keep typing/) as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: "/", selectionStart: 1, selectionEnd: 1 },
    });
    await screen.findByRole("listbox", { name: "Commands" });
    fireEvent.keyDown(textarea, { key: "Escape" });
    // The popup closes (its own Escape branch) and the turn is untouched —
    // stopping the agent because the user dismissed a menu would lose work.
    expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
    expect(onStop).not.toHaveBeenCalled();
  });
});

describe("composer ↑/↓ prompt recall", () => {
  const typeAt = (textarea: HTMLElement, value: string, caret = value.length) => {
    fireEvent.change(textarea, {
      target: { value, selectionStart: caret, selectionEnd: caret },
    });
  };
  const send = (textarea: HTMLElement, text: string) => {
    typeAt(textarea, text);
    fireEvent.keyDown(textarea, { key: "Enter" });
  };

  it("walks back and forth through this chat's prompts and restores the draft", async () => {
    const onSend = vi.fn();
    useChatStore.setState({ activeChatSessionId: "recall-session" });
    render(
      <ChatComposer onSend={onSend} streaming={false} onAgentModelPick={vi.fn()} />,
    );
    const textarea = screen.getByPlaceholderText(/Write a message/) as HTMLTextAreaElement;
    send(textarea, "first prompt");
    await vi.waitFor(() => expect(textarea.value).toBe(""));
    send(textarea, "second prompt");
    await vi.waitFor(() => expect(textarea.value).toBe(""));
    send(textarea, "third prompt");
    await vi.waitFor(() => expect(textarea.value).toBe(""));

    // ↑ from an empty box recalls the newest prompt, and older ones behind it.
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    await vi.waitFor(() => expect(textarea.value).toBe("third prompt"));
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    await vi.waitFor(() => expect(textarea.value).toBe("second prompt"));
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    await vi.waitFor(() => expect(textarea.value).toBe("first prompt"));
    // Past the oldest entry it holds still.
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    await vi.waitFor(() => expect(textarea.value).toBe("first prompt"));

    // ↓ walks forward again…
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    await vi.waitFor(() => expect(textarea.value).toBe("second prompt"));
    // …and off the newest end returns the draft the walk replaced.
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    await vi.waitFor(() => expect(textarea.value).toBe("third prompt"));
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    await vi.waitFor(() => expect(textarea.value).toBe(""));
  });

  it("restores a half-written draft when ↑ is pressed and then ↓", async () => {
    const onSend = vi.fn();
    useChatStore.setState({ activeChatSessionId: "recall-draft-session" });
    render(
      <ChatComposer onSend={onSend} streaming={false} onAgentModelPick={vi.fn()} />,
    );
    const textarea = screen.getByPlaceholderText(/Write a message/) as HTMLTextAreaElement;
    send(textarea, "sent earlier");
    await vi.waitFor(() => expect(textarea.value).toBe(""));
    typeAt(textarea, "unsent thought");
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    await vi.waitFor(() => expect(textarea.value).toBe("sent earlier"));
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    await vi.waitFor(() => expect(textarea.value).toBe("unsent thought"));
  });

  it("keeps ↑ moving the caret through a multi-line draft instead of recalling", async () => {
    const onSend = vi.fn();
    useChatStore.setState({ activeChatSessionId: "recall-multiline-session" });
    render(
      <ChatComposer onSend={onSend} streaming={false} onAgentModelPick={vi.fn()} />,
    );
    const textarea = screen.getByPlaceholderText(/Write a message/) as HTMLTextAreaElement;
    send(textarea, "an older prompt");
    await vi.waitFor(() => expect(textarea.value).toBe(""));
    // Caret on the SECOND line: ↑ belongs to the textarea. (A trailing space
    // keeps each write a real change event — an identical value fires none, so
    // the caret would stay where the previous write left it.)
    typeAt(textarea, "line one\nline two", 14);
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("line one\nline two");
    // From the first line it recalls.
    typeAt(textarea, "line one \nline two", 3);
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    await vi.waitFor(() => expect(textarea.value).toBe("an older prompt"));
  });

  it("does not offer another chat's prompts", async () => {
    const onSend = vi.fn();
    useChatStore.setState({ activeChatSessionId: "recall-chat-a" });
    render(
      <ChatComposer onSend={onSend} streaming={false} onAgentModelPick={vi.fn()} />,
    );
    const textarea = screen.getByPlaceholderText(/Write a message/) as HTMLTextAreaElement;
    send(textarea, "chat A prompt");
    await vi.waitFor(() => expect(textarea.value).toBe(""));
    cleanup();

    // A different chat: its own composer must not see chat A's history.
    useChatStore.setState({ activeChatSessionId: "recall-chat-b" });
    render(
      <ChatComposer onSend={onSend} streaming={false} onAgentModelPick={vi.fn()} />,
    );
    const other = screen.getByPlaceholderText(/Write a message/) as HTMLTextAreaElement;
    fireEvent.keyDown(other, { key: "ArrowUp" });
    expect(other.value).toBe("");
  });

  it("leaves ↑/↓ to the slash popup while it is open", async () => {
    const onSend = vi.fn();
    useChatStore.setState({ activeChatSessionId: "recall-popup-session" });
    render(
      <ChatComposer onSend={onSend} streaming={false} onAgentModelPick={vi.fn()} />,
    );
    const textarea = screen.getByPlaceholderText(/Write a message/) as HTMLTextAreaElement;
    send(textarea, "history entry");
    await vi.waitFor(() => expect(textarea.value).toBe(""));
    typeAt(textarea, "/");
    const menu = await screen.findByRole("listbox", { name: "Commands" });
    const items = within(menu).getAllByRole("option");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    // The popup's own navigation ran; the draft is untouched.
    expect(items[1].className).toContain("active");
    expect(textarea.value).toBe("/");
  });
});
