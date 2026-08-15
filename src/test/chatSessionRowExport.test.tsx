// ChatSessionRow: the sidebar's three-dot chat menu now includes an
// "Export as zip" item that invokes `onExport(sessionId)`. This test pins that
// wiring so the local-first backup entry point stays reachable from the chat
// list (alongside star/rename/unread/delete).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatSessionRow, type ChatSessionRowData } from "../components/chat/ChatSessionRow";

function rowData(over: Partial<ChatSessionRowData> = {}): ChatSessionRowData {
  return {
    id: "chat-1",
    title: "My chat",
    lastActiveAt: 1_700_000_000,
    lastMessage: "Hello world",
    ...over,
  };
}

const noop = () => {};

function renderRow(overrides: { onExport?: (id: string) => void } = {}) {
  return render(
    <ChatSessionRow
      session={rowData()}
      active={false}
      onSelect={noop}
      onDelete={noop}
      onRename={noop}
      onToggleStar={noop}
      onSetUnread={noop}
      onExport={overrides.onExport ?? vi.fn()}
    />,
  );
}

afterEach(cleanup);

describe("ChatSessionRow export menu", () => {
  it("renders an 'Export as zip' menu item alongside the other actions", () => {
    renderRow();
    // The menu is hidden until the ⋮ button is opened.
    expect(screen.queryByText("Export as zip")).toBeNull();
    fireEvent.click(screen.getByLabelText("Chat options"));
    expect(screen.getByText("Export as zip")).toBeTruthy();
    // The rest of the menu is intact.
    expect(screen.getByText("Keep at top")).toBeTruthy();
    expect(screen.getByText("Rename")).toBeTruthy();
    expect(screen.getByText("Mark as unread")).toBeTruthy();
    expect(screen.getByText("Delete")).toBeTruthy();
  });

  it("calls onExport with the session id when Export is clicked", () => {
    const onExport = vi.fn();
    renderRow({ onExport });
    fireEvent.click(screen.getByLabelText("Chat options"));
    fireEvent.click(screen.getByText("Export as zip"));
    expect(onExport).toHaveBeenCalledWith("chat-1");
  });

  it("closes the menu after selecting Export", () => {
    renderRow();
    fireEvent.click(screen.getByLabelText("Chat options"));
    fireEvent.click(screen.getByText("Export as zip"));
    expect(screen.queryByText("Export as zip")).toBeNull();
  });
});
