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
  listenChatArtifact,
  listenChatDone,
  listenChatError,
  listenChatToken,
} from "../lib/ipc";
import { useChatStore } from "../state/chat";

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

    return () => {
      for (const u of unlistens) void u.then((fn) => fn());
    };
  }, []);
}
