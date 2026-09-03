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
  listenChatApprovalRequest,
  listenChatApprovalResolved,
  listenChatQuestionRequest,
  listenChatArtifact,
  listenDocQa,
  listenChatCitationReport,
  listenChatDone,
  listenChatError,
  listenChatOpenBrowser,
  listenChatOpenPreview,
  listenChatOwner,
  listenChatStatus,
  listenChatTaskProgress,
  listenChatToken,
  listenCheckpointCreated,
  listenPlanStepProgress,
  listenPlanUpdated,
  listenPlanMode,
  listenPlanProposal,
  listenPlanAccepted,
  listenChatPerf,
  listenChatSubagentSpawn,
  listenChatSubagentTokens,
  listenChatSubagentDone,
} from "../lib/ipc";
import { matchPlanStep } from "../lib/planMatcher";
import { openInBrowserPane } from "../lib/openBrowserPane";
import { isAppFocused } from "../lib/appFocus";
import { relayNotify } from "../lib/notifyCenter";
import { sessionDisplayTitle } from "../lib/sessionTitle";
import { useChatStore } from "../state/chat";
import { useDocQaStore } from "../state/docQa";
import { useUiStore } from "../state/ui";

/** Is the user LOOKING at this session right now — Relay focused AND the
 *  session is the visible (focused/active) chat? Completion toasts + chimes
 *  are suppressed for the session the user is watching; background chats and
 *  unfocused-app completions still notify. */
function isViewingSession(chatSessionId: string): boolean {
  const chat = useChatStore.getState();
  const focusedId = chat.focusedChatSessionId ?? chat.activeChatSessionId;
  return isAppFocused() && chatSessionId === focusedId;
}

