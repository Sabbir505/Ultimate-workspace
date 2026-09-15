// Module-level drag state for chat-session → split-pane drag-and-drop.
//
// HTML5 drag-and-drop's dataTransfer is WRITE-only during `dragover` (the
// browser does this to prevent data leaks mid-drag), so drop zones can't read
// what's being dragged from the event. Panes consult this tiny store instead:
// ChatSessionRow publishes the dragged session id on dragstart, the pane drop
// zones subscribe to render themselves only while a chat drag is live, and
// the drop handler reads the id here.
import { create } from "zustand";

interface ChatSessionDragState {
  /** The chat session currently being dragged from the sidebar (null = none). */
  sessionId: string | null;
}

export const useChatSessionDrag = create<ChatSessionDragState>(() => ({
  sessionId: null,
}));

export function startChatSessionDrag(sessionId: string): void {
  useChatSessionDrag.setState({ sessionId });
}

export function endChatSessionDrag(): void {
  useChatSessionDrag.setState({ sessionId: null });
}

export function draggedChatSessionId(): string | null {
  return useChatSessionDrag.getState().sessionId;
}
