// Registers backend event listeners for chat token streaming (chat:token,
// chat:done, chat:error) and dispatches into useChatStore. Registered inside
// a React effect — never at module import time — so jsdom tests don't touch
// the Tauri event bridge.
//
// IMPORTANT: streaming updates are keyed by chatSessionId, not by
// "active session", so a stream completes and persists correctly even if the
// user switches to a different chat in the sidebar.
import { useEffect } from "react";
import {
  browserNavigateTab,
  listenChatApprovalRequest,
  listenChatApprovalResolved,
  listenChatArtifact,
  listenChatDone,
  listenChatError,
  listenChatOpenBrowser,
  listenChatToken,
} from "../lib/ipc";
import { useChatStore } from "../state/chat";
import { usePanesStore } from "../state/panes";
import { useProjectsStore } from "../state/projects";

/** Open (or reuse) a built-in browser pane pointed at `url`. */
function openInBrowserPane(url: string): void {
  const panes = usePanesStore.getState();
  const existing = panes.panes.find(
    (p) => p.data.kind === "browser" && !p.data.collapsed,
  );
  if (existing && existing.data.kind === "browser") {
    const tab = existing.data.tabs[existing.data.activeTabIndex];
    if (tab) {
      panes.setBrowserUrl(existing.paneId, url, tab.tabId);
      void browserNavigateTab(existing.paneId, tab.tabId, url).catch(() => {});
    }
    panes.focusPane(existing.paneId);
    return;
  }
  panes.addPane({
    kind: "browser",
    url,
    projectId: useProjectsStore.getState().selectedProjectId,
  });
}

export function useChatEvents(): void {
  useEffect(() => {
    const unlistens: Array<Promise<() => void>> = [];

    unlistens.push(
      listenChatToken(({ chatSessionId, token }) => {
        useChatStore.getState().onToken(chatSessionId, token);
      }),
    );

    unlistens.push(
      listenChatDone(({ chatSessionId, inputTokens, outputTokens, costUsd }) => {
        void useChatStore.getState().onDone(chatSessionId, inputTokens, outputTokens, costUsd);
      }),
    );

    unlistens.push(
      listenChatError(({ chatSessionId, message, code }) => {
        useChatStore.getState().onError(chatSessionId, message, code);
      }),
    );

    unlistens.push(
      listenChatArtifact((payload) => {
        useChatStore.getState().onArtifact(payload);
      }),
    );

    unlistens.push(
      listenChatOpenBrowser(({ url }) => {
        openInBrowserPane(url);
      }),
    );

    // Per-action filesystem-tool approval cards. `chat:approval-request`
    // surfaces a card the user Approves/Denies; `chat:approval-resolved`
    // dismisses it (the backend has already resumed the paused tool loop).
    unlistens.push(
      listenChatApprovalRequest((payload) => {
        useChatStore.getState().onApprovalRequest(payload);
      }),
    );

    unlistens.push(
      listenChatApprovalResolved((payload) => {
        useChatStore.getState().onApprovalResolved(payload);
      }),
    );

    return () => {
      for (const u of unlistens) void u.then((fn) => fn());
    };
  }, []);
}