function sessionName(chatSessionId: string): string {
  const title = useChatStore
    .getState()
    .sessions.find((s) => s.id === chatSessionId)?.title;
  return sessionDisplayTitle(title ?? undefined);
}

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
        // Completion notification — works for BOTH the active chat and
        // background chats (streams are session-keyed, so a background turn
        // completing is indistinguishable from an active one). Nothing fires
        // when the user is watching that session finish; the calm chime only
        // sounds when Relay itself is unfocused.
        if (!isViewingSession(chatSessionId)) {
          const appFocused = isAppFocused();
          relayNotify({
            kind: "completed",
            title: `${sessionName(chatSessionId)} finished`,
            body: "Agent turn complete — response ready.",
            chatSessionId,
            // OS toast only steals attention across apps when Relay isn't
            // the focused app; background-chat completions surface as an
            // in-app toast instead.
            osToast: !appFocused,
            inAppToast: appFocused,
            sound: "completion",
            soundOnlyUnfocused: true,
          });
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
        // Errors are always worth a record; the interrupting surfaces (OS
        // toast + alert chime) only fire when the user isn't looking at the
        // failing session.
        if (!isViewingSession(chatSessionId)) {
          const appFocused = isAppFocused();
          relayNotify({
            kind: "error",
            title: `${sessionName(chatSessionId)} hit an error`,
            body: message || "The agent turn failed.",
            chatSessionId,
            osToast: !appFocused,
            inAppToast: appFocused,
            sound: "alert",
            soundOnlyUnfocused: true,
          });
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

    // Design-QA verdict for plan-compiled documents (keyed by artifact path,
    // rendered in the artifact preview pane). Desktop-only UI.
    unlistens.push(
      listenDocQa((payload) => {
        useDocQaStore.getState().put(payload);
      }),
    );

    // End-of-turn citation-integrity verdict (research turns only): the
    // backend lints the generated report against the session's source ledger
    // and reports what was mechanically verified. Rendered as the trust strip
    // above the composer. No mobile relay (desktop-only UI).
    unlistens.push(
      listenChatCitationReport((payload) => {
        useChatStore.getState().onCitationReport(payload);
      }),
    );

    // Per-turn git checkpoints — appends the chip to the live message (or
    // keeps baselines for a later restore). Desktop-only UI element.
    unlistens.push(
      listenCheckpointCreated((payload) => {
        useChatStore.getState().onCheckpointCreated(payload);
      }),
    );

    unlistens.push(
      listenChatOpenBrowser(({ url }) => {
        openInBrowserPane(url);
      }),
    );

    // open_file routed a previewable file to the in-app viewer — open it as a
    // tab in the right-side tool panel (dedupes by path, expands the panel).
    unlistens.push(
      listenChatOpenPreview(({ path, filename }) => {
        useUiStore.getState().openArtifactTab({ path, filename });
      }),
    );

    // Background chat tasks (download_file / run_shell) — live progress
    // cards. Pushed from chat/tasks.rs; no mobile relay (desktop-only).
    unlistens.push(
      // Per-action tool approval cards. `chat:approval-request` surfaces a
      // card the user Approves/Denies (built-in tool loop AND headless
      // Claude Code can_use_tool requests share this event);
      // `chat:approval-resolved` dismisses it (the backend has already
      // resumed the paused turn).
      listenChatApprovalRequest((payload) => {
        useChatStore.getState().onApprovalRequest(payload);
        const ownerSessionId = useChatStore.getState().getOwnerSessionId(payload.chatSessionId);
        if (ownerSessionId) {
          void emitMobileSessionChatEvent(ownerSessionId, "approval", payload);
        }
        // The agent is BLOCKED until the user approves — worth interrupting
        // for. Same visibility policy as completions: quiet when the user is
        // watching that session (the approval card is right there).
        if (!isViewingSession(payload.chatSessionId)) {
          const appFocused = isAppFocused();
          relayNotify({
            kind: "approval",
            title: `${sessionName(payload.chatSessionId)} needs approval`,
            body: payload.summary || payload.tool || "A tool action is waiting for you.",
            chatSessionId: payload.chatSessionId,
            osToast: !appFocused,
            inAppToast: appFocused,
            sound: "alert",
            soundOnlyUnfocused: true,
          });
        }
      }),
    );

    unlistens.push(
      listenChatApprovalResolved((payload) => {
        useChatStore.getState().onApprovalResolved(payload);
      }),
    );

    // Harness questions (Claude Code AskUserQuestion over the control
    // protocol) — surface the question card; the harness turn is paused on
    // stdin until resolveQuestion answers or skips it.
    unlistens.push(
      listenChatQuestionRequest((payload) => {
        useChatStore.getState().onQuestionRequest(payload);
        // Same as approvals: the turn is paused until the user answers.
        if (!isViewingSession(payload.chatSessionId)) {
          const appFocused = isAppFocused();
          relayNotify({
            kind: "approval",
            title: `${sessionName(payload.chatSessionId)} has a question`,
            body: payload.questions?.[0]?.question || "The agent needs your input to continue.",
            chatSessionId: payload.chatSessionId,
            osToast: !appFocused,
            inAppToast: appFocused,
            sound: "alert",
            soundOnlyUnfocused: true,
          });
        }
      }),
    );

    unlistens.push(
      listenChatTaskProgress((payload) => {
        useChatStore.getState().onTaskProgress(payload);
      }),
    );

    // Plan step progress from backend — matches against PROSE-PARSED plan
    // steps only (source "parsed"). Steps from the model's authoritative
    // todo_write list must never be fuzzy-matched: a "Write src/x.ts" tool
    // description would wrongly complete whichever step shares two words.
    unlistens.push(
      listenPlanStepProgress(({ chatSessionId, stepLabel, status, detail, toolCall }) => {
        const store = useChatStore.getState();
        const steps = (store.planSteps[chatSessionId] ?? []).filter(
          (st) => st.source === "parsed",
        );
        if (steps.length === 0) return;
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

    // Structured plan tracking: the model's authoritative todo list, the
    // plan-mode flag, and present_plan proposal cards. No mobile relay
    // (desktop-only).
    unlistens.push(
      listenPlanUpdated((payload) => {
        useChatStore.getState().onPlanUpdated(payload);
      }),
    );
    unlistens.push(
      listenPlanMode((payload) => {
        useChatStore.getState().onPlanMode(payload);
      }),
    );
    unlistens.push(
      listenPlanProposal((payload) => {
        useChatStore.getState().onPlanProposal(payload);
      }),
    );
    unlistens.push(
      listenPlanAccepted((payload) => {
        useChatStore.getState().onPlanAccepted(payload);
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
