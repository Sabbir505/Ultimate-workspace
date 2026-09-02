// Paste-to-attach wiring on the composer textarea: a paste carrying clipboard
// files (a screenshot, a copied image, an OS-copied file) must become composer
// attachments — exactly like the "+" picker — while a text-only paste must
// attach nothing and stay a normal paste. The real ipc module is spread with
// only the mount-time loaders stubbed; nothing under test touches Tauri.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChatComposer } from "../components/chat/ChatComposer";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listConnectors: vi.fn(async () => []),
  mcpGalleryList: vi.fn(async () => ({ installed: [] })),
  listSessionConnectors: vi.fn(async () => []),
  listChatSkills: vi.fn(async () => []),
  listPromptTemplates: vi.fn(async () => []),
}));

afterEach(cleanup);

function renderComposer() {
  const onSend = vi.fn();
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
      new File([new Uint8Array(15 * 1024 * 1024 + 1)], "huge.png", { type: "image/png" }),
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
