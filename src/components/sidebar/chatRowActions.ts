// Shared chat-row actions for Sidebar and ProjectsSidebar (audit M: DRY —
// ~120 lines of eight handlers + their toasts were copy-pasted between the
// two sidebars, and the Windows path-split bug existed twice because of it).
// Both surfaces pass these straight onto their row components.

import { useCallback } from "react";
import { toastError, toastSuccess, exportChatZip } from "../../lib/ipc";
import { useChatStore } from "../../state/chat";
import { useUiStore } from "../../state/ui";

export function useChatRowActions() {
  const selectSession = useChatStore((s) => s.selectSession);
  const deleteChat = useChatStore((s) => s.deleteChat);
  const renameChat = useChatStore((s) => s.renameChat);
  const setStarred = useChatStore((s) => s.setStarred);
  const setUnread = useChatStore((s) => s.setUnread);
  const setActiveView = useUiStore((s) => s.setActiveView);

  const handleSelectChat = useCallback(
    (id: string) => {
      void selectSession(id).catch((err) => toastError("Couldn't open that chat", err));
      setActiveView("chat");
    },
    [selectSession, setActiveView],
  );

  const handleDeleteChat = useCallback(
    (id: string) => {
      deleteChat(id).catch((e) => toastError("Couldn't delete the chat", e));
    },
    [deleteChat],
  );

  const handleRenameChat = useCallback(
    (id: string, title: string) => {
      void renameChat(id, title);
    },
    [renameChat],
  );

  const handleToggleStar = useCallback(
    (id: string, starred: boolean) => {
      void setStarred(id, starred);
    },
    [setStarred],
  );

  const handleSetUnread = useCallback(
    (id: string, unread: boolean) => {
      void setUnread(id, unread);
    },
    [setUnread],
  );

  const handleExportChat = useCallback((id: string) => {
    exportChatZip(id)
      .then((saved) => {
        if (saved) toastSuccess("Chat exported to .zip");
      })
      .catch((err) => toastError("Chat export failed", err));
  }, []);

  // Open the chat in a NEW split pane beside the focused one; clicking the
  // item for a chat that's already pinned in a pane closes that pane (toggle
  // — decided inside the store action).
  const handleOpenSplitChat = useCallback((id: string) => {
    void useChatStore.getState().openChatSplit(id);
  }, []);

  // Fork the chat into N side-by-side panes — the dialog picks the count,
  // the store action does the copying + pinning.
  const handleForkChat = useCallback((id: string) => {
    useUiStore.getState().openForkChatModal(id);
  }, []);

  return {
    handleSelectChat,
    handleDeleteChat,
    handleRenameChat,
    handleToggleStar,
    handleSetUnread,
    handleExportChat,
    handleOpenSplitChat,
    handleForkChat,
  };
}
