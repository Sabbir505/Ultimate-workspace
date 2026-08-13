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
  emitMobileSessionChatEvent,
  listenChatArtifact,
  listenChatDone,
  listenChatError,
  listenChatOpenBrowser,
  listenChatOwner,
  listenChatStatus,
  listenChatTaskProgress,
  listenChatToken,
  listenPlanStepProgress,
  listenChatPerf,
  listenChatSubagentSpawn,
  listenChatSubagentTokens,
  listenChatSubagentDone,
} from "../lib/ipc";
import { matchPlanStep } from "../lib/planMatcher";
import { openInBrowserPane } from "../lib/openBrowserPane";
import { useChatStore } from "../state/chat";

export function useChatEvents(): void {
  useEffect(() => {
    const unlistens: Array<Promise<() => void>> = [];

    unlistens.push(
      listenChatToken(({ chatSessionId, token }) => {
        useChatStore.getState().onToken(chatSessionId, token);
        const ownerSessionId = useChatStore.getState().getOwnerSessionId(chatSessionId);
        if (ownerSessionId) {
          void emitMobileSessionChatEvent(ownerSessionId, "token", { chatSessionId, token });
        }
      }),
    );

    unlistens.push(
      listenChatStatus(({ chatSessionId, reason, message }) => {
        useChatStore.getState().onStatus(chatSessionId, reason, message);
        const ownerSessionId = useChatStore.getState().getOwnerSessionId(chatSessionId);
        if (ownerSessionId) {
          void emitMobileSessionChatEvent(ownerSessionId, "status", { chatSessionId, reason, message });
        }
      }),
    );

    unlistens.push(
      listenChatDone((payload) => {
        const { chatSessionId, inputTokens, outputTokens, costUsd } = payload;
        void useChatStore
          .getState()
          .onDone(
            chatSessionId,
            inputTokens,
            outputTokens,
            costUsd,
            payload.llmTimeMs ?? null,
            payload.toolTimeMs ?? null,
            payload.ttftMs ?? null,
            payload.tokensPerSecond ?? null,
            payload.cacheHitRate ?? null,
          );
        const ownerSessionId = useChatStore.getState().getOwnerSessionId(chatSessionId);
        if (ownerSessionId) {
          void emitMobileSessionChatEvent(ownerSessionId, "done", payload);
        }
      }),
    );

    // Throttled live perf snapshot during a turn (~1 Hz). Drives the composer
    // metrics row so the user sees speed/time updating while tokens stream.
    // No mobile relay (desktop-only UI element).
    unlistens.push(
      listenChatPerf((payload) => {
        useChatStore.getState().onPerf(payload);
      }),
    );

    unlistens.push(
      listenChatError(({ chatSessionId, message, code }) => {
        useChatStore.getState().onError(chatSessionId, message, code);
        const ownerSessionId = useChatStore.getState().getOwnerSessionId(chatSessionId);
        if (ownerSessionId) {
          void emitMobileSessionChatEvent(ownerSessionId, "error", { chatSessionId, message, code });
        }
      }),
    );

    unlistens.push(
      listenChatArtifact((payload) => {
        useChatStore.getState().onArtifact(payload);
        const ownerSessionId = useChatStore.getState().getOwnerSessionId(payload.chatSessionId);
        if (ownerSessionId) {
          void emitMobileSessionChatEvent(ownerSessionId, "artifact", payload);
        }
      }),
    );

    unlistens.push(
      listenChatOpenBrowser(({ url }) => {
        openInBrowserPane(url);
      }),
    );

    // Background chat tasks (download_file / run_shell) — live progress
    // cards. Pushed from chat/tasks.rs; no mobile relay (desktop-only).
    unlistens.push(
      listenChatTaskProgress((payload) => {
        useChatStore.getState().onTaskProgress(payload);
      }),
    );

    // Plan step progress from backend — matches against parsed plan steps
    // via fuzzy label matching. No mobile relay (desktop-only).
    unlistens.push(
      listenPlanStepProgress(({ chatSessionId, stepLabel, status, detail, toolCall }) => {
        const store = useChatStore.getState();
        const steps = store.planSteps[chatSessionId];
        if (!steps) return;
        const matched = matchPlanStep(
          { stepLabel, toolCall: toolCall ?? undefined },
          steps,
        );
        if (matched) {
          store.onPlanStepProgress(
            chatSessionId,
            matched.stepId,
            status,
            detail ?? undefined,
            toolCall ?? undefined,
          );
        }
      }),
    );

    // Subagent lifecycle (Task tool): spawn adds an entry, tokens stream
    // output live, done finalizes it. No mobile relay (desktop-only).
    unlistens.push(
      listenChatSubagentSpawn((payload) => {
        useChatStore.getState().onSubagentSpawn(payload);
      }),
    );
    unlistens.push(
      listenChatSubagentTokens((payload) => {
        useChatStore.getState().onSubagentTokens(payload);
      }),
    );
    unlistens.push(
      listenChatSubagentDone((payload) => {
        useChatStore.getState().onSubagentDone(payload);
      }),
    );

    // Listen for mobile:session_chat_owner to set the owner-session mapping.
    const unlistenOwner = listenChatOwner((payload) => {
      useChatStore.getState().setOwnerSessionId(payload.chatSessionId, payload.ownerSessionId);
    });
    unlistens.push(unlistenOwner);

    return () => {
      for (const u of unlistens) void u.then((fn) => fn());
    };
  }, []);
}
